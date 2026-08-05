import { DRAFT_TTL_DAYS } from "@kept/shared";
import { test, expect, type Page } from "@playwright/test";

import {
  controlPlaneUrl,
  deleteDraft,
  pageHtml,
  publishViaApi,
  SKIP_LIVE_PUBLISH,
} from "./live-publish";

/**
 * The two anon-token screens, against a page that was really published:
 * `/p/[anonToken]` (task 008, the manage console) and `/keep/[anonToken]`
 * (task 009, the page an agent hands a human).
 *
 * Both are `force-dynamic` server components reading Postgres and R2 with a
 * credential the browser never sees, so there is nothing to assert here without
 * a real publish — every test below starts by making one and ends by deleting
 * it. Skips without dev credentials, like every other live spec in this suite;
 * `publish-api.spec.ts` carries the always-running gate test that says so.
 *
 * THE QR ASSERTION IS THE LOAD-BEARING ONE. A QR code is the classic place a
 * third-party image service sneaks in, and this product hands the URL of
 * somebody's page to whatever renders it. The encoder runs in a server component
 * and the finished SVG is inlined, so the correct number of off-origin requests
 * on this screen is ZERO — asserted over every request the page makes, not just
 * the ones near the QR panel.
 */

const marker = () => `e04-010-screen-${crypto.randomUUID().slice(0, 8)}`;

interface Draft {
  slug: string;
  live_url: string;
  claim_url: string;
  anonToken: string;
  expires_at: string;
}

/**
 * Every HTTP request the page makes, split by origin, from before the first
 * byte. `all` is kept so the off-origin assertion cannot pass vacuously: an
 * empty `offOrigin` next to an empty `all` would only prove the listener never
 * fired.
 */
function trackRequests(page: Page): { all: string[]; offOrigin: string[] } {
  const seen = { all: [] as string[], offOrigin: [] as string[] };
  const origin = new URL(controlPlaneUrl).host;
  page.on("request", (request) => {
    const url = new URL(request.url());
    // `about:srcdoc` and `data:` are not network requests; only an HTTP(S) call
    // to another host is a third party.
    if (!url.protocol.startsWith("http")) return;
    seen.all.push(request.url());
    if (url.host !== origin) seen.offOrigin.push(request.url());
  });
  return seen;
}

test.describe("the anon-token screens", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));
  // Chromium refuses `navigator.clipboard` without these, and the copy control
  // is the single most important thing on the result screen.
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  let draft: Draft;
  let html: string;

  test.beforeEach(async ({ request }) => {
    // A unique document every time: identical bytes from the same publisher
    // dedup onto one page, which would couple these tests to each other.
    html = pageHtml(marker());
    const res = await publishViaApi(request, html);
    expect(res.status(), await res.text()).toBe(201);
    draft = (await res.json()) as Draft;
  });

  test.afterEach(async ({ request }) => {
    await deleteDraft(request, draft.anonToken);
  });

  test("/p — the live URL, the page's own bytes, and a countdown built from DRAFT_TTL_DAYS", async ({
    page,
  }) => {
    await page.goto(`/p/${draft.anonToken}`);

    const host = new URL(draft.live_url).host;
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(host);

    // The preview frames the published bytes, read from R2 server-side —
    // `srcdoc`, never `src`, because hosted pages are served `frame-ancestors
    // 'none'`.
    const preview = page.locator("iframe");
    await expect(preview).toHaveAttribute("srcdoc", html);
    await expect(preview).toHaveAttribute("sandbox", "");

    // A seven-day draft reads as seven days because the constant says so — the
    // expected string is composed from `DRAFT_TTL_DAYS`, not typed out.
    const chip = page.locator("time");
    await expect(chip).toHaveText(`Draft · ${DRAFT_TTL_DAYS} days left`);
    const deadline = await chip.getAttribute("datetime");
    expect(new Date(deadline!).getTime()).toBe(new Date(draft.expires_at).getTime());
  });

  test("/p — copying the link flashes, announces, and puts the real URL on the clipboard", async ({
    page,
  }) => {
    await page.goto(`/p/${draft.anonToken}`);

    await page.getByRole("button", { name: "Copy link" }).click();

    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    // The flash is visual; this is what a screen reader gets instead.
    await expect(page.getByText("Link copied to the clipboard.")).toHaveCount(1);

    // The flash is not the assertion — what landed on the clipboard is.
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(draft.live_url);
  });

  test("/p — the QR renders inline, with zero third-party requests on the whole screen", async ({
    page,
  }) => {
    const requests = trackRequests(page);

    await page.goto(`/p/${draft.anonToken}`);
    await page.waitForLoadState("networkidle");

    const qr = page.getByRole("img", { name: `QR code for ${draft.live_url}` });
    // Rendered on the server, but inside a closed panel until asked for.
    await expect(qr).toBeHidden();

    await page.getByRole("button", { name: "QR" }).click();
    await expect(qr).toBeVisible();
    // Geometry and two token references — no <img>, so nothing to fetch.
    await expect(qr.locator("path")).toHaveCount(1);

    expect(requests.all.length, "no requests were observed at all").toBeGreaterThan(0);
    expect(
      requests.offOrigin,
      `third-party requests: ${requests.offOrigin.join(", ")}`,
    ).toEqual([]);
  });

  test("/p — the reminder address is accepted and confirmed", async ({ page }) => {
    await page.goto(`/p/${draft.anonToken}`);

    const stored = page.waitForResponse(
      (res) => res.url().includes("/reminder") && res.request().method() === "POST",
    );
    await page
      .getByLabel("Email me before this draft expires")
      .fill("reminder-drill@example.com");
    await page.getByRole("button", { name: "Save" }).click();

    expect((await stored).status()).toBe(200);
    // Stops at "stored" deliberately: E04 persists the address, E05 sends.
    await expect(page.getByText(/Saved\. It's stored with this page/)).toBeVisible();
    // That the address is really on the row — and that saving an empty value
    // clears it — is asserted against Postgres in `lib/publish/anon-manage.test.ts`.
    // The form never reads a stored address back, so a leaked link cannot reveal
    // that one exists; there is nothing on this screen to assert it from.

    const cleared = page.waitForResponse(
      (res) => res.url().includes("/reminder") && res.request().method() === "POST",
    );
    await page.getByLabel("Email me before this draft expires").fill("");
    await page.getByRole("button", { name: "Save" }).click();
    expect((await cleared).status()).toBe(200);
    await expect(page.getByText("Cleared. No address is stored for this page.")).toBeVisible();
  });

  test("/p — 'Keep it forever' is a real URL, and it lands on the claim page", async ({
    page,
  }) => {
    await page.goto(`/p/${draft.anonToken}`);

    await page.getByRole("link", { name: /Keep it forever/ }).click();

    await expect(page).toHaveURL(`/keep/${draft.anonToken}`);
    await expect(
      page.getByRole("heading", { name: "It is live — but not permanent yet" }),
    ).toBeVisible();
    // The claim link the API handed out is the same one the screen links to.
    expect(draft.claim_url.endsWith(`/keep/${draft.anonToken}`)).toBe(true);
  });

  test("/keep — a stranger with no context can read it, and cannot break anything", async ({
    page,
  }) => {
    const requests = trackRequests(page);
    await page.goto(`/keep/${draft.anonToken}`);

    // What kept is, what the clock is, what keeping does — in that order.
    await expect(page.getByText("Someone shared this page with you")).toBeVisible();
    await expect(
      page.getByText(/kept gives a single web page a permanent home, free/),
    ).toBeVisible();
    await expect(
      page.getByText(new RegExp(`${DRAFT_TTL_DAYS} days from when it went live`)),
    ).toBeVisible();
    await expect(page.locator("time")).toHaveText(`Draft · ${DRAFT_TTL_DAYS} days left`);

    // The page it is being asked to keep, and the address it lives at.
    await expect(page.locator("iframe")).toHaveAttribute("srcdoc", html);
    await expect(
      page.getByRole("link", { name: new URL(draft.live_url).host }),
    ).toHaveAttribute("href", draft.live_url);

    // One button, honestly disabled, with the reason stated next to it (E05).
    const keep = page.getByRole("button", { name: "Keep it forever" });
    await expect(keep).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(/accounts are not open yet/)).toBeVisible();

    // IT IS NOT THE MANAGE SCREEN. A stranger handed a link must not be one
    // click from deleting somebody's page.
    for (const control of ["Copy link", "QR", "Replace", "Delete"]) {
      await expect(page.getByRole("button", { name: control })).toHaveCount(0);
    }

    expect(requests.all.length, "no requests were observed at all").toBeGreaterThan(0);
    expect(
      requests.offOrigin,
      `third-party requests: ${requests.offOrigin.join(", ")}`,
    ).toEqual([]);
  });
});

test.describe("an anon token that resolves to nothing", () => {
  // Still a live spec: both screens answer from Postgres.
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

  test("both screens answer with the same friendly, uninformative 404", async ({ page }) => {
    // Unknown, and malformed. Distinguishing them would turn a token guess into
    // a probe for whether somebody's page exists.
    for (const token of [crypto.randomUUID().replace(/-/g, ""), "not-a-token"]) {
      for (const prefix of ["/p", "/keep"]) {
        const response = await page.goto(`${prefix}/${token}`);
        expect(response?.status(), `${prefix}/${token}`).toBe(404);
        // A typographic apostrophe (`&rsquo;`), matched loosely so the copy can
        // be re-punctuated without breaking the security property under test.
        await expect(
          page.getByRole("heading", { name: /doesn.t open a page/ }),
        ).toBeVisible();
      }
    }
  });
});
