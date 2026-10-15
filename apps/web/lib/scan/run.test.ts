/**
 * The scan runtime (E07 task 007): `enqueueScan` → `runScan`, verdict reuse,
 * P4 on a classifier error, `scan-retry`'s pieces, the failure alert and the
 * spike check — AC2, AC3, AC7, AC8, AC10, AC11, AC12, AC22.
 *
 * NO MOCKS. Real dev Postgres for every row; real R2 objects for every page
 * scanned; real `setStatus` → `syncManifest` (R2 pointer + KV + purge) for
 * every flag; the deployed dev Worker for the 451. The classify path uses a
 * `ContentClassifier` that answers with `fixtures/decisions-response.json` —
 * the Decisions API envelope as task 006 saved it — over a real
 * `decisionsRequest`, the way 006's tests do; its calls are counted on the
 * client itself. A classifier ERROR is a real one: Jev with an invalid key,
 * which OpenRouter refuses. When `OPENROUTER_API_KEY` is configured, one extra
 * test runs the real Jev client; otherwise it skips and says so. The key is
 * never printed.
 *
 * SCANNER OFF BY DEFAULT HERE (D17): the key is removed from this process's
 * environment at load, so the publish paths scan exactly as a self-hosted
 * deploy without the key does — `skipped` rows, P4 still flags.
 *
 * KV QUOTA (dev free plan): the keyless publish (1 write) + its flag (1) + the
 * owned publish, replace and restore (3) + the P4-on-error flag (1), and one
 * delete per served page in `after` (3) — about 9 KV operations.
 *
 * SKIPS without the database or the dev store credentials (fork-PR CI).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { SCAN_RETRY_DELAYS, SCAN_FAILURE_ALERT_THRESHOLD, type ScanTrigger } from "@kept/shared";
import { config } from "dotenv";

import type { ClassifierResult, ContentClassifier } from "./classifier";
import type { Extraction } from "./types";

config({ path: ".env.local", quiet: true });

const RUN = crypto.randomUUID().slice(0, 8);
// Operator alerts (the scanner's flags, the failure alert) go to Resend's test inbox.
process.env.KEPT_ADMIN_EMAILS = `delivered+e07-007-admin-${RUN}@resend.dev`;
// D17, for real: this process scans with no key. The live test passes it explicitly.
const liveKey = process.env.OPENROUTER_API_KEY?.trim() || null;
delete process.env.OPENROUTER_API_KEY;

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
  "NEXT_PUBLIC_APP_URL",
  "PUBLISHER_HASH_SALT",
] as const;
const missing = LIVE_VARS.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0 ? `dev credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local` : false;
const skipLive = skip || (liveKey ? false : "OPENROUTER_API_KEY absent — the live Jev scan needs a real key");

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
/** A fixture made unique to this call, so neither the publish dedup nor the verdict reuse can answer it. */
const unique = (html: string) => `${html}\n<!-- e07-007 ${crypto.randomUUID()} -->\n`;
const cleanHtml = () =>
  unique(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>e07-007</title></head><body><h1>A portfolio</h1><p>Nothing to see.</p></body></html>`);
/** The inert P4 page: a password field and an eval(atob(…)) that decodes to a comment. */
const p4Html = () => unique(fixture("obfuscated-eval-base64.html"));

const documented: unknown = JSON.parse(fixture("decisions-response.json"));

/** The saved Decisions answer behind the real request builder and parser; counts its own calls. */
async function fixtureClassifier() {
  const { JEV_MODEL, decisionsRequest, parseDecisionsResponse } = await import("./classifier");
  return {
    model: JEV_MODEL,
    calls: 0,
    async classify(state: Extraction): Promise<ClassifierResult> {
      this.calls += 1;
      decisionsRequest(this.model, state);
      return parseDecisionsResponse(documented);
    },
  } satisfies ContentClassifier & { calls: number };
}

/** The real client, counted at the wrapper. */
function counted(inner: ContentClassifier) {
  return {
    model: inner.model,
    calls: 0,
    classify(state: Extraction) {
      this.calls += 1;
      return inner.classify(state);
    },
  } satisfies ContentClassifier & { calls: number };
}

async function deps() {
  const { and, desc, eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db");
  const { jobRuns, pageViewsDaily, profiles, scans, sites, user } = await import("../db/schema");
  const { ScanDrill } = await import("../testing/scan-drill");
  return { and, desc, eq, inArray, db, jobRuns, pageViewsDaily, profiles, scans, sites, user, ScanDrill };
}

const drillPromise = skip ? null : deps().then(({ ScanDrill }) => new ScanDrill("e07-007"));
const users = new Set<string>();
const jobs = new Set<string>();

after(async () => {
  if (skip) return;
  const { db, inArray, jobRuns, user } = await deps();
  await (await drillPromise)!.cleanup();
  if (users.size > 0) await db.delete(user).where(inArray(user.id, [...users]));
  if (jobs.size > 0) await db.delete(jobRuns).where(inArray(jobRuns.job, [...jobs]));
  const { closeDb } = await import("../db");
  await closeDb();
});

async function scansOf(versionId: string) {
  const { db, desc, eq, scans } = await deps();
  return db.select().from(scans).where(eq(scans.versionId, versionId)).orderBy(desc(scans.createdAt));
}

/** Poll until `versionId` has a finished scan with `trigger` (the publish paths scan in the background). */
async function settledScan(versionId: string, trigger: ScanTrigger, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (await scansOf(versionId)).find((scan) => scan.trigger === trigger);
    if (row && row.status !== "pending") return row;
    if (Date.now() > deadline) throw new Error(`no finished ${trigger} scan of ${versionId} within ${timeoutMs} ms`);
    await sleep(250);
  }
}

async function site(siteId: string) {
  const { db, eq, sites } = await deps();
  const [row] = await db.select().from(sites).where(eq(sites.id, siteId));
  assert.ok(row, `site ${siteId} vanished`);
  return row;
}

// ── pure ─────────────────────────────────────────────────────────────────────

test("retryAt: +5 min, +15 min, +1 h, +6 h, +24 h after attempts 1–5, then final", async () => {
  const { retryAt } = await import("./run");
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  for (const [i, delay] of SCAN_RETRY_DELAYS.entries()) {
    assert.equal(retryAt(i + 1, now)?.getTime(), now + delay * 1000, `attempt ${i + 1}`);
  }
  assert.deepEqual(
    SCAN_RETRY_DELAYS.map((s) => s / 60),
    [5, 15, 60, 360, 1440],
  );
  assert.equal(retryAt(SCAN_RETRY_DELAYS.length + 1, now), null, "the schedule is spent: final");
});

test("spikeDay: the last complete UTC day before the visits sync's success", async () => {
  const { spikeDay } = await import("./run");
  assert.equal(spikeDay(new Date("2026-10-16T03:17:00Z")), "2026-10-15");
  assert.equal(spikeDay(new Date("2026-10-16T23:50:00Z")), "2026-10-15", "a late manual sync maps to the same day");
  assert.equal(spikeDay(new Date("2026-03-01T00:00:00Z")), "2026-02-28");
});

// ── AC2 + AC8 + AC12: a keyless publish, the scanner off ─────────────────────

test("AC2/AC8/AC12: an inert phishing page published keyless is scanned after the response, flagged by P4 with the scanner off, and the edge serves 451", { skip, timeout: 240_000 }, async () => {
  const { publishPage } = await import("../publish/pipeline");
  const { pointerKey } = await import("../storage/manifest");
  const { r2Store } = await import("../storage/r2");
  const { KV_REPURGE_DELAY_MS } = await import("../storage/manifest");
  const { db, eq, scans, sites } = await deps();

  const outcome = await publishPage({ html: p4Html() }, { ip: "203.0.113.77", userAgent: `kept-e07-007-drill/${RUN}` });
  assert.ok(outcome.ok, JSON.stringify(outcome.body));
  const { slug, live_url: liveUrl } = outcome.body;

  // Read the moment the response is in hand: the scan has at most just begun.
  const atResponse = await db
    .select({ status: scans.status })
    .from(scans)
    .innerJoin(sites, eq(sites.id, scans.siteId))
    .where(eq(sites.slug, slug));
  assert.ok(
    atResponse.every((row) => row.status === "pending"),
    `the response did not wait for the scan (rows at response: ${JSON.stringify(atResponse)})`,
  );

  const [published] = await db.select().from(sites).where(eq(sites.slug, slug));
  assert.ok(published?.currentVersionId);
  (await drillPromise)!.track(published.id, slug);

  const scan = await settledScan(published.currentVersionId, "publish");
  assert.equal(scan.status, "skipped", "no key: the classifier is skipped");
  assert.equal(scan.verdict, "flag");
  assert.equal(scan.rule, "P4");
  assert.equal(scan.reason, "suspicious_code");
  assert.equal(scan.model, null);
  assert.equal(scan.costUsd, null);
  assert.equal(scan.answers, null);
  assert.equal(scan.attempts, 1);
  assert.ok(scan.completedAt);
  const facts = scan.facts as { obfuscated: boolean; secretField: boolean };
  assert.equal(facts.obfuscated && facts.secretField, true, "the facts are stored, not the page text");

  // The flag went through setStatus: row, manifest, edge.
  const deadline = Date.now() + 15_000;
  while ((await site(published.id)).status !== "under_review" && Date.now() < deadline) await sleep(250);
  assert.equal((await site(published.id)).status, "under_review");
  const pointer = JSON.parse((await r2Store().get(pointerKey(slug))) ?? "null") as { status?: string } | null;
  assert.equal(pointer?.status, "under_review", "the manifest says so");

  const edgeDeadline = Date.now() + KV_REPURGE_DELAY_MS + 25_000;
  let status = 0;
  while (Date.now() < edgeDeadline) {
    const res = await fetch(liveUrl, { redirect: "manual" });
    await res.body?.cancel();
    status = res.status;
    if (status === 451) break;
    await sleep(3_000);
  }
  assert.equal(status, 451, `the edge serves the suspended page within ${KV_REPURGE_DELAY_MS / 1000} s`);
});

// ── AC2: replace and restore ─────────────────────────────────────────────────

test("AC2: an owned publish, replace and restore each leave a scans row with their trigger", { skip, timeout: 120_000 }, async () => {
  const { publishOwnedPage } = await import("../sites/publish");
  const { replaceOwnedSite, restoreOwnedVersion } = await import("../sites/owner-routes");
  const { db, profiles, user } = await deps();

  const ownerId = crypto.randomUUID();
  const email = `e07-007-${ownerId.slice(0, 8)}@kept-e07-007.invalid`;
  await db.insert(user).values({ id: ownerId, name: "E07-007 drill", email, emailVerified: true });
  await db.insert(profiles).values({ id: ownerId, email, plan: "free" });
  users.add(ownerId);

  const { site: owned } = await publishOwnedPage({
    profileId: ownerId,
    html: cleanHtml(),
    publisher: { ip: "203.0.113.78", userAgent: `kept-e07-007-drill/${RUN}` },
  });
  (await drillPromise)!.track(owned.id, owned.slug);
  const first = (await site(owned.id)).currentVersionId!;
  assert.equal((await settledScan(first, "publish")).status, "skipped");

  const replaced = await replaceOwnedSite(owned.id, { html: cleanHtml() }, ownerId);
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const second = (await site(owned.id)).currentVersionId!;
  assert.notEqual(second, first);
  const replaceScan = await settledScan(second, "replace");
  assert.equal(replaceScan.verdict, "clean");

  const restored = await restoreOwnedVersion(owned.id, first, ownerId);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const restoreScan = await settledScan(first, "restore");
  assert.equal(restoreScan.verdict, "clean");
  assert.equal((await site(owned.id)).status, "live", "a clean scan changes nothing");
});

// ── AC7 + AC10: the classify path and verdict reuse ──────────────────────────

test("AC7/AC10: a classified scan stores the pinned model, the typed answers and usage.cost; the same bytes reuse it with no classifier call", { skip }, async () => {
  const { runScan } = await import("./run");
  const { classifierAnswersSchema } = await import("./types");
  const drill = (await drillPromise)!;
  const classifier = await fixtureClassifier();

  const html = cleanHtml();
  const a = await drill.page(html);
  const run = await runScan(a.siteId, a.versionId, "publish", classifier);
  assert.equal(run?.status, "done");
  assert.equal(classifier.calls, 1);
  const [stored] = await scansOf(a.versionId);
  assert.ok(stored);
  assert.match(stored.model ?? "", /^typesafe\/jev-1\.13/, "the pinned model");
  assert.equal(classifierAnswersSchema.parse(stored.answers).harm.choice, "none", "typed answers");
  assert.equal(Number(stored.costUsd), 0.00002, "usage.cost (numeric(10,6))");
  assert.equal(stored.verdict, "clean");
  assert.equal(stored.contentHash, a.contentHash);

  // Another page, the same bytes, the same policy version.
  const b = await drill.page(html);
  const again = await runScan(b.siteId, b.versionId, "backfill", classifier);
  assert.equal(again?.status, "done");
  assert.equal(classifier.calls, 1, "no classifier call for a reused verdict");
  const [reused] = await scansOf(b.versionId);
  assert.equal(Number(reused?.costUsd), 0, "cost_usd = 0");
  assert.equal(reused?.verdict, "clean");
  assert.equal(reused?.model, stored.model);
  assert.equal(reused?.trigger, "backfill");
});

test("live: the real Jev client classifies a page once, and the same bytes are reused without a network call", { skip: skipLive }, async () => {
  const { JevClassifier } = await import("./classifier");
  const { runScan } = await import("./run");
  const drill = (await drillPromise)!;
  const jev = counted(new JevClassifier(liveKey!));
  const html = cleanHtml();

  const a = await drill.page(html);
  assert.equal((await runScan(a.siteId, a.versionId, "publish", jev))?.status, "done");
  const [stored] = await scansOf(a.versionId);
  assert.match(stored?.model ?? "", /^typesafe\/jev-1\.13/);
  assert.ok(Number(stored?.costUsd) >= 0);

  const b = await drill.page(html);
  assert.equal((await runScan(b.siteId, b.versionId, "publish", jev))?.status, "done");
  assert.equal(jev.calls, 1, "one network call for two pages of the same bytes");
});

// ── edge case 1 + §6.5: errors, retries, final ───────────────────────────────

test("a classifier error still lets P4 flag, then the row is failed with +5 min; scan-retry re-runs it on the same row", { skip, timeout: 60_000 }, async () => {
  const { JevClassifier } = await import("./classifier");
  const { retryDueScans, runScan } = await import("./run");
  const { db, eq, scans } = await deps();
  const drill = (await drillPromise)!;
  // A real refusal: OpenRouter answers an invalid key with a non-2xx.
  const refused = new JevClassifier(`sk-or-v1-invalid-e07-007-${RUN}`);

  const page = await drill.page(p4Html());
  const started = Date.now();
  const run = await runScan(page.siteId, page.versionId, "publish", refused);
  assert.equal(run?.status, "failed");
  assert.equal(run?.flagged, true, "P4 acted on despite the error");
  assert.equal((await site(page.siteId)).status, "under_review");

  const [failed] = await scansOf(page.versionId);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.rule, "P4");
  assert.match(failed.error ?? "", /^Decisions API returned 4\d\d/);
  assert.ok(!(failed.error ?? "").includes("sk-or-v1"), "the key is never in the error");
  const wait = failed.nextAttemptAt!.getTime() - started;
  assert.ok(wait >= 5 * MS_PER_MINUTE - 5_000 && wait <= 5 * MS_PER_MINUTE + 30_000, `next attempt in ~5 min (${wait} ms)`);

  // Due now: the retry runs the SAME row, and this time the classifier answers.
  await db.update(scans).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(scans.id, failed.id));
  const classifier = await fixtureClassifier();
  const retried = await retryDueScans(classifier);
  assert.ok(retried.done >= 1, JSON.stringify(retried));
  const rows = await scansOf(page.versionId);
  assert.equal(rows.length, 1, "a retry is not a new row");
  assert.equal(rows[0]!.status, "done");
  assert.equal(rows[0]!.attempts, 2);
  assert.equal(rows[0]!.nextAttemptAt, null);
  assert.equal((await site(page.siteId)).status, "under_review", "D4: the second flag is refused, nothing else moves");
});

test("the sixth failed attempt is final; a dead process's pending row is picked up", { skip, timeout: 60_000 }, async () => {
  const { JevClassifier } = await import("./classifier");
  const { retryDueScans } = await import("./run");
  const { db, scans } = await deps();
  const drill = (await drillPromise)!;
  const { SCAN_POLICY_VERSION } = await import("@kept/shared");

  const lastTry = await drill.page(cleanHtml());
  await db.insert(scans).values({
    siteId: lastTry.siteId,
    versionId: lastTry.versionId,
    contentHash: lastTry.contentHash,
    trigger: "publish",
    status: "failed",
    attempts: SCAN_RETRY_DELAYS.length,
    nextAttemptAt: new Date(Date.now() - 1_000),
    policyVersion: SCAN_POLICY_VERSION,
  });
  const stale = await drill.page(cleanHtml());
  await db.insert(scans).values({
    siteId: stale.siteId,
    versionId: stale.versionId,
    contentHash: stale.contentHash,
    trigger: "replace",
    policyVersion: SCAN_POLICY_VERSION,
    createdAt: new Date(Date.now() - 11 * MS_PER_MINUTE),
  });

  await retryDueScans(new JevClassifier(`sk-or-v1-invalid-e07-007-${RUN}`));
  const [final] = await scansOf(lastTry.versionId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.attempts, SCAN_RETRY_DELAYS.length + 1);
  assert.equal(final?.nextAttemptAt, null, "final: never selected again");
  const [picked] = await scansOf(stale.versionId);
  assert.equal(picked?.status, "failed", "the stale pending row was run");
  assert.equal(picked?.attempts, 1);

  await retryDueScans(null);
  assert.equal((await scansOf(lastTry.versionId))[0]?.attempts, SCAN_RETRY_DELAYS.length + 1, "a final row is left alone");
  assert.equal((await site(lastTry.siteId)).status, "live", "the page stays live throughout");
});

test("AC3: a current version older than the grace with no scan row is picked up (trigger backfill); a younger one is not", { skip }, async () => {
  const { scanUnscanned } = await import("./run");
  const drill = (await drillPromise)!;
  const old = await drill.page(cleanHtml(), new Date(Date.now() - 11 * MS_PER_MINUTE));
  const young = await drill.page(cleanHtml(), new Date(Date.now() - 5 * MS_PER_MINUTE));

  // Newest first, one: this drill's page is the newest unscanned one past the grace.
  const counts = await scanUnscanned(null, { limit: 1 });
  assert.equal(counts.skipped, 1, JSON.stringify(counts));
  const [picked] = await scansOf(old.versionId);
  assert.equal(picked?.trigger, "backfill");
  assert.equal(picked?.status, "skipped");
  assert.equal((await scansOf(young.versionId)).length, 0, "inside the grace: left to the publish path");
});

test("AC11: more than 20 failures in 24 h → one admin alert, then throttled for the day", { skip }, async () => {
  const { alertOnScanFailures } = await import("./run");
  const { db, scans } = await deps();
  const { SCAN_POLICY_VERSION } = await import("@kept/shared");
  const page = await (await drillPromise)!.page(cleanHtml());
  await db.insert(scans).values(
    Array.from({ length: SCAN_FAILURE_ALERT_THRESHOLD + 1 }, () => ({
      siteId: page.siteId,
      versionId: page.versionId,
      contentHash: page.contentHash,
      trigger: "publish" as const,
      status: "failed" as const,
      attempts: SCAN_RETRY_DELAYS.length + 1,
      error: "Decisions API returned 503: e07-007 drill",
      policyVersion: SCAN_POLICY_VERSION,
      completedAt: new Date(),
    })),
  );

  const throttleKey = `scan-failures-e07-007-${RUN}`;
  const first = await alertOnScanFailures(throttleKey);
  assert.ok(first === "sent" || first === "failed", `an alert was attempted (${first})`);
  if (first === "failed") console.log("[run.test] RESEND_API_KEY absent or refused: the alert send reported `failed`");
  assert.equal(await alertOnScanFailures(throttleKey), "throttled", "one per day");
});

// ── AC22: the spike check ────────────────────────────────────────────────────

test("AC22: once per synced day, a spike (≥ 500 and ≥ 10× the 7-day average) is re-scanned; re-syncs and an off sync trigger nothing", { skip }, async () => {
  const { checkSpikes } = await import("./run");
  const { and, db, eq, jobRuns, pageViewsDaily, scans } = await deps();
  const drill = (await drillPromise)!;
  const spikeJobs = { sync: `visits-sync-e07-007-${RUN}`, check: `spike-check-e07-007-${RUN}` };
  jobs.add(spikeJobs.sync).add(spikeJobs.check);

  // A day no real page has visits on.
  const D = "2001-01-08";
  const before = (n: number) => new Date(Date.parse(`${D}T00:00:00Z`) - n * MS_PER_DAY).toISOString().slice(0, 10);
  const spiking = await drill.page(cleanHtml());
  const steady = await drill.page(cleanHtml());
  const quiet = await drill.page(cleanHtml());
  const rows = [
    { siteId: spiking.siteId, day: D, views: 600 },
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ siteId: spiking.siteId, day: before(n), views: 10 })),
    { siteId: steady.siteId, day: D, views: 600 },
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ siteId: steady.siteId, day: before(n), views: 100 })),
    { siteId: quiet.siteId, day: D, views: 499 },
  ];
  await db.insert(pageViewsDaily).values(rows);

  assert.deepEqual(await checkSpikes(null, spikeJobs), { day: null, scanned: null }, "the visits sync never ran: nothing");

  await db.insert(jobRuns).values({ job: spikeJobs.sync, lastSuccessAt: new Date("2001-01-09T03:17:00Z") });
  assert.deepEqual(await checkSpikes(null, spikeJobs), { day: D, scanned: 1 });
  const [spikeScan] = await scansOf(spiking.versionId);
  assert.equal(spikeScan?.trigger, "traffic_spike");
  assert.equal((await scansOf(steady.versionId)).length, 0, "600 < 10 × its average of 100");
  assert.equal((await scansOf(quiet.versionId)).length, 0, "under 500");
  assert.equal((await site(spiking.siteId)).status, "live", "a spike alone changes no status");
  const [checked] = await db.select().from(jobRuns).where(eq(jobRuns.job, spikeJobs.check));
  assert.equal(checked?.lastDay, D);
  assert.ok(checked?.lastSuccessAt, "recorded under withJobRun");

  assert.deepEqual(await checkSpikes(null, spikeJobs), { day: D, scanned: null }, "the same day is checked once");
  // A manual `?days=30` re-sync late the same day maps to the same D.
  await db.update(jobRuns).set({ lastSuccessAt: new Date("2001-01-09T23:50:00Z") }).where(eq(jobRuns.job, spikeJobs.sync));
  assert.deepEqual(await checkSpikes(null, spikeJobs), { day: D, scanned: null });
  const spikeRows = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.versionId, spiking.versionId), eq(scans.trigger, "traffic_spike")));
  assert.equal(spikeRows.length, 1);
});

test("AC22: the visits sync is untouched — the spike check lives in scan-retry", () => {
  const strip = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/spike|scan/i.test(strip("../visits/sync.ts")), "lib/visits/sync.ts knows nothing of scans or spikes");
  assert.match(strip("./run.ts"), /withJobRun\(jobs\.check/);
  assert.match(strip("./run.ts"), /from "\.\.\/visits\/sync"/);
});
