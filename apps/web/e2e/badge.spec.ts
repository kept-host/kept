import { BADGE_TOKENS, MANIFEST_KV_CACHE_TTL_SECONDS } from "@kept/shared";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { pointerKey, syncManifest } from "../lib/storage/manifest";
import { r2Store } from "../lib/storage/r2";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { probeEdge, publishViaApi, unbadged, type EdgeProbe } from "./live-publish";
import { cleanup, newScope, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * The page badge, end to end — E10 task 005 (AC1, AC2, AC6, AC8).
 *
 * NO MOCKS. One keyless draft is published for real, kept for real through the
 * bearer door by a real session, and then switched to the minimal badge with a
 * SQL fixture (the profile made Pro, its style set) and a real `syncManifest`.
 * Each step is checked twice: the control plane's half from the slug pointer
 * (byte-identical to KV), then the edge's half from the deployed Worker.
 *
 * The edge half needs E10's Worker (task 004) on dev — until the rc tag deploys
 * the branch (Q25) only the pointer assertions can pass.
 *
 * WAITS: every edge check after a manifest change polls until the second
 * purge has landed — `(2 * MANIFEST_KV_CACHE_TTL_SECONDS + 15) * 1000` ms —
 * because the first purge cannot reach the Worker's KV read cache.
 *
 * KV BUDGET: three manifest writes (publish, keep, minimal sync) and one
 * delete in teardown.
 */
const EDGE_WAIT_MS = (2 * MANIFEST_KV_CACHE_TTL_SECONDS + 15) * 1000;
const POLL_MS = 3_000;

/** The page's own CSS doing its worst to everything it can reach (AC6). */
const HOSTILE_CSS = "* { color: red !important; display: block }";

const scope = newScope();

/** The one badge element in a served body, or `""`. */
function badgeOf(body: string): string {
  return body.match(/<kept-badge>[\s\S]*?<\/kept-badge>/)?.[0] ?? "";
}

/** Poll the edge until `done(probe)` or the second purge's deadline. */
async function waitForEdge(url: string, done: (probe: EdgeProbe) => boolean): Promise<EdgeProbe> {
  const deadline = Date.now() + EDGE_WAIT_MS;
  for (;;) {
    const probe = await probeEdge(url);
    if (done(probe) || Date.now() > deadline) return probe;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function pointer(slug: string): Promise<Record<string, unknown>> {
  const body = await r2Store().get(pointerKey(slug));
  expect(body, `the manifest for ${slug} must exist`).not.toBeNull();
  return JSON.parse(body!) as Record<string, unknown>;
}

test.describe("the page badge", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT + 2 * EDGE_WAIT_MS });

  const draft = { slug: "", liveUrl: "", anonToken: "", html: "", siteId: "" };
  let ownerId = "";

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("AC2: a keyless draft wears the draft badge, and nothing in the response names its token or a claim link", async ({ request }) => {
    const marker = `e10-005-${crypto.randomUUID().slice(0, 8)}`;
    draft.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marker}</title><style>${HOSTILE_CSS}</style></head><body><h1>${marker}</h1></body></html>\n`;

    const res = await publishViaApi(request, draft.html);
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { slug: string; live_url: string; anonToken: string };
    Object.assign(draft, { slug: body.slug, liveUrl: body.live_url, anonToken: body.anonToken });
    const [row] = await db.select({ id: schema.sites.id }).from(schema.sites).where(eq(schema.sites.slug, body.slug));
    draft.siteId = row!.id;
    scope.siteIds.push(draft.siteId);
    scope.slugs.add(draft.slug);

    // The control plane's half: the manifest carries the draft badge, nothing more (D4).
    expect((await pointer(draft.slug)).badge).toEqual({ variant: "draft", style: "standard" });

    // The edge's half.
    const served = await waitForEdge(draft.liveUrl, (probe) => probe.status === 200 && badgeOf(probe.body) !== "");
    expect(served.status).toBe(200);
    expect(unbadged(served.body), "served = published bytes + one badge").toBe(draft.html);
    const badge = badgeOf(served.body);
    expect(badge).toContain('/drafts"');
    expect(badge).toContain("/report?url=");
    expect(served.body).not.toContain(draft.anonToken);
    expect(badge).not.toMatch(/claim|\/keep|\/anon\/|\?ref=/i);
  });

  test("AC1: keeping it turns the badge into the kept one — the referral link and the report link", async ({ page, baseURL }) => {
    ({ userId: ownerId } = await signInAs(page, baseURL!, scope));
    const kept = await page.request.post(`${baseURL}/api/anon/${draft.anonToken}/keep`);
    expect(kept.status(), await kept.text()).toBe(200);
    expect(((await kept.json()) as { outcome: string }).outcome).toBe("kept");

    const [profile] = await db
      .select({ code: schema.profiles.referralCode })
      .from(schema.profiles)
      .where(eq(schema.profiles.id, ownerId));
    const code = profile!.code;

    // The keep synced the manifest after its commit (D5).
    const manifest = await pointer(draft.slug);
    expect(manifest.ownerId).toBe(ownerId);
    expect(manifest.badge).toEqual({ variant: "kept", style: "standard", refCode: code });

    const served = await waitForEdge(draft.liveUrl, (probe) => badgeOf(probe.body).includes(`?ref=${code}`));
    const badge = badgeOf(served.body);
    expect(badge, "the kept badge credits its owner").toContain(`/?ref=${code}"`);
    expect(badge).toContain("/report?url=");
    expect(badge).not.toContain('/drafts"');
    expect(unbadged(served.body)).toBe(draft.html);
  });

  test("AC6: the page's hostile CSS does not reach the badge (chromium)", async ({ page }, testInfo) => {
    await page.goto(draft.liveUrl);
    const box = page.locator("kept-badge .b").first();
    await expect(box).toBeVisible();
    const style = await box.evaluate((el) => {
      const computed = getComputedStyle(el);
      return {
        color: computed.color,
        background: computed.backgroundColor,
        display: computed.display,
        host: getComputedStyle((el.getRootNode() as ShadowRoot).host).position,
      };
    });
    const rgb = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    expect(style).toEqual({
      color: rgb(BADGE_TOKENS["--text"]),
      background: rgb(BADGE_TOKENS["--surface"]),
      display: "flex",
      host: "fixed",
    });
    // The page itself did turn red — the CSS is live, it just stops at the badge.
    expect(await page.locator("h1").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 0, 0)");
    await testInfo.attach("badge-on-hostile-page", {
      body: await page.locator("kept-badge").screenshot(),
      contentType: "image/png",
    });
  });

  test("AC8: a Pro profile's minimal badge is collapsed, and <details> expands it with no script", async ({ browser }) => {
    // The SQL fixture: the owner made Pro, its style set to minimal; then the
    // one sync a badge-style change queues for this page.
    await db.update(schema.profiles).set({ plan: "premium", badgeStyle: "minimal" }).where(eq(schema.profiles.id, ownerId));
    const synced = await syncManifest(draft.siteId);
    expect(synced.ok, JSON.stringify(synced)).toBe(true);
    expect(((await pointer(draft.slug)).badge as { style: string }).style).toBe("minimal");

    const served = await waitForEdge(draft.liveUrl, (probe) => badgeOf(probe.body).includes("<details>"));
    expect(badgeOf(served.body)).toContain("<details><summary");

    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(draft.liveUrl);
      const summary = page.locator("kept-badge summary");
      const report = page.locator("kept-badge details a", { hasText: "Report" });
      await expect(summary).toBeVisible();
      await expect(report, "collapsed: only the mark shows").toBeHidden();
      await summary.click();
      await expect(report, "expanded by <details> alone").toBeVisible();
    } finally {
      await context.close();
    }
  });
});
