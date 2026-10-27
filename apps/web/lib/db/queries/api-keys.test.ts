/**
 * `api_keys` queries — E09-agents task 002.
 *
 * NO MOCKS (project rule): every assertion runs against the real dev Neon
 * branch with `0011` applied. The cap under concurrency (AC9) is a row lock,
 * and "one write a day" is a predicate — both database behaviour.
 *
 * Touches Postgres only. The drill account is deleted in `after`; its keys
 * cascade with it.
 *
 * SKIPS when `DATABASE_URL` is absent (CI on fork PRs has no secrets). Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/db/queries/api-keys.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { API_KEYS_PER_ACCOUNT } from "@kept/shared";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const createdUsers = new Set<string>();

async function deps() {
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { closeDb, db } = await import("../index");
  const { apiKeys, profiles, user } = await import("../schema");
  const queries = await import("./api-keys");
  return { eq, inArray, sql, closeDb, db, apiKeys, profiles, user, ...queries };
}

after(async () => {
  if (skipLive) return;
  const { closeDb, db, inArray, user } = await deps();
  if (createdUsers.size > 0) {
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  await closeDb();
});

async function makeUser(): Promise<string> {
  const { db, profiles, user } = await deps();
  const id = crypto.randomUUID();
  const email = `e09-002-${id}@kept.invalid`;
  await db
    .insert(user)
    .values({ id, name: "E09-002 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email });
  createdUsers.add(id);
  return id;
}

function drillKey(name: string) {
  return {
    name,
    prefix: "kpt_live_e09",
    hash: `e09-002-${crypto.randomUUID()}`,
  };
}

test(
  `AC9: the ${API_KEYS_PER_ACCOUNT + 1}th key is refused, race-free, and a revoke frees a slot`,
  { skip: skipLive },
  async () => {
    const { insertApiKey, listApiKeys, revokeApiKey } = await deps();
    const profileId = await makeUser();
    for (let i = 0; i < API_KEYS_PER_ACCOUNT - 1; i++) {
      assert.ok(await insertApiKey(profileId, drillKey(`key ${i}`)));
    }

    // Two concurrent creates at one slot short: exactly one lands.
    const race = await Promise.all([
      insertApiKey(profileId, drillKey("racer a")),
      insertApiKey(profileId, drillKey("racer b")),
    ]);
    console.log(
      `[api-keys] race at ${API_KEYS_PER_ACCOUNT - 1}: ${race.map((row) => (row ? "landed" : "refused"))}`
    );
    assert.equal(race.filter(Boolean).length, 1);

    const listed = await listApiKeys(profileId);
    assert.equal(listed.length, API_KEYS_PER_ACCOUNT);
    assert.equal(await insertApiKey(profileId, drillKey("one too many")), null);

    const [newest] = listed;
    assert.ok(newest);
    assert.equal(await revokeApiKey(newest.id, profileId), true);
    assert.ok(
      await insertApiKey(profileId, drillKey("after revoke")),
      "a revoke frees a slot"
    );
  }
);

test(
  "listApiKeys: active only, newest first, never the hash",
  { skip: skipLive },
  async () => {
    const { apiKeys, db, eq, insertApiKey, listApiKeys, revokeApiKey, sql } =
      await deps();
    const profileId = await makeUser();
    const first = await insertApiKey(profileId, drillKey("first"));
    const second = await insertApiKey(profileId, drillKey("second"));
    const third = await insertApiKey(profileId, drillKey("third"));
    assert.ok(first && second && third);
    // One transaction's now() each; make the order unambiguous.
    await db
      .update(apiKeys)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(eq(apiKeys.id, first.id));
    await revokeApiKey(second.id, profileId);

    const listed = await listApiKeys(profileId);
    assert.deepEqual(
      listed.map((row) => row.name),
      ["third", "first"]
    );
    assert.ok(!("hash" in (listed[0] ?? {})));
  }
);

test(
  "findActiveKeyByHash + revokeApiKey: plan resolved; owner-scoped, idempotent, immediate",
  { skip: skipLive },
  async () => {
    const { apiKeys, db, eq, findActiveKeyByHash, insertApiKey, revokeApiKey } =
      await deps();
    const profileId = await makeUser();
    const stranger = await makeUser();
    const key = drillKey("lookup");
    const row = await insertApiKey(profileId, key);
    assert.ok(row);

    assert.deepEqual(await findActiveKeyByHash(key.hash), {
      keyId: row.id,
      profileId,
      plan: "free",
    });
    assert.equal(await findActiveKeyByHash("e09-002-no-such-hash"), null);

    assert.equal(
      await revokeApiKey(row.id, stranger),
      false,
      "another account cannot revoke it"
    );
    assert.ok(await findActiveKeyByHash(key.hash));

    assert.equal(await revokeApiKey(row.id, profileId), true);
    const [stamped] = await db
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, row.id));
    assert.equal(await revokeApiKey(row.id, profileId), true, "idempotent");
    const [again] = await db
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, row.id));
    assert.deepEqual(again, stamped, "a second revoke keeps the first stamp");
    assert.equal(
      await findActiveKeyByHash(key.hash),
      null,
      "revocation is immediate"
    );
  }
);

test(
  "touchKeyLastUsed: twice in a day is one write",
  { skip: skipLive },
  async () => {
    const { apiKeys, db, eq, insertApiKey, sql, touchKeyLastUsed } =
      await deps();
    const profileId = await makeUser();
    const row = await insertApiKey(profileId, drillKey("touch"));
    assert.ok(row);

    // `xmin` is the id of the transaction that last wrote the row.
    const version = async () => {
      const [found] = await db
        .select({
          xmin: sql<string>`xmin::text`,
          lastUsedOn: apiKeys.lastUsedOn,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, row.id));
      return found;
    };
    const before = await version();
    await touchKeyLastUsed(row.id);
    const first = await version();
    await touchKeyLastUsed(row.id);
    const second = await version();
    console.log(
      `[api-keys] xmin ${before?.xmin} → ${first?.xmin} → ${second?.xmin}; last_used_on=${first?.lastUsedOn}`
    );

    assert.equal(before?.lastUsedOn, null);
    assert.notEqual(first?.xmin, before?.xmin, "the first touch writes");
    assert.ok(first?.lastUsedOn);
    assert.deepEqual(
      second,
      first,
      "the second touch the same day writes nothing"
    );
  }
);
