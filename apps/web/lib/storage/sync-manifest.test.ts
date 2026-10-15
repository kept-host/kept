/**
 * `syncManifest` (E07 D18) and the durable re-purge (§6.14) — AC34's race
 * drills and AC35's replay, against the real dev Postgres, R2, KV and edge.
 *
 * NO MOCKS. Every writer below is the real one (`replaceSite`, `replacePage`,
 * `restoreVersion`, `renameSite`, `keepSite`); every flag is a real committed
 * `UPDATE sites SET status = …` on a second connection (`setStatus` arrives in
 * task 004); every manifest is a real pointer + KV write, read back from the R2
 * pointer (byte-identical to KV by construction) and from the deployed edge.
 *
 * ── HOW EACH RACE IS HELD OPEN, WITHOUT A SLEEP ──────────────────────────────
 * Connection H locks the page's row (`SELECT … FOR UPDATE`, no change). The
 * writer W starts and queues on that row — after its own status check for a
 * replace (which checks without a lock), or for the lock its check runs under
 * (restore, rename, late keep). The drill waits until Postgres SHOWS W waiting
 * behind H, then issues the flag B, and waits until Postgres shows B waiting
 * too. Only then does H let go. Row-lock waiters are served in order, so W
 * passes its check against the row as it was, and B's flag commits before W's
 * manifest is written. The pre-D18 writers wrote `status: "live"` at that point
 * and the edge served the page; through `syncManifest` it serves the row.
 *
 * KV QUOTA (dev is on the free plan, 1k writes + 1k deletes a day): one page per
 * race, about seven KV writes and nine deletes for the whole file.
 *
 * SKIPS when the database or the dev store credentials are absent (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { generateAnonToken, hashToken, REPURGE_MAX_ATTEMPTS, type SiteStatus } from "@kept/shared";
import { config } from "dotenv";
import { eq, inArray, or } from "drizzle-orm";
import postgres from "postgres";

import { closeDb, db } from "../db";
import { insertPendingPurge } from "../db/queries/manifest-sync";
import { pendingPurges, sites, siteVersions } from "../db/schema";
import { renameSite } from "../names/rename";
import { replacePage } from "../publish/anon-manage";
import { keepSite } from "../sites/keep";
import { replaceSite } from "../sites/manage";
import { restoreVersion } from "../sites/restore";
import { NamesDrill } from "../testing/names-drill";

import { pointerKey, removeManifest, syncManifest } from "./manifest";
import { pageObjectKey, r2Store } from "./r2";
import { replayPendingPurge } from "./repurge";

config({ path: ".env.local", quiet: true });

const LIVE_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_AUTO",
  "KV_NAMESPACE_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "KEPT_BASE_DOMAIN",
] as const;
const missing = LIVE_VARS.filter((name) => !process.env[name]);
const skip = missing.length > 0 ? `dev credentials absent (${missing.join(", ")})` : false;

const PROPAGATION_WINDOW_MS = 60_000;
const PROBE_INTERVAL_MS = 3_000;
const LOCK_WAIT_TIMEOUT_MS = 20_000;

const drill = new NamesDrill("e07-003");
/** Every slug a drill may have published, removed again in `after`. */
const slugs = new Set<string>();
const siteIds = new Set<string>();

/** H and B: their own pool, so the app's pool is exactly what the writer sees. */
const side = skip ? null : postgres(process.env.DATABASE_URL!, { prepare: false, max: 3 });

after(async () => {
  if (skip) return;
  for (const slug of slugs) await removeManifest(slug).catch(() => undefined);
  if (siteIds.size > 0) {
    const objects = await db
      .select({ r2Key: siteVersions.r2Key })
      .from(siteVersions)
      .where(inArray(siteVersions.siteId, [...siteIds]));
    for (const { r2Key } of objects) await r2Store().delete(r2Key).catch(() => undefined);
    await db
      .delete(pendingPurges)
      .where(or(inArray(pendingPurges.siteId, [...siteIds]), inArray(pendingPurges.slug, [...slugs])));
  }
  await drill.cleanup();
  await side?.end();
  await closeDb();
});

const html = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1>${marker}</h1></body></html>\n`;

/** A kept, `live`, owned page — tracked for teardown. */
async function ownedPage(options: { kept?: boolean } = {}) {
  const ownerId = await drill.profile();
  const page = await drill.site({ ownerId, kept: options.kept ?? true });
  slugs.add(page.slug);
  siteIds.add(page.id);
  return { ownerId, ...page };
}

/** The manifest the edge reads for `slug` — the R2 pointer, byte-identical to KV. */
async function manifestAt(slug: string): Promise<{ status: string; versionId: string; siteId: string } | null> {
  const body = await r2Store().get(pointerKey(slug));
  return body === null ? null : (JSON.parse(body) as { status: string; versionId: string; siteId: string });
}

/** The edge's answer for `slug`, polled until it is `expected` or the window closes. */
async function edgeStatus(slug: string, expected: number): Promise<number> {
  const url = `https://${slug}.${process.env.KEPT_BASE_DOMAIN}/`;
  const deadline = Date.now() + PROPAGATION_WINDOW_MS;
  for (;;) {
    const res = await fetch(url, { redirect: "manual" });
    await res.body?.cancel();
    if (res.status === expected || Date.now() > deadline) return res.status;
    await sleep(PROBE_INTERVAL_MS);
  }
}

/** Hold the row lock on connection H until `release`. */
async function holdRowLock(siteId: string): Promise<{ pid: number; release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let locked!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => (locked = resolve));
  const done = side!.begin(async (tx) => {
    await tx`select id from sites where id = ${siteId} for update`;
    const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    locked(row!.pid);
    await gate;
  });
  return {
    pid: await Promise.race([pid, done.then(() => Promise.reject(new Error("H ended early")))]),
    release: async () => {
      open();
      await done;
    },
  };
}

/** Wait until `n` backends are queued, directly or transitively, behind `root`. */
async function waitForWaiters(root: number, n: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    const rows = await side!<{ pid: number; blockers: number[] }[]>`
      select pid, pg_blocking_pids(pid) as blockers
        from pg_stat_activity
       where cardinality(pg_blocking_pids(pid)) > 0`;
    const behind = new Set([root]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (!behind.has(row.pid) && row.blockers.some((pid) => behind.has(pid))) {
          behind.add(row.pid);
          grew = true;
        }
      }
    }
    if (behind.size - 1 >= n) return;
    if (Date.now() - started > LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`Only ${behind.size - 1} of ${n} backends queued behind pid ${root}.`);
    }
    await sleep(50);
  }
}

/**
 * THE RACE: W queues on the row, the flag B queues behind it, then the row is
 * released. Returns W's outcome (its result, or the error it threw).
 */
async function race(siteId: string, status: SiteStatus, writer: () => Promise<unknown>): Promise<unknown> {
  const h = await holdRowLock(siteId);
  let w: Promise<unknown> | undefined;
  let b: Promise<unknown> | undefined;
  try {
    w = writer().then(
      (result) => result,
      (err: unknown) => err,
    );
    await waitForWaiters(h.pid, 1);
    b = side!`update sites set status = ${status} where id = ${siteId}`.then(() => null);
    await waitForWaiters(h.pid, 2);
  } finally {
    await h.release();
  }
  await b;
  return w;
}

/** The row, the manifest and the edge all agree on `status`, at the row's version. */
async function assertEdgeMatchesRow(siteId: string, status: SiteStatus, httpStatus: number): Promise<void> {
  const row = await drill.read(siteId);
  assert.equal(row.status, status, "the flag committed");
  const manifest = await manifestAt(row.slug);
  assert.ok(manifest, `no manifest at "${row.slug}"`);
  assert.equal(manifest.status, status, `the manifest must say what the row says (${status}), not a stale "live"`);
  assert.equal(manifest.versionId, row.currentVersionId, "the manifest names the row's version");
  assert.equal(manifest.siteId, siteId);
  assert.equal(await edgeStatus(row.slug, httpStatus), httpStatus, `the edge serves ${httpStatus}`);
}

function assertSucceeded(outcome: unknown): void {
  assert.ok(!(outcome instanceof Error), `the writer itself must succeed: ${outcome instanceof Error ? outcome.message : ""}`);
}

test("AC34: a flag committed during an OWNER replace leaves the edge on 451", { skip }, async () => {
  const page = await ownedPage();
  const outcome = await race(page.id, "under_review", () =>
    replaceSite(page.id, page.ownerId, html("e07-003 owner replace")),
  );
  assertSucceeded(outcome);
  await assertEdgeMatchesRow(page.id, "under_review", 451);
});

test("AC34: expiry committed during an owner replace leaves the edge on 410", { skip }, async () => {
  const page = await ownedPage({ kept: false });
  const outcome = await race(page.id, "expired", () =>
    replaceSite(page.id, page.ownerId, html("e07-003 replace vs expire")),
  );
  assertSucceeded(outcome);
  await assertEdgeMatchesRow(page.id, "expired", 410);
});

test("AC34: a flag committed during an ANONYMOUS replace leaves the edge on 451", { skip }, async () => {
  const page = await ownedPage({ kept: false });
  const token = generateAnonToken();
  await db
    .update(sites)
    .set({ ownerId: null, claimedAt: null, anonTokenHash: await hashToken(token) })
    .where(eq(sites.id, page.id));

  const outcome = await race(page.id, "under_review", () =>
    replacePage(token, { html: html("e07-003 anon replace") }, "api"),
  );
  assert.equal((outcome as { ok?: boolean }).ok, true, `anonymous replace must land: ${JSON.stringify(outcome)}`);
  await assertEdgeMatchesRow(page.id, "under_review", 451);
});

test("AC34: a flag committed during a RESTORE leaves the edge on 451", { skip }, async () => {
  const page = await ownedPage();
  // A previous version with real bytes, written straight to R2 + Postgres: no KV.
  const versionId = crypto.randomUUID();
  const r2Key = pageObjectKey(page.id, versionId);
  await r2Store().put(r2Key, html("e07-003 restore target"), "text/html; charset=utf-8");
  await db.insert(siteVersions).values({
    id: versionId,
    siteId: page.id,
    r2Key,
    contentHash: `e07-003-${versionId}`,
    sizeBytes: 128,
    publishedVia: "studio",
  });

  const outcome = await race(page.id, "under_review", () => restoreVersion(page.id, versionId, page.ownerId));
  assertSucceeded(outcome);
  assert.equal((await drill.read(page.id)).currentVersionId, versionId, "the restore landed");
  await assertEdgeMatchesRow(page.id, "under_review", 451);
});

test("AC34: a flag committed during a RENAME leaves the NEW name on 451", { skip }, async () => {
  const page = await ownedPage();
  const newName = drill.name();
  slugs.add(newName);

  const outcome = await race(page.id, "under_review", () => renameSite(page.id, page.ownerId, newName));
  assertSucceeded(outcome);
  assert.equal((await drill.read(page.id)).slug, newName, "the rename landed");
  await assertEdgeMatchesRow(page.id, "under_review", 451);
  assert.equal(await manifestAt(page.slug), null, "the old name is still removed");
});

test("AC34: a flag committed during a LATE KEEP leaves the edge on 451", { skip }, async () => {
  const page = await ownedPage({ kept: false });
  const day = 24 * 60 * 60 * 1000;
  await db
    .update(sites)
    .set({ status: "expired", expiresAt: new Date(Date.now() - day), purgeAfter: new Date(Date.now() + 10 * day) })
    .where(eq(sites.id, page.id));

  const outcome = await race(page.id, "under_review", () => keepSite(page.id, page.ownerId));
  assertSucceeded(outcome);
  assert.equal((outcome as { restored?: boolean }).restored, true, "a late keep");
  await assertEdgeMatchesRow(page.id, "under_review", 451);
});

test("AC35: a failed KV write leaves a pending_purges row, and repurge brings the edge to the row's CURRENT state", { skip }, async () => {
  const page = await ownedPage();

  // A real KV failure: the KV client re-reads its configuration on every call.
  const prior = process.env.KV_NAMESPACE_ID;
  delete process.env.KV_NAMESPACE_ID;
  let failed;
  try {
    failed = await syncManifest(page.id);
  } finally {
    process.env.KV_NAMESPACE_ID = prior;
  }
  assert.equal(failed.ok, false, "the sync must fail at the KV step");

  const [row] = await db.select().from(pendingPurges).where(eq(pendingPurges.siteId, page.id));
  assert.ok(row, "a failed sync leaves a pending_purges row naming the site");
  assert.ok(row.dueAt.getTime() <= Date.now(), "due now");
  assert.equal(row.attempts, 0);

  // The row moves on before the replay: the edge must end on THIS state.
  await db.update(sites).set({ status: "under_review" }).where(eq(sites.id, page.id));

  assert.equal(await replayPendingPurge(row), "synced");
  await assertEdgeMatchesRow(page.id, "under_review", 451);

  // What the row still owes is the second purge of the write the replay made.
  const [owed] = await db.select().from(pendingPurges).where(eq(pendingPurges.id, row.id));
  assert.ok(owed, "kept for the delayed second purge");
  assert.equal(owed.siteId, null, "its next replay is a purge, not another manifest write");
  assert.ok(owed.dueAt.getTime() > Date.now(), "not due until the KV read cache has turned over");
  assert.deepEqual(owed.urls, [
    `https://${page.slug}.${process.env.KEPT_BASE_DOMAIN}/`,
    `https://${page.slug}.${process.env.KEPT_BASE_DOMAIN}/index.html`,
  ]);
  // Replayed early (a run that overlaps), it purges and waits for the window.
  assert.equal(await replayPendingPurge(owed), "deferred");
});

test("AC35: a replay that keeps failing is counted, and gives up at REPURGE_MAX_ATTEMPTS", { skip }, async () => {
  const page = await ownedPage();
  const id = await insertPendingPurge({ siteId: page.id, slug: page.slug, urls: [], dueAt: new Date() });
  await db.update(pendingPurges).set({ attempts: REPURGE_MAX_ATTEMPTS - 2 }).where(eq(pendingPurges.id, id));

  const prior = process.env.KV_NAMESPACE_ID;
  delete process.env.KV_NAMESPACE_ID;
  try {
    const read = async () => (await db.select().from(pendingPurges).where(eq(pendingPurges.id, id)))[0]!;
    assert.equal(await replayPendingPurge(await read()), "failed");
    const once = await read();
    assert.equal(once.attempts, REPURGE_MAX_ATTEMPTS - 1);
    assert.match(once.lastError ?? "", /^sync: kv/);
    assert.ok(once.dueAt.getTime() > Date.now(), "retried later, not again this run");

    assert.equal(await replayPendingPurge(once), "gave_up");
    assert.equal((await read()).attempts, REPURGE_MAX_ATTEMPTS, "kept for a human, never selected again");
  } finally {
    process.env.KV_NAMESPACE_ID = prior;
  }
  // The non-durable replay sync recorded no second row of its own.
  const rows = await db.select().from(pendingPurges).where(eq(pendingPurges.siteId, page.id));
  assert.equal(rows.length, 1, "a failed replay must not spawn a new row");
});
