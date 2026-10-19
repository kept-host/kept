import { RATE_LIMITS } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { closeDb, db } from "../lib/db";
import { abuseReports, moderationActions, sites } from "../lib/db/schema";
import { keptOpen } from "../lib/launch";
import { drillIp } from "../lib/testing/drill-ip";
import { NamesDrill } from "../lib/testing/names-drill";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, publishOwned, readSite, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";
import { pageUrl, reportBody, reportFlow, reportsFor, SKIP_REPORTS } from "./report-flow";

/**
 * Reports on an OPEN deploy (E07 task 010): the shared flow (`report-flow.ts`,
 * AC15), then what only the open harness can drive end to end —
 *
 *   AC16  a sixth report from one IP within the hour is 429 with `Retry-After`;
 *         the repeats on one page are stored `duplicate`.
 *   AC17  a child-sexual-abuse report on a REAL published page quarantines it
 *         at once, and its owner can neither download it nor find it in the
 *         export (task 009's predicates, asserted here over the wire).
 *
 * AC17 publishes two real pages through `POST /api/sites` (R2 + KV + purge)
 * for an owner on Resend's test inbox: about 6 KV operations including
 * teardown. The PRIORITY alert goes to the harness's per-run admin address.
 */
reportFlow("open");

test.describe("reports (open only)", () => {
  test.skip(!keptOpen(), "the harness is closed");
  test.skip(!!SKIP_REPORTS, SKIP_REPORTS || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  const drill = new NamesDrill("e07-010-limits");
  const scope = newScope();

  test.beforeAll(async () => {
    if (!SKIP_REPORTS) await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_REPORTS) return;
    const ids = [...scope.siteIds];
    const drilled = await db.select({ id: sites.id }).from(sites).where(eq(sites.publisherHash, "e07-010-limits-drill"));
    ids.push(...drilled.map((row) => row.id));
    if (ids.length > 0) {
      await db.delete(abuseReports).where(inArray(abuseReports.siteId, ids));
      await db.delete(moderationActions).where(inArray(moderationActions.siteId, ids));
    }
    await cleanup(scope);
    await drill.cleanup();
    await closeDb();
  });

  test("AC16: a sixth report from one IP within the hour is 429; repeats on a page are duplicates", async ({ request }) => {
    const site = await drill.site({ ownerId: await drill.profile() });
    await db.update(sites).set({ ownerId: null, currentVersionId: null }).where(eq(sites.id, site.id));
    const headers = { "cf-connecting-ip": drillIp() };

    for (let n = 1; n <= RATE_LIMITS.reportPerIpHour.limit; n++) {
      const response = await request.post("/api/reports", { data: reportBody(pageUrl(site.slug)), headers });
      expect(response.status(), `report ${n}`).toBe(201);
    }
    const sixth = await request.post("/api/reports", { data: reportBody(pageUrl(site.slug)), headers });
    expect(sixth.status()).toBe(429);
    expect(Number(sixth.headers()["retry-after"])).toBeGreaterThan(0);
    const body = (await sixth.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: "rate_limited", message: "Too many reports from here — try again later." });

    const statuses = (await reportsFor(site.id)).map((row) => row.status);
    expect(statuses).toEqual(["open", "duplicate", "duplicate", "duplicate", "duplicate"]);
  });

  test("AC17: a CSAM report hides a real page at once; its owner can't download or export it", async ({ page, baseURL }) => {
    test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
    await signInAs(page, baseURL!, scope, `delivered+e07-010-owner-${crypto.randomUUID().slice(0, 8)}@resend.dev`);
    const reported = await publishOwned(page, baseURL!, scope, "reported page");
    const other = await publishOwned(page, baseURL!, scope, "unrelated page");

    const response = await page.request.post(`${baseURL}/api/reports`, {
      data: reportBody(reported.liveUrl, {
        category: "child_sexual_abuse",
        details: "This page shows child sexual abuse material.",
      }),
      headers: { "cf-connecting-ip": drillIp() },
    });
    expect(response.status()).toBe(201);

    const row = await readSite(reported.siteId);
    expect(row.status).toBe("quarantined");
    expect(row.moderationReason).toBe("child_sexual_abuse");
    const [report] = await reportsFor(reported.siteId);
    const [action] = await db.select().from(moderationActions).where(eq(moderationActions.siteId, reported.siteId));
    expect(action).toMatchObject({ actor: "report", action: "hide", automated: true, reportId: report?.id });

    const download = await page.request.get(`${baseURL}/api/sites/${reported.siteId}/download`);
    expect(download.status()).toBe(404);
    expect((await page.request.get(`${baseURL}/api/sites/${other.siteId}/download`)).status()).toBe(200);

    const exported = await page.request.get(`${baseURL}/api/export`);
    expect(exported.status()).toBe(200);
    const zip = (await exported.body()).toString("utf8");
    expect(zip).toContain(`${other.slug}/index.html`);
    expect(zip).not.toContain(reported.slug);
  });
});
