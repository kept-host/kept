import { MAX_PAGE_BYTES } from "@kept/shared";
import { test, expect, type Page } from "@playwright/test";

import {
  deleteDrafts,
  pageHtml,
  servingDomain,
  SKIP_LIVE_PUBLISH,
  trackDrafts,
} from "./live-publish";

/**
 * The hero's publish flow, against the REAL `POST /api/publish`.
 *
 * Nothing here simulates a mint. The engine used to invent a slug from a fixed
 * name array and flip to `live` on a 1700ms `setTimeout`; this spec exists to
 * prove that both are gone. `minting` now lasts exactly as long as the request,
 * which is asserted by holding the request open and watching the phase — never
 * by timing it against a constant.
 *
 * The minted host is read off the response's `live_url` and checked against the
 * CONFIGURED serving domain. A literal `.kept.host` here would fail on the dev
 * track, which serves `*.kept-dev.xyz`, for entirely the wrong reason.
 *
 * The happy paths need the dev stores (Postgres + R2 + KV + purge), so they
 * skip when the credentials are absent — see `./live-publish`. The failure path
 * needs no stores and always runs: it intercepts the route to force a 500,
 * which is the one thing that cannot be provoked for real on demand.
 */

/** One tile face per `Phase`. The engine crossfades them by opacity. */
const face = (page: Page, name: "idle" | "minting" | "live" | "error") =>
  page.locator(`[data-face="${name}"]`);

/** The host written into the live label, once the tile is live. */
const liveLabel = (page: Page) => face(page, "live").locator("span").last();

/** Longer than the deleted 1700ms simulation, short enough to keep the run brisk. */
const HOLD_MS = 3_500;
/** When we check that the tile is STILL minting — past the deleted timer. */
const PAST_OLD_TIMER_MS = 2_400;

const marker = () => `e04-007-${crypto.randomUUID().slice(0, 8)}`;

/** Publish through the hidden file input, exactly as the browse control does. */
async function dropFile(page: Page, html: string) {
  await page.setInputFiles('input[type="file"]', {
    name: "hello.html",
    mimeType: "text/html",
    buffer: Buffer.from(html),
  });
}

/**
 * Publish by pasting. Dispatches the real `paste` event with a real
 * `DataTransfer` on the body, which is what a ⌘V outside a form field produces.
 */
async function pasteHtml(page: Page, html: string) {
  await page.evaluate((markup) => {
    const data = new DataTransfer();
    data.setData("text/plain", markup);
    document.body.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, html);
}

test.describe("publish flow", () => {
  test.describe("against the live publish API", () => {
    test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

    let drafts: Promise<string | null>[] = [];

    test.beforeEach(async ({ page }) => {
      drafts = trackDrafts(page);
    });

    test.afterEach(async ({ request }) => {
      await deleteDrafts(request, drafts);
    });

    test("drop a file → minting lasts as long as the request → live carries the minted slug", async ({
      page,
    }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Hold the REAL request open. The route still runs — this only delays it,
      // so "minting lasts as long as the request" becomes observable instead of
      // being a race against a fast server.
      await page.route("**/api/publish", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        await route.continue();
      });

      const published = page.waitForResponse(
        (res) => res.url().includes("/api/publish") && res.status() === 201,
      );

      await dropFile(page, pageHtml(marker()));

      // Minting begins with the request.
      await expect(face(page, "minting")).toHaveCSS("opacity", "1");

      // …and is still the face well past the moment the deleted 1700ms
      // simulation would have flipped it to live. This is the assertion the
      // whole task turns on: the phase tracks the request, not a timer.
      await page.waitForTimeout(PAST_OLD_TIMER_MS);
      await expect(face(page, "minting")).toHaveCSS("opacity", "1");
      await expect(face(page, "live")).toHaveCSS("opacity", "0");

      const body = (await (await published).json()) as {
        live_url: string;
        slug: string;
      };
      const host = new URL(body.live_url).host;

      // The link is real: minted server-side, on the configured serving domain.
      expect(host).toBe(`${body.slug}.${servingDomain()}`);

      // Live resolves FROM the response — the same host, nothing invented.
      await expect(face(page, "live")).toHaveCSS("opacity", "1");
      await expect(liveLabel(page)).toHaveText(host);
      await expect(face(page, "minting")).toHaveCSS("opacity", "0");

      // A minted page is a DRAFT. The next step offers to keep it — the modal
      // is rendered only once opened, and speaks keep/kept, never "claim".
      await expect(
        page.getByRole("heading", { name: "Keep this page" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: /Keep it & manage it/ }).click();

      await expect(
        page.getByRole("heading", { name: "Keep this page" }),
      ).toBeVisible();
      await expect(
        page.getByText(
          /keeping it stops the 7-day draft clock and puts it in your dashboard/,
        ),
      ).toBeVisible();
      // The pre-pivot "Claim this page" framing is gone entirely.
      await expect(page.getByText(/Claim this page/)).toHaveCount(0);
    });

    test("paste is publish-equivalent: same path, same phases, same minted link", async ({
      page,
    }) => {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const published = page.waitForResponse(
        (res) => res.url().includes("/api/publish") && res.status() === 201,
      );

      await pasteHtml(page, pageHtml(marker()));

      const body = (await (await published).json()) as { live_url: string };
      const host = new URL(body.live_url).host;

      await expect(face(page, "live")).toHaveCSS("opacity", "1");
      await expect(liveLabel(page)).toHaveText(host);
      expect(host.endsWith(`.${servingDomain()}`)).toBe(true);

      // The manage screen is a real URL keyed by the anon token, not a panel.
      await page.getByRole("button", { name: /manage this draft/ }).click();
      await expect(page).toHaveURL(/\/p\/[^/]+$/);
    });

    test("under reduced motion it crossfades straight to live — the engine reads the preference itself", async ({
      page,
    }) => {
      // Before `goto`: the engine reads `prefers-reduced-motion` once, in its
      // constructor, and that decision must stay the engine's — not React's.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const published = page.waitForResponse(
        (res) => res.url().includes("/api/publish") && res.status() === 201,
      );

      await dropFile(page, pageHtml(marker()));

      const body = (await (await published).json()) as { live_url: string };
      const host = new URL(body.live_url).host;

      // No rAF loop runs under reduced motion, so this only passes because the
      // phase transition itself paints the face.
      await expect(face(page, "live")).toHaveCSS("opacity", "1");
      await expect(liveLabel(page)).toHaveText(host);
      await expect(face(page, "idle")).toHaveCSS("opacity", "0");
    });
  });

  test("a failed publish lands on the error face, keeps the message, and returns to idle", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const message = "Something went wrong on our side. Nothing was published.";
    await page.route("**/api/publish", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "internal_error", message }),
      });
    });

    await dropFile(page, pageHtml(marker()));

    // The API's own words, on the tile — not a generic client string.
    await expect(face(page, "error")).toHaveCSS("opacity", "1");
    await expect(face(page, "error")).toContainText(message);
    await expect(face(page, "live")).toHaveCSS("opacity", "0");

    // Retry returns the tile to the drop box. Nothing was published, so there
    // is nothing to recover.
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(face(page, "idle")).toHaveCSS("opacity", "1");
    await expect(face(page, "error")).toHaveCSS("opacity", "0");
    await expect(page.getByText("Drop your HTML").first()).toBeVisible();
  });

  test("a non-HTML file is refused before the network, and prose pasted by accident is ignored", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    let requests = 0;
    await page.route("**/api/publish", async (route) => {
      requests += 1;
      await route.abort();
    });

    // A `.txt` dropped on the tile. `checkPageFile` reads the MIME type first
    // and falls back to the extension for the browsers that hand over an empty
    // one — either way this never reaches the wire, so the visitor gets the
    // sentence immediately instead of a round trip and a 400.
    await page.setInputFiles('input[type="file"]', {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("just some notes, not a page"),
    });

    await expect(face(page, "error")).toHaveCSS("opacity", "1");
    await expect(face(page, "error")).toContainText(
      "kept hosts a single HTML document",
    );
    expect(requests, "a non-HTML file reached the network").toBe(0);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(face(page, "idle")).toHaveCSS("opacity", "1");

    // …and a ⌘V of ordinary prose does not even become an error: without the
    // markup guard, copying a sentence and pasting it on the landing page
    // would publish it. Nothing happens at all — the tile stays idle.
    await pasteHtml(page, "Reminder: buy milk on the way home.");

    await expect(face(page, "idle")).toHaveCSS("opacity", "1");
    await expect(face(page, "error")).toHaveCSS("opacity", "0");
    await expect(face(page, "minting")).toHaveCSS("opacity", "0");
    expect(requests, "pasted prose reached the network").toBe(0);
  });

  test("an oversized page fails before the network — the byte cap is shared, not guessed", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    let requests = 0;
    await page.route("**/api/publish", async (route) => {
      requests += 1;
      await route.abort();
    });

    // One byte over the shared cap — the constant comes from `@kept/shared`,
    // the same module the client and the route read it from. The file is built
    // in the browser so the buffer never crosses the wire.
    await page.evaluate((limit) => {
      const input = document.querySelector('input[type="file"]')!;
      const oversized = new File([new Uint8Array(limit + 1)], "big.html", {
        type: "text/html",
      });
      const data = new DataTransfer();
      data.items.add(oversized);
      (input as HTMLInputElement).files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, MAX_PAGE_BYTES);

    await expect(face(page, "error")).toHaveCSS("opacity", "1");
    await expect(face(page, "error")).toContainText(/over the .* limit/);
    expect(requests).toBe(0);
  });
});
