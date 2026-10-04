/**
 * Account deletion against the REAL dev stack — E06 task 011, decision **D3**.
 *
 * NO MOCKS. Every page the teardown unwinds is published through
 * `publishOwnedPage` — the same function `POST /api/sites` calls — so the R2
 * object, the slug pointer and the KV manifest all genuinely exist before the
 * teardown unwinds them. The rows are read back from Postgres afterwards,
 * because "it returned 200" and "the row is in the state E07 will find" are
 * different claims and only the second matters.
 *
 * The one exception is the summary drill's cap: filling `limitsFor("free")`
 * kept slots by publishing would be dozens of R2/KV round trips proving nothing
 * the counts need, so all but the last slot are real rows seeded by direct
 * insert (`seedKept`). The last slot and the draft past it are still published.
 *
 * ── THE FIVE CLAIMS ──────────────────────────────────────────────────────────
 *
 *  1. **No ownerless live page.** `status = 'live' AND owner_id IS NULL AND
 *     anon_token_hash IS NULL AND expires_at IS NULL` returns zero rows —
 *     verification criterion 13, and the query the FK's `SET NULL` would
 *     silently fail. It is asserted globally, not scoped to this test's rows:
 *     the whole point is that such a row is undiscoverable by ownership.
 *  2. **Every page is sweepable.** `status = 'removed'` with a non-null
 *     `purge_after`, which is exactly what E07's daily purge selects on
 *     (`status IN (expired, removed) AND purge_after < now()`).
 *  3. **The edge is off.** The slug pointer is gone for every affected slug.
 *  4. **R2 objects are STILL PRESENT, and that is correct.** Asserted, so a
 *     future change that starts deleting them here is caught by this file
 *     rather than by E07 discovering it has nothing left to collect.
 *  5. **Another account is untouched** — row, pointer and object. A `WHERE`
 *     that forgot the owner scope here would be catastrophic and silent.
 *
 * SKIPS without dev credentials: CI runs `pnpm test` on fork PRs with no cloud
 * secrets. Run locally with `pnpm --filter @kept/web test:unit`.
 *
 * Every row, object and pointer created here is cleaned up in `after` — the
 * deleted account's site rows survive the teardown (that is the point), and
 * their `owner_id` is null by then, so cleanup tracks ids rather than owners.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  accountDeletionResultSchema,
  limitsFor,
} from "@kept/shared";
import { config } from "dotenv";
import { and, eq, isNull } from "drizzle-orm";

import { closeDb, db } from "../db";
import { archiveSite } from "../db/queries/publish";
import { account, profiles, session, siteVersions, sites, user } from "../db/schema";
import { pointerKey } from "../storage/manifest";
import { pageObjectKey, r2Store } from "../storage/r2";

import { deleteAccount, getAccountDeletionSummary } from "./account-deletion";
import { demoteSite } from "./keep";
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
    assert.deepEqual(empty, {
      kept: 0,
      drafts: 0,
      total: 0,
      confirmationPhrase: ACCOUNT_DELETION_CONFIRMATION,
    });

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
    assert.deepEqual(full, {
      kept: FREE_LIMIT,
      drafts: 1,
      total: FREE_LIMIT + 1,
      confirmationPhrase: ACCOUNT_DELETION_CONFIRMATION,
    });

    // Archive one and quarantine another. The archived page leaves the QUOTA;
    // the quarantined one still holds its slot (a flag is not a deletion — E06
    // task 004's kept predicate). Both stay in `total`, because both rows are
    // still this account's and both will be destroyed. That is why
    // `kept + drafts` does not have to equal `total`.
    await archiveSite(kept[0]!);
    await db.update(sites).set({ status: "quarantined" }).where(eq(sites.id, kept[1]!));

    const mixed = await getAccountDeletionSummary(owner.id);
    assert.equal(mixed.kept, FREE_LIMIT - 1, "an archived page is not kept; a quarantined one still is");
    assert.equal(mixed.drafts, 1);
    assert.equal(mixed.total, FREE_LIMIT + 1, "every row is still destroyed");
  },
);

test(
  "deleting an account removes every page from the edge, marks it for E07, and leaves the bytes",
  { skip },
  async () => {
    const owner = await makeAccount();
    const bystander = await makeAccount();

    // Kept pages, a draft, an archived page and a quarantined page — the four
    // shapes an account can be holding when its owner presses delete. All four
    // are real publishes, so every one has bytes and a pointer to unwind; the
    // draft is a kept page DEMOTED through the real primitive, so the shape does
    // not depend on filling the account to its cap first.
    const keptPages: Published[] = [];
    for (const shape of ["archived", "quarantined", "kept"]) {
      keptPages.push(await publish(owner.id, `e06-011-mix-${shape}`));
    }
    const draft = await publish(owner.id, "e06-011-mix-draft");
    await demoteSite(draft.siteId, owner.id);
    await archiveSite(keptPages[0]!.siteId);
    await db
      .update(sites)
      .set({ status: "quarantined" })
      .where(eq(sites.id, keptPages[1]!.siteId));

    const theirs = await publish(bystander.id, "e06-011-bystander");
    const theirsBefore = await readSite(theirs.siteId);

    const doomed = [...keptPages, draft];
    const result = accountDeletionResultSchema.parse(await deleteAccount(owner.id));
    assert.equal(result.pagesRemoved, doomed.length);
    assert.equal(result.status, "removed");

    for (const page of doomed) {
      const row = await readSite(page.siteId);
      // ── CLAIM 2: sweepable, in exactly the state E07's purge selects on.
      assert.equal(row.status, "removed", `${page.slug} must be removed, never archived`);
      assert.notEqual(row.purgeAfter, null, `${page.slug} must carry a purge deadline`);
      assert.ok(
        row.purgeAfter!.getTime() <= Date.now(),
        `${page.slug}'s deadline must already be in the past — nobody is left to offer a download to`,
      );
      // The FK's `SET NULL` fired, and it is harmless now.
      assert.equal(row.ownerId, null);

      // ── CLAIM 3: the edge is off. The pointer is written and deleted from the
      // same `removeManifest` call as the KV key (`lib/storage/kv` may not be
      // imported outside `manifest.ts`), so its absence is the manifest's.
      assert.equal(await r2Store().get(pointerKey(page.slug)), null, page.slug);

      // ── CLAIM 4: the bytes survive. E07 collects them; this path must not.
      assert.notEqual(
        await r2Store().get(page.objectKey),
        null,
        `${page.slug}'s object is E07's to collect, not this path's`,
      );
    }

    // ── CLAIM 1, criterion 13. Deliberately UNSCOPED: the failure mode is a row
    // nobody can reach by ownership, so a query scoped by owner could not see it.
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

    // Better Auth's rows go with the user, so the same email cannot land back in
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

    // ── CLAIM 5: the other account is exactly as it was.
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
  assert.equal(result.pagesRemoved, 0);
  assert.deepEqual(
    await db.select({ id: user.id }).from(user).where(eq(user.id, owner.id)),
    [],
  );
});

test(
  "the route half refuses a body without the typed phrase, and deletes nothing",
  { skip },
  async () => {
    const owner = await makeAccount();
    const page = await publish(owner.id, "e06-011-confirm");
    const before = await readSite(page.siteId);

    for (const body of [
      undefined,
      {},
      { confirm: "" },
      { confirm: "Delete My Account" }, // exact match, deliberately case-sensitive
      { confirm: `${ACCOUNT_DELETION_CONFIRMATION} ` }, // no trim, deliberately
      { confirm: "yes" },
    ]) {
      const outcome = await deleteOwnAccount(body, owner.id);
      assert.equal(outcome.ok, false, JSON.stringify(body));
      assert.equal(outcome.ok === false && outcome.status, 400);
      // The claim that matters: the page and the account are still there.
      assert.deepEqual(await readSite(page.siteId), before);
    }

    const done = await deleteOwnAccount({ confirm: ACCOUNT_DELETION_CONFIRMATION }, owner.id);
    assert.equal(done.ok, true);
    assert.equal(done.ok === true && done.body.status, "removed");
    assert.equal((await readSite(page.siteId)).status, "removed");
  },
);
