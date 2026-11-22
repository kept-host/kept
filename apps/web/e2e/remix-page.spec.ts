import { DRAFT_TTL_DAYS, REMIX_PROMPT_MAX, remixPrompt } from "@kept/shared";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db, schema } from "../lib/db";
import { liveUrl } from "../lib/publish/pipeline";

import { warmDb } from "./live-stack";
import { SKIP_LIVE_PUBLISH } from "./live-publish";
import { cleanup, newScope, seedKept } from "./owner-fixtures";

/**
 * `/remix/{slug}` and `/drafts` — E10 task 007, AC12. Control-plane pages only:
 * the rows are seeded straight into dev Postgres (`seedKept`, no manifest), so
 * this spec spends no KV write and asserts nothing about the edge.
 */
test.describe("/remix and /drafts", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

  const scope = newScope();
  const model = "claude-opus-4";
  // Longer than the remix prompt's room, so the page has to cut it.
  const longPrompt = `Build a calm one-page portfolio. ${"Keep it warm and quiet. ".repeat(260)}`;
  let slug = "";
  let draftSlug = "";

  test.beforeAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await warmDb();
    const ownerId = crypto.randomUUID();
    const email = `e10-007-${ownerId.slice(0, 8)}@kept-e10-007.invalid`;
    await db.insert(schema.user).values({ id: ownerId, name: "E10-007 drill", email, emailVerified: true });
    await db.insert(schema.profiles).values({ id: ownerId, email, plan: "free" });
    scope.userIds.push(ownerId);

    const [kept] = await seedKept(scope, ownerId, 1);
    const [draft] = await seedKept(scope, ownerId, 1, {
      expiresAt: new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000),
    });
    slug = kept!.slug;
    draftSlug = draft!.slug;
    await db
      .update(schema.sites)
      .set({ title: "E10-007 remix drill", model, prompt: longPrompt, showPrompt: true })
      .where(eq(schema.sites.id, kept!.siteId));
    await db
      .update(schema.sites)
      .set({ model, prompt: longPrompt, showPrompt: true, allowRemix: true })
      .where(eq(schema.sites.id, draft!.siteId));
    console.log(`[remix] seeded kept ${slug}, draft ${draftSlug}`);
  });

  test.afterAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await cleanup(scope);
  });

  async function setSite(values: Partial<typeof schema.sites.$inferInsert>) {
    await db.update(schema.sites).set(values).where(eq(schema.sites.slug, slug));
  }

  async function claudeLinkPrompt(page: Page, name: string): Promise<string> {
    const href = await page.getByRole("link", { name, exact: true }).getAttribute("href");
    expect(href).toBeTruthy();
    const q = new URL(href!).searchParams.get("q");
    expect(q).not.toBeNull();
    return q!;
  }

  test("the prompt, Copy and both Claude links", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const res = await page.goto(`/remix/${slug}`);
    console.log(`[remix] GET /remix/${slug} → ${res?.status()}`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("Remix E10-007 remix drill · kept");
    await expect(page.getByRole("heading", { level: 1, name: "E10-007 remix drill" })).toBeVisible();
    await expect(page.getByText(`Made with ${model}`)).toBeVisible();

    const expected = remixPrompt({ pageUrl: liveUrl(slug), shownPrompt: longPrompt });
    console.log(`[remix] prompt is ${expected.length} chars`);
    expect(expected.length).toBeLessThanOrEqual(REMIX_PROMPT_MAX);
    expect(expected).toContain(`remix_of: "${slug}"`);
    expect(expected).toContain("(https://kept.host/agents)");
    expect(expected).toContain("Build a calm one-page portfolio.");
    await expect(page.locator("pre")).toHaveText(expected);

    await page.getByRole("button", { name: "Copy the remix prompt" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

    expect(await claudeLinkPrompt(page, "Open in Claude")).toBe(expected);
    const web = await page.getByRole("link", { name: "Open in Claude", exact: true }).getAttribute("href");
    expect(web!.startsWith("https://claude.ai/new?q=")).toBe(true);
    const desktop = page.getByRole("link", { name: "Open in Claude desktop" });
    await expect(desktop).toBeVisible();
    expect((await desktop.getAttribute("href"))!.startsWith("claude://claude.ai/new?q=")).toBe(true);
    expect(await claudeLinkPrompt(page, "Open in Claude desktop")).toBe(expected);
    // No other chat app (E09 D11) — the name is spelled out only in agent-copy.ts.
    await expect(page.getByText(new RegExp("chat" + "gpt", "i"))).toHaveCount(0);

    const og = await page.locator("main img").getAttribute("src");
    console.log(`[remix] thumbnail ${og}`);
    expect(og).toMatch(/\/api\/og\/[0-9a-f-]{36}\?v=/);
  });

  test("show_prompt off → the prompt is gone, the remix stays", async ({ page }) => {
    await setSite({ showPrompt: false });
    expect((await page.goto(`/remix/${slug}`))?.status()).toBe(200);
    const expected = remixPrompt({ pageUrl: liveUrl(slug) });
    await expect(page.locator("pre")).toHaveText(expected);
    await expect(page.getByText("Build a calm one-page portfolio.")).toHaveCount(0);
    expect(await claudeLinkPrompt(page, "Open in Claude")).toBe(expected);
  });

  test("allow_remix off → 404", async ({ page }) => {
    await setSite({ allowRemix: false });
    const res = await page.goto(`/remix/${slug}`);
    console.log(`[remix] allow_remix=false → ${res?.status()}`);
    expect(res?.status()).toBe(404);
  });

  test("a draft's slug → 404", async ({ page }) => {
    const res = await page.goto(`/remix/${draftSlug}`);
    console.log(`[remix] draft ${draftSlug} → ${res?.status()}`);
    expect(res?.status()).toBe(404);
  });

  test("/drafts renders", async ({ page }) => {
    const res = await page.goto("/drafts");
    expect(res?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: `Drafts last ${DRAFT_TTL_DAYS} days.` }),
    ).toBeVisible();
    await expect(page.getByText("The person who published this has the link to keep it.")).toBeVisible();
  });
});
