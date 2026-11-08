/**
 * E10 task 005 — `resyncOwnerPages` (Q4): a profile change the badge shows
 * queues one `pending_purges` re-sync per KEPT page the owner serves, in one
 * statement, and nothing inline. Against the real dev Postgres; no store is
 * touched (the `repurge` job is what writes KV, and it is not run here).
 *
 * The rows are dropped inside each test as soon as they are asserted, so the
 * dev `repurge` cron cannot replay them against the drill's version-less rows.
 *
 * SKIPS without `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL absent — run locally with apps/web/.env.local";

const siteIds = new Set<string>();
let drill: import("../testing/names-drill").NamesDrill | null = null;

async function names() {
  const { NamesDrill } = await import("../testing/names-drill");
  drill ??= new NamesDrill("e10-005");
  return drill;
}

after(async () => {
  if (skip) return;
  const { clearPendingPurges } = await import("../testing/pending-purges");
  const { closeDb } = await import("../db");
  await clearPendingPurges([], siteIds);
  await drill?.cleanup();
  await closeDb();
});

test("resyncOwnerPages queues the owner's served KEPT pages only — once — with no URLs, due now", { skip }, async () => {
  const { resyncOwnerPages } = await import("./fan-out");
  const { db } = await import("../db");
  const { pendingPurges } = await import("../db/schema");
  const { inArray } = await import("drizzle-orm");
  const d = await names();

  const owner = await d.profile();
  const stranger = await d.profile();
  const live = await d.site({ ownerId: owner });
  const reviewed = await d.site({ ownerId: owner, status: "under_review" });
  const draft = await d.site({ ownerId: owner, kept: false });
  const archived = await d.site({ ownerId: owner, status: "archived" });
  const quarantined = await d.site({ ownerId: owner, status: "quarantined" });
  const theirs = await d.site({ ownerId: stranger });
  for (const site of [live, reviewed, draft, archived, quarantined, theirs]) siteIds.add(site.id);

  const before = Date.now();
  assert.equal(await resyncOwnerPages(owner), 2, "the live and the under_review kept page");

  const rows = await db.select().from(pendingPurges).where(inArray(pendingPurges.siteId, [...siteIds]));
  assert.deepEqual(rows.map((row) => row.siteId).sort(), [live.id, reviewed.id].sort());
  for (const row of rows) {
    assert.deepEqual(row.urls, [], "a re-sync: the replay derives the URLs from the site");
    assert.equal(row.slug, row.siteId === live.id ? live.slug : reviewed.slug, "the slug the replay purges under");
    assert.ok(row.dueAt.getTime() <= Date.now() && row.dueAt.getTime() >= before - 60_000, "due now");
    assert.equal(row.attempts, 0);
  }

  assert.equal(await resyncOwnerPages(owner), 0, "a page already queued is not queued again");
  assert.equal(await resyncOwnerPages(stranger), 1, "another owner's pages are theirs alone");

  await db.delete(pendingPurges).where(inArray(pendingPurges.siteId, [...siteIds]));
});

test("admin:badge-backfill refuses a bad invocation before touching the database", { skip }, async () => {
  const { runAdmin } = await import("../admin/cli");
  const io = { out: () => undefined, info: () => undefined };
  await assert.rejects(runAdmin(["badge-backfill", "--limit", "0"], io), /--limit must be a positive whole number/);
  await assert.rejects(runAdmin(["badge-backfill", "--apply"], io), /admin:badge-backfill \[--limit <n>\]/);
});
