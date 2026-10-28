/**
 * Handles (E10 D9, D10, PRD §5.5) — an account's one reserved name in the
 * namespace page names live in: `{handle}.kept.host`. Same rule as a page name
 * (`validateName`: free ≥ 5, Pro ≥ 4, reserved, brand terms), outside the name
 * quota, never released. Until E12 the current handle's host answers the
 * branded 404 — it has no manifest.
 *
 * ── A CHANGE, IN ONE TRANSACTION, THEN THE EDGE ──────────────────────────────
 *
 *   lockOwner                          ← the profile row: the 30-day limit is read under it
 *   lockNames(old, new)                ← sorted; the order ../names/availability.ts fixes
 *   re-check: limit, rule, namespace
 *   [an old handle taken back → its handle_redirects row and hold go]
 *   UPDATE profiles SET handle (and handle_changed_at, on a change)
 *   [there was an old handle → hold it forever + handle_redirects row]
 *   COMMIT
 *   removeManifest(new)                ← only when taking back an old handle: its redirect goes
 *   writeRedirectManifest(old → new)   ← EVERY old handle, so no chain (Q2)
 *   resyncOwnerPages                   ← the badge carries the handle (005, Q4: queued)
 *
 * A failed store write after the commit is logged, not answered: the handle is
 * set, and the next change rewrites every redirect again.
 *
 * ── THE 30-DAY LIMIT (D10, AC16) ─────────────────────────────────────────────
 * Setting a FIRST handle is not a change and stamps nothing; each change after
 * it stamps `handle_changed_at`, and the next is allowed from the start of the
 * UTC day `HANDLE_CHANGE_DAYS` later — the date the field states.
 */
import {
  HANDLE_CHANGE_DAYS,
  type HandleChangeResult,
  type NameCheckResult,
  type NameCheckStatus,
  type Plan,
  type StudioErrorCode,
} from "@kept/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import { resyncOwnerPages } from "../badge/fan-out";
import { db, type Tx } from "../db";
import {
  insertHandleRedirect,
  isOldHandleOf,
  oldHandlesOf,
  reclaimHandleRedirect,
} from "../db/queries/handles";
import { nameHolds, profiles, sites } from "../db/schema";
import { claimsItsName, isNameAvailable, lockNames, type Queryable } from "../names/availability";
import { nameRuleVerdict } from "../names/check";
import { holdNameForever } from "../names/holds";
import { nameStatusMessage } from "../names/messages";
import { NAME_REFUSAL_CODE } from "../names/rename";
import { lockOwner } from "../sites/keep";
import { StudioRefusal } from "../sites/studio-refusal";
import { servingBaseDomain } from "../storage/env";
import { removeManifest, writeRedirectManifest } from "../storage/manifest";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What the handle check reads off a profile. */
export interface HandleOwner {
  id: string;
  plan: Plan;
  handle: string | null;
  handleChangedAt: Date | null;
}

/** Every handle check status that refuses the save, and its studio code. */
const HANDLE_REFUSAL_CODE = {
  invalid: NAME_REFUSAL_CODE.invalid,
  too_short: NAME_REFUSAL_CODE.too_short,
  pro_length: NAME_REFUSAL_CODE.pro_length,
  reserved: NAME_REFUSAL_CODE.reserved,
  inappropriate: NAME_REFUSAL_CODE.inappropriate,
  taken: NAME_REFUSAL_CODE.taken,
  handle_change_limited: "handle_change_limited",
} as const satisfies Partial<Record<NameCheckStatus, StudioErrorCode>>;

type RefusedVerdict = NameCheckResult & { status: keyof typeof HANDLE_REFUSAL_CODE };

/** The handle may not be set. The sentence is the field's own (`nameStatusMessage`). */
class HandleRefusal extends StudioRefusal {
  constructor(verdict: RefusedVerdict, name: string) {
    super(HANDLE_REFUSAL_CODE[verdict.status], nameStatusMessage(verdict, name, `.${servingBaseDomain()}`));
    this.name = "HandleRefusal";
  }
}

function assertAllowed(verdict: NameCheckResult | null, name: string): void {
  if (!verdict || verdict.status === "available" || verdict.status === "held_for_you") return;
  if (verdict.status in HANDLE_REFUSAL_CODE) throw new HandleRefusal(verdict as RefusedVerdict, name);
  // `quota` / `rate_limited` are a page rename's; the handle check never answers them.
  throw new Error(`Handle check answered "${verdict.status}", which no handle refusal maps.`);
}

/**
 * The UTC date a handle changed at `changedAt` may change again (`YYYY-MM-DD`):
 * `HANDLE_CHANGE_DAYS` later, rounded UP to the next UTC midnight, so the date
 * stated is the first whole day the change is allowed.
 */
export function nextHandleChangeOn(changedAt: Date): string {
  const due = new Date(changedAt.getTime() + HANDLE_CHANGE_DAYS * MS_PER_DAY);
  const midnight = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const day = midnight === due.getTime() ? midnight : midnight + MS_PER_DAY;
  return new Date(day).toISOString().slice(0, 10);
}

/**
 * The UTC date `owner` may next change its handle, while a change is still
 * refused at `now`; `null` when a change is allowed (no handle yet, or never
 * changed, or the limit has passed).
 */
export function handleChangeBlockedUntil(owner: HandleOwner, now: Date = new Date()): string | null {
  if (owner.handle === null || owner.handleChangedAt === null) return null;
  const availableOn = nextHandleChangeOn(owner.handleChangedAt);
  return now.getTime() < Date.parse(`${availableOn}T00:00:00Z`) ? availableOn : null;
}

/**
 * The handle check's answer for `name`, in precedence: the account's current
 * handle (`available`, a no-op) → the 30-day limit → the name rule → the
 * namespace, where one of the account's own old handles reads `held_for_you`.
 * Runs on the save's transaction, after its locks, or on the pool for the field.
 */
async function handleVerdict(tx: Queryable, name: string, owner: HandleOwner): Promise<NameCheckResult> {
  if (name === owner.handle) return { status: "available" };

  const availableOn = handleChangeBlockedUntil(owner);
  if (availableOn) return { status: "handle_change_limited", availableOn };

  const rule = nameRuleVerdict(name, owner.plan);
  if (rule) return rule;

  const availability = await isNameAvailable(name, owner.id, tx);
  if (availability !== "taken") return { status: availability };
  return (await isOldHandleOf(name, owner.id, tx)) ? { status: "held_for_you" } : { status: "taken" };
}

/**
 * `GET /api/names/check?name=&handle=1` — what a save of `name` as `owner`'s
 * handle would answer now. A read with no lock: the save re-asks under its locks.
 */
export function checkHandle(name: string, owner: HandleOwner): Promise<NameCheckResult> {
  return handleVerdict(db, name, owner);
}

interface AppliedHandle {
  /** The handle it replaced; `null` for a first handle or the no-op. */
  previous: string | null;
  /** The new handle was one of the account's old ones (its redirect must go). */
  reclaimed: boolean;
  /** `handle_changed_at` as it now stands. */
  changedAt: Date | null;
  /** The save named the current handle: nothing written. */
  noop: boolean;
}

/** The Postgres half — every lock, re-check and row write. No store call. */
async function applyHandle(tx: Tx, profileId: string, name: string): Promise<AppliedHandle> {
  const plan = await lockOwner(tx, profileId);
  const [row] = await tx
    .select({ handle: profiles.handle, handleChangedAt: profiles.handleChangedAt })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  const owner: HandleOwner = { id: profileId, plan, handle: row!.handle, handleChangedAt: row!.handleChangedAt };

  if (name === owner.handle) {
    return { previous: null, reclaimed: false, changedAt: owner.handleChangedAt, noop: true };
  }

  // The pure rule first, so a junk name takes no lock.
  assertAllowed(nameRuleVerdict(name, plan), name);
  await lockNames(tx, owner.handle === null ? [name] : [owner.handle, name]);
  const verdict = await handleVerdict(tx, name, owner);
  assertAllowed(verdict, name);

  let reclaimed = false;
  if (verdict.status === "held_for_you") {
    // Taking a name back: a page name held for this account, or one of its own
    // old handles. Either way the hold is spent; an old handle's redirect row
    // goes too, in this transaction (it would redirect to itself).
    reclaimed = await reclaimHandleRedirect(tx, name, profileId);
    await tx.delete(nameHolds).where(eq(nameHolds.name, name));
  }

  const isChange = owner.handle !== null;
  const [updated] = await tx
    .update(profiles)
    .set({ handle: name, ...(isChange && { handleChangedAt: sql`now()` }) })
    .where(eq(profiles.id, profileId))
    .returning({ handleChangedAt: profiles.handleChangedAt });

  if (isChange) {
    await holdNameForever(tx, owner.handle!, profileId, "renamed");
    await insertHandleRedirect(tx, owner.handle!, profileId);
  }

  return { previous: owner.handle, reclaimed, changedAt: updated!.handleChangedAt, noop: false };
}

/**
 * Point every old handle of `profileId` at `current` — one redirect manifest
 * each, so a second change re-points the first old handle too (no chains, Q2).
 * An old handle a live page of the account now sits on (it took the handle
 * before the change, Q22) keeps the page. Never throws.
 */
async function writeHandleRedirects(profileId: string, current: string): Promise<void> {
  try {
    const olds = await oldHandlesOf(profileId);
    if (olds.length === 0) return;
    const claimed = new Set(
      (
        await db
          .select({ slug: sites.slug })
          .from(sites)
          .where(and(inArray(sites.slug, olds), claimsItsName()))
      ).map((row) => row.slug),
    );
    // Sequential, like every multi-slug store loop: purges stay inside the rate.
    for (const old of olds.filter((name) => !claimed.has(name))) {
      const written = await writeRedirectManifest(old, current);
      if (!written.ok) {
        console.error(
          `[kept] handle change: the redirect "${old}" → "${current}" was not written at the "${written.step}" step — ${written.error}. The old host answers the branded 404 until the next handle change rewrites it.`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[kept] handle change: redirects to "${current}" for profile ${profileId} not written — ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}

/**
 * Set `profileId`'s handle to `name` (`PUT /api/profile/handle`).
 *
 * @throws {HandleRefusal} the limit, the name rule or the namespace
 */
export async function setHandle(profileId: string, name: string): Promise<HandleChangeResult> {
  const applied = await db.transaction((tx) => applyHandle(tx, profileId, name));
  const nextChangeOn = applied.changedAt ? nextHandleChangeOn(applied.changedAt) : null;
  if (applied.noop) return { handle: name, nextChangeOn };

  // COMMITTED. From here a failure is logged — the handle is set either way.
  if (applied.reclaimed) {
    const removed = await removeManifest(name);
    if (!removed.ok) {
      console.error(
        `[kept] handle change: the old redirect at "${name}" was not removed at the "${removed.step}" step — ${removed.error}. It still 301s to the handle it left; replay this removal (contract §3).`,
      );
    }
  }
  if (applied.previous !== null) await writeHandleRedirects(profileId, name);

  try {
    await resyncOwnerPages(profileId);
  } catch (err) {
    console.error(
      `[kept] handle change: badge re-sync not queued for profile ${profileId} — ${err instanceof Error ? err.message : String(err)}. Kept pages show the old handle until their next sync.`,
    );
  }
  return { handle: name, nextChangeOn };
}
