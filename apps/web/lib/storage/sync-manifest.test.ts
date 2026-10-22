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
 * The batch replay's alert (task 012) goes to Resend's test inbox: this process
 * sets its own `KEPT_ADMIN_EMAILS`, so no drill ever mails a real admin.
 *
 * SKIPS when the database or the dev store credentials are absent (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { generateAnonToken, hashToken, REPURGE_MAX_ATTEMPTS, type SiteStatus } from "@kept/shared";
import { config } from "dotenv";
import { and, eq, gte, inArray } from "drizzle-orm";
import postgres from "postgres";

import { closeDb, db } from "../db";
import { insertPendingPurge } from "../db/queries/manifest-sync";
import { insertVersionFiles, siteObjectKeys } from "../db/queries/version-files";
import { pendingPurges, sites, siteVersions } from "../db/schema";
import { renameSite } from "../names/rename";
import { replacePage } from "../publish/anon-manage";
import { keepSite } from "../sites/keep";
import { replaceSite } from "../sites/manage";
import { restoreVersion } from "../sites/restore";
import { NamesDrill } from "../testing/names-drill";
import { clearPendingPurges } from "../testing/pending-purges";

import {
  KV_REPURGE_DELAY_MS,
  pointerKey,
  purgeOwedUrls,
  removeManifest,
  setPurgeUrls,
  syncManifest,
} from "./manifest";
import { pageObjectKey, r2Store, siteObjectKey } from "./r2";
import { replayDue, replayPendingPurge } from "./repurge";

config({ path: ".env.local", quiet: true });
process.env.KEPT_ADMIN_EMAILS = `delivered+e07-012-admin-${crypto.randomUUID().slice(0, 8)}@resend.dev`;
const mailOn = Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim());

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
    const keys = new Set(objects.map((object) => object.r2Key));
    for (const id of siteIds) for (const key of await siteObjectKeys(db, id)) keys.add(key);
    await r2Store().deleteMany([...keys]).catch(() => undefined);
    await clearPendingPurges(slugs, siteIds);
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

test("AC35 (batch): one replay run purges, defers and gives up row by row, sends ONE alert, and a second run finds nothing", { skip }, async () => {
  const page = await ownedPage();
  const settled = new Date(Date.now() - KV_REPURGE_DELAY_MS - 1_000);
  // Owes one purge and is past the KV read cache's turnover: purged and deleted.
  const done = await insertPendingPurge({ siteId: null, slug: page.slug, urls: [], dueAt: new Date() });
  await db.update(pendingPurges).set({ createdAt: settled }).where(eq(pendingPurges.id, done));
  // Owes one purge of a write just made: purged, then deferred until it settles.
  const fresh = await insertPendingPurge({ siteId: null, slug: page.slug, urls: [], dueAt: new Date() });
  // A sync that keeps failing, on its last attempt: gives up and is alerted.
  const stuck = await insertPendingPurge({ siteId: page.id, slug: page.slug, urls: [], dueAt: new Date() });
  await db.update(pendingPurges).set({ attempts: REPURGE_MAX_ATTEMPTS - 1 }).where(eq(pendingPurges.id, stuck));
  const scope = [done, fresh, stuck];

  // A real KV failure for the sync; the purges never touch KV.
  const prior = process.env.KV_NAMESPACE_ID;
  delete process.env.KV_NAMESPACE_ID;
  let first;
  try {
    first = await replayDue(scope);
  } finally {
    process.env.KV_NAMESPACE_ID = prior;
  }
  console.log(`[repurge] batch → ${JSON.stringify(first)}`);
  assert.deepEqual(first, {
    synced: 0,
    purged: 1,
    deferred: 1,
    failed: 0,
    gave_up: 1,
    alert: mailOn ? "sent" : "failed",
  });

  const rows = await db.select().from(pendingPurges).where(inArray(pendingPurges.id, scope));
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.has(done), false, "a purge that landed after the window is deleted");
  const deferred = byId.get(fresh);
  assert.ok(deferred, "a purge inside the window is kept for its second purge");
  assert.equal(deferred.attempts, 0, "deferring is not a failure");
  assert.ok(deferred.dueAt.getTime() > Date.now(), "due once the window has passed");
  const gaveUp = byId.get(stuck);
  assert.ok(gaveUp, "a row that gave up stays for a human");
  assert.equal(gaveUp.attempts, REPURGE_MAX_ATTEMPTS);
  assert.match(gaveUp.lastError ?? "", /^sync: kv/);

  // Idempotent: nothing it touched is due again, and nothing gave up twice.
  assert.deepEqual(await replayDue(scope), { synced: 0, purged: 0, deferred: 0, failed: 0, gave_up: 0, alert: null });
});

// ── E08 D14: the file set ──────────────────────────────────────────────────────
// ONE scratch page walks through every sync case in order (KV budget: five
// manifest writes and three deletes for the lot). Each step's `pending_purges`
// rows are the record of what it purged: written before the first call and
// still there for 125 s, so a step reads the rows it created.

type SetFiles = Record<string, string>;

const multi = {
  page: null as null | { id: string; slug: string; ownerId: string },
  /** The name the page answered at before the rename step. */
  formerSlug: "",
  /** `version name → id`, and the paths each holds. */
  versions: new Map<string, { id: string; paths: string[] }>(),
};

/** A version of the scratch page: every file in R2, the rows in Postgres. No KV. */
async function setVersion(name: string, files: SetFiles, flags: { spa?: boolean; has404?: boolean } = {}) {
  const page = multi.page!;
  const id = crypto.randomUUID();
  const entries = Object.entries(files);
  for (const [path, body] of entries) {
    await r2Store().put(siteObjectKey(page.id, id, path), body, path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain");
  }
  const sha = async (body: string) =>
    Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("hex");
  await db.insert(siteVersions).values({
    id,
    siteId: page.id,
    r2Key: siteObjectKey(page.id, id, "index.html"),
    contentHash: `e08-005-${id}`,
    sizeBytes: entries.reduce((n, [, body]) => n + body.length, 0),
    publishedVia: "studio",
    fileCount: entries.length,
    spa: flags.spa ?? false,
    has404: flags.has404 ?? false,
  });
  await insertVersionFiles(
    db,
    id,
    await Promise.all(entries.map(async ([path, body]) => ({ path, sizeBytes: body.length, sha256: await sha(body) }))),
  );
  const paths = entries.map(([path]) => path).sort();
  multi.versions.set(name, { id, paths });
  return { id, paths };
}

/** Point the page at a version, as a replace's commit does. */
async function pointAt(versionId: string): Promise<void> {
  await db.update(sites).set({ currentVersionId: versionId }).where(eq(sites.id, multi.page!.id));
}

/** The `pending_purges` rows `slug` gained since `since`, oldest first. */
async function rowsSince(slug: string, since: Date) {
  const rows = await db
    .select()
    .from(pendingPurges)
    .where(and(eq(pendingPurges.slug, slug), gte(pendingPurges.createdAt, since)));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

const sorted = (urls: unknown) => [...(urls as string[])].sort();

/** Poll one URL of the scratch page until `done(status, body, cacheControl)` or the window closes. */
async function pollEdge(
  path: string,
  done: (seen: { status: number; body: string; cacheControl: string }) => boolean,
  windowMs = KV_REPURGE_DELAY_MS + 30_000,
) {
  const url = `https://${multi.page!.slug}.${process.env.KEPT_BASE_DOMAIN}/${path}`;
  const deadline = Date.now() + windowMs;
  for (;;) {
    const res = await fetch(url, { redirect: "manual" });
    const seen = { status: res.status, body: await res.text(), cacheControl: res.headers.get("cache-control") ?? "" };
    if (done(seen) || Date.now() > deadline) return seen;
    await sleep(PROBE_INTERVAL_MS);
  }
}

test("E08: a single-file sync writes the dev-v0.8.0 manifest, byte for byte, and purges only / and /index.html", { skip }, async () => {
  const ownerId = await drill.profile();
  const page = await drill.site({ ownerId, kept: true });
  slugs.add(page.slug);
  siteIds.add(page.id);
  multi.page = { ...page, ownerId };

  const v1 = await setVersion("v1", { "index.html": html("e08-005 v1") });
  await pointAt(v1.id);
  const since = new Date();
  const synced = await syncManifest(page.id);
  assert.equal(synced.ok, true, JSON.stringify(synced));

  const body = (await r2Store().get(pointerKey(page.slug)))!;
  const { updatedAt } = JSON.parse(body) as { updatedAt: number };
  // The literal dev-v0.8.0 wrote, in its key order: no `spa`, no `has404`.
  assert.equal(
    body,
    JSON.stringify({ siteId: page.id, versionId: v1.id, status: "live", region: "auto", ownerId, updatedAt }),
  );

  const rows = await rowsSince(page.slug, since);
  assert.equal(rows.length, 1, "one batch, one row");
  assert.deepEqual(rows[0]!.urls, setPurgeUrls(page.slug, []), "the dev-v0.8.0 purge list");
  assert.equal(rows[0]!.siteId, page.id);
});

test("E08 AC25: replacing a 3-file set with a 2-file set — the removed path stops serving, a changed file serves new bytes, one manifest write", { skip }, async () => {
  const page = multi.page;
  assert.ok(page, "runs after the single-file step");

  const v1 = multi.versions.get("v1")!;
  const v2 = await setVersion("v2", {
    "index.html": html("e08-005 v2"),
    "a.css": "/* e08-005 v2 css */",
    "old.js": "/* e08-005 v2 old */",
  });
  await pointAt(v2.id);
  assert.equal((await syncManifest(page.id, { alsoPurgeVersionId: v1.id })).ok, true);

  // Arm the drill: every file of v2 served FROM KV, so it sits in the Cache API for a year.
  for (const [path, marker] of [["a.css", "v2 css"], ["old.js", "v2 old"]] as const) {
    const seen = await pollEdge(path, (s) => s.status === 200 && s.body.includes(marker) && s.cacheControl.includes("s-maxage=31536000"));
    assert.equal(seen.status, 200, `${path} must serve before the replace`);
    assert.match(seen.body, new RegExp(marker));
    assert.match(seen.cacheControl, /s-maxage=31536000\b/, `${path} must be cached from the KV path`);
  }

  // THE REPLACE (hand-pointed — the public route lands in task 004).
  const v3 = await setVersion("v3", { "index.html": html("e08-005 v3"), "a.css": "/* e08-005 v3 css */" }, { spa: true, has404: true });
  await pointAt(v3.id);
  const since = new Date();
  assert.equal((await syncManifest(page.id, { alsoPurgeVersionId: v2.id })).ok, true);

  const rows = await rowsSince(page.slug, since);
  assert.equal(rows.length, 1, "ONE manifest write, one batch of purges");
  assert.deepEqual(sorted(rows[0]!.urls), sorted(setPurgeUrls(page.slug, [...v2.paths, ...v3.paths])), "old ∪ new");
  assert.ok((rows[0]!.urls as string[]).some((url) => url.endsWith("/old.js")), "the removed path is purged");

  const manifest = JSON.parse((await r2Store().get(pointerKey(page.slug)))!) as Record<string, unknown>;
  assert.equal(manifest.versionId, v3.id);
  assert.equal(manifest.spa, true, "the flags are the new version's");
  assert.equal(manifest.has404, true);

  const gone = await pollEdge("old.js", (s) => s.status !== 200);
  assert.notEqual(gone.status, 200, `old.js still served ${gone.status} after the purge window — the removed path was not purged`);
  assert.doesNotMatch(gone.body, /v2 old/);
  const changed = await pollEdge("a.css", (s) => s.status === 200 && s.body.includes("v3 css"));
  assert.match(changed.body, /v3 css/, "the changed file serves its new bytes");
});

test("E08 AC27: restore re-serves a multi-file version with ITS flags, purging both sets", { skip }, async () => {
  const page = multi.page!;
  const v2 = multi.versions.get("v2")!;
  const v3 = multi.versions.get("v3")!;

  const since = new Date();
  const restored = await restoreVersion(page.id, v2.id, page.ownerId);
  assert.equal(restored.unchanged, false);

  const manifest = JSON.parse((await r2Store().get(pointerKey(page.slug)))!) as Record<string, unknown>;
  assert.equal(manifest.versionId, v2.id);
  assert.equal("spa" in manifest, false, "v2 has no SPA flag — omitted, not false");
  assert.equal("has404" in manifest, false);

  const rows = await rowsSince(page.slug, since);
  assert.equal(rows.length, 1);
  assert.deepEqual(sorted(rows[0]!.urls), sorted(setPurgeUrls(page.slug, [...v2.paths, ...v3.paths])), "restored ∪ replaced");
});

test("E08: rename purges the OLD hostname's whole set", { skip }, async () => {
  const page = multi.page!;
  const v2 = multi.versions.get("v2")!;
  const newName = drill.name();
  slugs.add(newName);

  const since = new Date();
  await renameSite(page.id, page.ownerId, newName);
  const old = await rowsSince(page.slug, since);
  assert.equal(old.length, 1);
  assert.deepEqual(old[0]!.urls, setPurgeUrls(page.slug, v2.paths), "every path of the set, at the old host");
  assert.equal(old[0]!.siteId, page.id, "the replay re-syncs the page");
  assert.equal(await r2Store().get(pointerKey(page.slug)), null, "the old name is unpublished");
  const renamed = await rowsSince(newName, since);
  assert.deepEqual(renamed[0]!.urls, setPurgeUrls(newName, v2.paths));
  multi.formerSlug = page.slug;
  multi.page = { ...page, slug: newName };
});

test("E08: the unserve branch purges the set, and a replayed row with no URLs derives them from site_version_files", { skip }, async () => {
  const page = multi.page!;
  const v2 = multi.versions.get("v2")!;
  await db.update(sites).set({ status: "archived" }).where(eq(sites.id, page.id));

  const since = new Date();
  const synced = await syncManifest(page.id);
  assert.deepEqual(synced, { ok: true, outcome: "removed", slug: page.slug });
  const rows = await rowsSince(page.slug, since);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.urls, setPurgeUrls(page.slug, v2.paths), "archived: the whole set leaves the edge");

  // A row recorded without URLs (the zone was unconfigured) under a name the
  // page USED to answer at: the replay derives that host's set from Postgres.
  const { formerSlug } = multi;
  const id = await insertPendingPurge({ siteId: page.id, slug: formerSlug, urls: [], dueAt: new Date() });
  const [row] = await db.select().from(pendingPurges).where(eq(pendingPurges.id, id));
  assert.equal(await replayPendingPurge(row!), "synced");
  const [owed] = await db.select().from(pendingPurges).where(eq(pendingPurges.id, id));
  for (const url of setPurgeUrls(formerSlug, v2.paths)) {
    assert.ok((owed!.urls as string[]).includes(url), `derived from site_version_files, not the root forms: ${url}`);
  }
  assert.equal(owed!.siteId, null);
});

test("E08 Verification 3: 250 files → 3 rows before the first call; a refusal on batch 2 leaves 2–3 due; replayDue converges", { skip }, async () => {
  // No manifest: only rows and purge calls (no KV). A slug nothing serves.
  const slug = drill.name();
  slugs.add(slug);
  const paths = [
    "index.html",
    ...Array.from({ length: 9 }, (_, i) => `d${i}/index.html`),
    ...Array.from({ length: 240 }, (_, i) => `assets/f${String(i).padStart(3, "0")}.js`),
  ];
  assert.equal(paths.length, 250);
  const urls = setPurgeUrls(slug, paths);
  assert.equal(urls.length, 260, "250 paths + / + nine dir/ forms");

  // THE SEAM: a URL Cloudflare refuses, placed in batch 2. A real refusal, not a stub.
  const bad = [...urls];
  bad[150] = "not a url";
  const result = await purgeOwedUrls(slug, bad, { siteId: null });
  assert.equal(result.ok, false, "Cloudflare must refuse batch 2");
  console.log(`[e08-005] batch 2 refusal → ${result.ok ? "" : result.error}`);

  const rows = (await db.select().from(pendingPurges).where(eq(pendingPurges.slug, slug))).sort(
    (a, b) => urls.indexOf((a.urls as string[])[0]!) - urls.indexOf((b.urls as string[])[0]!),
  );
  assert.deepEqual(rows.map((row) => (row.urls as string[]).length), [100, 100, 60], "one row per batch");
  const now = Date.now();
  assert.ok(rows[0]!.dueAt.getTime() > now, "batch 1 landed: due for its second purge only");
  assert.ok(rows[1]!.dueAt.getTime() <= now, "batch 2 was refused: due now");
  assert.ok(rows[2]!.dueAt.getTime() <= now, "batch 3 was never sent: due now");
  const scope = rows.map((row) => row.id);

  // Fix the cause (the bad URL), then replay: 2 and 3 purge and wait out the window.
  await db.update(pendingPurges).set({ urls: urls.slice(100, 200) }).where(eq(pendingPurges.id, rows[1]!.id));
  assert.deepEqual(await replayDue(scope), { synced: 0, purged: 0, deferred: 2, failed: 0, gave_up: 0, alert: null });

  // Past the window, every row purges and leaves.
  const settled = new Date(Date.now() - KV_REPURGE_DELAY_MS - 1_000);
  await db.update(pendingPurges).set({ createdAt: settled, dueAt: settled }).where(inArray(pendingPurges.id, scope));
  assert.deepEqual(await replayDue(scope), { synced: 0, purged: 3, deferred: 0, failed: 0, gave_up: 0, alert: null });
  assert.equal((await db.select().from(pendingPurges).where(inArray(pendingPurges.id, scope))).length, 0);
  assert.deepEqual(await replayDue(scope), { synced: 0, purged: 0, deferred: 0, failed: 0, gave_up: 0, alert: null });
});
