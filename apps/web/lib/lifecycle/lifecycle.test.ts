/**
 * `expire` and `purge` (E07 §6.13, D14) — AC23, AC24, AC25, AC40 and the
 * reporter-contact clearing, against the real dev Postgres, R2, KV and edge.
 *
 * NO MOCKS. The jobs are the real ones; the late keep is the real `keepSite`;
 * the bytes are real R2 objects and the manifests real pointer + KV writes.
 *
 * ⚠️ EVERY SWEEP HERE IS SCOPED to the fixture ids it created (`expireDue(ids)`,
 * `purgeDue(ids)`): the dev database is shared, and an unscoped run would expire
 * or hard-delete pages this file did not make. The cron entry points
 * (`runExpire`, `runPurge`) are never called here. The one unscoped call is
 * `clearResolvedReporterContacts`, which deletes nothing and only forgets
 * contacts on reports resolved more than 180 days ago.
 *
 * ── THE LATE-KEEP RACES (AC25, edge case 13), WITHOUT A SLEEP ─────────────────
 * Connection H takes the owner's `profiles` row lock (`lockOwner`). The job and
 * the keep are started in a chosen order and the drill waits until Postgres
 * SHOWS each queued behind H; lock waiters are served in queue order, so letting
 * H go runs them in exactly that order — both orders, for both jobs.
 *
 * ── E08: EVERY FILE OF EVERY VERSION (AC29), THE PER-RUN CAP (Q2) ────────────
 * The purge reads a page's objects from `site_version_files`, so every fixture
 * with bytes records its files there. Two scratch pages carry real file sets:
 * 2 × 250 files (AC29, timed against `JOB_DEADLINE_SECONDS` — Verification 4)
 * and `PURGE_DELETES_PER_RUN + 50` files (the cap and the resume). Neither has
 * a manifest; each costs one KV delete when it is finally purged.
 *
 * KV QUOTA (dev is on the free plan): about eight KV writes and fourteen
 * deletes for the whole file. Every row, hold, object, report and `pending_purges` row
 * it creates is deleted in `after`.
 *
 * SKIPS when the database or the dev store credentials are absent (fork-PR CI).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  EXPIRE_BATCH_SIZE,
  JOB_DEADLINE_SECONDS,
  PURGE_DELETES_PER_RUN,
  REPORTER_CONTACT_RETENTION_DAYS,
  type NameKind,
  type SiteStatus,
} from "@kept/shared";
import { config } from "dotenv";
import { eq, inArray, sql } from "drizzle-orm";

import { closeDb, db } from "../db";
import { clearResolvedReporterContacts, dueExpiriesQuery } from "../db/queries/lifecycle";
import { insertVersionFiles, siteObjectKeys } from "../db/queries/version-files";
import { abuseReports, appeals, moderationActions, nameHolds, sites, siteVersionFiles, siteVersions } from "../db/schema";
import { MS_PER_DAY, MS_PER_SECOND } from "../sites/display";
import { keepSite } from "../sites/keep";
import { removeManifest, syncManifest } from "../storage/manifest";
import { pageObjectKey, PAGE_CONTENT_TYPE, r2Store, siteObjectKey } from "../storage/r2";
import { edgeStatus, liveSkip, LockDrill, manifestAt, settle } from "../testing/lock-drill";
import { NamesDrill } from "../testing/names-drill";
import { clearPendingPurges } from "../testing/pending-purges";

import { expireDue, expireSite } from "./expire";
import { purgeDue, purgeSite, type PurgeResult } from "./purge";

config({ path: ".env.local", quiet: true });

const skip = liveSkip();
const skipDb = process.env.DATABASE_URL ? false : "DATABASE_URL absent — run locally with apps/web/.env.local";


const drill = new NamesDrill("e07-008l");
const slugs = new Set<string>();
const siteIds = new Set<string>();
const objectKeys = new Set<string>();
const reportIds = new Set<string>();

const locks = skipDb ? null : new LockDrill();

after(async () => {
  if (skipDb) return;
  if (!skip) {
    for (const slug of slugs) await removeManifest(slug).catch(() => undefined);
    await r2Store().deleteMany([...objectKeys]).catch(() => undefined);
  }
  if (reportIds.size > 0) await db.delete(abuseReports).where(inArray(abuseReports.id, [...reportIds]));
  if (siteIds.size > 0) {
    // Every fixture slug is in `slugs`, so the set is never empty here.
    await db.delete(moderationActions).where(inArray(moderationActions.slug, [...slugs]));
    await clearPendingPurges(slugs, siteIds);
  }
  await drill.cleanup();
  await locks?.end();
  await closeDb();
});

interface PageOptions {
  owned?: boolean;
  status?: SiteStatus;
  /** Days from now; negative is in the past; `null` for none (kept). */
  expiresInDays?: number | null;
  purgeInDays?: number | null;
  nameKind?: NameKind;
  slug?: string;
  /** Put the current version's bytes in R2 (and a `site_versions` row). */
  bytes?: boolean;
  /** Write the manifest the row implies (one KV write). */
  manifest?: boolean;
}

const at = (days: number | null | undefined) => (days == null ? null : new Date(Date.now() + days * MS_PER_DAY));

/** One fixture page, shaped exactly as asked. */
async function fixture(options: PageOptions = {}) {
  const ownerId = await drill.profile();
  const page = await drill.site({ ownerId, slug: options.slug, nameKind: options.nameKind });
  siteIds.add(page.id);
  slugs.add(page.slug);
  await db
    .update(sites)
    .set({
      ownerId: options.owned === false ? null : ownerId,
      status: options.status ?? "live",
      expiresAt: at(options.expiresInDays),
      purgeAfter: at(options.purgeInDays),
    })
    .where(eq(sites.id, page.id));
  const row = await drill.read(page.id);
  const objectKey = pageObjectKey(page.id, row.currentVersionId!);
  if (options.bytes) {
    objectKeys.add(objectKey);
    const html = `<!doctype html><title>${page.slug}</title>`;
    await r2Store().put(objectKey, html, PAGE_CONTENT_TYPE);
    await db.insert(siteVersions).values({
      id: row.currentVersionId!,
      siteId: page.id,
      r2Key: objectKey,
      contentHash: `e07-008-${page.id}`,
      sizeBytes: Buffer.byteLength(html),
      publishedVia: "studio",
    });
    await insertVersionFiles(db, row.currentVersionId!, [
      { path: "index.html", sizeBytes: Buffer.byteLength(html), sha256: `e07-008-${page.id}` },
    ]);
  }
  if (options.manifest) assert.ok((await syncManifest(page.id)).ok, "precondition: the manifest is written");
  return { ...page, ownerId, objectKey };
}

/** R2 puts and gets in flight at once while building or checking a scratch file set. */
const R2_CONCURRENCY = 32;

/** `fn` over `items`, `R2_CONCURRENCY` at a time. */
async function inChunks<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += R2_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + R2_CONCURRENCY).map(fn))));
  }
  return out;
}

/**
 * Version `versionId` of `siteId` as a set of `n` one-byte files: its
 * `site_versions` row, its `site_version_files` rows and a real R2 object per
 * file. Returns the keys.
 */
async function fileSet(siteId: string, versionId: string, n: number): Promise<string[]> {
  const entries = Array.from({ length: n }, (_, i) => ({
    path: i === 0 ? "index.html" : `assets/f${i}.txt`,
    sizeBytes: 1,
    sha256: `e08-008-${i}`,
  }));
  await db.insert(siteVersions).values({
    id: versionId,
    siteId,
    r2Key: pageObjectKey(siteId, versionId),
    contentHash: `e08-008-${versionId}`,
    sizeBytes: n,
    fileCount: n,
    publishedVia: "studio",
  });
  await insertVersionFiles(db, versionId, entries);
  const keys = entries.map((entry) => siteObjectKey(siteId, versionId, entry.path));
  for (const key of keys) objectKeys.add(key);
  await inChunks(keys, (key) => r2Store().put(key, "k", "text/plain; charset=utf-8"));
  return keys;
}

/** The keys among `keys` that R2 still holds. */
async function stillStored(keys: readonly string[]): Promise<string[]> {
  const found = await inChunks(keys, async (key) => ((await r2Store().get(key)) === null ? null : key));
  return found.filter((key): key is string => key !== null);
}

async function rowOf(siteId: string) {
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  return row ?? null;
}

/** Run `first` then `second` against one owner lock, queued in that order. */
async function inOrder(ownerId: string, first: () => Promise<unknown>, second: () => Promise<unknown>) {
  const h = await locks!.hold("profiles", ownerId);
  let a: Promise<unknown> | undefined;
  let b: Promise<unknown> | undefined;
  try {
    a = settle(first());
    await locks!.waitForWaiters(h.pid, 1);
    b = settle(second());
    await locks!.waitForWaiters(h.pid, 2);
  } finally {
    await h.release();
  }
  return [await a, await b] as const;
}

test("AC40: the expiry query is served by sites_live_expires_idx", { skip: skipDb }, async () => {
  const plan = await db.execute<{ "QUERY PLAN": string }>(sql`explain ${dueExpiriesQuery(EXPIRE_BATCH_SIZE)}`);
  const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
  assert.match(text, /sites_live_expires_idx/, `the plan must read the partial index:\n${text}`);
});

test("AC23: expire turns due live drafts into expired (edge 410) and leaves kept pages and flagged drafts alone", { skip }, async () => {
  const anon = await fixture({ owned: false, expiresInDays: -1, purgeInDays: 29 });
  const owned = await fixture({ expiresInDays: -0.01, purgeInDays: 30 });
  const kept = await fixture({ expiresInDays: null });
  const flagged = await fixture({ status: "under_review", expiresInDays: -2, purgeInDays: 28 });
  const notYet = await fixture({ expiresInDays: 1, purgeInDays: 31 });
  const scope = [anon.id, owned.id, kept.id, flagged.id, notYet.id];
  const before = await Promise.all([kept, flagged, notYet].map((page) => rowOf(page.id)));

  assert.deepEqual(await expireDue(scope), { expired: 2, skipped: 0, failed: 0 });

  for (const page of [anon, owned]) {
    const row = await rowOf(page.id);
    assert.equal(row?.status, "expired", "a due draft is expired");
    assert.equal((await manifestAt(page.slug))?.status, "expired", "and the edge is told (syncManifest)");
  }
  assert.deepEqual(await Promise.all([kept, flagged, notYet].map((page) => rowOf(page.id))), before, "untouched");
  assert.equal(await edgeStatus(anon.slug, 410), 410, "the edge serves the 410 page");

  // Idempotent: nothing is due any more.
  assert.deepEqual(await expireDue(scope), { expired: 0, skipped: 0, failed: 0 });
});

test("AC25: a late keep racing expire keeps the page in either order, and the edge matches the row", { skip }, async () => {
  // expire first, then the keep: the keep is a LATE keep of the expired draft.
  const a = await fixture({ expiresInDays: -1, purgeInDays: 29, manifest: true });
  const [expiredA, keptA] = await inOrder(a.ownerId, () => expireSite(a.id), () => keepSite(a.id, a.ownerId));
  assert.equal(expiredA, "expired");
  assert.equal((keptA as { restored?: boolean }).restored, true, `a late keep: ${String(keptA)}`);

  // the keep first, then expire: nothing is left to expire.
  const b = await fixture({ expiresInDays: -1, purgeInDays: 29, manifest: true });
  const [keptB, expiredB] = await inOrder(b.ownerId, () => keepSite(b.id, b.ownerId), () => expireSite(b.id));
  assert.equal((keptB as { restored?: boolean }).restored, false, `an ordinary keep: ${String(keptB)}`);
  assert.equal(expiredB, "skipped");

  for (const page of [a, b]) {
    const row = await rowOf(page.id);
    assert.equal(row?.status, "live");
    assert.equal(row?.expiresAt, null, "kept: no clock");
    assert.equal((await manifestAt(page.slug))?.status, "live", "the edge serves the kept page");
  }
});

test("AC25: a late keep racing purge loses cleanly in either order — never a half-deleted page", { skip }, async () => {
  const pages = [
    await fixture({ status: "expired", expiresInDays: -40, purgeInDays: -10, bytes: true, manifest: true }),
    await fixture({ status: "expired", expiresInDays: -40, purgeInDays: -10, bytes: true, manifest: true }),
  ];
  const [purgedFirst, keepSecond] = await inOrder(
    pages[0]!.ownerId,
    () => purgeSite(pages[0]!.id),
    () => keepSite(pages[0]!.id, pages[0]!.ownerId),
  );
  const [keepFirst, purgedSecond] = await inOrder(
    pages[1]!.ownerId,
    () => keepSite(pages[1]!.id, pages[1]!.ownerId),
    () => purgeSite(pages[1]!.id),
  );
  assert.deepEqual(
    [purgedFirst, purgedSecond].map((result) => (result as PurgeResult).outcome),
    ["purged", "purged"],
  );
  for (const lost of [keepSecond, keepFirst]) {
    assert.equal((lost as { code?: string }).code, "not_found", "past grace, the keep finds nothing to keep");
  }
  for (const page of pages) {
    assert.equal(await rowOf(page.id), null, "the row is gone");
    assert.deepEqual(await db.select().from(siteVersions).where(eq(siteVersions.siteId, page.id)), []);
    assert.equal(await r2Store().get(page.objectKey), null, "the bytes are gone");
    assert.equal(await manifestAt(page.slug), null, "the manifest is gone");
  }
});

test("AC24: purge deletes every eligible status past purge_after — name, manifest, bytes, row — keeps the D19 hold, skips open appeals, and runs twice safely", { skip }, async () => {
  const pastDue = { expiresInDays: -40, purgeInDays: -1, bytes: true };
  const expired = await fixture({ ...pastDue, status: "expired", nameKind: "chosen", manifest: true });
  const archived = await fixture({ ...pastDue, owned: false, status: "archived" });
  const removed = await fixture({ ...pastDue, status: "removed", expiresInDays: null });
  await db.insert(nameHolds).values({
    name: removed.slug,
    userId: null,
    siteId: removed.id,
    reason: "removed",
    heldUntil: at(300)!,
  });
  const reviewed = await fixture({ ...pastDue, status: "under_review" });
  const appealed = await fixture({ ...pastDue, status: "quarantined" });
  await db.insert(appeals).values({ siteId: appealed.id, message: "e07-008 drill: please look again at this page." });
  // An archived row whose name a live page took since: its manifest is the live page's.
  const released = await fixture({ ...pastDue, status: "archived" });
  const taker = await fixture({ slug: released.slug, expiresInDays: null, manifest: true });
  const notYet = await fixture({ status: "archived", expiresInDays: -2, purgeInDays: 28, bytes: true });
  const kept = await fixture({ expiresInDays: null, bytes: true });

  // The records outlive the page.
  const [action] = await db
    .insert(moderationActions)
    .values({
      siteId: reviewed.id,
      slug: reviewed.slug,
      actor: "admin",
      action: "flag",
      fromStatus: "live",
      toStatus: "under_review",
      automated: false,
    })
    .returning({ id: moderationActions.id });
  const [report] = await db
    .insert(abuseReports)
    .values({
      siteId: reviewed.id,
      slug: reviewed.slug,
      url: `https://${reviewed.slug}.${process.env.KEPT_BASE_DOMAIN}/`,
      category: "phishing",
      details: "e07-008 drill report",
      reporterBucket: "e07-008-drill",
    })
    .returning({ id: abuseReports.id });
  reportIds.add(report!.id);

  const scope = [expired, archived, removed, reviewed, appealed, released, taker, notYet, kept].map((page) => page.id);
  const untouched = await Promise.all([appealed, taker, notYet, kept].map((page) => rowOf(page.id)));

  assert.deepEqual(await purgeDue(scope), { purged: 5, partial: 0, skipped: 0, failed: 0, reporterContactsCleared: 0 });

  for (const page of [expired, archived, removed, reviewed, released]) {
    assert.equal(await rowOf(page.id), null, `${page.slug}: the row is gone`);
    assert.deepEqual(await db.select().from(siteVersions).where(eq(siteVersions.siteId, page.id)), []);
    assert.equal(await r2Store().get(page.objectKey), null, `${page.slug}: every version's bytes are gone`);
  }
  for (const page of [expired, archived, removed, reviewed]) {
    assert.equal(await manifestAt(page.slug), null, `${page.slug}: the manifest is gone`);
  }
  assert.equal((await manifestAt(taker.slug))?.siteId, taker.id, "the page that took the name still serves");
  assert.deepEqual(await Promise.all([appealed, taker, notYet, kept].map((page) => rowOf(page.id))), untouched);
  assert.notEqual(await r2Store().get(notYet.objectKey), null);

  // releaseName: a chosen name is held for its last owner; the removal's
  // ownerless hold survives the page (D19, AC36).
  const purgedHold = await drill.holdOf(expired.slug);
  assert.equal(purgedHold?.reason, "purged");
  assert.equal(purgedHold?.userId, expired.ownerId);
  const removedHold = await drill.holdOf(removed.slug);
  assert.equal(removedHold?.reason, "removed", "purge leaves the removal's hold in place");
  assert.equal(removedHold?.userId, null);

  const [actionAfter] = await db.select().from(moderationActions).where(eq(moderationActions.id, action!.id));
  assert.equal(actionAfter?.siteId, null, "the log keeps its row, site_id set null");
  assert.equal(actionAfter?.slug, reviewed.slug);
  const [reportAfter] = await db.select().from(abuseReports).where(eq(abuseReports.id, report!.id));
  assert.equal(reportAfter?.siteId, null);

  // Safe to run twice: nothing is due any more.
  assert.deepEqual(await purgeDue(scope), { purged: 0, partial: 0, skipped: 0, failed: 0, reporterContactsCleared: 0 });
});

test(
  "AC29 + Verification 4: purge deletes every file of every version of an expired 500-file draft, inside JOB_DEADLINE_SECONDS",
  { skip, timeout: 300_000 },
  async () => {
    const page = await fixture({ status: "expired", expiresInDays: -40, purgeInDays: -1 });
    const current = (await drill.read(page.id)).currentVersionId!;
    const previous = crypto.randomUUID();
    const keys = [...(await fileSet(page.id, previous, 250)), ...(await fileSet(page.id, current, 250))];
    assert.equal((await siteObjectKeys(db, page.id)).length, 500, "precondition: 2 versions × 250 recorded files");
    assert.equal((await stillStored(keys)).length, 500, "precondition: every file is in R2");

    const started = Date.now();
    const counts = await purgeDue([page.id]);
    const elapsed = Date.now() - started;
    console.log(`[purge drill] 500 files across 2 versions purged in ${elapsed} ms`);

    assert.deepEqual(counts, { purged: 1, partial: 0, skipped: 0, failed: 0, reporterContactsCleared: 0 });
    assert.ok(elapsed < JOB_DEADLINE_SECONDS * MS_PER_SECOND, `${elapsed} ms is inside the job's deadline`);
    assert.equal(await rowOf(page.id), null, "the row is gone");
    assert.deepEqual(await db.select().from(siteVersions).where(eq(siteVersions.siteId, page.id)), []);
    assert.deepEqual(
      await db.select().from(siteVersionFiles).where(inArray(siteVersionFiles.versionId, [previous, current])),
      [],
      "site_version_files cascaded with the versions",
    );
    assert.deepEqual(await stillStored(keys), [], "a get on every recorded key is null");
  },
);

test(
  "Q2: a page past PURGE_DELETES_PER_RUN keeps its row and its unfinished files; the next run resumes and finishes",
  { skip, timeout: 600_000 },
  async () => {
    const page = await fixture({ status: "expired", expiresInDays: -40, purgeInDays: -1 });
    const current = (await drill.read(page.id)).currentVersionId!;
    const keys = await fileSet(page.id, current, PURGE_DELETES_PER_RUN + 50);

    assert.deepEqual(await purgeDue([page.id]), {
      purged: 0,
      partial: 1,
      skipped: 0,
      failed: 0,
      reporterContactsCleared: 0,
    });
    const row = await rowOf(page.id);
    assert.equal(row?.status, "expired", "cut off by the cap: the row stays, untouched");
    assert.equal(row?.slug, page.slug, "and keeps its name");
    const recorded = await siteObjectKeys(db, page.id);
    assert.equal(recorded.length, 50, "only the files not yet deleted are still recorded");
    assert.deepEqual(
      (await stillStored(keys)).sort(),
      [...recorded].sort(),
      "R2 holds exactly the recorded remainder — Postgres and the bytes agree",
    );

    assert.deepEqual(await purgeDue([page.id]), {
      purged: 1,
      partial: 0,
      skipped: 0,
      failed: 0,
      reporterContactsCleared: 0,
    });
    assert.equal(await rowOf(page.id), null, "the next run finishes: the row is gone");
    assert.deepEqual(await stillStored(recorded), [], "and so is the rest of the bytes");
  },
);

test("purge forgets a reporter's name and email REPORTER_CONTACT_RETENTION_DAYS after resolution, and only then", { skip: skipDb }, async () => {
  const resolved = (days: number) => ({
    slug: "e07-008-gone",
    url: "https://e07-008-gone.invalid/",
    category: "phishing" as const,
    details: "e07-008 drill report",
    reporterName: "Drill Reporter",
    reporterEmail: "drill-reporter@kept.invalid",
    reporterBucket: "e07-008-drill",
    status: "actioned" as const,
    resolvedAt: new Date(Date.now() - days * MS_PER_DAY),
  });
  const [old, recent] = await db
    .insert(abuseReports)
    .values([resolved(REPORTER_CONTACT_RETENTION_DAYS + 1), resolved(REPORTER_CONTACT_RETENTION_DAYS - 1)])
    .returning({ id: abuseReports.id });
  reportIds.add(old!.id);
  reportIds.add(recent!.id);

  assert.ok((await clearResolvedReporterContacts()) >= 1);
  const [oldAfter] = await db.select().from(abuseReports).where(eq(abuseReports.id, old!.id));
  const [recentAfter] = await db.select().from(abuseReports).where(eq(abuseReports.id, recent!.id));
  assert.equal(oldAfter?.reporterName, null);
  assert.equal(oldAfter?.reporterEmail, null);
  assert.equal(oldAfter?.details, "e07-008 drill report", "the report itself stays");
  assert.equal(recentAfter?.reporterName, "Drill Reporter", "inside the window the contact stays");
  assert.equal(await clearResolvedReporterContacts(), 0, "a second run clears nothing");
});
