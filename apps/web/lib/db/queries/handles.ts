/**
 * Every SQL statement about handles as names (E10 D9, Q2, Q3) — the current
 * handle on `profiles`, the old ones in `handle_redirects`, and resolving a
 * `?ref=` value to the account it credits.
 *
 * An old handle points at its ACCOUNT, never at the handle that replaced it, so
 * every redirect resolves to the current handle and a second rename leaves no
 * chain behind (Q2).
 */
import { and, asc, eq, sql } from "drizzle-orm";

import { db, type Tx } from "../index";
import { handleRedirects, profiles } from "../schema";

/** The account's current handle, or `null` (never set, or no such account). */
export async function currentHandleOf(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ handle: profiles.handle })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  return row?.handle ?? null;
}

/** Every handle the account has left behind, oldest first. */
export async function oldHandlesOf(profileId: string, tx: Tx | typeof db = db): Promise<string[]> {
  const rows = await tx
    .select({ oldHandle: handleRedirects.oldHandle })
    .from(handleRedirects)
    .where(eq(handleRedirects.profileId, profileId))
    .orderBy(asc(handleRedirects.createdAt), asc(handleRedirects.oldHandle));
  return rows.map((row) => row.oldHandle);
}

/**
 * Record `oldHandle` as left behind by `profileId`, inside the handle change's
 * transaction. Idempotent: an old handle is recorded once, for its first owner —
 * it stays held forever (Q17), so nobody else can ever leave it behind.
 */
export async function insertHandleRedirect(
  tx: Tx,
  oldHandle: string,
  profileId: string,
): Promise<void> {
  await tx
    .insert(handleRedirects)
    .values({ oldHandle, profileId })
    .onConflictDoNothing({ target: handleRedirects.oldHandle });
}

/**
 * Take `oldHandle` back as `profileId`'s current handle: its redirect row goes,
 * inside the handle change's transaction — left behind, the handle would
 * redirect to itself. Returns whether it was one of the account's old handles.
 */
export async function reclaimHandleRedirect(
  tx: Tx,
  oldHandle: string,
  profileId: string,
): Promise<boolean> {
  const deleted = await tx
    .delete(handleRedirects)
    .where(and(eq(handleRedirects.oldHandle, oldHandle), eq(handleRedirects.profileId, profileId)))
    .returning({ oldHandle: handleRedirects.oldHandle });
  return deleted.length > 0;
}

/** Whether `name` is one `profileId` left behind — theirs to take back as a handle. */
export async function isOldHandleOf(
  name: string,
  profileId: string,
  tx: Tx | typeof db = db,
): Promise<boolean> {
  const [row] = await tx
    .select({ oldHandle: handleRedirects.oldHandle })
    .from(handleRedirects)
    .where(and(eq(handleRedirects.oldHandle, name), eq(handleRedirects.profileId, profileId)));
  return row !== undefined;
}

/**
 * The account a `?ref=` value credits, or `null` (Q3). Tried in order: a
 * current handle, an old handle (a link shared before a rename still counts),
 * then the permanent referral code. One round trip.
 */
export async function resolveRefCode(code: string): Promise<string | null> {
  const [row] = await db.execute<{ id: string | null }>(sql`
    select coalesce(
      (select ${profiles.id} from ${profiles} where ${profiles.handle} = ${code}),
      (select ${handleRedirects.profileId} from ${handleRedirects}
        where ${handleRedirects.oldHandle} = ${code}),
      (select ${profiles.id} from ${profiles} where ${profiles.referralCode} = ${code})
    ) as id
  `);
  return row?.id ?? null;
}

/**
 * What the edge must say for `name` as a handle (E10 Q2): `redirectTo` — the
 * current handle of the account that left `name` behind, when it has one —
 * and whether `name` is somebody's CURRENT handle (no manifest until E12).
 */
export async function handleEdgeState(
  name: string,
): Promise<{ redirectTo: string | null; isCurrent: boolean }> {
  const [row] = await db.execute<{ redirect_to: string | null; is_current: boolean }>(sql`
    select
      (select ${profiles.handle} from ${handleRedirects}
        join ${profiles} on ${profiles.id} = ${handleRedirects.profileId}
        where ${handleRedirects.oldHandle} = ${name}) as redirect_to,
      exists (select 1 from ${profiles} where ${profiles.handle} = ${name}) as is_current
  `);
  return { redirectTo: row?.redirect_to ?? null, isCurrent: row?.is_current === true };
}
