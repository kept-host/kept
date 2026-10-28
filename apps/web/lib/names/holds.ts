/**
 * Name holds (D4) — E06 task 006.
 *
 * When a CHOSEN name leaves a page — renamed away, deleted, purged, or its
 * account deleted — it is held for `NAME_HOLD_DAYS` for its last owner: nobody
 * else can take it, the owner can take it back (`isNameAvailable` answers them
 * `held_for_you`). That is what stops a stranger re-registering a name with live
 * inbound links the moment it is let go. Generated names are never held.
 */
import { NAME_HOLD_DAYS, type NameHoldReason } from "@kept/shared";
import { and, eq, sql, type SQL } from "drizzle-orm";

import { db, type Tx } from "../db";
import { nameHolds, sites } from "../db/schema";

import { lockNames } from "./availability";

/**
 * Hold `name` for `userId` (`null` once the account is gone, D16) until
 * `now() + NAME_HOLD_DAYS`.
 *
 * AN UPSERT: holding a name that already has a row — the same owner's earlier
 * hold, or an expired one somebody else left — replaces it, so a re-hold
 * extends and a stale owner never outlives the newer one.
 *
 * Takes the name's advisory lock (`lockNames`) inside `tx`. A caller that has
 * already locked the name holds it again harmlessly; a caller without a
 * transaction gets one, because the lock is transaction-scoped. Callers that
 * also take `lockOwner` (rename; delete and account deletion in task 008) must
 * take it FIRST — the order `./availability.ts` fixes.
 */
export async function holdName(
  name: string,
  userId: string | null,
  reason: NameHoldReason,
  siteId?: string,
  tx?: Tx,
): Promise<void> {
  const heldUntil = sql`now() + make_interval(days => ${NAME_HOLD_DAYS})`;
  const run = (trx: Tx) => upsertHold(trx, name, userId, reason, siteId ?? null, heldUntil);
  await (tx ? run(tx) : db.transaction(run));
}

/**
 * Hold `name` for `userId` (`null`: nobody) with no end — `held_until =
 * 'infinity'`. A handle is never released (E10 D9, D10): an old handle is held
 * for its owner, and a deleted account's handles for nobody (Q17). Same lock
 * and upsert as `holdName`; always inside the caller's transaction.
 */
export async function holdNameForever(
  tx: Tx,
  name: string,
  userId: string | null,
  reason: NameHoldReason,
): Promise<void> {
  await upsertHold(tx, name, userId, reason, null, sql`'infinity'::timestamptz`);
}

async function upsertHold(
  tx: Tx,
  name: string,
  userId: string | null,
  reason: NameHoldReason,
  siteId: string | null,
  heldUntil: SQL,
): Promise<void> {
  await lockNames(tx, [name]);
  await tx
    .insert(nameHolds)
    .values({ name, userId, siteId, reason, heldUntil })
    .onConflictDoUpdate({
      target: nameHolds.name,
      set: { userId, siteId, reason, heldUntil, createdAt: sql`now()` },
    });
}

/**
 * Release the name of a page that is being purged — **E07's contract**
 * (edge case 7, 08 §4). A chosen name gets a `purged` hold for the page's last
 * owner; a generated name is simply gone.
 *
 * ⚠️ ITS CALLER IS E07's PURGE JOB (`lib/lifecycle/purge.ts`), which skips it
 * for a `removed` page so the ownerless D19 hold survives. The purge takes
 * `lockOwner` on the page's owner before calling this (epic Risk 7): a late
 * keep re-reads the row under that lock, and a sweep that did not take it could
 * purge a page in the same instant its owner kept it.
 */
export async function releaseName(siteId: string, tx?: Tx): Promise<void> {
  const run = async (trx: Tx) => {
    const [site] = await trx
      .select({ slug: sites.slug, nameKind: sites.nameKind, ownerId: sites.ownerId })
      .from(sites)
      .where(eq(sites.id, siteId));
    if (!site || site.nameKind !== "chosen") return;
    await holdName(site.slug, site.ownerId, "purged", siteId, trx);
  };
  await (tx ? run(tx) : db.transaction(run));
}

/**
 * Lift the ownerless `removed` hold a moderation removal put on `name` (E07
 * D19) — what a restore does. Only that hold, and only this page's: a hold for
 * an owner (renamed, deleted, purged) is never touched here.
 *
 * Takes the name's advisory lock inside `tx`, after the caller's `lockOwner`
 * and site-row locks (the order `./availability.ts` fixes).
 */
export async function dropRemovedHold(name: string, siteId: string, tx: Tx): Promise<void> {
  await lockNames(tx, [name]);
  await tx
    .delete(nameHolds)
    .where(and(eq(nameHolds.name, name), eq(nameHolds.reason, "removed"), eq(nameHolds.siteId, siteId)));
}
