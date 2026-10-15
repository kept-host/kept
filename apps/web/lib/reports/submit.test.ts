/**
 * Taking a report (E07 task 010): URL → page resolution with the partial
 * `sites_slug_key`, the refusals (AC15), the per-IP limit and the 24 h
 * duplicate collapse (AC16), the CSAM fast path (AC17), the re-scan rule and
 * the reporter mails (AC18).
 *
 * NO MOCKS. Real dev Postgres for every row; real Turnstile siteverify on
 * Cloudflare's published test secrets; real `setStatus` → `syncManifest` (R2
 * pointer + KV + purge) for the fast path; real Resend for every mail.
 *
 * MAIL. Every reporter is a `delivered+…@resend.dev` address and
 * `KEPT_ADMIN_EMAILS` is pointed at one too, so nothing reaches a person.
 * Without `RESEND_API_KEY` the sends report `failed`, asserted as such.
 *
 * KV QUOTA (dev free plan): only the CSAM fast path touches KV — one manifest
 * write per hide and one delete in teardown, about 2 operations for the file.
 * Drill pages are anonymous, so no statement of reasons is mailed.
 *
 * SKIPS without the database or the dev store credentials (fork-PR CI).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";

import { RATE_LIMITS, REPORT_ALERT_PER_SITE_HOUR, SCAN_POLICY_VERSION, type SiteStatus } from "@kept/shared";
import { config } from "dotenv";
import { eq, inArray, like, or, sql } from "drizzle-orm";

import { closeDb, db } from "../db";
import { findReportTarget } from "../db/queries/reports";
import {
  abuseReports,
  moderationActions,
  pendingPurges,
  rateLimits,
  scans,
  sites,
  siteVersions,
} from "../db/schema";
import { adminAlertBucket } from "../email/admin-alert";
import { sendReportDecision } from "../email/reports";
import { ipKey } from "../rate-limit";
import { removeManifest } from "../storage/manifest";
import { drillIp } from "../testing/drill-ip";
import { stillServed } from "../testing/moderation-drill";
import { NamesDrill } from "../testing/names-drill";
import { setTurnstileTestKeys, TURNSTILE_TEST_KEYS } from "../testing/turnstile";

import { submitReport, type ReportAccepted, type ReportOutcome } from "./submit";

config({ path: ".env.local", quiet: true });

const RUN = crypto.randomUUID().slice(0, 8);
process.env.KEPT_ADMIN_EMAILS = `delivered+e07-010-admin-${RUN}@resend.dev`;
process.env.RATE_LIMIT_SECRET ??= randomBytes(32).toString("base64url");
setTurnstileTestKeys("pass");
const mailOn = Boolean(process.env.RESEND_API_KEY);
const SENT = mailOn ? "sent" : "failed";
if (!mailOn) console.log("[reports] RESEND_API_KEY absent: sends are expected to report `failed`");

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

const drill = new NamesDrill("e07-010");
const siteIds = new Set<string>();
const slugs = new Set<string>();
const ips = new Set<string>();

after(async () => {
  if (skip) return;
  const ids = [...siteIds];
  if (ids.length > 0) {
    for (const slug of await stillServed(ids)) await removeManifest(slug).catch(() => undefined);
    await db.delete(abuseReports).where(inArray(abuseReports.siteId, ids));
    await db.delete(moderationActions).where(inArray(moderationActions.siteId, ids));
    await db
      .delete(pendingPurges)
      .where(or(inArray(pendingPurges.siteId, ids), inArray(pendingPurges.slug, [...slugs])));
    await db
      .delete(rateLimits)
      .where(inArray(rateLimits.bucket, ids.map((id) => adminAlertBucket(`report-alert:${id}`))));
  }
  for (const ip of ips) {
    await db.delete(rateLimits).where(like(rateLimits.bucket, `${await ipKey("report", ip)}%`));
  }
  await drill.cleanup();
  await closeDb();
});

/** A fresh client address, tracked so its buckets are torn down. */
function client(): string {
  const ip = drillIp();
  ips.add(ip);
  return ip;
}

/** A real version row for `siteId`, made current. No R2 object: nothing here reads the bytes. */
async function currentVersion(siteId: string): Promise<string> {
  const [version] = await db
    .insert(siteVersions)
    .values({ siteId, r2Key: `sites/${siteId}/drill/index.html`, contentHash: `e07-010-${RUN}`, sizeBytes: 10 })
    .returning({ id: siteVersions.id });
  assert.ok(version);
  await db.update(sites).set({ currentVersionId: version.id }).where(eq(sites.id, siteId));
  return version.id;
}

/** A `done` scan of `versionId`, finished `ageHours` ago. */
async function doneScan(siteId: string, versionId: string, ageHours = 0): Promise<void> {
  await db.insert(scans).values({
    siteId,
    versionId,
    contentHash: `e07-010-${RUN}`,
    trigger: "publish",
    status: "done",
    verdict: "clean",
    policyVersion: SCAN_POLICY_VERSION,
    completedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000),
  });
}

/**
 * An anonymous page (no statement-of-reasons recipient) in `status`. With no
 * version unless `scanned`, so no re-scan is enqueued for a page whose bytes do
 * not exist; `scanned` gives it a version with a fresh `done` scan.
 */
async function page(status: SiteStatus = "live", options: { slug?: string; scanned?: boolean } = {}) {
  const site = await drill.site({ ownerId: await drill.profile(), status, slug: options.slug });
  await db.update(sites).set({ ownerId: null, currentVersionId: null }).where(eq(sites.id, site.id));
  siteIds.add(site.id);
  slugs.add(site.slug);
  if (options.scanned) await doneScan(site.id, await currentVersion(site.id));
  return site;
}

const url = (slug: string) => `https://${slug}.${process.env.KEPT_BASE_DOMAIN}`;

function body(slug: string, extra: Record<string, unknown> = {}) {
  return {
    url: url(slug),
    category: "phishing",
    details: "It asks for my bank login and it is not my bank's site.",
    goodFaith: true,
    turnstileToken: TURNSTILE_TEST_KEYS.dummyToken,
    ...extra,
  };
}

function accepted(outcome: ReportOutcome): ReportAccepted {
  assert.equal(outcome.ok, true, `expected a stored report, got ${JSON.stringify(outcome)}`);
  return outcome as ReportAccepted;
}

async function report(id: string) {
  const [row] = await db.select().from(abuseReports).where(eq(abuseReports.id, id));
  assert.ok(row, `report ${id} vanished`);
  return row;
}

async function alertCount(siteId: string): Promise<number> {
  const rows = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(eq(rateLimits.bucket, adminAlertBucket(`report-alert:${siteId}`)));
  return rows.reduce((sum, row) => sum + row.count, 0);
}

test("a slug names the row that still claims it, else the latest archived/removed row", { skip }, async () => {
  const shared = drill.name();
  const archived = await page("archived", { slug: shared });
  const live = await page("live", { slug: shared });
  assert.equal((await findReportTarget(shared))?.id, live.id, "the claiming row wins over an archived one");

  await db.update(sites).set({ status: "removed" }).where(eq(sites.id, live.id));
  await db.update(sites).set({ updatedAt: sql`now() - interval '1 day'` }).where(eq(sites.id, archived.id));
  assert.equal((await findReportTarget(shared))?.id, live.id, "of two ended rows, the most recently changed");

  assert.equal(await findReportTarget(drill.name()), null, "a slug nobody has (or a purged one) is nothing");
});

test("refusals: limits first, then the body, Turnstile and the link (AC15)", { skip }, async () => {
  const site = await page();
  const ip = client();

  assert.deepEqual(await submitReport({ ...body(site.slug), goodFaith: false }, ip), { ok: false, code: "invalid" });
  assert.deepEqual(await submitReport({ ...body(site.slug), details: "too short" }, ip), { ok: false, code: "invalid" });
  assert.deepEqual(await submitReport(body(site.slug, { turnstileToken: undefined }), ip), {
    ok: false,
    code: "invalid",
  });

  setTurnstileTestKeys("fail");
  try {
    assert.deepEqual(await submitReport(body(site.slug), client()), { ok: false, code: "turnstile_failed" });
  } finally {
    setTurnstileTestKeys("pass");
  }

  const other = client();
  for (const link of ["https://example.com", url(drill.name()), `https://app.${process.env.KEPT_BASE_DOMAIN}`]) {
    assert.deepEqual(await submitReport({ ...body(site.slug), url: link }, other), { ok: false, code: "not_a_kept_page" }, link);
  }
  const rows = await db.select({ id: abuseReports.id }).from(abuseReports).where(eq(abuseReports.siteId, site.id));
  assert.equal(rows.length, 0, "a refusal stores nothing");
});

test("a sixth report from one IP within the hour is 429; repeats on one page are duplicates with one alert (AC16)", { skip }, async () => {
  const site = await page();
  const ip = client();
  const email = `delivered+e07-010-reporter-${RUN}@resend.dev`;

  const first = accepted(await submitReport(body(site.slug, { email, name: "Rita Reporter" }), ip));
  assert.equal(first.status, "open");
  assert.equal(first.alert, SENT);
  assert.equal(first.hidden, null, "only child sexual abuse material hides on report");
  assert.equal(first.reporterMail, SENT, "the receipt goes to a given email");
  const stored = await report(first.reportId);
  assert.equal(stored.reporterEmail, email);
  assert.equal(stored.reporterName, "Rita Reporter");
  assert.equal(stored.reporterBucket, await ipKey("report", ip), "a salted digest, never the address");
  assert.ok(!stored.reporterBucket.includes(ip));

  for (let n = 2; n <= RATE_LIMITS.reportPerIpHour.limit; n++) {
    const repeat = accepted(await submitReport(body(site.slug, { category: "spam" }), ip));
    assert.equal(repeat.status, "duplicate", `report ${n}`);
    assert.equal(repeat.alert, null, "a duplicate alerts nobody");
    assert.equal(repeat.rescanned, null, "a duplicate re-scans nothing");
    assert.equal(repeat.reporterMail, "no_email", "no email given, nothing sent");
    assert.equal((await report(repeat.reportId)).reporterEmail, null);
  }
  assert.equal(await alertCount(site.id), 1, "one admin alert attempt for the page");

  const sixth = await submitReport(body(site.slug), ip);
  assert.equal(sixth.ok, false);
  assert.ok(!sixth.ok && sixth.code === "rate_limited" && sixth.retryAfterSeconds > 0, JSON.stringify(sixth));
});

test("the hourly alert is per page: a second reporter inside the hour is stored open but throttled", { skip }, async () => {
  const site = await page();
  accepted(await submitReport(body(site.slug), client()));
  const second = accepted(await submitReport(body(site.slug), client()));
  assert.equal(second.status, "open");
  assert.equal(second.alert, "throttled");
  assert.equal(await alertCount(site.id), REPORT_ALERT_PER_SITE_HOUR.limit + 1);
});

test("the 24 h collapse survives the daily salt: yesterday's digest of the same address counts", { skip }, async () => {
  const site = await page();
  const ip = client();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await db.insert(abuseReports).values({
    siteId: site.id,
    slug: site.slug,
    url: url(site.slug),
    category: "spam",
    details: "seeded: the same reporter, before 00:00 UTC",
    reporterBucket: await ipKey("report", ip, yesterday),
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  assert.equal(accepted(await submitReport(body(site.slug), ip)).status, "duplicate");
});

test("a report on a page already gone is stored and closed 'already removed' at once (edge case 11)", { skip }, async () => {
  const site = await page("archived");
  const email = `delivered+e07-010-gone-${RUN}@resend.dev`;
  const outcome = accepted(await submitReport(body(site.slug, { email }), client()));
  assert.equal(outcome.status, "dismissed");
  assert.equal(outcome.alert, null);
  assert.equal(outcome.rescanned, null);
  assert.equal(outcome.reporterMail, SENT, "the decision goes out at once");
  const row = await report(outcome.reportId);
  assert.equal(row.resolutionNote, "already removed");
  assert.ok(row.resolvedAt, "closed on arrival");
});

test("child sexual abuse material hides the page at once, PRIORITY, automated (AC17)", { skip }, async () => {
  const site = await page("live", { scanned: true });
  const outcome = accepted(
    await submitReport(body(site.slug, { category: "child_sexual_abuse" }), client()),
  );
  assert.ok(outcome.hidden?.ok, JSON.stringify(outcome.hidden));
  assert.equal(outcome.hidden.to, "quarantined");
  assert.equal(outcome.hidden.alert, SENT, "setStatus's own alert is the PRIORITY mail");
  assert.equal(outcome.alert, null, "no second alert on top of it");
  assert.equal(outcome.status, "open", "Arun still reviews it");

  const row = await drill.read(site.id);
  assert.equal(row.status, "quarantined");
  assert.equal(row.moderationReason, "child_sexual_abuse");
  const [action] = await db.select().from(moderationActions).where(eq(moderationActions.siteId, site.id));
  assert.equal(action?.actor, "report");
  assert.equal(action?.automated, true);
  assert.equal(action?.reportId, outcome.reportId);

  // Already hidden: no edge to take, so the report alert itself is PRIORITY and never throttled.
  const again = accepted(await submitReport(body(site.slug, { category: "child_sexual_abuse" }), client()));
  assert.equal(again.hidden, null);
  assert.equal(again.alert, SENT);
  assert.equal(await alertCount(site.id), 0, "a PRIORITY alert spends no throttle");
});

test("a report re-scans the current version unless a done scan of it is under 24 h old", { skip }, async () => {
  const site = await page();
  const versionId = await currentVersion(site.id);
  await doneScan(site.id, versionId);
  assert.equal(accepted(await submitReport(body(site.slug), client())).rescanned, null, "fresh scan: no re-scan");

  await db
    .update(scans)
    .set({ completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(scans.versionId, versionId));
  assert.equal(accepted(await submitReport(body(site.slug), client())).rescanned, versionId);

  // Let the enqueued scan settle (its row leaves `pending`) before teardown deletes the page.
  for (let i = 0; i < 40; i++) {
    const pending = await db
      .select({ id: scans.id })
      .from(scans)
      .where(sql`${scans.versionId} = ${versionId} and ${scans.trigger} = 'report' and ${scans.status} <> 'pending'`);
    if (pending.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

test("the decision mail goes only to a resolved report with an email (AC18)", { skip }, async () => {
  const site = await page();
  const email = `delivered+e07-010-decision-${RUN}@resend.dev`;
  const withEmail = accepted(await submitReport(body(site.slug, { email }), client()));
  const without = accepted(await submitReport(body(site.slug), client()));

  assert.equal(await sendReportDecision(withEmail.reportId), "not_resolved", "open: no decision yet");
  await db
    .update(abuseReports)
    .set({ status: "actioned", resolvedAt: new Date(), resolutionNote: "Taken down." })
    .where(inArray(abuseReports.id, [withEmail.reportId, without.reportId]));
  assert.equal(await sendReportDecision(withEmail.reportId), SENT);
  assert.equal(await sendReportDecision(without.reportId), "no_email");
  assert.equal(await sendReportDecision(crypto.randomUUID()), "not_found");
});
