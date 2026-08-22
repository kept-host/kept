/**
 * Deleting a whole account — E06 task 011, epic decision **D3**.
 *
 * ── THE BUG THIS FILE EXISTS TO DELETE ───────────────────────────────────────
 *
 *   user  ──cascade──▶  profiles  ──SET NULL──▶  sites.owner_id
 *
 * `DELETE FROM "user"` on its own cascades the profile away and *nulls*
 * `sites.owner_id`, leaving every page the account kept as `owner_id NULL`,
 * `anon_token_hash NULL` (keeping killed it), `expires_at NULL` (kept pages have
 * no clock), `status = 'live'`. **That is a page with no owner, no token, no
 * clock and no expiry — permanent, serving, and unreachable by any authority in
 * the product.** Not even E07's sweeps touch it: both select on clocks that are
 * null.
 *
 * **Relying on the FK is the failure mode.** It is the shape that passes every
 * test that does not go looking, producing rows that are undiscoverable by
 * design. So the teardown below is explicit, and the `SET NULL` still fires
 * afterwards — harmlessly, because by then no row it touches is still `live`.
 *
 * ── THE ORDER, AND WHAT A CRASH AT EACH POINT COSTS ──────────────────────────
 *
 *   removeManifest(slug) × every page   ← pointer → KV → purge. Serving STOPS.
 *   BEGIN
 *     lockOwner(profile)                ← the publish/keep serialisation point
 *     UPDATE sites SET status='removed', purge_after=now  WHERE owner_id = ?
 *     DELETE FROM "user" WHERE id = ?
 *   COMMIT
 *
 * The manifest calls are the deliberate exception to "one transaction": they are
 * remote store operations and cannot join a database transaction. They go
 * **first**, and the asymmetry is the whole reason:
 *
 *   · crash after an unwind, before the commit → a page that is not serving but
 *     still says `live` in Postgres. Visible to an audit, invisible to the
 *     internet, and **recoverable** — the user retries and the whole teardown
 *     completes, because every step is idempotent.
 *   · crash the other way round → a row that says `removed` for a page that is
 *     still answering the internet with nobody left to take it down. **Not**
 *     recoverable by anything short of E07's purge.
 *
 * One of those is a bad afternoon and the other is the failure this task is
 * about, so a failed unwind refuses the whole deletion (`AccountDeletionStoreError`)
 * before a single row moves.
 *
 * ── `removed`, NOT `archived`, AND THE TWO ARE NOT DRIFT ─────────────────────
 * Deleting ONE page archives it (`lib/sites/manage.ts` → `archiveSite`): the row
 * and the R2 object are retained so the OWNER can download them during E07's
 * window. Deleting an ACCOUNT lands `removed` with a `purge_after`, because the
 * owner is precisely who no longer exists — archiving would promise a recovery
 * path to nobody and park the bytes outside the purge predicate forever. E07's
 * daily job is specified as `status IN (expired, removed) AND purge_after <
 * now()` → hard-delete R2 + rows, so this hands off to machinery that is already
 * designed. **Two verbs, two terminal states, both deliberate. Do not harmonise
 * them.** No new status value and no new column is introduced for any of it.
 *
 * ── E06 DEFINES THE TERMINAL ROW STATE; E07 OWNS THE BROOM ───────────────────
 * ⚠️ **THERE IS NO R2 DELETE IN THIS FILE, AND ADDING ONE IS THE BUG.** The
 * bytes are E07's. An inline object-delete loop would block an HTTP request on
 * unbounded work for an account with hundreds of pages, and — the architectural
 * reason, which comes first — it would be a second purge path competing with the
 * one E07 is going to own. Two brooms disagreeing about which floor is clean is
 * how a product ends up unable to say whether anything was actually deleted. No
 * cron, no sweep, no background job is added here either; E05's cron substrate
 * exists and E07 inherits it.
 *
 * ⚠️ **UNTIL E07 SHIPS, R2 OBJECTS LEGITIMATELY PERSIST AFTER A DELETION.** The
 * copy must accommodate that: *"your pages stop being served immediately; the
 * files are erased shortly after"* is true, and *"erased immediately"* is not.
 *
 * ── BETTER AUTH'S `deleteUser` IS DELIBERATELY NOT ENABLED ───────────────────
 * better-auth@1.6.26 ships a `/delete-user` endpoint behind `user.deleteUser.
 * enabled`. It is left off and the `user` row is deleted here, in this
 * transaction, for two reasons that both point the same way:
 *
 *   1. Enabling it MOUNTS A SECOND ACCOUNT-DELETION DOOR at
 *      `/api/auth/delete-user` — one that deletes the `user` row and lets the
 *      FK's `SET NULL` fire, which is exactly the undiscoverable-row bug at the
 *      top of this file, reachable by anyone with a session.
 *   2. Its adapter calls cannot join a Drizzle transaction, so the row flip and
 *      the user delete could not be atomic — and D3 requires that they are.
 *
 * The cascades this relies on (`session`, `account`, `profiles` → `user.id`
 * `ON DELETE CASCADE`) are declared in **kept's own** `lib/db/schema.ts`, not by
 * Better Auth, so deleting the row directly is the supported path *for this
 * schema*. If a future epic enables `deleteUser`, it must route through
 * `deleteAccount` below or it re-opens the hole.
 */
import {
  ACCOUNT_DELETION_CONFIRMATION,
  type AccountDeletionResult,
} from "@kept/shared";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { getDashboardSites } from "../db/queries/dashboard";
import { sites, user } from "../db/schema";
import { removeManifest } from "../storage/manifest";

import { lockOwner } from "./keep";

/**
 * A page could not be taken off the edge, so **nothing** was deleted.
 *
 * Raised before the transaction opens, so every row is still owned, the account
 * still exists, and the honest answer to the caller is "nothing changed, try
 * again" — never "we half-deleted your account". Retrying is safe: an already
 * unwound slug unwinds again without complaint.
 */
export class AccountDeletionStoreError extends Error {
  constructor(
    public readonly slug: string,
    detail: string,
  ) {
    super(`"${slug}" could not be taken off the edge: ${detail}`);
    this.name = "AccountDeletionStoreError";
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What the confirmation dialog states before it destroys anything — E06 task
 * 012's read (D3: **real counts**, read at render time, never a generic
 * warning).
 *
 * `kept + drafts` does NOT necessarily equal `total`, and that is correct rather
 * than a rounding error: `kept` is the *quota* predicate, so an `archived` or
 * `quarantined` page with no clock is in `total` and in neither category. The
 * dialog names the two things a person recognises; `total` is every row the
 * teardown touches.
 */
export interface AccountDeletionSummary {
  /** Permanent pages, from `isKeptCondition` via `keptQuotaFor` — never recounted. */
  kept: number;
  /** `expires_at != null`. The one draft split there is. */
  drafts: number;
  /** Every page the account owns, in every status. All of them are destroyed. */
  total: number;
  /** What the user must type. From `@kept/shared`, so both halves agree. */
  confirmationPhrase: typeof ACCOUNT_DELETION_CONFIRMATION;
}

/**
 * The counts for the deletion dialog.
 *
 * ⚠️ KEPT-NESS IS NOT RE-SPELLED HERE. It comes from `keptQuotaFor` (through
 * `getDashboardSites`), which is the same predicate the cap branch enforces
 * with. A second `WHERE expires_at IS NULL AND status = 'live'` in this module
 * would be the drift `isKeptCondition` exists to prevent, and it would show a
 * user a number that disagrees with their own dashboard on the one screen where
 * being believed matters most.
 *
 * One read of the owner's rows, reused rather than duplicated: the dashboard
 * query already returns exactly the split this needs.
 */
export async function getAccountDeletionSummary(
  profileId: string,
): Promise<AccountDeletionSummary> {
  const { kept, drafts, quota } = await getDashboardSites(profileId);
  return {
    kept: quota.used,
    drafts: drafts.length,
    total: kept.length + drafts.length,
    confirmationPhrase: ACCOUNT_DELETION_CONFIRMATION,
  };
}

/** Take one page off the edge, or refuse the whole deletion. */
async function unwind(slug: string): Promise<void> {
  const removed = await removeManifest(slug);
  if (removed.ok) return;
  // `removed.purge.ok === false` is NOT this branch (contract §3) — both stores
  // agree the slug is gone and only the edge is stale. This is a store failure.
  console.error(
    `[kept] account deletion: manifest removal failed at the "${removed.step}" step for slug "${slug}" — ${removed.error}. NOTHING has been deleted; every row is still owned and the account still exists. The caller may retry.`,
  );
  throw new AccountDeletionStoreError(slug, `${removed.step}: ${removed.error}`);
}

/**
 * Destroy an account: stop serving every page it has, mark every page for E07's
 * purge, and remove the user.
 *
 * The caller can only ever pass **their own** profile id — `app/api/account/route.ts`
 * resolves it from the session and there is no id parameter naming a victim.
 *
 * @throws {AccountDeletionStoreError} a page could not be taken off the edge; nothing was deleted
 */
export async function deleteAccount(profileId: string): Promise<AccountDeletionResult> {
  // Every page, in every status — `archived` and `expired` rows included. Their
  // manifests are already gone, and `removeManifest` on an absent slug succeeds,
  // so unwinding unconditionally costs a purge and buys the guarantee that the
  // loop has no status-shaped hole in it.
  const owned = await db
    .select({ slug: sites.slug })
    .from(sites)
    .where(eq(sites.ownerId, profileId));

  // Sequential, never concurrent: `removeManifest` issues real purges, and
  // fanning a hundred of them at Cloudflare at once is how an account with a lot
  // of pages gets itself rate-limited half way through a teardown.
  const unwound = new Set<string>();
  for (const site of owned) {
    await unwind(site.slug);
    unwound.add(site.slug);
  }

  const { affected, purgeAfter } = await db.transaction(async (tx) => {
    // THE SAME SERIALISATION POINT every cap decision takes. A dashboard tab
    // publishing while another confirms deletion would otherwise insert a row
    // after the unwind loop read the slugs; blocking here means such a publish
    // either committed before this lock (caught by the reconciliation below) or
    // finds no profile afterwards and rolls itself back.
    await lockOwner(tx, profileId);

    const now = new Date();
    // ONE owner-scoped statement for every page. The scope is the whole ball
    // game: a `WHERE` that forgot `owner_id` here would silently destroy the
    // internet's pages instead of this account's.
    const rows = await tx
      .update(sites)
      .set({ status: "removed", purgeAfter: now, updatedAt: now })
      .where(eq(sites.ownerId, profileId))
      .returning({ slug: sites.slug });

    // AND ONLY NOW THE USER. The FK cascade takes `session`, `account` and
    // `profiles` with it, and its `SET NULL` on `sites.owner_id` fires against
    // rows that are already `removed` — which is what makes it harmless.
    await tx.delete(user).where(eq(user.id, profileId));

    return { affected: rows, purgeAfter: now };
  });

  // A page that appeared between the unwind loop and the lock: its row is
  // `removed` but its manifest was never taken down, so it would keep serving
  // until E07 collected it. Post-commit, so it cannot fail the deletion the user
  // already got — the account is gone either way.
  for (const row of affected) {
    if (unwound.has(row.slug)) continue;
    console.error(
      `[kept] account deletion: "${row.slug}" was published while profile ${profileId} was being deleted; unwinding it after the fact.`,
    );
    try {
      const late = await removeManifest(row.slug);
      if (!late.ok) {
        console.error(
          `[kept] account deletion: LATE UNWIND FAILED for "${row.slug}" at the "${late.step}" step — ${late.error}. The row is \`removed\` but the page is still serving. E07 DIVERGENCE AUDIT: reconcile against Postgres (contract §7.5).`,
        );
      }
    } catch (err) {
      console.error(
        `[kept] account deletion: LATE UNWIND THREW for "${row.slug}" — ${message(err)}. The row is \`removed\` but the page is still serving.`,
      );
    }
  }

  return {
    pagesRemoved: affected.length,
    status: "removed",
    purgeAfter: purgeAfter.toISOString(),
  };
}
