import { readFileSync } from "node:fs";

import { appealResultSchema, nameCheckResultSchema, ownedPublishResultSchema } from "@kept/shared";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { and, desc, eq, inArray } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { keptOpen } from "../lib/launch";
import { drillIp } from "../lib/testing/drill-ip";
import { clearPendingPurges } from "../lib/testing/pending-purges";

import { sweep } from "./lifecycle-sweep";
import { controlPlaneUrl, probeEdge, STALE_EDGE_WINDOW_MS } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, readSite, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";
import { reportBody, SKIP_REPORTS } from "./report-flow";

/**
 * The E07 epic drill (task 012), declared once and run on BOTH deploys —
 * `epic-drill.spec.ts` (open) and `epic-drill.closed.spec.ts` (closed). The
 * epic's acceptance, end to end, on real pages against the real dev stack:
 *
 *   A  an inert phishing page published keyless is `under_review` within
 *      seconds and the edge serves 451 within the re-purge window (AC8); the
 *      response never waited for the scan; the token holder appeals; the admin
 *      grants it from /admin/moderation and the owner gets a statement;
 *   B  a report reaches the admin's Reports tab — closed mode too — and the
 *      admin removes the page from the item view; the removed view shows the
 *      deadline; after `purge` its bytes and row are gone and its name stays
 *      refused (D19);
 *   C  an unkept draft past `expires_at` → `expired` → the edge's 410 → purged;
 *   D  a child-sexual-abuse report hides an anonymous page at once, and no byte
 *      of it reaches `/p` or the admin before "Show";
 *   E  (open) an owned page flagged by the scanner: the studio appeal, the
 *      admin rejects it, then restores the page;
 *   F  (open) the CSAM byte sweep on an owned page — studio, download, export,
 *      admin preview and source.
 *
 * NO MOCKS. Every page is published through the real routes (R2 + KV + purge);
 * every flag is the real scanner's — rule P4 fires on the inert fixture's
 * hidden code with or without a classifier key (D17) — or a real report's; the
 * admin acts through the real screen. The only seeded values are clocks: C's
 * `expires_at` and B/C's `purge_after` are moved into the past, and the two
 * jobs run fenced to these pages (`./lifecycle-sweep.ts` says why).
 *
 * Skips, each with its reason: the real classifier's own verdict (the server's
 * `/api/health` says `scanner: "off"` without `OPENROUTER_API_KEY`); every mail
 * body (Resend's test inbox accepts the send and cannot be read back — the
 * routes' `statement: "sent"` is asserted instead); the owner halves when
 * closed (closed mode signs in admins only).
 *
 * KV (dev free plan): about 20 writes + deletes open, 14 closed, teardown
 * included.
 */
const P4_FIXTURE = readFileSync(new URL("../lib/scan/fixtures/obfuscated-eval-base64.html", import.meta.url), "utf8");
const APPEAL = "This is my own demo login page for a workshop. The form posts nowhere and the script decodes to a comment.";
const MS_PER_MINUTE = 60_000;
/** "Within seconds" (AC8): the scan runs right after the response. */
const FLAG_WITHIN_MS = 30_000;

type Mode = "open" | "closed";

interface AnonPage {
  siteId: string;
  slug: string;
  liveUrl: string;
  token: string;
  versionId: string;
  marker: string;
  ms: number;
}

/** Text only the page's BODY carries — its `<title>` is metadata every surface may show. */
const bodyText = (marker: string) => `${marker}-body-only`;
/** A fixture made this run's own, so neither publish dedup nor verdict reuse answers it. */
const unique = (html: string, marker: string) => `${html}\n<p>${bodyText(marker)}</p>\n`;
const cleanHtml = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title></head><body><h1 id="m">${bodyText(marker)}</h1><p>A plain page.</p></body></html>\n`;

/** Poll `read` until `done(value)`, or fail with `what` at `withinMs`. */
async function until<T>(what: string, withinMs: number, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)} after ${withinMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** The edge's status for `url`, polled until `expected` or the re-purge window closes. */
const edgeStatus = (url: string, expected: number, withinMs = STALE_EDGE_WINDOW_MS + 25_000) =>
  until(`${url} at the edge`, withinMs, async () => (await probeEdge(url)).status, (status) => status === expected);

export function epicDrill(mode: Mode): void {
  test.describe(`E07 epic drill (${mode})`, () => {
    test.skip(
      keptOpen() !== (mode === "open"),
      mode === "open" ? "the harness is closed" : "the harness is open — run `pnpm test:e2e:closed`",
    );
    test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
    test.skip(!!SKIP_REPORTS, SKIP_REPORTS || undefined);
    test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT * 3 });

    const RUN = `e07-drill-${mode}-${crypto.randomUUID().slice(0, 8)}`;
    const ADMIN = process.env.KEPT_E2E_EPIC_ADMIN_EMAIL!;
    const ACCESS = process.env.KEPT_E2E_ACCESS_TOKEN;
    /** Closed, the keyless routes need the run's access token (E06a §2). */
    const credential = (): Record<string, string> => (mode === "closed" ? { authorization: `Bearer ${ACCESS}` } : {});
    const reminder = (label: string) => `delivered+${RUN}-${label}@resend.dev`;

    const scope = newScope();
    /** Every slug and id this drill made — purged rows included, for the rows that outlive them. */
    const allSlugs = new Set<string>();
    const allIds = new Set<string>();
    const contexts: BrowserContext[] = [];
    let scanner: "on" | "off" = "off";
    let admin: Page;
    const pages: Partial<Record<"A" | "B" | "C" | "D", AnonPage>> = {};

    test.beforeAll(async ({ browser, request }) => {
      if (SKIP_OWNER_UI || SKIP_REPORTS || keptOpen() !== (mode === "open")) return;
      expect(ADMIN, "playwright.config.ts sets KEPT_E2E_EPIC_ADMIN_EMAIL").toBeTruthy();
      if (mode === "closed") expect(ACCESS, "playwright.config.ts mints KEPT_E2E_ACCESS_TOKEN").toBeTruthy();
      const health = (await (await request.get("/api/health")).json()) as { open: boolean; scanner: "on" | "off" };
      expect(health.open, `the server on :3000 is not ${mode} — stop it and rerun`).toBe(mode === "open");
      scanner = health.scanner;
      await warmDb();
      admin = await signedIn(browser, ADMIN);
    });

    test.afterAll(async () => {
      if (SKIP_OWNER_UI || SKIP_REPORTS || keptOpen() !== (mode === "open")) return;
      for (const context of contexts) await context.close();
      // Purged pages leave their log and reports behind with `site_id` NULL.
      if (allSlugs.size > 0) {
        await db.delete(schema.moderationActions).where(inArray(schema.moderationActions.slug, [...allSlugs]));
        await db.delete(schema.abuseReports).where(inArray(schema.abuseReports.slug, [...allSlugs]));
      }
      // Manifests, R2 objects, holds, pages and both accounts (the admin's too).
      await cleanup(scope);
      await clearPendingPurges(allSlugs, allIds);
      await closeDb();
    });

    async function signedIn(browser: Browser, email?: string): Promise<Page> {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: controlPlaneUrl });
      contexts.push(context);
      const page = await context.newPage();
      await signInAs(page, controlPlaneUrl, scope, email);
      return page;
    }

    function track(siteId: string, slug: string) {
      scope.siteIds.push(siteId);
      scope.slugs.add(slug);
      allIds.add(siteId);
      allSlugs.add(slug);
    }

    /** A keyless publish as its own publisher, timed; the page and its token. */
    async function publishKeyless(request: APIRequestContext, html: string, marker: string, reminderEmail?: string): Promise<AnonPage> {
      const started = Date.now();
      const response = await request.post("/api/publish", {
        headers: { ...credential(), "content-type": "application/json", "user-agent": `kept-e2e/${marker}` },
        data: { html, ...(reminderEmail ? { reminderEmail } : {}) },
      });
      const ms = Date.now() - started;
      expect(response.status(), await response.text()).toBe(201);
      const body = (await response.json()) as { slug: string; live_url: string; anonToken: string };
      const site = await siteBySlug(body.slug);
      track(site.id, body.slug);
      return { siteId: site.id, slug: body.slug, liveUrl: body.live_url, token: body.anonToken, versionId: site.currentVersionId!, marker, ms };
    }

    /** An owned publish from `owner`'s session. */
    async function publishOwnedHtml(owner: Page, html: string) {
      const response = await owner.request.post("/api/sites", {
        headers: { origin: new URL(controlPlaneUrl).origin, "content-type": "text/html" },
        data: html,
      });
      expect(response.status(), await response.text()).toBe(201);
      const { site } = ownedPublishResultSchema.parse(await response.json());
      track(site.id, site.slug);
      return { siteId: site.id, slug: site.slug, liveUrl: site.liveUrl, versionId: (await readSite(site.id)).currentVersionId! };
    }

    async function siteBySlug(slug: string) {
      const [row] = await db
        .select()
        .from(schema.sites)
        .where(eq(schema.sites.slug, slug))
        .orderBy(desc(schema.sites.createdAt))
        .limit(1);
      expect(row, slug).toBeDefined();
      return row!;
    }

    const scansOf = (versionId: string) =>
      db.select().from(schema.scans).where(eq(schema.scans.versionId, versionId)).orderBy(desc(schema.scans.createdAt));
    const actionsOf = (siteId: string) =>
      db.select().from(schema.moderationActions).where(eq(schema.moderationActions.siteId, siteId));

    /** The scanner's flag: `under_review` within seconds, by the publish scan. */
    async function flaggedByScanner(siteId: string, versionId: string) {
      await until("the page's status", FLAG_WITHIN_MS, async () => (await readSite(siteId)).status, (s) => s === "under_review");
      // The flag commits first; the scan row is finished after it (`lib/scan/run.ts` steps 7 → 8).
      const [scan] = await until("the publish scan", FLAG_WITHIN_MS, () => scansOf(versionId), (rows) => rows[0]?.status !== "pending");
      expect(scan?.trigger).toBe("publish");
      expect(scan?.verdict).toBe("flag");
      // Off: the classifier is skipped and P4 decides alone (D17). On: whichever rule fired first.
      if (scanner === "off") expect(scan).toMatchObject({ status: "skipped", rule: "P4", reason: "suspicious_code" });
      else expect(scan?.status).toBe("done");
      const [action] = await actionsOf(siteId);
      expect(action).toMatchObject({ actor: "scanner", action: "flag", automated: true, toStatus: "under_review" });
    }

    /**
     * Take a decision on the admin's item view; the route's JSON answer.
     *
     * The screen reads only `response.ok` and never the body, so Chromium never
     * finishes the response and `Response.text()` would wait forever. The POST is
     * therefore passed through `route.fetch()` — the same request, the browser's
     * own headers and cookie, the server's own answer handed back unchanged — so
     * the drill can read what the route said (`statement` included).
     */
    async function decide(testId: string, fill: { note?: string; reason?: string; understood?: boolean }) {
      const answers: { status: number; body: Record<string, unknown> }[] = [];
      const pattern = "**/api/admin/moderation/**";
      await admin.route(pattern, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const response = await route.fetch();
        answers.push({ status: response.status(), body: (await response.json()) as Record<string, unknown> });
        await route.fulfill({ response });
      });
      try {
        await admin.getByTestId(testId).click();
        const dialog = admin.getByTestId(`${testId}-dialog`);
        await expect(dialog).toBeVisible();
        if (fill.reason) await dialog.getByTestId(`${testId}-reason`).selectOption(fill.reason);
        if (fill.note) await dialog.getByTestId(`${testId}-note`).fill(fill.note);
        if (fill.understood) await dialog.getByTestId(`${testId}-understood`).check();
        await dialog.getByTestId(`${testId}-dialog-confirm`).click();
        await expect(dialog).toBeHidden({ timeout: LIVE_STACK_TIMEOUT });
      } finally {
        await admin.unroute(pattern);
      }
      expect(answers).toHaveLength(1);
      expect(answers[0]!.status, JSON.stringify(answers[0]!.body)).toBe(200);
      return answers[0]!.body;
    }

    async function report(request: APIRequestContext, liveUrl: string, category: string, details: string) {
      const response = await request.post("/api/reports", {
        data: reportBody(liveUrl, { category, details, email: reminder("reporter") }),
        headers: { "cf-connecting-ip": drillIp() },
      });
      expect(response.status(), await response.text()).toBe(201);
    }

    /** What `/p` must never carry for a restricted page: a frame or any byte of it. */
    async function noBytesOnP(page: Page, site: AnonPage, state: string) {
      const response = await page.goto(`/p/${site.token}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("restricted-banner")).toHaveAttribute("data-state", state);
      await expect(page.locator("iframe")).toHaveCount(0);
      expect(await page.content()).not.toContain(bodyText(site.marker));
    }

    test("A: an inert phishing page published keyless is under_review within seconds and 451 at the edge; the response never waited; an unkept draft past its clock expires to 410", async ({
      request,
    }) => {
      const a = await publishKeyless(request, unique(P4_FIXTURE, `${RUN}-a`), `${RUN}-a`, reminder("a"));
      // Read the moment the response is in hand: the scan runs after it (D2).
      const atResponse = await scansOf(a.versionId);
      expect(atResponse.every((row) => row.status === "pending"), JSON.stringify(atResponse.map((r) => r.status))).toBe(true);
      pages.A = a;

      const c = await publishKeyless(request, cleanHtml(`${RUN}-c`), `${RUN}-c`);
      pages.C = c;
      test.info().annotations.push({
        type: "publish latency",
        description: `inert phishing page ${a.ms} ms · clean page ${c.ms} ms (the scan runs after the response either way)`,
      });

      // C: past its clock, then the expire job — in parallel with A's edge wait.
      await db.update(schema.sites).set({ expiresAt: new Date(Date.now() - MS_PER_MINUTE) }).where(eq(schema.sites.id, c.siteId));
      const expired = sweep("expire", [c.siteId]);

      await flaggedByScanner(a.siteId, a.versionId);
      await edgeStatus(a.liveUrl, 451);

      expect(await expired).toEqual({ expired: 1, skipped: 0, failed: 0 });
      expect((await readSite(c.siteId)).status).toBe("expired");
      await edgeStatus(c.liveUrl, 410, 30_000);
    });

    test("A: the classifier's own verdict flags a plain phishing page (P1/P3)", async ({ request }) => {
      test.skip(scanner === "off", "the server's /api/health says scanner: off (no OPENROUTER_API_KEY) — P4 carried the flag above without the classifier");
      const marker = `${RUN}-p1`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to Northwind Bank</title></head><body><h1>Northwind Bank</h1><p>Your account is locked. Confirm your details to unlock it.</p><form action="https://collect.northwind-bank-verify.invalid/login" method="post"><input name="card" placeholder="Card number"><input name="pin" type="password" placeholder="PIN"><button>Unlock</button></form><!-- ${marker} --></body></html>`;
      const page = await publishKeyless(request, html, marker);
      await until("the page's status", LIVE_STACK_TIMEOUT, async () => (await readSite(page.siteId)).status, (s) => s === "under_review");
      // The flag commits first; the scan row is finished after it (`lib/scan/run.ts` steps 7 → 8).
      const [scan] = await until("the publish scan", FLAG_WITHIN_MS, () => scansOf(page.versionId), (rows) => rows[0]?.status !== "pending");
      expect(scan).toMatchObject({ status: "done", verdict: "flag" });
      expect(["P1", "P3"]).toContain(scan!.rule);
    });

    test("A: the token holder appeals; the admin grants it from /admin/moderation; a statement goes out", async ({ page, request }) => {
      const a = pages.A!;
      await noBytesOnP(page, a, "under_review");
      if (mode === "open") {
        const banner = page.getByTestId("restricted-banner");
        await banner.getByTestId("appeal-button").click();
        await banner.getByTestId("appeal-message").fill(APPEAL);
        await banner.getByTestId("appeal-submit").click();
        await expect(banner.getByTestId("appeal-open")).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
      } else {
        // Closed, `/api/anon/*` takes the access token, which the browser's form
        // does not carry — the token holder's agent appeals over the API.
        const response = await request.post(`/api/anon/${a.token}/appeal`, { headers: credential(), data: { message: APPEAL } });
        expect(response.status(), await response.text()).toBe(201);
        appealResultSchema.parse(await response.json());
      }
      const again = await request.post(`/api/anon/${a.token}/appeal`, { headers: credential(), data: { message: APPEAL } });
      expect(again.status(), "one open appeal per page").toBe(409);

      const [appeal] = await db.select().from(schema.appeals).where(eq(schema.appeals.siteId, a.siteId));
      expect(appeal).toMatchObject({ status: "open", submittedByUserId: null });

      await admin.goto("/admin/moderation?tab=appeals");
      await admin.getByTestId(`appeal-${appeal!.id}`).click();
      await expect(admin).toHaveURL(`/admin/moderation/site/${a.siteId}`);
      const granted = await decide("action-grant", { note: `${RUN}: a workshop demo, nothing leaves the page.` });
      expect(granted).toMatchObject({ decision: "grant", to: "live", statement: "sent" });

      const row = await readSite(a.siteId);
      expect(row.status).toBe("live");
      expect(row.moderationReason).toBeNull();
      const [decided] = await db.select().from(schema.appeals).where(eq(schema.appeals.id, appeal!.id));
      expect(decided!.status).toBe("granted");
      expect((await actionsOf(a.siteId)).map((x) => `${x.actor}:${x.action}`).sort()).toEqual(["admin:appeal_granted", "scanner:flag"]);
    });

    test("B: a report reaches the admin's Reports tab; the admin removes the page; the owner's view shows the deadline", async ({ page, request }) => {
      const b = await publishKeyless(request, cleanHtml(`${RUN}-b`), `${RUN}-b`, reminder("b"));
      pages.B = b;
      await report(request, b.liveUrl, "phishing", `${RUN}: it asks for my bank password on the second screen.`);
      const [stored] = await db.select().from(schema.abuseReports).where(eq(schema.abuseReports.siteId, b.siteId));
      expect(stored).toMatchObject({ status: "open", category: "phishing" });
      // Only CSAM hides on report (D10): the page is live until a person decides.
      expect((await readSite(b.siteId)).status).toBe("live");

      await admin.goto("/admin/moderation?tab=reports");
      await admin.getByTestId(`report-${stored!.id}`).click();
      await expect(admin).toHaveURL(`/admin/moderation/site/${b.siteId}`);
      await expect(admin.getByTestId(`item-report-${stored!.id}`)).toHaveAttribute("data-status", "open");
      const removed = await decide("action-remove", { reason: "phishing", note: `${RUN}: confirmed phishing.`, understood: true });
      expect(removed).toMatchObject({ to: "removed", statement: "sent" });

      const row = await readSite(b.siteId);
      expect(row.status).toBe("removed");
      expect(row.moderationReason).toBe("phishing");
      const [actioned] = await db.select().from(schema.abuseReports).where(eq(schema.abuseReports.id, stored!.id));
      expect(actioned!.status).toBe("actioned");
      const [hold] = await db.select().from(schema.nameHolds).where(eq(schema.nameHolds.name, b.slug));
      expect(hold, "D19: the name is held").toMatchObject({ reason: "removed", userId: null, siteId: b.siteId });

      await noBytesOnP(page, b, "removed");
      await expect(page.getByTestId("restricted-deadline")).toBeVisible();
      await expect(page.getByTestId("restricted-banner").getByTestId("appeal-button")).toBeEnabled();
    });

    test("D: a child-sexual-abuse report hides an anonymous page at once; no byte of it reaches /p or the admin before Show", async ({ page, request }) => {
      const d = await publishKeyless(request, cleanHtml(`${RUN}-d`), `${RUN}-d`);
      pages.D = d;
      await report(request, d.liveUrl, "child_sexual_abuse", `${RUN}: this page shows child sexual abuse material.`);
      // At once: read as soon as the report's 201 is in hand.
      const row = await readSite(d.siteId);
      expect(row).toMatchObject({ status: "quarantined", moderationReason: "child_sexual_abuse" });
      const [action] = await actionsOf(d.siteId);
      expect(action).toMatchObject({ actor: "report", action: "hide", automated: true });

      await noBytesOnP(page, d, "quarantined");
      for (const kind of ["preview", "source"]) {
        const refused = await admin.request.get(`/api/admin/moderation/sites/${d.siteId}/${kind}`);
        expect(refused.status(), kind).toBe(404);
        expect(await refused.text(), kind).toBe("");
      }
    });

    test("E (owner): the scanner flags an owned page; the studio appeal; the admin rejects it, then restores the page", async ({ browser }) => {
      test.skip(mode === "closed", "closed mode signs in admins only — an owner's studio is the open run's");
      const owner = await signedIn(browser, reminder("owner"));
      const e = await publishOwnedHtml(owner, unique(P4_FIXTURE, `${RUN}-e`));
      await flaggedByScanner(e.siteId, e.versionId);

      await owner.goto(`/site/${e.siteId}`);
      const banner = owner.getByTestId("restricted-banner");
      await expect(banner).toHaveAttribute("data-state", "under_review");
      await banner.getByTestId("appeal-button").click();
      await banner.getByTestId("appeal-message").fill(APPEAL);
      await banner.getByTestId("appeal-submit").click();
      await expect(banner.getByTestId("appeal-open")).toBeVisible({ timeout: LIVE_STACK_TIMEOUT });
      const [appeal] = await db.select().from(schema.appeals).where(eq(schema.appeals.siteId, e.siteId));
      expect(appeal!.submittedByUserId).not.toBeNull();

      await admin.goto(`/admin/moderation/site/${e.siteId}`);
      const rejected = await decide("action-reject", { note: `${RUN}: the hidden script stays a concern.` });
      expect(rejected).toMatchObject({ decision: "reject", statement: "sent" });
      await owner.reload();
      await expect(owner.getByTestId("appeal-rejected")).toBeVisible();

      await admin.reload();
      const restored = await decide("action-restore", { note: `${RUN}: checked by hand, harmless.` });
      expect(restored).toMatchObject({ to: "live", statement: "sent" });
      expect((await readSite(e.siteId)).status).toBe("live");
      await owner.reload();
      await expect(owner.getByTestId("restricted-banner")).toHaveCount(0);
    });

    test("F (owner): the CSAM byte sweep — studio, download, export and the admin's preview and source refuse a reported owned page", async ({ browser, request }) => {
      test.skip(mode === "closed", "closed mode signs in admins only — an owner's studio is the open run's");
      const owner = await signedIn(browser, reminder("owner-f"));
      const marker = `${RUN}-f`;
      const f = await publishOwnedHtml(owner, cleanHtml(marker));
      const other = await publishOwnedHtml(owner, cleanHtml(`${RUN}-f-other`));
      await report(request, f.liveUrl, "child_sexual_abuse", `${RUN}: this page shows child sexual abuse material.`);
      expect(await readSite(f.siteId)).toMatchObject({ status: "quarantined", moderationReason: "child_sexual_abuse" });

      const studio = await owner.goto(`/site/${f.siteId}`);
      expect(studio?.status()).toBe(200);
      await expect(owner.getByTestId("restricted-banner")).toHaveAttribute("data-state", "quarantined");
      await expect(owner.locator("iframe")).toHaveCount(0);
      expect(await owner.content()).not.toContain(bodyText(marker));

      expect((await owner.request.get(`/api/sites/${f.siteId}/download`)).status()).toBe(404);
      expect((await owner.request.get(`/api/sites/${other.siteId}/download`)).status()).toBe(200);
      const exported = await owner.request.get("/api/export");
      expect(exported.status()).toBe(200);
      const zip = (await exported.body()).toString("utf8");
      expect(zip).toContain(`${other.slug}/index.html`);
      expect(zip).not.toContain(f.slug);

      for (const kind of ["preview", "source"]) {
        expect((await admin.request.get(`/api/admin/moderation/sites/${f.siteId}/${kind}`)).status(), kind).toBe(404);
        const shown = await admin.request.get(`/api/admin/moderation/sites/${f.siteId}/${kind}?show=1`);
        expect(shown.status(), `${kind} after Show`).toBe(200);
      }
    });

    test("B + C: purge after purge_after removes bytes and row; the removed page's name stays refused (D19)", async () => {
      const b = pages.B!;
      const c = pages.C!;
      // The admin's own page: the account that asks for B's name.
      const mine = await publishOwnedHtml(admin, cleanHtml(`${RUN}-g`));
      const keys = await db
        .select({ r2Key: schema.siteVersions.r2Key })
        .from(schema.siteVersions)
        .where(inArray(schema.siteVersions.siteId, [b.siteId, c.siteId]));
      expect(keys).toHaveLength(2);

      const past = new Date(Date.now() - MS_PER_MINUTE);
      await db.update(schema.sites).set({ purgeAfter: past }).where(inArray(schema.sites.id, [b.siteId, c.siteId]));
      expect(await sweep("purge", [b.siteId, c.siteId])).toEqual({ purged: 2, skipped: 0, failed: 0, reporterContactsCleared: 0 });
      // Gone: no manifest left to remove at teardown.
      scope.slugs.delete(b.slug);
      scope.slugs.delete(c.slug);

      expect(await db.select().from(schema.sites).where(inArray(schema.sites.id, [b.siteId, c.siteId]))).toEqual([]);
      const { r2Store } = await import("../lib/storage/r2");
      for (const { r2Key } of keys) expect(await r2Store().get(r2Key), r2Key).toBeNull();
      // The record outlives the page; the hold too, still ownerless.
      const log = await db.select().from(schema.moderationActions).where(eq(schema.moderationActions.slug, b.slug));
      expect(log.map((x) => x.action)).toContain("remove");
      const [hold] = await db.select().from(schema.nameHolds).where(and(eq(schema.nameHolds.name, b.slug), eq(schema.nameHolds.reason, "removed")));
      expect(hold?.userId).toBeNull();

      const check = await admin.request.get(`/api/names/check?${new URLSearchParams({ name: b.slug, siteId: mine.siteId })}`);
      expect(check.status(), await check.text()).toBe(200);
      expect(nameCheckResultSchema.parse(await check.json()).status).toBe("taken");
      const rename = await admin.request.patch(`/api/sites/${mine.siteId}/name`, {
        headers: { origin: new URL(controlPlaneUrl).origin },
        data: { name: b.slug },
      });
      expect(rename.status(), await rename.text()).toBe(409);
      expect((await readSite(mine.siteId)).slug).toBe(mine.slug);
    });

    test("the mail itself — statements, the PRIORITY alert, the reporter's receipt", () => {
      test.skip(true, "no inbox credential: Resend's test addresses accept the send but cannot be read back — each send is asserted as `statement: \"sent\"` above; the bodies are lib/email/*.test.ts's");
    });
  });
}
