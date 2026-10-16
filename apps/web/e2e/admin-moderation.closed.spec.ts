import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { keptOpen } from "../lib/launch";

import { LIVE_STACK_TIMEOUT, skipAuth, warmDb } from "./live-stack";
import { cleanup, newScope, signInAs } from "./owner-fixtures";

/**
 * The moderation screen's gate on a CLOSED deploy (E07 task 011, AC20) — the
 * deploy prod runs until launch. Run with `pnpm --filter @kept/web test:e2e:closed`.
 *
 * `/admin/*` and `/api/admin/*` are `app.` routes a closed deploy still serves
 * (`lib/routing/host-split.ts`), so the handlers' own gate is what answers:
 * the bare 404 to anyone signed out, and the screen — with its CSP — to the
 * run's moderation admin. (A non-admin cannot hold a session here at all.)
 */
const ADMIN = process.env.KEPT_E2E_MODERATION_ADMIN_EMAIL!;

test.describe("the moderation screen (closed)", () => {
  test.skip(keptOpen(), "the harness is open — run `pnpm test:e2e:closed` for this file");
  const SKIP_AUTH = skipAuth();
  test.skip(!!SKIP_AUTH, SKIP_AUTH || undefined);
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

  const scope = newScope();

  test.beforeAll(async ({ request }) => {
    const health = await request.get("/api/health");
    expect(((await health.json()) as { open: boolean }).open, "the server on :3000 is open").toBe(false);
    await warmDb();
  });

  test.afterAll(async () => {
    await cleanup(scope);
    await closeDb();
  });

  test("AC20: signed out, every admin page and API is the bare 404", async ({ request }) => {
    const id = crypto.randomUUID();
    for (const path of [
      "/admin/moderation",
      `/admin/moderation/site/${id}`,
      `/api/admin/moderation/sites/${id}/source`,
      `/api/admin/moderation/sites/${id}/preview?show=1`,
    ]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
    const post = await request.post(`/api/admin/moderation/sites/${id}`, { data: { action: "restore", note: "x" } });
    expect(post.status()).toBe(404);
    expect(await post.text()).toBe("");
  });

  test("AC20: the admin gets the screen, under its CSP", async ({ page, baseURL }) => {
    expect(ADMIN, "playwright.config.ts sets KEPT_E2E_MODERATION_ADMIN_EMAIL").toBeTruthy();
    const { userId } = await signInAs(page, baseURL!, scope, ADMIN);
    const [row] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId));
    expect(row?.email).toBe(ADMIN);

    const response = await page.goto("/admin/moderation");
    expect(response?.status()).toBe(200);
    expect(response!.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    await page.getByTestId("tab-appeals").click();
    await expect(page).toHaveURL(/tab=appeals/);
  });
});
