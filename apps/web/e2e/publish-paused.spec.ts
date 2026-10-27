import { publishErrorSchema, studioErrorSchema } from "@kept/shared";
import { expect, test } from "@playwright/test";

import { closeDb } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, readSite, seedOwned, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

/**
 * The operator's publish pause over the wire — E09 task 011.
 *
 * A SEPARATE RUN, on a server booted with the switch on:
 *
 *   KEPT_PUBLISH_PAUSED=true pnpm --filter @kept/web exec playwright test e2e/publish-paused.spec.ts
 *
 * The harness's `webServer` inherits this process's environment, so the server
 * it boots is paused. `reuseExistingServer` would instead keep an unpaused one,
 * which is why the health check runs first and fails loudly on `"on"`. Without
 * the variable the whole file SKIPS — every other spec needs publishing on.
 *
 * 0 KV WRITES. The five page-writing routes answer 503 before they read
 * anything, so nothing publishes; the "still works" half retitles a seeded page
 * (a Postgres write) and asks the name rename and the delete for refusals that
 * come from their own rules — proving the pause never reached them without
 * spending a manifest write or delete.
 */
const PAUSED = process.env.KEPT_PUBLISH_PAUSED?.trim() === "true";
const scope = newScope();

/** The pause's sentence, verbatim from the task. */
const MESSAGE =
  "Publishing on kept is paused for now. Pages already live are not affected. Please try again later.";

/** A real document, so a refusal cannot be blamed on an empty or malformed body. */
const HTML = "<!doctype html><title>paused</title><p>This must never land.</p>";

test.describe("publish pause (KEPT_PUBLISH_PAUSED=true)", () => {
  test.skip(!PAUSED, "run with KEPT_PUBLISH_PAUSED=true — see the header");
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  test.afterAll(async () => {
    if (!PAUSED || SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("/api/health reports publishing: paused", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { publishing?: unknown };
    expect(body.publishing, "the server under test was not started with KEPT_PUBLISH_PAUSED=true").toBe("paused");
  });

  test("every page-writing route answers 503 publishing_paused with Retry-After, before auth or body", async ({
    request,
    baseURL,
  }) => {
    const origin = new URL(baseURL!).origin;
    const siteId = crypto.randomUUID();
    const flat = [
      { label: "POST /api/publish", url: "/api/publish" },
      { label: "POST /api/anon/:token/replace", url: `/api/anon/${"x".repeat(43)}/replace` },
    ];
    const studio = [
      { label: "POST /api/sites", url: "/api/sites", data: HTML, type: "text/html" },
      { label: "POST /api/sites/:id/replace", url: `/api/sites/${siteId}/replace`, data: HTML, type: "text/html" },
      { label: "POST /api/uploads", url: "/api/uploads", data: JSON.stringify({ size_bytes: 1024 }), type: "application/json" },
    ];

    for (const { label, url } of flat) {
      const res = await request.post(url, { headers: { "content-type": "text/html" }, data: HTML });
      expect(res.status(), label).toBe(503);
      expect(res.headers()["retry-after"], label).toBe("600");
      const body = publishErrorSchema.parse(await res.json());
      expect(body, label).toEqual({ error: "publishing_paused", message: MESSAGE, retry_after_seconds: 600 });
    }

    // No session and the app's own origin: the pause answers before either is
    // looked at, so a signed-out caller sees it too.
    for (const { label, url, data, type } of studio) {
      const res = await request.post(url, { headers: { "content-type": type, origin }, data });
      expect(res.status(), label).toBe(503);
      expect(res.headers()["retry-after"], label).toBe("600");
      const body = studioErrorSchema.parse(await res.json());
      expect(body, label).toEqual({ error: { code: "publishing_paused", message: MESSAGE } });
    }
  });

  test("rename and delete are not paused", async ({ page, baseURL }) => {
    test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
    await warmDb();
    const { userId } = await signInAs(page, baseURL!, scope);
    const site = await seedOwned(scope, userId, "E09 paused rename");
    const headers = { origin: new URL(baseURL!).origin };

    // Retitle: a real rename, saved — a Postgres write, no manifest.
    const retitled = await page.request.patch(`${baseURL}/api/sites/${site.siteId}`, {
      headers,
      data: { title: "Retitled while paused" },
    });
    expect(retitled.status(), await retitled.text()).toBe(200);
    expect((await readSite(site.siteId)).title).toBe("Retitled while paused");

    // The name rename reaches its own validation, refusing a two-letter name.
    const renamed = await page.request.patch(`${baseURL}/api/sites/${site.siteId}/name`, {
      headers,
      data: { name: "ab" },
    });
    expect(renamed.status(), await renamed.text()).toBe(400);
    expect(studioErrorSchema.parse(await renamed.json()).error.code).not.toBe("publishing_paused");

    // The delete reaches its ownership lookup: an id that is no page is 404.
    const deleted = await page.request.delete(`${baseURL}/api/sites/${crypto.randomUUID()}`, { headers });
    expect(deleted.status(), await deleted.text()).toBe(404);
    expect(studioErrorSchema.parse(await deleted.json()).error.code).toBe("not_found");
  });
});
