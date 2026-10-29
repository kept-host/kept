import { expect, test } from "@playwright/test";
import { config } from "dotenv";

import { keptOpen } from "../lib/launch";
import { waitlistHref } from "../lib/routing/host-split";

/**
 * E10's ONE closed-mode spec — the creator-loop routes on the deploy prod runs
 * until launch (Q21, task 003's classification, proven end to end). Run with
 *
 *   NEXT_PUBLIC_KEPT_OPEN=false pnpm --filter @kept/web exec playwright test e2e/creator-loop.closed.spec.ts
 *
 *   - `/drafts` and `/remix/{slug}` are apex pages served while closed: the
 *     explainer renders, an unknown remix slug is the 404 page — never a
 *     redirect to the landing's `/`.
 *   - `/api/profile`, `/api/profile/handle` and `/api/referrals` are `app.`
 *     APIs: from any other host they are the JSON `not_open` 404.
 *   - `/referrals` is an `app.` page: from another host it goes to `app.`.
 *
 * "Another host" is sent as `x-forwarded-host`, as a proxy sends it (the
 * middleware reads it, never the listen address). Locally the landing and
 * `app.` are one origin (`https://localhost:3000`), so the apex pages are
 * requested on it plainly. Nothing is published: 0 KV writes.
 */

config({ path: ".env.local", quiet: true });

const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "") ?? "";

/** A host that is not `app.` — the apex on whichever track `.env.local` points at. */
const OTHER_HOST = { "x-forwarded-host": process.env.KEPT_BASE_DOMAIN?.trim() || "apex.invalid" };

const NOT_OPEN = {
  error: "not_open",
  message: "kept opens in December.",
  waitlist: waitlistHref(process.env.NEXT_PUBLIC_APP_URL),
};

test.describe("the creator loop (closed)", () => {
  test.skip(keptOpen(), "the harness is open — run this file with NEXT_PUBLIC_KEPT_OPEN=false");
  test.skip(!APP_URL, "NEXT_PUBLIC_APP_URL absent — run locally with apps/web/.env.local");

  test.beforeAll(async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(
      ((await health.json()) as { open: boolean }).open,
      "the server on :3000 is open — stop it and rerun closed",
    ).toBe(false);
  });

  test("/drafts is served on the landing's host while closed", async ({ page }) => {
    const response = await page.goto("/drafts");
    console.log(`[closed] /drafts → ${response?.status()} ${page.url()}`);
    expect(response?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/drafts");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("/remix/{unknown} is the 404 page, not a redirect", async ({ request, page }) => {
    test.skip(!process.env.DATABASE_URL, "DATABASE_URL absent — the remix lookup reads Postgres");
    const slug = `e10-closed-${crypto.randomUUID().slice(0, 8)}`;
    const direct = await request.get(`/remix/${slug}`, { maxRedirects: 0 });
    console.log(`[closed] /remix/${slug} → ${direct.status()}`);
    expect(direct.status()).toBe(404);
    expect(direct.headers()["location"]).toBeUndefined();

    const response = await page.goto(`/remix/${slug}`);
    expect(response?.status()).toBe(404);
    expect(new URL(page.url()).pathname).toBe(`/remix/${slug}`);
  });

  test("off the landing's host, the apex pages keep their path", async ({ request }) => {
    for (const path of ["/drafts", "/remix/e10-closed-probe"]) {
      const response = await request.get(path, { headers: OTHER_HOST, maxRedirects: 0 });
      console.log(`[closed] ${path} from ${OTHER_HOST["x-forwarded-host"]} → ${response.status()} ${response.headers()["location"]}`);
      expect(response.status(), path).toBe(307);
      expect(new URL(response.headers()["location"]!, APP_URL).pathname, path).toBe(path);
    }
  });

  test("the profile and referral APIs are the not_open 404 off the app host", async ({ request }) => {
    const calls = [
      request.patch("/api/profile", { headers: OTHER_HOST, data: { bio: "x" } }),
      request.put("/api/profile/handle", { headers: OTHER_HOST, data: { handle: "e10closed" } }),
      request.get("/api/referrals", { headers: OTHER_HOST }),
    ];
    for (const response of await Promise.all(calls)) {
      console.log(`[closed] ${response.url()} → ${response.status()}`);
      expect(response.status(), response.url()).toBe(404);
      expect(await response.json(), response.url()).toEqual(NOT_OPEN);
      expect(response.headers()["set-cookie"], response.url()).toBeUndefined();
    }
  });

  test("/referrals goes to the app host", async ({ request }) => {
    const response = await request.get("/referrals", { headers: OTHER_HOST, maxRedirects: 0 });
    const location = response.headers()["location"] ?? "";
    console.log(`[closed] /referrals from ${OTHER_HOST["x-forwarded-host"]} → ${response.status()} ${location}`);
    expect(response.status()).toBe(307);
    expect(new URL(location, APP_URL).href).toBe(`${APP_URL}/referrals`);
  });
});
