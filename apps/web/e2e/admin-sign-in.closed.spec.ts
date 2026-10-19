import { test, expect } from "@playwright/test";
import { config } from "dotenv";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { keptOpen } from "../lib/launch";
import { waitlistHref } from "../lib/routing/host-split";
import { drillIp } from "../lib/testing/drill-ip";

import { pageHtml, publishViaApi, SKIP_LIVE_PUBLISH } from "./live-publish";
import { LIVE_STACK_TIMEOUT, skipAuth, warmDb } from "./live-stack";
import { cleanup, newScope } from "./owner-fixtures";

/**
 * Admin-only sign-in on a CLOSED deploy — E06a task 003 (PRD §2, D7). Run with
 *
 *   pnpm --filter @kept/web test:e2e:closed
 *
 * `playwright.config.ts` makes ONE admin for the run (`KEPT_E2E_ADMIN_EMAIL`, a
 * labelled Resend test address, the server's whole `KEPT_ADMIN_EMAILS`) and one
 * access token. Nothing here prints either.
 *
 *   AC4 — a stranger's magic-link request sends nothing and reads exactly like
 *         an admin's; a stranger's link (minted, never mailed) makes no user,
 *         no session and no cookie; a `not_open` bounce reads "kept isn't open
 *         yet" with the waitlist link.
 *   AC5 — the admin signs in, lands on /dashboard, and keeps a token-published
 *         page through its claim link.
 *
 * The OAuth refusal is server-side identical to the magic-link one (the same
 * two Better Auth hooks) and is proved at the adapter entry points the OAuth
 * callback calls, in `lib/auth/closed-sign-in.test.ts`; driving it here needs a
 * human at a GitHub or Google consent screen, so that half is skipped below.
 *
 * The inbox is the one thing substituted for the verify leg: the verification
 * value is written through the plugin's own storage contract and the REAL
 * `/api/auth/magic-link/verify` is opened, as in `anon-keep-flow.spec.ts`.
 */

config({ path: ".env.local", quiet: true });

const SKIP_AUTH = skipAuth();

const NEUTRAL = "If this address can sign in, a link is on its way.";

const runId = crypto.randomUUID().slice(0, 8);
/**
 * `.invalid`, never mailable. The harness runs with `KEPT_EMAIL_DELIVERY=off`,
 * so here a send to it would not surface as an error; that "nothing was sent"
 * proof is `lib/auth/closed-sign-in.test.ts`, which runs with delivery on.
 */
const stranger = `stranger-${runId}@kept-e06a-003.invalid`;

test.describe("closed deploy — who may sign in", () => {
  test.skip(keptOpen(), "the harness is open — run `pnpm test:e2e:closed` for this file");

  test.beforeAll(async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(
      ((await health.json()) as { open: boolean }).open,
      "the server on :3000 is open — stop it and rerun test:e2e:closed",
    ).toBe(false);
  });

  test.beforeEach(({ page }) => page.setExtraHTTPHeaders({ "cf-connecting-ip": drillIp() }));

  test("AC4: a not_open bounce says kept isn't open yet and links the waitlist", async ({
    page,
  }) => {
    await page.goto("/auth?error=not_open&error_description=not_open");
    await expect(page.getByRole("heading", { name: "kept isn't open yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Join the waitlist" })).toHaveAttribute(
      "href",
      waitlistHref(process.env.NEXT_PUBLIC_APP_URL),
    );
  });

  test("AC4: OAuth refusal end to end", () => {
    test.skip(
      true,
      "needs a human at a real GitHub/Google consent screen — the hook refusal is proved at " +
        "createOAuthUser/createSession in lib/auth/closed-sign-in.test.ts, the screen above",
    );
  });

  test.describe("against the real auth stack", () => {
    test.skip(!!SKIP_AUTH, SKIP_AUTH || undefined);
    test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });

    const admin = process.env.KEPT_E2E_ADMIN_EMAIL!;
    // The admin, and every page it owns — the kept page's manifest and R2
    // object included — unwound by `cleanup()`.
    const scope = newScope();

    test.beforeAll(warmDb);
    test.afterAll(async () => {
      await cleanup(scope);
      await closeDb();
    });

    const usersWithEmail = async (email: string) =>
      (
        await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email))
      ).map((row) => row.id);

    /** A magic link for `email`, issued the way the plugin issues one. */
    async function magicLink(email: string, callbackURL: string): Promise<string> {
      const { auth } = await import("../lib/auth");
      const ctx = await auth.$context;
      const token = crypto.randomUUID().replace(/-/g, "");
      await ctx.internalAdapter.createVerificationValue({
        identifier: token,
        value: JSON.stringify({ email, name: "E06a-003 drill" }),
        expiresAt: new Date(Date.now() + 300_000),
      });
      return `/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(callbackURL)}`;
    }

    test("AC4: a stranger and the admin get the same answer; only the admin's is sent", async ({
      page,
    }) => {
      expect(admin, "playwright.config.ts sets KEPT_E2E_ADMIN_EMAIL for a closed run").toBeTruthy();
      const answers: { status: number; body: unknown }[] = [];

      for (const email of [stranger, admin]) {
        await page.setExtraHTTPHeaders({ "cf-connecting-ip": drillIp() });
        await page.goto("/auth");
        await page.getByLabel("Email").fill(email);
        const sent = page.waitForResponse(
          (res) => res.url().includes("/sign-in/magic-link") && res.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Email me a magic link" }).click();
        const response = await sent;
        answers.push({ status: response.status(), body: await response.json() });

        // The panel for a send that never happened (stranger) or succeeded
        // (admin) — the same panel, which is the point.
        await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible({
          timeout: 20_000,
        });
        await expect(page.getByText(NEUTRAL)).toBeVisible();
        await expect(page.getByText(email)).toHaveCount(0);
      }

      expect(answers[0]).toEqual({ status: 200, body: { status: true } });
      expect(answers[1]).toEqual(answers[0]);
      expect(await usersWithEmail(stranger)).toEqual([]);
    });

    test("AC4: a stranger's link makes no user, no session and no Set-Cookie", async ({
      request,
    }) => {
      const response = await request.get(await magicLink(stranger, "/dashboard"), {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("not_open");
      expect(response.headers()["set-cookie"]).toBeUndefined();
      expect(await usersWithEmail(stranger)).toEqual([]);
    });

    test("AC5: the admin signs in, sees /dashboard, and keeps a token-published page", async ({
      page,
      baseURL,
    }) => {
      test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

      await page.goto(`${baseURL}${await magicLink(admin, "/dashboard")}`);
      await expect(page).toHaveURL("/dashboard", { timeout: LIVE_STACK_TIMEOUT });
      const [adminId] = await usersWithEmail(admin);
      expect(adminId).toBeTruthy();
      scope.userIds.push(adminId!);

      const token = process.env.KEPT_E2E_ACCESS_TOKEN!;
      const published = await publishViaApi(
        page.request,
        pageHtml(`closed-ac5-${crypto.randomUUID()}`),
        { authorization: `Bearer ${token}` },
      );
      expect(published.status(), await published.text()).toBe(201);
      const { claim_url } = (await published.json()) as { claim_url: string };

      await page.goto(new URL(claim_url).pathname);
      await page.getByRole("button", { name: "Keep it forever" }).click();
      await expect(page.getByRole("heading", { name: "Kept forever" })).toBeVisible({
        timeout: LIVE_STACK_TIMEOUT,
      });

      const kept = await db
        .select({ id: schema.sites.id, expiresAt: schema.sites.expiresAt })
        .from(schema.sites)
        .where(eq(schema.sites.ownerId, adminId!));
      expect(kept).toHaveLength(1);
      expect(kept[0]!.expiresAt, "kept means no clock").toBeNull();
    });
  });
});
