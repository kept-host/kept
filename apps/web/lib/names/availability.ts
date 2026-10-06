/**
 * THE namespace check — the only place a page name's availability is decided
 * (D5). E06 task 006.
 *
 * A name is taken when an ACTIVE page has it (any owner, any status but
 * `archived` / `removed` — the partial `sites_slug_key`'s own predicate) or an
 * unexpired `name_holds` row holds it for somebody else. `RESERVED_NAMES` is not
 * looked at here: `validateName` refuses those before a caller gets this far.
 * E10 adds handles to this same function rather than writing a second check.
 *
 * ── THE RACE, AND THE LOCK THAT CLOSES IT (epic Risk 8) ──────────────────────
 * The unique index arbitrates active slugs but cannot see holds:
 *
 *   T1: A renames X→Y and holds X        T2: B renames Z→X
 *       UPDATE A.slug = Y (uncommitted)      holds(X)? none — T1 not committed
 *                                            UPDATE B.slug = X → waits on A's X
 *       INSERT hold(X, A); COMMIT            A's row is now Y → B takes X  ← hijack
 *
 * So every path that reads-then-writes a name takes `lockNames` on EACH name it
 * touches, in the same transaction, and asks this module only AFTER the lock is
 * held. Read Committed gives each later statement a fresh snapshot, so the
 * second transaction sees the first one's hold. Lock order is fixed — the
 * owner's profile row (`lockOwner`) first, then the names, sorted — so two
 * transactions can never hold one each and wait on the other.
 *
 * The generated-name mint takes no lock (a held name exists only because
 * somebody CHOSE it, and the unique index still guards the insert) but does ask
 * `isNameAvailable` — see `withMintedSlug` in `../db/queries/publish.ts` (AC23).
 */
import { and, eq, gt, notInArray, sql, type SQL } from "drizzle-orm";

import { db, type Tx } from "../db";
import { nameHolds, sites } from "../db/schema";

/** What the namespace says about a name, for one asker. */
export type NameAvailability = "available" | "held_for_you" | "taken";

/**
 * A page that still claims its name: any status but `archived` / `removed`,
 * which keep their slug for history without holding it (D5). The partial
 * `sites_slug_key` index carries the same predicate, and the chosen-name quota
 * counts the same rows (D3).
 */
export function claimsItsName(): SQL {
  return notInArray(sites.status, ["archived", "removed"]);
}

/** A query runs on the caller's transaction when it is inside one, else on the pool. */
export type Queryable = Tx | typeof db;

/**
 * Whether `name` may go on a page for `userId` — `null` for the anonymous mint,
 * which nobody's hold is for.
 *
 *   · an active page has it                       → `taken`
 *   · an unexpired hold for `userId`              → `held_for_you` (it is theirs to take back)
 *   · an unexpired hold for anyone else, or none  → `taken` — never anything
 *                                                    more specific (edge case 4)
 *   · otherwise, including an expired hold        → `available`
 *
 * Expired holds are ignored, not swept: there is no cleanup job, and the next
 * `holdName` on the same name overwrites the row.
 */
export async function isNameAvailable(
  name: string,
  userId: string | null,
  tx: Queryable = db,
): Promise<NameAvailability> {
  const [active] = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.slug, name), claimsItsName()))
    .limit(1);
  if (active) return "taken";

  const [hold] = await tx
    .select({ userId: nameHolds.userId })
    .from(nameHolds)
    .where(and(eq(nameHolds.name, name), gt(nameHolds.heldUntil, sql`now()`)));
  if (!hold) return "available";
  return userId !== null && hold.userId === userId ? "held_for_you" : "taken";
}

/**
 * Take the per-name advisory lock on every name in `names`, sorted, inside
 * `tx`. Held to commit or rollback (`pg_advisory_xact_lock`), so there is
 * nothing to release and nothing a thrown error can leak.
 *
 * Call it after `lockOwner` and before the first read of the namespace — see
 * the header for why that order, and why "before the read" is the whole point.
 */
export async function lockNames(tx: Tx, names: readonly string[]): Promise<void> {
  for (const name of [...new Set(names)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kept-name:${name}`}))`);
  }
}
