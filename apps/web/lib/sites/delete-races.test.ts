/**
 * AC42 (Arun 2026-10-15, decisions 1–2) — the three deletes, against the real
 * dev Postgres, R2, KV and edge.
 *
 *   · Edge first, then the row change under the lock with its status
 *     re-checked, then a trailing `syncManifest` whether the row change
 *     committed or was refused: a writer that re-publishes the manifest between
 *     the edge removal and the row change ends with the edge matching the row.
 *   · A flagged page is never deleted: anonymous delete answers the uniform 404
 *     for `under_review`, `quarantined` and `removed`, and moves nothing.
 *
 * NO MOCKS. The deletes are the real ones (`deleteSite`, `deletePage`,
 * `deleteAccount`); the interleaved writers are a real `writeManifest` and a
 * real committed flag on a second connection.
 *
 * ── HOW EACH RACE IS HELD OPEN, WITHOUT A SLEEP ──────────────────────────────
 * Connection H takes the lock the delete's row change needs — the owner's
 * `profiles` row (`lockOwner`) for the owner and account deletes, the site row
 * for the anonymous one — BEFORE the delete starts. The delete takes the page
 * off the edge (no lock needed) and then queues behind H. The drill waits until
 * Postgres SHOWS it waiting — so the edge removal has returned — then runs the
 * interleaved writer, and only then lets H go.
 *
 * KV QUOTA (dev is on the free plan): one page per race, about four KV writes
 * and seven deletes for the whole file. Every row, hold and `pending_purges`
 * row it creates is deleted in `after`.
 *
 * SKIPS when the database or the dev store credentials are absent (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { generateAnonToken, hashToken, type SiteStatus } from "@kept/shared";
import { config } from "dotenv";
import { eq } from "drizzle-orm";

import { closeDb, db } from "../db";
import { archiveSite } from "../db/queries/publish";
import { sites } from "../db/schema";
import { deletePage } from "../publish/anon-manage";
import { notFound } from "../publish/anon-token";
import { removeManifest, syncManifest, writeManifest } from "../storage/manifest";
import { edgeStatus, liveSkip, LockDrill, manifestAt, settle } from "../testing/lock-drill";
import { NamesDrill } from "../testing/names-drill";
import { clearPendingPurges } from "../testing/pending-purges";

import { deleteAccount } from "./account-deletion";
import { managementRefusal } from "./display";
import { deleteSite } from "./manage";
import { StudioRefusal } from "./studio-refusal";

config({ path: ".env.local", quiet: true });

const skip = liveSkip();
const skipDb = process.env.DATABASE_URL ? false : "DATABASE_URL absent — run locally with apps/web/.env.local";

const drill = new NamesDrill("e07-008d");
const slugs = new Set<string>();
const siteIds = new Set<string>();

const locks = skipDb ? null : new LockDrill();

after(async () => {
  if (skipDb) return;
  if (!skip) for (const slug of slugs) await removeManifest(slug).catch(() => undefined);
  if (siteIds.size > 0) {
    await clearPendingPurges(slugs, siteIds);
  }
  await drill.cleanup();
  await locks?.end();
  await closeDb();
});

/** A `live` page owned by a fresh account, with its manifest on the edge. */
async function servedPage(options: { kept?: boolean } = {}) {
  const ownerId = await drill.profile();
  const page = await drill.site({ ownerId, kept: options.kept ?? true });
  slugs.add(page.slug);
  siteIds.add(page.id);
  const synced = await syncManifest(page.id);
  assert.ok(synced.ok, "precondition: the page is on the edge");
  return { ownerId, ...page };
}

/** The same, as an anonymous draft reachable by a bearer token. */
async function anonPage(status: SiteStatus = "live") {
  const ownerId = await drill.profile();
  const page = await drill.site({ ownerId, kept: false, status });
  siteIds.add(page.id);
  const token = generateAnonToken();
  await db
    .update(sites)
    .set({ ownerId: null, claimedAt: null, anonTokenHash: await hashToken(token) })
    .where(eq(sites.id, page.id));
  return { ...page, token };
}

/** The stale writer: a `live` manifest put back for a page that is coming down. */
async function republishLive(siteId: string): Promise<void> {
  const row = await drill.read(siteId);
  const written = await writeManifest(row.slug, {
    siteId: row.id,
    versionId: row.currentVersionId!,
    status: "live",
    region: row.region,
    ownerId: row.ownerId,
    updatedAt: Date.now(),
  });
  assert.ok(written.ok, "the stale writer's manifest landed");
  assert.equal((await manifestAt(row.slug))?.status, "live", "precondition: the edge says live again");
}

test("AC42 owner delete: a stale manifest re-published mid-delete is taken down by the trailing sync", { skip }, async () => {
  const page = await servedPage();
  const h = await locks!.hold("profiles", page.ownerId);
  let w: Promise<unknown> | undefined;
  try {
    w = settle(deleteSite(page.id, page.ownerId));
    await locks!.waitForWaiters(h.pid);
    assert.equal(await manifestAt(page.slug), null, "edge first: the manifest is gone before the row moves");
    await republishLive(page.id);
  } finally {
    await h.release();
  }
  const outcome = await w;
  assert.ok(!(outcome instanceof Error), `the delete succeeds: ${String(outcome)}`);
  assert.equal((await drill.read(page.id)).status, "archived");
  assert.equal(await manifestAt(page.slug), null, "the edge matches the row: no manifest for an archived page");
});

test("AC42 owner delete: a flag committed mid-delete is refused under the lock and re-published as 451", { skip }, async () => {
  const page = await servedPage();
  const h = await locks!.hold("profiles", page.ownerId);
  let w: Promise<unknown> | undefined;
  try {
    w = settle(deleteSite(page.id, page.ownerId));
    await locks!.waitForWaiters(h.pid);
    assert.equal(await manifestAt(page.slug), null, "edge first");
    // The flag commits while the delete waits for the owner lock.
    await db.update(sites).set({ status: "under_review" }).where(eq(sites.id, page.id));
  } finally {
    await h.release();
  }
  const outcome = await w;
  assert.ok(outcome instanceof StudioRefusal, `refused: ${String(outcome)}`);
  assert.equal(outcome.code, "not_allowed_in_status");
  assert.equal(outcome.message, managementRefusal("under_review"));
  assert.equal((await drill.read(page.id)).status, "under_review", "the re-check refused the archive");
  assert.equal((await manifestAt(page.slug))?.status, "under_review", "the trailing sync re-published the flag");
  assert.equal(await edgeStatus(page.slug, 451), 451, "the edge serves the suspended page");
});

test("AC42 anonymous delete: a flag committed mid-delete leaves the row flagged, the edge on 451, and answers 404", { skip }, async () => {
  const page = await anonPage();
  slugs.add(page.slug);
  assert.ok((await syncManifest(page.id)).ok, "precondition: the page is on the edge");

  const h = await locks!.hold("sites", page.id);
  let w: Promise<unknown> | undefined;
  try {
    w = settle(deletePage(page.token));
    await locks!.waitForWaiters(h.pid);
    assert.equal(await manifestAt(page.slug), null, "edge first");
  } finally {
    // The flag commits in H's transaction, ahead of the delete's guarded UPDATE.
    await h.release("under_review");
  }
  const outcome = await w;
  assert.deepEqual(outcome, notFound(), "a flagged page is the uniform 404");
  assert.equal((await drill.read(page.id)).status, "under_review", "archiveSite's guard refused the row");
  assert.equal((await manifestAt(page.slug))?.status, "under_review", "the trailing sync re-published the flag");
  assert.equal(await edgeStatus(page.slug, 451), 451);
});

test("AC42 account deletion: a stale manifest re-published mid-deletion is taken down by the trailing sync", { skip }, async () => {
  const page = await servedPage();
  const h = await locks!.hold("profiles", page.ownerId);
  let w: Promise<unknown> | undefined;
  try {
    w = settle(deleteAccount(page.ownerId));
    await locks!.waitForWaiters(h.pid);
    assert.equal(await manifestAt(page.slug), null, "edge first: the unwind ran");
    await republishLive(page.id);
  } finally {
    await h.release();
  }
  const outcome = await w;
  assert.deepEqual(outcome, { pagesArchived: 1 });
  const row = await drill.read(page.id);
  assert.equal(row.status, "archived");
  assert.equal(row.ownerId, null);
  assert.equal(await manifestAt(page.slug), null, "the edge matches the row");
});

test("anonymous delete refuses every flagged status with the uniform 404 and moves nothing (decision 2)", { skip: skipDb }, async () => {
  for (const status of ["under_review", "quarantined", "removed"] as const) {
    const page = await anonPage(status);
    const before = await drill.read(page.id);
    assert.deepEqual(await deletePage(page.token), notFound(), `${status}: the uniform 404`);
    assert.deepEqual(await drill.read(page.id), before, `${status}: the row is untouched`);
    // The query layer refuses on its own too: the guard is in the WHERE.
    assert.equal(await archiveSite(page.id), false, `${status}: archiveSite moves no flagged row`);
    assert.deepEqual(await drill.read(page.id), before);
  }

  // An archived page is still the idempotent success, with no store call.
  const archived = await anonPage("archived");
  assert.deepEqual(await deletePage(archived.token), { ok: true, status: 200, body: { ok: true } });
});
