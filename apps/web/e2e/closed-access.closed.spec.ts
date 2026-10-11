import { test, expect, type APIRequestContext } from "@playwright/test";
import { config } from "dotenv";
import { count } from "drizzle-orm";

import { closeDb, db } from "../lib/db";
import { sites } from "../lib/db/schema";
import { keptOpen } from "../lib/launch";
import { mintAccessToken } from "../lib/access-token";
import { waitlistHref } from "../lib/routing/host-split";

import { pageHtml, publishViaApi, SKIP_LIVE_PUBLISH } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";

/**
 * A CLOSED deploy's API — E06a task 002 (PRD §1, §2). Run with
 *
 *   pnpm --filter @kept/web test:e2e:closed
 *
 * which boots the server closed and, in `playwright.config.ts`, mints ONE
 * access token for the run: its digest goes into the server's
 * `KEPT_ACCESS_TOKEN_HASHES`, the token into `KEPT_E2E_ACCESS_TOKEN`. Neither is
 * printed. A server already on :3000 was not booted with that digest, so this
 * file insists on a closed server it booted itself (see `beforeAll`).
 *
 *   AC1 — no credential: the JSON `not_open` 404, from the middleware.
 *   AC2 — an unknown token: the same 404 from the handler, before the body is
 *         read, and no row afterwards.
 *   AC3 — the run's token: an ordinary anonymous publish, `claim_url` included.
 *   AC7 — `/api/cron/*` reaches its own secret check: 401, not 404.
 */

config({ path: ".env.local", quiet: true });

const NOT_OPEN = {
  error: "not_open",
  message: "kept opens in December.",
  waitlist: waitlistHref(process.env.NEXT_PUBLIC_APP_URL),
};

const CRON_REQUIRED = ["DATABASE_URL", "RESEND_API_KEY", "EMAIL_FROM", "CRON_SECRET"] as const;
const missingCron = CRON_REQUIRED.filter((name) => !process.env[name]?.trim());

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function expectNotOpen(response: Awaited<ReturnType<APIRequestContext["post"]>>) {
  expect(response.status(), response.url()).toBe(404);
  expect(await response.json(), response.url()).toEqual(NOT_OPEN);
  expect(response.headers()["set-cookie"], response.url()).toBeUndefined();
}

test.describe("closed deploy — who may publish", () => {
  test.skip(keptOpen(), "the harness is open — run `pnpm test:e2e:closed` for this file");

  test.beforeAll(async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(
      ((await health.json()) as { open: boolean }).open,
      "the server on :3000 is open — stop it and rerun test:e2e:closed",
    ).toBe(false);
  });

  test("AC1: without a credential, publish and the anon routes are the JSON not_open 404", async ({
    request,
  }) => {
    await expectNotOpen(await publishViaApi(request, pageHtml("closed-ac1")));
    await expectNotOpen(await request.post("/api/anon/tok_e2e/replace", { data: "x" }));
    await expectNotOpen(await request.post("/api/anon/tok_e2e/keep"));
    await expectNotOpen(await request.delete("/api/anon/tok_e2e"));
    await expectNotOpen(await request.get("/api/no-such-route"));
  });

  test("AC1: sign-in's API is reachable and mints no session", async ({ request }) => {
    const response = await request.get("/api/auth/get-session");
    expect(response.status()).toBe(200);
    expect(await response.json()).toBeNull();
    expect(response.headers()["set-cookie"]).toBeUndefined();
  });

  test.describe("against the real database", () => {
    test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));
    // AC2 counts every site row; AC3 adds one. In order, never side by side.
    test.describe.configure({ mode: "serial" });
    test.setTimeout(LIVE_STACK_TIMEOUT);
    test.beforeAll(warmDb);
    test.afterAll(closeDb);

    const siteCount = async () => (await db.select({ n: count() }).from(sites))[0]!.n;

    test("AC2: an unknown token is refused before the body is read, and writes nothing", async ({
      request,
    }) => {
      const unknown = (await mintAccessToken()).token;
      const before = await siteCount();

      // Malformed JSON: an open deploy answers it 400 `invalid_request`. A 404
      // here proves the handler refused before it parsed anything.
      const publish = await request.post("/api/publish", {
        headers: { ...bearer(unknown), "content-type": "application/json" },
        data: "{not json",
      });
      await expectNotOpen(publish);

      const replace = await request.post("/api/anon/tok_e2e/replace", {
        headers: { ...bearer(unknown), "content-type": "application/json" },
        data: "{not json",
      });
      await expectNotOpen(replace);

      expect(await siteCount()).toBe(before);
    });

    test("AC3: the run's access token publishes an ordinary draft, claim link included", async ({
      request,
    }) => {
      const token = process.env.KEPT_E2E_ACCESS_TOKEN;
      expect(
        token,
        "playwright.config.ts mints KEPT_E2E_ACCESS_TOKEN for a closed run",
      ).toBeTruthy();

      const response = await publishViaApi(
        request,
        pageHtml(`closed-ac3-${crypto.randomUUID()}`),
        bearer(token!),
      );
      expect(response.status(), await response.text()).toBe(201);
      const body = (await response.json()) as {
        live_url: string;
        claim_url: string;
        anonToken: string;
        expires_in: string;
      };
      expect(body.claim_url).toContain(`/keep/${body.anonToken}`);
      expect(body.expires_in).toBe("7d");

      // The anon routes take the same token: the draft comes down again.
      const deleted = await request.delete(`/api/anon/${body.anonToken}`, {
        headers: bearer(token!),
      });
      expect(deleted.status(), await deleted.text()).toBe(200);
    });
  });

  test("AC7: the cron routes reach their secret check — 401, not 404", async ({ request }) => {
    for (const path of ["/api/cron/draft-reminder", "/api/cron/visits-sync"]) {
      const response = await request.post(path);
      expect(response.status(), path).toBe(401);
    }
  });

  test("AC7: with the secret, the reminder cron answers as it does open", async ({ request }) => {
    test.skip(missingCron.length > 0, `cron credentials absent (${missingCron.join(", ")})`);
    const response = await request.post("/api/cron/draft-reminder", {
      headers: bearer(process.env.CRON_SECRET!),
    });
    expect(response.status(), await response.text()).toBe(200);
  });
});
