/**
 * The moderation screen's decisions (E07 task 011, AC21): which actions the
 * screen offers per status, Hide closing a page's open reports as `actioned`,
 * Dismiss closing reports as `dismissed` with the note and one log row each,
 * and a refused action touching nothing.
 *
 * NO MOCKS. Real dev Postgres; real `syncManifest` for the one committed Hide;
 * real Resend for the reporter mails (Resend's test inbox — without
 * `RESEND_API_KEY` the outcome is `failed`, asserted as either).
 *
 * KV (dev free plan): one write (the Hide) and one delete in `after` — two
 * operations for the file. SKIPS without the database or dev store credentials.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../db";
import { abuseReports, moderationActions, sites } from "../db/schema";
import { removeManifest } from "../storage/manifest";
import { stillServed } from "../testing/moderation-drill";
import { NamesDrill } from "../testing/names-drill";
import { clearPendingPurges } from "../testing/pending-purges";

import { allowedSiteActions, dismissReports, moderateSite, readAdminHtml } from "./admin";

config({ path: ".env.local", quiet: true });

const RUN = crypto.randomUUID().slice(0, 8);
// Owner statements and any alert go to Resend's test inbox, never to a person.
process.env.KEPT_ADMIN_EMAILS = `delivered+e07-011-admin-${RUN}@resend.dev`;

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

const drill = new NamesDrill("e07-011");
const siteIds = new Set<string>();
const slugs = new Set<string>();
const reportIds: string[] = [];

after(async () => {
  if (skip) return;
  if (siteIds.size > 0) {
    for (const slug of await stillServed([...siteIds])) await removeManifest(slug).catch(() => undefined);
    await db.delete(moderationActions).where(inArray(moderationActions.siteId, [...siteIds]));
    await clearPendingPurges(slugs, siteIds);
  }
  if (reportIds.length) await db.delete(abuseReports).where(inArray(abuseReports.id, reportIds));
  await drill.cleanup();
  await closeDb();
});

async function flagged() {
  const ownerId = await drill.profile();
  const site = await drill.site({ ownerId, status: "under_review" });
  await db.update(sites).set({ moderationReason: "phishing" }).where(eq(sites.id, site.id));
  siteIds.add(site.id);
  slugs.add(site.slug);
  return site;
}

async function report(site: { id: string; slug: string }, status: "open" | "dismissed" = "open") {
  const [row] = await db
    .insert(abuseReports)
    .values({
      siteId: site.id,
      slug: site.slug,
      url: `https://${site.slug}.example`,
      category: "phishing",
      details: `e07-011 ${RUN}: a drill report about this page.`,
      reporterEmail: `delivered+e07-011-reporter-${RUN}@resend.dev`,
      reporterBucket: `e07-011-${RUN}`,
      status,
    })
    .returning({ id: abuseReports.id });
  reportIds.push(row!.id);
  return row!.id;
}

const reportRow = async (id: string) => (await db.select().from(abuseReports).where(eq(abuseReports.id, id)))[0]!;
const actionsOf = (siteId: string) => db.select().from(moderationActions).where(eq(moderationActions.siteId, siteId));

test("the screen offers exactly the admin edges of the transition table", () => {
  assert.deepEqual(allowedSiteActions("live"), { restore: false, hide: true, remove: true });
  assert.deepEqual(allowedSiteActions("under_review"), { restore: true, hide: true, remove: true });
  assert.deepEqual(allowedSiteActions("quarantined"), { restore: true, hide: false, remove: true });
  assert.deepEqual(allowedSiteActions("removed"), { restore: true, hide: false, remove: false });
  assert.deepEqual(allowedSiteActions("expired"), { restore: false, hide: false, remove: true });
});

test("AC21: Dismiss closes open reports as dismissed with the note, logs each, skips closed ones", { skip }, async () => {
  const site = await flagged();
  const open = await report(site);
  const closedAlready = await report(site, "dismissed");
  const admin = await drill.profile();

  const result = await dismissReports([open, closedAlready], "e07-011: not a phishing page.", admin);
  assert.equal(result.closed, 1);
  assert.equal(result.mails.length, 1);
  assert.ok(["sent", "failed"].includes(result.mails[0]!), result.mails[0]);

  const row = await reportRow(open);
  assert.equal(row.status, "dismissed");
  assert.equal(row.resolutionNote, "e07-011: not a phishing page.");
  assert.ok(row.resolvedAt);
  assert.equal((await reportRow(closedAlready)).resolutionNote, null, "a closed report is left as it was");

  const actions = await actionsOf(site.id);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.action, "dismiss_report");
  assert.equal(actions[0]!.reportId, open);
  assert.equal(actions[0]!.actorUserId, admin);
  assert.equal(actions[0]!.fromStatus, "under_review");
  assert.equal(actions[0]!.toStatus, null);
  // Dismissing changes no status.
  assert.equal((await db.select().from(sites).where(eq(sites.id, site.id)))[0]!.status, "under_review");
});

test("AC21: Hide quarantines through setStatus and closes the page's open reports as actioned", { skip }, async () => {
  const site = await flagged();
  const open = await report(site);
  const admin = await drill.profile();

  const { status, reports } = await moderateSite(site.id, { action: "hide", reason: "phishing", note: "e07-011 hide" }, admin);
  assert.ok(status.ok, status.ok ? "" : status.message);
  assert.equal(status.to, "quarantined");
  assert.equal(reports.closed, 1);

  const row = await reportRow(open);
  assert.equal(row.status, "actioned");
  assert.equal(row.resolutionNote, "e07-011 hide");
  const actions = await actionsOf(site.id);
  assert.deepEqual(
    actions.map((a) => [a.actor, a.action, a.toStatus, a.reason, a.actorUserId]),
    [["admin", "hide", "quarantined", "phishing", admin]],
  );
});

test("a refused action writes nothing and leaves the reports open", { skip }, async () => {
  const site = await flagged();
  const open = await report(site);
  await db.update(sites).set({ status: "live", moderationReason: null }).where(eq(sites.id, site.id));

  const { status, reports } = await moderateSite(site.id, { action: "restore", note: "nothing to restore" }, await drill.profile());
  assert.equal(status.ok ? "ok" : status.refusal, "not_allowed");
  assert.equal(reports.closed, 0);
  assert.equal((await reportRow(open)).status, "open");
  assert.deepEqual(await actionsOf(site.id), []);
});

test("the admin read of a page with no version is null, never a throw", { skip }, async () => {
  assert.equal(await readAdminHtml({ id: crypto.randomUUID(), slug: "e07-011-none", currentVersionId: null }), null);
});
