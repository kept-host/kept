/**
 * Deleting a whole account — epic decision **D16** (E06 task 008).
 *
 * Immediate and complete: every page goes offline and is `archived` with no
 * owner and `purge_after = now + DRAFT_GRACE_DAYS` (as D14); every CHOSEN name
 * is held for `NAME_HOLD_DAYS` with no owner; `reminder_email` is cleared; the
 * `user` row goes, and `session` / `account` / `profiles` cascade with it, so
 * every other device is signed out on its next request (edge case 19). Owners
 * reach `archived`; `removed` is E07's.
 *
 * ── THE BUG THIS FILE EXISTS TO PREVENT ──────────────────────────────────────
 *
 *   user  ──cascade──▶  profiles  ──SET NULL──▶  sites.owner_id
 *
 * `DELETE FROM "user"` on its own cascades the profile away and *nulls*
 * `sites.owner_id`, leaving every kept page `owner_id NULL`, `anon_token_hash
 * NULL`, `expires_at NULL`, `status = 'live'`: **a page with no owner, no token
 * and no clock — permanent, serving, and unreachable by any authority in the
 * product.** Relying on the FK is the failure mode, so the teardown below is
 * explicit.
 *
 * ── THE ORDER, AND WHAT A CRASH AT EACH POINT COSTS ──────────────────────────
 *
 *   removeManifest(slug) × every active page  ← pointer → KV → purge. Serving STOPS.
 *   BEGIN
 *     lockOwner(profile)                ← the publish/keep/rename serialisation point
 *     lockNames(chosen names)           ← then the names, sorted (../names/availability.ts)
 *     UPDATE sites SET archived, purge_after  WHERE owner_id = ? AND claims its name
 *     holdName(name, NULL, 'account_deleted') × every chosen name
 *     UPDATE sites SET owner_id = NULL, reminder_email = NULL  WHERE owner_id = ?
 *     DELETE FROM "user" WHERE id = ?
 *   COMMIT
 *
 * The manifest calls cannot join a database transaction, so they go **first**:
 * a crash after the unwind and before the commit leaves pages offline that
 * still say `live` — visible to an audit, and recoverable, because the user
 * retries and every step is idempotent. The reverse order could leave a row
 * that says archived for a page still answering the internet with nobody left
 * to take it down. So a failed unwind refuses the whole deletion
 * (`AccountDeletionStoreError`) before a single row moves.
 *
 * ⚠️ ONLY PAGES THAT STILL CLAIM THEIR NAME ARE UNWOUND. An `archived` or
 * `removed` row keeps its slug for history without holding it (D5), so the same
 * name may by now be serving SOMEBODY ELSE's page — unwinding it would take that
 * page down.
 *
 * ⚠️ **THERE IS NO R2 DELETE IN THIS FILE, AND ADDING ONE IS THE BUG.** The
 * bytes are E07's purge job's, selected on `purge_after`. An inline delete loop
 * would block a request on unbounded work and be a second purge path competing
 * with E07's. Until E07 ships, R2 objects legitimately persist after a deletion.
 *
 * ── BETTER AUTH'S `deleteUser` IS DELIBERATELY NOT ENABLED ───────────────────
 * better-auth@1.6.26 ships a `/delete-user` endpoint behind `user.deleteUser.
 * enabled`. It is left off and the `user` row is deleted here, in this
 * transaction (epic Risk 9), for two reasons that both point the same way:
 *
 *   1. Enabling it MOUNTS A SECOND ACCOUNT-DELETION DOOR at
 *      `/api/auth/delete-user` — one that deletes the `user` row and lets the
 *      FK's `SET NULL` fire, which is exactly the bug above, reachable by
 *      anyone with a session.
 *   2. Its adapter calls cannot join a Drizzle transaction, so the archive, the
 *      holds and the user delete could not be atomic.
 *
 * The cascades this relies on (`session`, `account`, `profiles` → `user.id`
 * `ON DELETE CASCADE`) are declared in **kept's own** `lib/db/schema.ts`, so
 * deleting the row directly is the supported path *for this schema*. If a
 * future epic enables `deleteUser`, it must route through `deleteAccount` below
 * or it re-opens the hole.
 */
import type { AccountDeletionResult } from "@kept/shared";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { getDashboardSites } from "../db/queries/dashboard";
import { sites, user } from "../db/schema";
import { claimsItsName, lockNames } from "../names/availability";
import { holdName } from "../names/holds";
import { removeManifest } from "../storage/manifest";

import { lockOwner } from "./keep";
import { archivedForGrace } from "./manage";
import { StudioRefusal } from "./studio-refusal";

/**
 * A page could not be taken off the edge, so **nothing** was deleted.
 *
 * Raised before the transaction opens, so every row is still owned, the account
 * still exists, and the honest answer to the caller is "nothing changed, try
 * again" — never "we half-deleted your account". Retrying is safe: an already
 * unwound slug unwinds again without complaint.
 */
export class AccountDeletionStoreError extends StudioRefusal {
  constructor(
    public readonly slug: string,
    detail: string,
  ) {
    super(
      "internal_error",
      "kept could not take your pages off the internet just now, so nothing was deleted. Your account and every page are exactly as they were. Try again in a moment.",
      `"${slug}" could not be taken off the edge: ${detail}`,
    );
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
 * `total` is exactly `kept + drafts`: every page the Pages home lists. It is
 * NOT every row the teardown touches — `archived`, `removed` and past-grace
 * drafts are absent from `getDashboardSites` (task 011), so they are in no
 * count here, although the deletion still leaves them ownerless. Settings
 * reads `total === 0` as "nothing to export, nothing goes offline".
 */
export interface AccountDeletionSummary {
  /** Permanent pages, from `isKeptCondition` via `keptQuotaFor` — never recounted. */
  kept: number;
  /** `expires_at != null`, as the Pages home lists them. The one draft split there is. */
  drafts: number;
  /** `kept + drafts` — the pages the home lists, never archived/removed/past-grace rows. */
  total: number;
}

/**
 * The counts for the deletion dialog.
 *
 * ⚠️ KEPT-NESS IS NOT RE-SPELLED HERE. It comes from `keptQuotaFor` (through
 * `getDashboardSites`), which is the same predicate the cap branch enforces
 * with. A second spelling of that WHERE clause in this module
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
 * Destroy an account (D16): take every active page offline, archive it with no
 * owner, hold its chosen names with no owner, and remove the user.
 *
 * The caller can only ever pass **their own** profile id — `app/api/account/route.ts`
 * resolves it from the session and there is no id parameter naming a victim.
 *
 * @throws {AccountDeletionStoreError} a page could not be taken off the edge; nothing was deleted
 */
export async function deleteAccount(profileId: string): Promise<AccountDeletionResult> {
  const active = await db
    .select({ slug: sites.slug })
    .from(sites)
    .where(and(eq(sites.ownerId, profileId), claimsItsName()));

  // Sequential, never concurrent: `removeManifest` issues real purges, and
  // fanning a hundred of them at Cloudflare at once is how an account with a lot
  // of pages gets itself rate-limited half way through a teardown.
  const unwound = new Set<string>();
  for (const site of active) {
    await unwind(site.slug);
    unwound.add(site.slug);
  }

  const archived = await db.transaction(async (tx) => {
    // THE SAME SERIALISATION POINT every publish, keep and rename takes. A tab
    // publishing or renaming while another confirms deletion either committed
    // before this lock (caught by the reconciliation below) or finds no profile
    // afterwards and rolls itself back.
    await lockOwner(tx, profileId);

    // Re-read under the lock: this is the set the rows below move.
    const pages = await tx
      .select({ id: sites.id, slug: sites.slug, nameKind: sites.nameKind })
      .from(sites)
      .where(and(eq(sites.ownerId, profileId), claimsItsName()));
    const chosen = pages.filter((page) => page.nameKind === "chosen");
    // Every chosen name locked, sorted, BEFORE a row moves — a rename-to by
    // another account waits here and then finds the hold.
    await lockNames(
      tx,
      chosen.map((page) => page.slug),
    );

    if (pages.length > 0) {
      await tx
        .update(sites)
        .set(archivedForGrace())
        .where(
          inArray(
            sites.id,
            pages.map((page) => page.id),
          ),
        );
    }
    for (const page of chosen) {
      await holdName(page.slug, null, "account_deleted", page.id, tx);
    }

    // EVERY row the account had, archived before or just now: no owner left to
    // name, and nobody left to remind. ONE owner-scoped statement — a `WHERE`
    // that forgot `owner_id` here would orphan the internet's pages.
    await tx
      .update(sites)
      .set({ ownerId: null, reminderEmail: null })
      .where(eq(sites.ownerId, profileId));

    // AND ONLY NOW THE USER. `session`, `account` and `profiles` cascade with
    // it; the user's earlier holds keep their deadline and lose their owner
    // (`name_holds.user_id` is `ON DELETE SET NULL`).
    await tx.delete(user).where(eq(user.id, profileId));

    return pages;
  });

  // A page published or renamed between the unwind loop and the lock: archived
  // in Postgres, but its manifest was never taken down. Post-commit, so it
  // cannot fail the deletion the user already got — the account is gone either way.
  for (const page of archived) {
    if (unwound.has(page.slug)) continue;
    console.error(
      `[kept] account deletion: "${page.slug}" appeared while profile ${profileId} was being deleted; unwinding it after the fact.`,
    );
    try {
      const late = await removeManifest(page.slug);
      if (!late.ok) {
        console.error(
          `[kept] account deletion: LATE UNWIND FAILED for "${page.slug}" at the "${late.step}" step — ${late.error}. The row is \`archived\` but the page is still serving. E07 DIVERGENCE AUDIT: reconcile against Postgres (contract §7.5).`,
        );
      }
    } catch (err) {
      console.error(
        `[kept] account deletion: LATE UNWIND THREW for "${page.slug}" — ${message(err)}. The row is \`archived\` but the page is still serving.`,
      );
    }
  }

  return { pagesArchived: archived.length };
}
