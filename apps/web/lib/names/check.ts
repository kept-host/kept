/**
 * The name check — PRD §5.4's precedence, decided in ONE place for both the
 * check route (`GET /api/names/check`) and the rename (`./rename.ts`), so the
 * field can never preview an answer the write would not give. E06 task 006.
 *
 *   1. the name rule (`validateName`, reserved and inappropriate first — AC22)
 *   2. availability (`isNameAvailable`): `taken`, or `held_for_you`
 *   3. `quota` — only when the page's name is still `generated`: renaming a page
 *      that already has a chosen name to another one does not use a new name (AC20)
 *   4. `rate_limited` — `RENAMES_PER_DAY` per rolling 24 h, counted from
 *      `name_events` (D6)
 *   5. `available` — or `held_for_you`, which is the same answer with a kinder
 *      sentence: a held name taken back counts against the quota again (edge
 *      case 5), so it has to pass 3 and 4 like any other.
 *
 * Every number comes from `limitsFor(plan)` or a count; the words are
 * `./messages.ts`'s.
 */
import {
  RENAMES_PER_DAY,
  limitsFor,
  type NameCheckResult,
  type NameKind,
  type Plan,
} from "@kept/shared";
import { validateName } from "@kept/shared/names";
import { and, eq, gt, sql } from "drizzle-orm";

import { db } from "../db";
import { nameEvents, profiles, sites } from "../db/schema";
import { SiteNotFoundError } from "../sites/keep";

import { claimsItsName, isNameAvailable, type Queryable } from "./availability";

/**
 * Chosen names counted against `userId`'s quota: pages whose name is `chosen`
 * and that are not `archived` / `removed` — so a DEMOTED page keeps counting
 * (D3). The one query; the Pages counter and the Plan meter reuse it.
 */
export async function chosenNameCount(userId: string, tx: Queryable = db): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(sites)
    .where(
      and(
        eq(sites.ownerId, userId),
        eq(sites.nameKind, "chosen"),
        claimsItsName(),
      ),
    );
  return row?.count ?? 0;
}

/** Renames `userId` made in the rolling 24 hours (D6) — the durable rename limit. */
async function renamesInLastDay(userId: string, tx: Queryable): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(nameEvents)
    .where(
      and(eq(nameEvents.userId, userId), gt(nameEvents.createdAt, sql`now() - interval '24 hours'`)),
    );
  return row?.count ?? 0;
}

/** Step 1: the pure name rule's refusal, or `null` when the name may be asked about. */
export function nameRuleVerdict(name: string, plan: Plan): NameCheckResult | null {
  const rule = validateName(name, plan);
  if (rule === "ok") return null;
  if (rule === "too_short") return { status: "too_short", min: limitsFor(plan).nameMinLength };
  return { status: rule };
}

/**
 * Steps 2–5, for a name that passed the rule. Inside a rename this runs on the
 * rename's transaction, AFTER `lockOwner` and the name locks — that is what
 * makes its answer the one the write acts on.
 */
export async function namespaceVerdict(
  tx: Queryable,
  input: { name: string; userId: string; plan: Plan; nameKind: NameKind },
): Promise<NameCheckResult> {
  const availability = await isNameAvailable(input.name, input.userId, tx);
  if (availability === "taken") return { status: "taken" };

  if (input.nameKind === "generated") {
    const count = await chosenNameCount(input.userId, tx);
    const quota = limitsFor(input.plan).chosenNames;
    if (count >= quota) return { status: "quota", count, quota };
  }

  const renames = await renamesInLastDay(input.userId, tx);
  if (renames >= RENAMES_PER_DAY) return { status: "rate_limited", count: renames };

  return { status: availability };
}

/**
 * The answer `GET /api/names/check` gives about `name` for the page `siteId`.
 *
 * The page must be the caller's and not `archived` / `removed`, or this throws
 * `SiteNotFoundError` — the same 404 as a page that does not exist. Its own
 * current name reads `available`, because renaming a page to the name it has is
 * the no-op success `renameSite` gives it.
 *
 * A READ, with no lock: the rename re-asks under its locks, and a name taken
 * between this answer and the save is the rename's `409 name_taken`.
 */
export async function checkName(
  name: string,
  userId: string,
  siteId: string,
): Promise<NameCheckResult> {
  const [site] = await db
    .select({ slug: sites.slug, nameKind: sites.nameKind, plan: profiles.plan })
    .from(sites)
    .innerJoin(profiles, eq(profiles.id, sites.ownerId))
    .where(
      and(
        eq(sites.id, siteId),
        eq(sites.ownerId, userId),
        claimsItsName(),
      ),
    );
  if (!site) throw new SiteNotFoundError(siteId);
  if (name === site.slug) return { status: "available" };

  return (
    nameRuleVerdict(name, site.plan) ??
    (await namespaceVerdict(db, { name, userId, plan: site.plan, nameKind: site.nameKind }))
  );
}

/** Name checks one account may make per minute, in this process. */
export const NAME_CHECKS_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

const checkWindows = new Map<string, { start: number; count: number }>();
let lastSweep = 0;

/**
 * Whether `userId` may make another name check now — a fixed one-minute window
 * of `NAME_CHECKS_PER_MINUTE`.
 *
 * ⚠️ IN-PROCESS ON PURPOSE (epic Risk 12). It guards a READ on one Railway
 * instance from a field that checks as you type; a restart forgets it and a
 * second instance would double it, and neither matters. The limit that does
 * matter — `RENAMES_PER_DAY` — is counted from `name_events` in Postgres.
 *
 * Windows that have ended are swept at most once a minute, so the map holds the
 * accounts active in the last minute and nothing older. `now` is injectable for
 * the test; production passes nothing.
 */
export function allowNameCheck(userId: string, now: number = Date.now()): boolean {
  if (now - lastSweep >= MINUTE_MS) {
    for (const [id, window] of checkWindows) {
      if (now - window.start >= MINUTE_MS) checkWindows.delete(id);
    }
    lastSweep = now;
  }
  const window = checkWindows.get(userId);
  if (!window || now - window.start >= MINUTE_MS) {
    checkWindows.set(userId, { start: now, count: 1 });
    return true;
  }
  if (window.count >= NAME_CHECKS_PER_MINUTE) return false;
  window.count += 1;
  return true;
}
