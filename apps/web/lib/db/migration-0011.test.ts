/**
 * Migration `0011_agents` drills — E09-agents task 002.
 *
 * NO MOCKS (project rule). Every assertion runs against the real dev Neon
 * branch: CHECKs, foreign keys and partial indexes are database behaviour.
 *
 * Two databases are proved:
 *   - FROM EMPTY: every migration `0000` → `0011` (not later ones), replayed into a scratch
 *     schema inside a transaction that is rolled back — nothing persists.
 *   - ON TOP OF `0010`: the dev branch's `public` schema, migrated by
 *     `pnpm --filter @kept/web db:migrate`.
 * In both, the SQL bounds must equal `PROVENANCE_LIMITS` and the client CHECK
 * must accept exactly what `parseKeptClient` accepts (SQL cannot import them).
 *
 * The drills SKIP when `DATABASE_URL` is absent (CI on fork PRs). Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/db/migration-0011.test.ts
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { parseKeptClient, PROVENANCE_LIMITS } from "@kept/shared";
import { config } from "dotenv";

import type { Tx } from "./index";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const createdSites = new Set<string>();
const createdUsers = new Set<string>();
const createdCodes = new Set<string>();

async function deps() {
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { closeDb, db } = await import("./index");
  const schema = await import("./schema");
  return { eq, inArray, sql, closeDb, db, ...schema };
}

after(async () => {
  if (skipLive) return;
  const { agentCodes, closeDb, db, inArray, sites, user } = await deps();
  if (createdCodes.size > 0) {
    await db
      .delete(agentCodes)
      .where(inArray(agentCodes.email, [...createdCodes]));
  }
  if (createdSites.size > 0) {
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdUsers.size > 0) {
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  await closeDb();
});

async function makeSite(): Promise<string> {
  const { db, sites } = await deps();
  const id = crypto.randomUUID();
  await db.insert(sites).values({
    id,
    slug: `e09-002-${id.slice(0, 12)}`,
    status: "live",
    region: "auto",
    publisherHash: "e09-002-drill",
    contentHash: "e09-002",
    sizeBytes: 1,
  });
  createdSites.add(id);
  return id;
}

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

/** The CHECK definitions 0011 adds, by name, as Postgres prints them. */
async function checkDefinitions(
  handle: Tx | Awaited<ReturnType<typeof deps>>["db"],
  schemaName: string
) {
  const { sql } = await deps();
  const rows = await handle.execute<{ conname: string; def: string }>(sql`
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = ${schemaName} and c.contype = 'c'
      and c.conname in ('sites_model_length_check', 'sites_tool_length_check',
        'sites_prompt_length_check', 'sites_readme_length_check',
        'sites_source_url_length_check', 'site_versions_client_check',
        'api_keys_name_length_check')
  `);
  return new Map(rows.map((row) => [row.conname, row.def]));
}

function assertChecksAgree(defs: Map<string, string>) {
  const bounds = {
    sites_model_length_check: PROVENANCE_LIMITS.model,
    sites_tool_length_check: PROVENANCE_LIMITS.tool,
    sites_prompt_length_check: PROVENANCE_LIMITS.prompt,
    sites_readme_length_check: PROVENANCE_LIMITS.readme,
    sites_source_url_length_check: PROVENANCE_LIMITS.source_url,
  };
  for (const [name, max] of Object.entries(bounds)) {
    const def = defs.get(name);
    console.log(`[migration-0011] ${name}: ${def}`);
    assert.ok(
      def?.includes(`<= ${max}`),
      `${name} must bound at ${max}, got ${def}`
    );
  }
  for (const name of [
    "site_versions_client_check",
    "api_keys_name_length_check",
  ]) {
    console.log(`[migration-0011] ${name}: ${defs.get(name)}`);
  }
  assert.ok(
    defs.get("site_versions_client_check")?.includes("'^[a-z0-9._/-]{1,40}$'")
  );
  assert.match(defs.get("api_keys_name_length_check") ?? "", />= 1\).*<= 60\)/);
}

test(
  "from empty: 0000 → 0011 replay cleanly into a scratch schema, with the same CHECKs",
  { skip: skipLive },
  async () => {
    const { db, sql } = await deps();
    const dir = join(process.cwd(), "drizzle");
    // Up to 0011 only: later migrations have their own drills.
    const files = readdirSync(dir)
      .filter((file) => /^\d{4}_.*\.sql$/.test(file) && file <= "0011_~")
      .sort();
    assert.equal(files.at(-1)?.slice(0, 4), "0011", "replays through 0011");
    const scratch = `e09_002_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

    let defs = new Map<string, string>();
    let tables: string[] = [];
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`create schema "${scratch}"`));
        await tx.execute(sql.raw(`set local search_path = "${scratch}"`));
        for (const file of files) {
          const body = readFileSync(join(dir, file), "utf8").replaceAll(
            '"public".',
            `"${scratch}".`
          );
          for (const statement of body.split("--> statement-breakpoint")) {
            if (statement.trim()) await tx.execute(sql.raw(statement));
          }
        }
        defs = await checkDefinitions(tx, scratch);
        const rows = await tx.execute<{ table_name: string }>(sql`
          select table_name from information_schema.tables
          where table_schema = ${scratch} and table_name in ('api_keys', 'agent_codes')
        `);
        tables = rows.map((row) => row.table_name).sort();
        tx.rollback();
      }),
      /rollback/i
    );
    console.log(
      `[migration-0011] replayed ${files.length} migrations into ${scratch} (rolled back)`
    );
    assert.deepEqual(tables, ["agent_codes", "api_keys"]);
    assertChecksAgree(defs);
  }
);

test(
  "on top of 0010: the dev branch carries 0011's CHECKs",
  { skip: skipLive },
  async () => {
    const { db } = await deps();
    assertChecksAgree(await checkDefinitions(db, "public"));
  }
);

test(
  "sites provenance: each column takes its limit and refuses limit + 1",
  { skip: skipLive },
  async () => {
    const { db, eq, sites } = await deps();
    const id = await makeSite();
    const columns = {
      model: PROVENANCE_LIMITS.model,
      tool: PROVENANCE_LIMITS.tool,
      prompt: PROVENANCE_LIMITS.prompt,
      readme: PROVENANCE_LIMITS.readme,
      sourceUrl: PROVENANCE_LIMITS.source_url,
    } as const;
    for (const [column, max] of Object.entries(columns)) {
      await db
        .update(sites)
        .set({ [column]: "x".repeat(max) })
        .where(eq(sites.id, id));
      await assert.rejects(
        db
          .update(sites)
          .set({ [column]: "x".repeat(max + 1) })
          .where(eq(sites.id, id)),
        (err: unknown) => {
          const code = (err as { cause?: { code?: string } }).cause?.code;
          assert.equal(
            code,
            "23514",
            `${column} at ${max + 1} must violate its CHECK`
          );
          return true;
        }
      );
    }
  }
);

test(
  "sites.remix_of goes NULL when the remixed page is deleted",
  { skip: skipLive },
  async () => {
    const { db, eq, sites } = await deps();
    const original = await makeSite();
    const remix = await makeSite();
    await db
      .update(sites)
      .set({ remixOf: original })
      .where(eq(sites.id, remix));
    await db.delete(sites).where(eq(sites.id, original));
    createdSites.delete(original);
    const [row] = await db
      .select({ remixOf: sites.remixOf })
      .from(sites)
      .where(eq(sites.id, remix));
    assert.deepEqual(row, { remixOf: null });
  }
);

test(
  "site_versions.client: the CHECK accepts exactly what parseKeptClient accepts",
  { skip: skipLive },
  async () => {
    const { db, eq, siteVersions } = await deps();
    const siteId = await makeSite();
    const versionId = crypto.randomUUID();
    await db.insert(siteVersions).values({
      id: versionId,
      siteId,
      r2Key: `sites/${siteId}/${versionId}/index.html`,
      contentHash: "e09-002",
      sizeBytes: 1,
    });
    const samples = [
      "claude-code",
      "cursor/1.2",
      "a.b_c-d",
      "x".repeat(40),
      "x".repeat(41),
      "Claude",
      "a b",
      "../x?",
      "",
    ];
    for (const sample of samples) {
      const accepted = await db
        .update(siteVersions)
        .set({ client: sample })
        .where(eq(siteVersions.id, versionId))
        .then(
          () => true,
          () => false
        );
      console.log(
        `[migration-0011] client ${JSON.stringify(sample)}: sql=${accepted}`
      );
      assert.equal(
        accepted,
        parseKeptClient(sample) === sample,
        `CHECK and parseKeptClient disagree on ${JSON.stringify(sample)}`
      );
    }
  }
);

test(
  "account deletion: api_keys cascade with the profile — account-deletion.ts needs no change",
  { skip: skipLive },
  async () => {
    const { apiKeys, db, eq, user } = await deps();
    const userId = await makeUser();
    await db.insert(apiKeys).values({
      userId,
      name: "drill",
      prefix: "kpt_live_e09",
      hash: `e09-002-${crypto.randomUUID()}`,
    });
    await db.delete(user).where(eq(user.id, userId));
    createdUsers.delete(userId);
    const left = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId));
    assert.equal(left.length, 0);
  }
);

test(
  "agent_codes: a right code is single use; five wrong tries kill it; an expired code is refused",
  { skip: skipLive },
  async () => {
    const { agentCodes, db, eq, sql } = await deps();
    const { consumeAgentCode, upsertAgentCode } =
      await import("./queries/agent-codes");
    const email = `e09-002-${crypto.randomUUID()}@kept.invalid`;
    createdCodes.add(email);

    await upsertAgentCode(email, "right", "claude-code");
    assert.equal(await consumeAgentCode(email, "wrong"), null);
    assert.deepEqual(await consumeAgentCode(email, "right"), {
      client: "claude-code",
    });
    assert.equal(await consumeAgentCode(email, "right"), null, "single use");

    // A new request resets the tries.
    await upsertAgentCode(email, "right", null);
    for (let i = 0; i < 5; i++)
      assert.equal(await consumeAgentCode(email, "wrong"), null);
    assert.equal(
      await consumeAgentCode(email, "right"),
      null,
      "dead after five wrong tries"
    );
    const [row] = await db
      .select({ attempts: agentCodes.attempts })
      .from(agentCodes)
      .where(eq(agentCodes.email, email));
    assert.deepEqual(row, { attempts: 5 });

    await upsertAgentCode(email, "right", null);
    await db.execute(
      sql`update agent_codes set expires_at = now() - interval '1 second' where email = ${email}`
    );
    assert.equal(await consumeAgentCode(email, "right"), null, "expired");

    // Two concurrent right answers: exactly one wins.
    await upsertAgentCode(email, "right", null);
    const both = await Promise.all([
      consumeAgentCode(email, "right"),
      consumeAgentCode(email, "right"),
    ]);
    assert.equal(both.filter(Boolean).length, 1);
  }
);
