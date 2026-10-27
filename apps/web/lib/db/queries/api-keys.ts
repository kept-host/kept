/**
 * Every SQL statement about API keys (E09) — the only module that reads or
 * writes `api_keys`.
 *
 * Only a key's SHA-256 reaches this module; the raw key never does. Keys are
 * revoked, never deleted, and cascade with the profile.
 */
import { API_KEYS_PER_ACCOUNT, type Plan } from "@kept/shared";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";

import { lockOwner } from "../../sites/keep";
import { db } from "../index";
import { apiKeys, profiles } from "../schema";

/** A key as the settings table lists it — never its hash. */
export type ApiKeyRow = Pick<
  typeof apiKeys.$inferSelect,
  "id" | "name" | "prefix" | "createdAt" | "lastUsedOn"
>;

const summaryColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  createdAt: apiKeys.createdAt,
  lastUsedOn: apiKeys.lastUsedOn,
};

const isActive = isNull(apiKeys.revokedAt);

/**
 * Store a new key, or refuse with `null` when the account already holds
 * `API_KEYS_PER_ACCOUNT` active keys. The count and the insert run under
 * `lockOwner`, so two concurrent creates at 24 cannot both land (AC9).
 */
export async function insertApiKey(
  profileId: string,
  key: { name: string; prefix: string; hash: string }
): Promise<ApiKeyRow | null> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, profileId);
    const [active] = await tx
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, profileId), isActive));
    if ((active?.n ?? 0) >= API_KEYS_PER_ACCOUNT) return null;
    const [row] = await tx
      .insert(apiKeys)
      .values({ userId: profileId, ...key })
      .returning(summaryColumns);
    return row ?? null;
  });
}

/** The account's active keys, newest first. */
export async function listApiKeys(profileId: string): Promise<ApiKeyRow[]> {
  return db
    .select(summaryColumns)
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, profileId), isActive))
    .orderBy(desc(apiKeys.createdAt));
}

/** The active key with this hash and its owner's plan, or `null`. */
export async function findActiveKeyByHash(
  hash: string
): Promise<{ keyId: string; profileId: string; plan: Plan } | null> {
  const [row] = await db
    .select({
      keyId: apiKeys.id,
      profileId: apiKeys.userId,
      plan: profiles.plan,
    })
    .from(apiKeys)
    .innerJoin(profiles, eq(profiles.id, apiKeys.userId))
    .where(and(eq(apiKeys.hash, hash), isActive))
    .limit(1);
  return row ?? null;
}

/**
 * Revoke one of the account's keys. Owner-scoped (another account's id is a
 * no-op) and idempotent (an already-revoked key keeps its first stamp).
 * Returns whether the account owns a key with this id.
 */
export async function revokeApiKey(
  id: string,
  profileId: string
): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, profileId)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/** Stamp today's use — at most one write a day; later calls match no row. */
export async function touchKeyLastUsed(id: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedOn: sql`current_date` })
    .where(
      and(
        eq(apiKeys.id, id),
        sql`${apiKeys.lastUsedOn} is distinct from current_date`
      )
    );
}
