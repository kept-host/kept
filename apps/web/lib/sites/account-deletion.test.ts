/**
 * Account deletion against the REAL dev stack — decision **D16** (E06 task 008;
 * the server half of AC43).
 *
 * NO MOCKS. Every page the teardown unwinds is published through
 * `publishOwnedPage` — the same function `POST /api/sites` calls — so the R2
 * object, the slug pointer and the KV manifest all genuinely exist before the
 * teardown unwinds them. Chosen names are given through `renameSite`, and the
 * rows and holds are read back from Postgres afterwards, because "it returned
 * 200" and "the rows are in the state E07 will find" are different claims.
 *
 * The one exception is the summary drill's cap: filling `limitsFor("free")`
 * kept slots by publishing would be dozens of R2/KV round trips proving nothing
 * the counts need, so all but the last slot are real rows seeded by direct
 * insert (`seedKept`). The last slot and the draft past it are still published.
 *
 * ── THE CLAIMS ───────────────────────────────────────────────────────────────
 *
 *  1. **No ownerless live page.** `status = 'live' AND owner_id IS NULL AND
 *     anon_token_hash IS NULL AND expires_at IS NULL` returns zero rows —
 *     asserted globally, because such a row is undiscoverable by ownership.
 *  2. **Every page is `archived`, ownerless, with a deadline.** Pages taken
 *     offline now get `purge_after = now + DRAFT_GRACE_DAYS`; a page the owner
 *     had already deleted keeps its own. `reminder_email` is NULL everywhere.
 *  3. **The edge is off** for every page that was serving.
 *  4. **R2 objects are STILL PRESENT** — E07's purge collects them, not this.
 *  5. **Chosen names are held with no owner** — the ones taken offline now as
 *     `account_deleted`, an earlier `deleted` hold losing its owner; generated
 *     names are never held.
 *  6. **The account is gone:** `user`, `session`, `account`, `profiles`.
 *  7. **Another account is untouched** — row, pointer and object.
 *
 * SKIPS without dev credentials: CI runs `pnpm test` on fork PRs with no cloud
 * secrets. Run locally with `pnpm --filter @kept/web test:unit`.
 *
 * Every row, object, pointer and hold created here is cleaned up in `after` —
 * the deleted account's site rows survive the teardown (that is the point), and
 * their `owner_id` is null by then, so cleanup tracks ids rather than owners.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  DRAFT_GRACE_DAYS,
  accountDeletionResultSchema,
  limitsFor,
} from "@kept/shared";
import { config } from "dotenv";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { closeDb, db } from "../db";
import {
  account,
  nameHolds,
  profiles,
  session,
  siteVersions,
  sites,
  user,
} from "../db/schema";
import { renameSite } from "../names/rename";
import { pointerKey } from "../storage/manifest";
import { pageObjectKey, r2Store } from "../storage/r2";

import { deleteAccount, getAccountDeletionSummary } from "./account-deletion";
import { demoteSite } from "./keep";
import { deleteSite } from "./manage";
import { deleteOwnAccount } from "./owner-routes";
import { publishOwnedPage } from "./publish";

config({ path: ".env.local", quiet: true });

const REQUIRED = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
  "PUBLISHER_HASH_SALT",
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0
    ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Clock slack between this process and Postgres. */
const SLACK_MS = 5 * 60_000;

const createdUsers = new Set<string>();
const createdSites = new Set<string>();
const createdSlugs = new Set<string>();

const publisher = { ip: "127.0.0.1", userAgent: "kept-e06-011-drill/1.0" };

/** The cap every drill account (`free`) is held to. */
const FREE_LIMIT = limitsFor("free").keptPages;

function html(marker: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;
}

/** A real auth user + profile, plus a session and an account row to prove the cascade. */
async function makeAccount(): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `e06-011-${id.slice(0, 12)}@kept-e06-011.invalid`;
  await db.insert(user).values({ id, name: "E06-011 deletion drill", email, emailVerified: true });
  await db.insert(profiles).values({ id, email, plan: "free" });
  await db.insert(session).values({
    id: crypto.randomUUID(),
    userId: id,
    token: `e06-011-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
  });
  await db.insert(account).values({
    id: crypto.randomUUID(),
    userId: id,
    providerId: "e06-011-drill",
    accountId: id,
    updatedAt: new Date(),
  });
  createdUsers.add(id);
  return { id, email };
}

interface Published {
  siteId: string;
  slug: string;
  versionId: string;
  objectKey: string;
}

async function publish(profileId: string, marker: string): Promise<Published> {
  const { site } = await publishOwnedPage({ profileId, html: html(marker), publisher });
  createdSlugs.add(site.slug);
  createdSites.add(site.id);
  const [row] = await db
    .select({ versionId: sites.currentVersionId })
    .from(sites)
    .where(eq(sites.id, site.id));
  const versionId = row?.versionId;
  assert.ok(versionId, `published site ${site.id} has no current version`);
  return {
    siteId: site.id,
    slug: site.slug,
    versionId,
    objectKey: pageObjectKey(site.id, versionId),
  };
}

/**
 * `n` kept rows in ONE insert — real rows, with no bytes behind them. For the
 * summary's counts only: nothing here is unwound from the edge, because nothing
 * here was ever on it.
 */
async function seedKept(profileId: string, n: number): Promise<string[]> {
  const rows = Array.from({ length: n }, () => {
    const id = crypto.randomUUID();
    createdSites.add(id);
    return {
      id,
      slug: `e06-011-${id.slice(0, 12)}`,
      ownerId: profileId,
      publisherHash: "e06-011-drill",
      claimedAt: new Date(),
      contentHash: "e06-011",
      sizeBytes: 128,
    };
  });
  await db.insert(sites).values(rows);
  return rows.map((row) => row.id);
}

async function readSite(siteId: string) {
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  assert.ok(row, `site ${siteId} vanished`);
  return row;
}

/** A chosen name `validateName` accepts on a free plan, unique to this run. */
function chosenName(): string {
  const name = `e06-008-ad-${crypto.randomUUID().slice(0, 8)}`;
  createdSlugs.add(name);
  return name;
}

async function holdOf(name: string) {
  const [row] = await db.select().from(nameHolds).where(eq(nameHolds.name, name));
  return row ?? null;
}

function assertGraceFromNow(purgeAfter: Date | null, label: string) {
  assert.ok(purgeAfter, `${label}: purge_after must be set`);
  const expected = Date.now() + DRAFT_GRACE_DAYS * MS_PER_DAY;
  assert.ok(
    Math.abs(purgeAfter.getTime() - expected) < SLACK_MS,
    `${label}: purge_after ${purgeAfter.toISOString()} should be ~DRAFT_GRACE_DAYS from now`,
  );
}

after(async () => {
  if (skip) return;
  const { removeManifest } = await import("../storage/manifest");
  for (const slug of createdSlugs) {
    await removeManifest(slug).catch(() => undefined);
  }
  for (const id of createdSites) {
    const versions = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(eq(siteVersions.siteId, id));
    for (const version of versions) {
      await r2Store()
        .delete(pageObjectKey(id, version.id))
        .catch(() => undefined);
    }
    await db.delete(sites).where(eq(sites.id, id));
  }
  if (createdSlugs.size > 0) {
    await db.delete(nameHolds).where(inArray(nameHolds.name, [...createdSlugs]));
  }
  for (const id of createdUsers) {
    // `profiles`/`session`/`account` all cascade off `user.id`.
    await db.delete(user).where(eq(user.id, id));
  }
  // No resource leak: `postgres-js` holds the pool open and the process would
  // otherwise never exit.
  await closeDb();
});

test(
  "the summary counts what the account really holds, from the kept-ness predicate",
  { skip },
  async () => {
    const owner = await makeAccount();
    const empty = await getAccountDeletionSummary(owner.id);
    assert.deepEqual(empty, { kept: 0, drafts: 0, total: 0 });

    // Fill the cap exactly, then one more so the account holds a real draft.
    // Every slot but the last is seeded; the last is a real publish that must
    // land kept, and the one past it a real publish that must not.
    const kept = await seedKept(owner.id, FREE_LIMIT - 1);
    const last = await publish(owner.id, "e06-011-kept-last");
    assert.equal((await readSite(last.siteId)).expiresAt, null, "the last free slot is kept");
    const draft = await publish(owner.id, "e06-011-draft");
    assert.notEqual(
      (await readSite(draft.siteId)).expiresAt,
      null,
      "publishing at the cap must land an owned DRAFT, never an error",
    );

    const full = await getAccountDeletionSummary(owner.id);
    assert.deepEqual(full, { kept: FREE_LIMIT, drafts: 1, total: FREE_LIMIT + 1 });

    // Quarantine one: a flag is not a deletion, so it still holds its slot (E06
    // task 004's kept predicate).
    await db.update(sites).set({ status: "quarantined" }).where(eq(sites.id, kept[1]!));
    const flagged = await getAccountDeletionSummary(owner.id);
    assert.equal(flagged.kept, FREE_LIMIT, "a quarantined page still holds its slot");
    assert.equal(flagged.drafts, 1);
  },
);

test(
  "deleting an account archives every page with no owner, holds its chosen names with no owner, and leaves the bytes",
  { skip },
  async () => {
    const owner = await makeAccount();
    const bystander = await makeAccount();

    // The shapes an account can be holding when its owner presses delete — all
    // real publishes, so every one has bytes and a pointer to unwind:
    //   · a kept page with a CHOSEN name, and one with a generated name;
    //   · a quarantined page; an owned draft (demoted through the real
    //     primitive) carrying a reminder address;
    //   · a page the owner had already DELETED, with a chosen name (held for
    //     them since) and its own purge_after.
    const named = await publish(owner.id, "e06-008-ad-named");
    const namedName = chosenName();
    await renameSite(named.siteId, owner.id, namedName);
    const generated = await publish(owner.id, "e06-008-ad-generated");
    const flagged = await publish(owner.id, "e06-008-ad-flagged");
    await db.update(sites).set({ status: "quarantined" }).where(eq(sites.id, flagged.siteId));
    const draft = await publish(owner.id, "e06-008-ad-draft");
    await demoteSite(draft.siteId, owner.id);
    await db
      .update(sites)
      .set({ reminderEmail: owner.email })
      .where(eq(sites.id, draft.siteId));
    const gone = await publish(owner.id, "e06-008-ad-gone");
    const goneName = chosenName();
    await renameSite(gone.siteId, owner.id, goneName);
    await deleteSite(gone.siteId, owner.id);
    const goneBefore = await readSite(gone.siteId);
    const goneHoldBefore = await holdOf(goneName);
    assert.equal(goneHoldBefore?.userId, owner.id, "precondition: held for its owner");

    const theirs = await publish(bystander.id, "e06-011-bystander");
    const theirsBefore = await readSite(theirs.siteId);

    const offline = [
      { page: named, slug: namedName },
      { page: generated, slug: generated.slug },
      { page: flagged, slug: flagged.slug },
      { page: draft, slug: draft.slug },
    ];
    const updatedBefore = new Map<string, Date>();
    for (const { page } of offline) {
      updatedBefore.set(page.siteId, (await readSite(page.siteId)).updatedAt);
    }
    const result = accountDeletionResultSchema.parse(await deleteAccount(owner.id));
    assert.equal(result.pagesArchived, offline.length, "the pages this call took offline");

    for (const { page, slug } of offline) {
      const row = await readSite(page.siteId);
      // ── CLAIM 2
      assert.equal(row.status, "archived", `${slug}: owners reach archived; removed is E07's`);
      assertGraceFromNow(row.purgeAfter, slug);
      assert.equal(row.ownerId, null, `${slug}: no owner left`);
      assert.equal(row.reminderEmail, null, `${slug}: nobody left to remind`);
      assert.ok(row.updatedAt > updatedBefore.get(page.siteId)!, `${slug}: the delete moves updated_at`);
      // ── CLAIM 3: the edge is off. The pointer is written and deleted from the
      // same `removeManifest` call as the KV key (`lib/storage/kv` may not be
      // imported outside `manifest.ts`), so its absence is the manifest's.
      assert.equal(await r2Store().get(pointerKey(slug)), null, slug);
      // ── CLAIM 4: the bytes survive. E07 collects them; this path must not.
      assert.notEqual(
        await r2Store().get(page.objectKey),
        null,
        `${slug}'s object is E07's to collect, not this path's`,
      );
    }

    // The page deleted earlier keeps its own deadline and loses its owner.
    const goneAfter = await readSite(gone.siteId);
    assert.equal(goneAfter.status, "archived");
    assert.deepEqual(goneAfter.purgeAfter, goneBefore.purgeAfter, "no second purge_after bump");
    assert.equal(goneAfter.ownerId, null);
    assert.ok(goneAfter.updatedAt > goneBefore.updatedAt, "losing its owner moves updated_at");

    // ── CLAIM 5: names held with no owner; generated names never held.
    const namedHold = await holdOf(namedName);
    assert.ok(namedHold, "a chosen name taken offline is held");
    assert.equal(namedHold.userId, null, "held with no owner (D16)");
    assert.equal(namedHold.reason, "account_deleted");
    assert.equal(namedHold.siteId, named.siteId);
    const goneHold = await holdOf(goneName);
    assert.ok(goneHold);
    assert.equal(goneHold.userId, null, "an earlier hold loses its owner with the account");
    assert.deepEqual(goneHold.heldUntil, goneHoldBefore!.heldUntil, "and keeps its deadline");
    for (const page of [generated, flagged, draft]) {
      assert.equal(await holdOf(page.slug), null, `${page.slug}: a generated name is never held`);
    }

    // ── CLAIM 1, deliberately UNSCOPED: the failure mode is a row nobody can
    // reach by ownership, so a query scoped by owner could not see it.
    const ownerless = await db
      .select({ id: sites.id, slug: sites.slug })
      .from(sites)
      .where(
        and(
          eq(sites.status, "live"),
          isNull(sites.ownerId),
          isNull(sites.anonTokenHash),
          isNull(sites.expiresAt),
        ),
      );
    assert.deepEqual(
      ownerless,
      [],
      "a live page with no owner, no token and no clock is unreachable by any authority in the product",
    );

    // ── CLAIM 6: Better Auth's rows go with the user, so every other device is
    // signed out on its next request, and the same email cannot land back in
    // the old account.
    for (const table of [user, profiles] as const) {
      const rows = await db.select({ id: table.id }).from(table).where(eq(table.id, owner.id));
      assert.deepEqual(rows, []);
    }
    assert.deepEqual(
      await db.select({ id: session.id }).from(session).where(eq(session.userId, owner.id)),
      [],
    );
    assert.deepEqual(
      await db.select({ id: account.id }).from(account).where(eq(account.userId, owner.id)),
      [],
    );
    assert.deepEqual(
      await db.select({ id: user.id }).from(user).where(eq(user.email, owner.email)),
      [],
      "signing in with the same address must build a new account, not resurrect this one",
    );

    // ── CLAIM 7: the other account is exactly as it was.
    assert.deepEqual(await readSite(theirs.siteId), theirsBefore);
    assert.notEqual(await r2Store().get(pointerKey(theirs.slug)), null);
    assert.equal(
      (await db.select({ id: user.id }).from(user).where(eq(user.id, bystander.id))).length,
      1,
    );
  },
);

test("an account with no pages deletes cleanly", { skip }, async () => {
  const owner = await makeAccount();
  const result = await deleteAccount(owner.id);
  assert.equal(result.pagesArchived, 0);
  assert.deepEqual(
    await db.select({ id: user.id }).from(user).where(eq(user.id, owner.id)),
    [],
  );
});

test(
  "the route half refuses any body but the account's own email, and deletes nothing",
  { skip },
  async () => {
    const owner = await makeAccount();
    const other = await makeAccount();
    const page = await publish(owner.id, "e06-008-ad-confirm");
    const before = await readSite(page.siteId);

    for (const body of [
      undefined,
      {},
      { email: "" },
      { email: other.email }, // a real address — just not this account's
      { email: `${owner.email}x` },
      { confirm: "delete my account" }, // the old phrase is not a way in
    ]) {
      const outcome = await deleteOwnAccount(body, owner.id, owner.email);
      assert.equal(outcome.ok, false, JSON.stringify(body));
      assert.equal(outcome.ok === false && outcome.status, 400);
      assert.equal(
        outcome.ok === false && outcome.body.error.message.includes(owner.email),
        false,
        "the refusal never echoes the address",
      );
      // The claim that matters: the page and the account are still there.
      assert.deepEqual(await readSite(page.siteId), before);
    }

    // Trimmed and case-insensitive — the rule `confirmsAccountEmail` states.
    const done = await deleteOwnAccount(
      { email: `  ${owner.email.toUpperCase()} ` },
      owner.id,
      owner.email,
    );
    assert.equal(done.ok, true);
    assert.equal(done.ok === true && done.body.pagesArchived, 1);
    assert.equal((await readSite(page.siteId)).status, "archived");
  },
);
