import { siteUpdateResultSchema, studioErrorSchema } from "@kept/shared";
import { expect, test } from "@playwright/test";

import { closeDb } from "../lib/db";

import { servingDomain } from "./live-publish";
import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, publishOwned, readSite, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";
import { jarlessContext } from "./session-request";

/**
 * `PATCH /api/sites/:id` over the wire — AC44 for the Details route. E06 task
 * 012.
 *
 * `lib/sites/details.test.ts` proves every rule of the function the route
 * delegates to. What only the wire can prove is the half the route file adds:
 * the E05a origin gate runs FIRST (a hosted page retitling its publisher's
 * other pages is the same-site CSRF `SameSite` cannot stop), the session is
 * required, and another account's page is the not-found envelope — never 403,
 * which would confirm the page exists.
 *
 * Two real magic-link sessions in two browser contexts; real rows re-read after
 * every refusal. SKIPS without dev credentials.
 */
const scope = newScope();

test.describe("PATCH /api/sites/:id (AC44)", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  test("a hosted page's origin is refused, signed out is 401, another account gets not-found, and the owner saves", async ({
    page,
    browser,
    baseURL,
  }) => {
    await signInAs(page, baseURL!, scope);
    const site = await publishOwned(page, baseURL!, scope, "E06 details api");
    const url = `${baseURL}/api/sites/${site.siteId}`;
    const appOrigin = new URL(baseURL!).origin;

    // A real session cookie, sent from a HOSTED page's origin: refused before
    // the body is read, and nothing is written.
    const foreign = await page.request.patch(url, {
      headers: { origin: `https://${site.slug}.${servingDomain()}` },
      data: { title: "Retitled from a hosted page" },
    });
    expect(foreign.status()).toBe(403);
    expect((await readSite(site.siteId)).title).toBe(site.title);

    // No session at all.
    const anonymous = await jarlessContext();
    try {
      const signedOut = await anonymous.patch(url, {
        headers: { origin: appOrigin },
        data: { title: "Anyone" },
      });
      expect(signedOut.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }

    // Another account: the same body as an id that never existed.
    const strangerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const stranger = await strangerContext.newPage();
      await signInAs(stranger, baseURL!, scope);
      const stolen = await stranger.request.patch(url, {
        headers: { origin: appOrigin },
        data: { title: "Hijacked", listedPublic: true },
      });
      const absent = await stranger.request.patch(`${baseURL}/api/sites/${crypto.randomUUID()}`, {
        headers: { origin: appOrigin },
        data: { title: "Hijacked" },
      });
      expect(stolen.status()).toBe(404);
      expect(absent.status()).toBe(404);
      const stolenBody = studioErrorSchema.parse(await stolen.json());
      expect(stolenBody.error.code).toBe("not_found");
      expect(stolenBody).toEqual(studioErrorSchema.parse(await absent.json()));
    } finally {
      await strangerContext.close();
    }
    const untouched = await readSite(site.siteId);
    expect(untouched.title).toBe(site.title);
    expect(untouched.listedPublic).toBe(false);

    // The owner, from the app's own origin.
    const saved = await page.request.patch(url, {
      headers: { origin: appOrigin },
      data: { title: "The owner's title", listedPublic: true },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const { site: body } = siteUpdateResultSchema.parse(await saved.json());
    expect(body.title).toBe("The owner's title");
    expect(body.titleSource).toBe("owner");
    expect(body.listedPublic).toBe(true);
  });
});
