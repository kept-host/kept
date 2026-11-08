/**
 * Migration `0012_creator_loop` drills — E10-creator-loop task 002.
 *
 * NO MOCKS (project rule). Every assertion runs against the real dev Neon
 * branch: CHECKs, defaults, foreign keys and partial indexes are database
 * behaviour.
 *
 * Two databases are proved:
 *   - FROM EMPTY: `0000` → `0011` replayed into a scratch schema, two profiles
 *     sharing a display handle inserted, then `0012` applied on top — so the
 *     handle reset and the per-row code backfill are proved on rows that
 *     existed before it. All inside a transaction that is rolled back.
 *   - ON TOP OF `0011`: the dev branch's `public` schema, migrated by
 *     `pnpm --filter @kept/web db:migrate`.
 * In both, the SQL bounds must equal `PROFILE_BIO_MAX`, `BADGE_STYLES` and
 * `REFERRAL_CODE_LENGTH` (SQL cannot import them).
 *
 * The drills SKIP when `DATABASE_URL` is absent (CI on fork PRs). Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/db/migration-0012.test.ts
 *
 * Every row created here is deleted in `after`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  BADGE_STYLES,
  PROFILE_BIO_MAX,
  REFERRAL_CODE_LENGTH,
  referralCodeSchema,
} from "@kept/shared";
import { config } from "dotenv";

import type { Tx } from "./index";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

const createdSites = new Set<string>();
const createdUsers = new Set<string>();
const createdRedirects = new Set<string>();

async function deps() {
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { closeDb, db } = await import("./index");
  const schema = await import("./schema");
  return { eq, inArray, sql, closeDb, db, ...schema };
}

after(async () => {
  if (skipLive) return;
  const { closeDb, db, handleRedirects, inArray, sites, user } = await deps();
  if (createdRedirects.size > 0) {
    await db
      .delete(handleRedirects)
      .where(inArray(handleRedirects.oldHandle, [...createdRedirects]));
  }
  if (createdSites.size > 0) {
    await db.delete(sites).where(inArray(sites.id, [...createdSites]));
  }
  if (createdUsers.size > 0) {
    await db.delete(user).where(inArray(user.id, [...createdUsers]));
  }
  await closeDb();
});

/** A real auth user + profile through `ensureProfile`, as a sign-up makes them. */
async function makeUser(name = "E10-002 drill") {
  const { db, user } = await deps();
  const { ensureProfile } = await import("./queries/profile");
  const id = crypto.randomUUID();
  const email = `e10-002-${id}@kept.invalid`;
  await db.insert(user).values({ id, name, email, emailVerified: true });
  createdUsers.add(id);
  return ensureProfile({ userId: id, email });
}

/** A unique, well-shaped handle for this run. */
function freshHandle(): string {
  return `e10h${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function sqlState(err: unknown): string | undefined {
  return (err as { cause?: { code?: string } }).cause?.code;
}

/** What 0012 defines that a shared constant governs, as Postgres prints it. */
async function definitions(
  handle: Tx | Awaited<ReturnType<typeof deps>>["db"],
  schemaName: string,
) {
  const { sql } = await deps();
  const checks = await handle.execute<{ conname: string; def: string }>(sql`
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = ${schemaName} and c.contype = 'c'
      and c.conname in ('profiles_bio_length_check', 'profiles_badge_style_check',
        'referrals_not_self_check')
  `);
  const [code] = await handle.execute<{ column_default: string | null }>(sql`
    select column_default from information_schema.columns
    where table_schema = ${schemaName} and table_name = 'profiles'
      and column_name = 'referral_code'
  `);
  const tables = await handle.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = ${schemaName} and table_name in ('referrals', 'handle_redirects')
  `);
  return {
    checks: new Map(checks.map((row) => [row.conname, row.def])),
    codeDefault: code?.column_default ?? null,
    tables: tables.map((row) => row.table_name).sort(),
  };
}

function assertDefinitionsAgree(defs: Awaited<ReturnType<typeof definitions>>) {
  for (const [name, def] of defs.checks) console.log(`[migration-0012] ${name}: ${def}`);
  console.log(`[migration-0012] referral_code default: ${defs.codeDefault}`);
  assert.deepEqual(defs.tables, ["handle_redirects", "referrals"]);

  const bio = defs.checks.get("profiles_bio_length_check");
  assert.ok(bio?.includes(`<= ${PROFILE_BIO_MAX}`), `bio must bound at ${PROFILE_BIO_MAX}, got ${bio}`);

  const style = defs.checks.get("profiles_badge_style_check") ?? "";
  const allowed = [...style.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(allowed, [...BADGE_STYLES], `badge_style CHECK must list BADGE_STYLES, got ${style}`);

  assert.ok(defs.checks.has("referrals_not_self_check"));
  assert.match(
    defs.codeDefault ?? "",
    new RegExp(`gen_random_uuid\\(\\).*, ${REFERRAL_CODE_LENGTH}\\)$`),
    `referral_code must default to ${REFERRAL_CODE_LENGTH} random characters`,
  );
}

test(
  "from empty: 0000 → 0011, rows, then 0012 — handles nulled, every row coded, same CHECKs",
  { skip: skipLive },
  async () => {
    const { db, sql } = await deps();
    const dir = join(process.cwd(), "drizzle");
    const files = readdirSync(dir)
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .sort();
    assert.equal(files.at(-1)?.slice(0, 4), "0012", "0012 is the latest migration");
    const scratch = `e10_002_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

    const run = async (tx: Tx, file: string) => {
      const body = readFileSync(join(dir, file), "utf8").replaceAll('"public".', `"${scratch}".`);
      for (const statement of body.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
    };

    let defs: Awaited<ReturnType<typeof definitions>> | undefined;
    let rows: { handle: string | null; referral_code: string; badge_style: string }[] = [];
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`create schema "${scratch}"`));
        await tx.execute(sql.raw(`set local search_path = "${scratch}"`));
        for (const file of files.slice(0, -1)) await run(tx, file);
        // Two pre-0012 accounts whose seeded display handles collide — the
        // unique index could not be built over them without the reset.
        for (const n of [1, 2]) {
          const id = crypto.randomUUID();
          await tx.execute(sql`
            insert into "user" (id, name, email) values (${id}, 'Alex Kim', ${`e10-002-${n}-${id}@kept.invalid`})
          `);
          await tx.execute(sql`insert into profiles (id, handle) values (${id}, 'Alex Kim')`);
        }
        await run(tx, files.at(-1)!);
        defs = await definitions(tx, scratch);
        rows = await tx.execute(sql`select handle, referral_code, badge_style from profiles`);
        tx.rollback();
      }),
      /rollback/i,
    );
    console.log(`[migration-0012] replayed ${files.length} migrations into ${scratch} (rolled back)`);
    assertDefinitionsAgree(defs!);
    console.log(`[migration-0012] backfilled rows: ${JSON.stringify(rows)}`);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.handle, null, "D9/AC14: every handle is reset");
      assert.equal(row.badge_style, "standard");
      assert.ok(referralCodeSchema.safeParse(row.referral_code).success, row.referral_code);
    }
    assert.notEqual(rows[0]!.referral_code, rows[1]!.referral_code, "a code per row, not one shared");
  },
);

test("on top of 0011: the dev branch carries 0012's definitions", { skip: skipLive }, async () => {
  const { db } = await deps();
  assertDefinitionsAgree(await definitions(db, "public"));
});

test(
  "profiles: bio takes PROFILE_BIO_MAX and refuses one more; badge_style only BADGE_STYLES",
  { skip: skipLive },
  async () => {
    const { db, eq, profiles } = await deps();
    const { id } = await makeUser();
    await db.update(profiles).set({ bio: "x".repeat(PROFILE_BIO_MAX) }).where(eq(profiles.id, id));
    await assert.rejects(
      db.update(profiles).set({ bio: "x".repeat(PROFILE_BIO_MAX + 1) }).where(eq(profiles.id, id)),
      (err) => sqlState(err) === "23514",
    );
    for (const style of BADGE_STYLES) {
      await db.update(profiles).set({ badgeStyle: style }).where(eq(profiles.id, id));
    }
    await assert.rejects(
      db.execute(
        (await deps()).sql`update profiles set badge_style = 'fancy' where id = ${id}`,
      ),
      (err) => sqlState(err) === "23514",
    );
  },
);

test(
  "profiles.handle is unique where set; any number of accounts may have none",
  { skip: skipLive },
  async () => {
    const { db, eq, profiles } = await deps();
    const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
    assert.deepEqual([a.handle, b.handle, c.handle], [null, null, null]);
    const handle = freshHandle();
    await db.update(profiles).set({ handle }).where(eq(profiles.id, a.id));
    await assert.rejects(
      db.update(profiles).set({ handle }).where(eq(profiles.id, b.id)),
      (err) => sqlState(err) === "23505",
    );
  },
);

test("sites: the display switches default to shown, hidden, default rule", { skip: skipLive }, async () => {
  const { db, eq, sites } = await deps();
  const id = crypto.randomUUID();
  await db.insert(sites).values({
    id,
    slug: `e10-002-${id.slice(0, 12)}`,
    status: "live",
    region: "auto",
    publisherHash: "e10-002-drill",
    contentHash: "e10-002",
    sizeBytes: 1,
  });
  createdSites.add(id);
  const [row] = await db
    .select({ showMadeWith: sites.showMadeWith, showPrompt: sites.showPrompt, allowRemix: sites.allowRemix })
    .from(sites)
    .where(eq(sites.id, id));
  assert.deepEqual(row, { showMadeWith: true, showPrompt: false, allowRemix: null });
});

test(
  "referrals: one per account, never self, counted once verified, survive the referrer's deletion",
  { skip: skipLive },
  async () => {
    const { db, eq, referrals, sql, user } = await deps();
    const { insertReferral, markReferralVerified, referralStats } = await import("./queries/referrals");
    const referrer = await makeUser("Referrer");
    const verified = await makeUser("  Verified Friend  ");
    const pending = await makeUser("Pending Friend");
    const other = await makeUser("Other Referrer");

    assert.equal(
      await insertReferral({ referrerId: referrer.id, referredId: referrer.id, verified: true }),
      false,
      "self-referral refused",
    );
    await assert.rejects(
      db.execute(sql`insert into referrals (referred_id, referrer_id) values (${referrer.id}, ${referrer.id})`),
      (err) => sqlState(err) === "23514",
      "and the CHECK refuses it too",
    );

    assert.equal(await insertReferral({ referrerId: referrer.id, referredId: verified.id, verified: true }), true);
    assert.equal(await insertReferral({ referrerId: referrer.id, referredId: pending.id, verified: false }), true);
    assert.equal(
      await insertReferral({ referrerId: other.id, referredId: verified.id, verified: true }),
      false,
      "the first referral wins",
    );

    let stats = await referralStats(referrer.id);
    console.log(`[migration-0012] stats before verify: ${JSON.stringify(stats)}`);
    assert.equal(stats.verifiedCount, 1, "an unverified sign-up never counts");
    assert.deepEqual(Object.keys(stats.referrals[0]!).sort(), ["createdAt", "displayName"]);
    assert.equal(stats.referrals[0]!.displayName, "Verified Friend");

    await markReferralVerified(pending.id);
    await markReferralVerified(pending.id);
    stats = await referralStats(referrer.id);
    assert.equal(stats.verifiedCount, 2);
    assert.equal(stats.referrals[0]!.displayName, "Pending Friend", "newest first");
    assert.equal((await referralStats(other.id)).verifiedCount, 0);

    // The referrer leaves: the rows stay, credited to nobody.
    await db.delete(user).where(eq(user.id, referrer.id));
    createdUsers.delete(referrer.id);
    const left = await db.select().from(referrals).where(eq(referrals.referredId, verified.id));
    assert.equal(left[0]?.referrerId, null);
    // The referred account leaves: its row goes with it.
    await db.delete(user).where(eq(user.id, verified.id));
    createdUsers.delete(verified.id);
    assert.equal(
      (await db.select().from(referrals).where(eq(referrals.referredId, verified.id))).length,
      0,
    );
  },
);

test(
  "handles: old handles point at the account; ?ref resolves current → old → code; deletion orphans",
  { skip: skipLive },
  async () => {
    const { db, eq, profiles, user } = await deps();
    const { currentHandleOf, insertHandleRedirect, oldHandlesOf, resolveRefCode } = await import(
      "./queries/handles"
    );
    const owner = await makeUser();
    const [first, second, current] = [freshHandle(), freshHandle(), freshHandle()];

    assert.equal(await currentHandleOf(owner.id), null);
    await db.transaction(async (tx) => {
      await insertHandleRedirect(tx, first, owner.id);
      await insertHandleRedirect(tx, second, owner.id);
      await insertHandleRedirect(tx, first, owner.id); // idempotent
    });
    createdRedirects.add(first).add(second);
    await db.update(profiles).set({ handle: current }).where(eq(profiles.id, owner.id));

    assert.equal(await currentHandleOf(owner.id), current);
    // One transaction, one `now()`: ties fall back to the name.
    assert.deepEqual(await oldHandlesOf(owner.id), [first, second].sort());

    assert.equal(await resolveRefCode(current), owner.id, "current handle");
    assert.equal(await resolveRefCode(first), owner.id, "a handle shared before a rename");
    assert.equal(await resolveRefCode(owner.referralCode), owner.id, "the permanent code");
    assert.equal(await resolveRefCode(freshHandle()), null, "unknown");

    // A handle wins over another account's code that happens to equal it.
    const other = await makeUser();
    await db.update(profiles).set({ handle: other.referralCode }).where(eq(profiles.id, owner.id));
    assert.equal(await resolveRefCode(other.referralCode), owner.id);

    // Q17: the account goes; its old handles stay, ownerless, and credit nobody.
    await db.delete(user).where(eq(user.id, owner.id));
    createdUsers.delete(owner.id);
    assert.deepEqual(await oldHandlesOf(owner.id), []);
    assert.equal(await resolveRefCode(first), null);
  },
);
