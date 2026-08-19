import { DRAFT_TTL_DAYS, KEPT_PAGE_LIMIT } from "@kept/shared";
import { test, expect, type Page } from "@playwright/test";

import {
  DELETE_GRACE_NOTE,
  REPLACE_CLOCK_NOTE,
} from "../components/kept/draft-chip";
import {
  controlPlaneUrl,
  deleteDraft,
  pageHtml,
  publishViaApi,
  SKIP_LIVE_PUBLISH,
} from "./live-publish";
import { LIVE_STACK_TIMEOUT } from "./live-stack";

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
  /**
   * Every test here publishes for real and reads the bytes back out of R2, so
   * the whole describe belongs to the live-stack family and not to Playwright's
   * 30 s default.
   *
   * This file was missed when that budget was applied elsewhere, and the reason
   * is worth recording: `test.setTimeout(60_000)` further down looks like the
   * describe is already covered, but it sits INSIDE one test's body and applies
   * to that test alone. `describe.configure` is the one that reaches every test.
   */
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });
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

  test("/p — the manage URL is a bearer credential, and the screen treats it as one", async ({
    page,
  }) => {
    await page.goto(`/p/${draft.anonToken}`);

    // A manage link in a search index is somebody else's delete button.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /nofollow/,
    );
    // Without this, every outbound navigation from this document hands the
    // token to whatever it lands on — including the visitor's own hosted page.
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );

    // The one link that leaves the origin opens a new tab and is pinned on
    // BOTH counts: `noopener` so the opened page cannot reach back through
    // `window.opener`, `noreferrer` because the document-level policy above is
    // belt-and-braces for the link that matters most.
    const open = page.getByRole("link", { name: "Open" });
    await expect(open).toHaveAttribute("href", draft.live_url);
    await expect(open).toHaveAttribute("target", "_blank");
    const rel = (await open.getAttribute("rel")) ?? "";
    expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));

    // The live dot is DATA — it reads the row's status, and this row is live.
    await expect(page.getByText("Live", { exact: true })).toHaveCount(1);

    // The edge case the PRD names outright: the visitor closes this tab. The
    // warning has to be on the screen, not in the docs.
    await expect(
      page.getByText("This link is the only handle on this page."),
    ).toBeVisible();
    await expect(page.getByText(/Bookmark it, or leave an address above/)).toBeVisible();

    // Same guarantees under the dark theme — the status label and the warning
    // are the two things on this screen a publisher acts on.
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1);
    await expect(page.getByText("Live", { exact: true })).toHaveCount(1);
    await expect(
      page.getByText("This link is the only handle on this page."),
    ).toBeVisible();
  });

  test("/p — replacing swaps the bytes at the same link and leaves the clock alone", async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto(`/p/${draft.anonToken}`);

    const chip = page.locator("time");
    const deadlineBefore = await chip.getAttribute("datetime");

    await page.getByRole("button", { name: "Replace" }).click();

    // The panel says what a replace does and does not do, in words built from
    // `DRAFT_TTL_DAYS` — the publisher is told before they act, not after.
    await expect(page.getByText(REPLACE_CLOCK_NOTE)).toBeVisible();

    const replacement = pageHtml(marker());
    const replaced = page.waitForResponse(
      (res) => res.url().includes("/replace") && res.request().method() === "POST",
    );
    await page.getByLabel("…or paste the HTML").fill(replacement);
    await page.getByRole("button", { name: "Replace with this" }).click();

    expect((await replaced).status()).toBe(200);
    await expect(
      page.getByText("Replaced. The new version is live at the same link."),
    ).toBeVisible();

    // The screen re-reads the row and the stored bytes, so the preview shows
    // the version that is actually being served now — not the one dropped
    // first. A stale frame here is the product's most visible failure: "I
    // re-dropped my file and nothing changed."
    await expect(page.locator("iframe")).toHaveAttribute("srcdoc", replacement);

    // …and the URL and the deadline are both untouched. If a replace restarted
    // the window, a weekly re-drop would hold a page forever for free.
    await expect(
      page.getByRole("heading", { level: 1 }),
    ).toHaveText(new URL(draft.live_url).host);
    await expect(chip).toHaveAttribute("datetime", deadlineBefore!);
  });

  test("/p — delete confirms in a real dialog, never window.confirm, and ends in a terminal state", async ({
    page,
  }) => {
    // A native dialog cannot be styled, cannot be tested in-page and is
    // suppressible by the browser. If one ever fires here this list is
    // non-empty and the test fails — Playwright would otherwise dismiss it
    // silently and the assertion below would pass for the wrong reason.
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });

    await page.goto(`/p/${draft.anonToken}`);
    const host = new URL(draft.live_url).host;

    await page.getByRole("button", { name: "Delete" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Stop serving this page?" }),
    ).toBeVisible();
    // The words matter: the page STOPS SERVING, it is not destroyed, and the
    // grace window would contradict "deleted forever".
    await expect(dialog.getByText(DELETE_GRACE_NOTE)).toBeVisible();

    // Backing out is a real option, and it leaves everything exactly as it was.
    await dialog.getByRole("button", { name: "Keep it online" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    const stopped = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/anon/${draft.anonToken}`) &&
        res.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Stop serving it" }).click();
    expect((await stopped).status()).toBe(200);

    // The terminal state. Everything else on the screen acted on a page that
    // was still being served, so none of it may stay on offer once it is not.
    await expect(
      page.getByRole("heading", { name: `${host} has stopped serving` }),
    ).toBeVisible();
    await expect(page.getByText("Not serving")).toBeVisible();
    await expect(page.getByText(DELETE_GRACE_NOTE)).toBeVisible();
    for (const control of ["Copy link", "Replace", "Delete", "QR"]) {
      await expect(page.getByRole("button", { name: control })).toHaveCount(0);
    }

    expect(
      nativeDialogs,
      `a native dialog fired: ${nativeDialogs.join(" | ")}`,
    ).toEqual([]);
  });

  test("/p — 'Keep it forever' is a real URL, and it lands on the claim page", async ({
    page,
  }) => {
    await page.goto(`/p/${draft.anonToken}`);

    await page.getByRole("link", { name: /Keep it forever/ }).click();

    // The default 5 s EXPECT budget, not the 60 s test budget, is what fired
    // here: `/keep` resolves the token against remote Neon and reads the
    // preview bytes from R2 before it renders, which is comfortably over 5 s
    // from a laptop. `test.setTimeout` does not widen a per-assertion wait.
    await expect(page).toHaveURL(`/keep/${draft.anonToken}`, { timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: "It is live — but not permanent yet" }),
    ).toBeVisible();
    // The claim link the API handed out is the same one the screen links to.
    expect(draft.claim_url.endsWith(`/keep/${draft.anonToken}`)).toBe(true);
  });

  test("/keep — noindex, no-referrer, and the token appears in no link on the page", async ({
    page,
  }) => {
    await page.goto(`/keep/${draft.anonToken}`);

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );

    // THE TOKEN IS IN THIS PAGE'S PATH AND MUST BE IN NOTHING ELSE. The claim
    // link is the one an agent hands to a stranger, so a token that leaked into
    // an `href` would ride out in a `Referer` — or be copied by anyone who
    // right-clicks the link to somebody else's page.
    const hrefs = await page
      .locator("[href]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") ?? ""));
    expect(hrefs.length, "no links were found at all").toBeGreaterThan(0);
    expect(
      hrefs.filter((href) => href.includes(draft.anonToken)),
      "the anon token leaked into a link on the claim page",
    ).toEqual([]);

    // The hosted page's own address is linked, and pinned like the manage
    // screen's — `noreferrer` because the destination is the visitor's own
    // page and the token is in this document's URL.
    const live = page.getByRole("link", { name: new URL(draft.live_url).host });
    await expect(live).toHaveAttribute("rel", /noopener/);
    await expect(live).toHaveAttribute("rel", /noreferrer/);
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
    // The clock is the chip's job, asserted on `time` below. The prose used to
    // restate "N days from when it went live" as well; that duplication was cut,
    // so what the body must still carry is what KEEPING does.
    await expect(page.getByText(/Keeping takes the clock off/)).toBeVisible();
    await expect(page.locator("time")).toHaveText(`Draft · ${DRAFT_TTL_DAYS} days left`);

    // The page it is being asked to keep, and the address it lives at.
    await expect(page.locator("iframe")).toHaveAttribute("srcdoc", html);
    await expect(
      page.getByRole("link", { name: new URL(draft.live_url).host }),
    ).toHaveAttribute("href", draft.live_url);

    // One button, live since E05 task 009, with the reason stated next to it.
    // It submits a form rather than following a link: the token is a bearer
    // credential and must not appear in an href (see `./anon-keep-flow.spec.ts`).
    const keep = page.getByRole("button", { name: "Keep it forever" });
    await expect(keep).toBeEnabled();
    await expect(keep).not.toHaveAttribute("aria-disabled", "true");
    await expect(
      page.getByText(new RegExp(`free accounts keep ${KEPT_PAGE_LIMIT} pages`)),
    ).toBeVisible();

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

/**
 * The claim page is required to carry ZERO client behaviour — it is three
 * things (the page, the clock, one button) and every one of them is rendered on
 * the server. Turning JavaScript off is the only assertion that actually proves
 * it: a `"use client"` component that crept in would still render its markup
 * during SSR and pass every test above.
 */
test.describe("the claim page with JavaScript switched off", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });
  test.use({ javaScriptEnabled: false });

  let draft: { anonToken: string; live_url: string };
  let html: string;

  test.beforeEach(async ({ request }) => {
    html = pageHtml(marker());
    const res = await publishViaApi(request, html);
    expect(res.status(), await res.text()).toBe(201);
    draft = (await res.json()) as { anonToken: string; live_url: string };
  });

  test.afterEach(async ({ request }) => {
    await deleteDraft(request, draft.anonToken);
  });

  test("renders in full — preview, clock and a keep button that works with no JS", async ({
    page,
  }) => {
    const response = await page.goto(`/keep/${draft.anonToken}`);
    expect(response?.status()).toBe(200);

    // All three things the screen exists to show, with no hydration involved.
    await expect(page.locator("iframe")).toHaveAttribute("srcdoc", html);
    await expect(page.locator("time")).toHaveText(`Draft · ${DRAFT_TTL_DAYS} days left`);

    // THE POINT OF THIS FILE, after E05 task 009: the keep CTA is a plain
    // `type="submit"` inside a real `<form>` pointed at a server action, so it
    // posts and follows the redirect with no client bundle involved. A CTA
    // wired through `onClick` would pass every other test and be dead here —
    // which is where a stranger with a blocked script would meet it. Pressing
    // it needs the auth stack, so the round trip itself is asserted in
    // `./anon-keep-flow.spec.ts`; what is checked here is the markup that makes
    // it possible without JavaScript.
    const keep = page.getByRole("button", { name: "Keep it forever" });
    const form = keep.locator("xpath=ancestor::form");
    await expect(keep).toBeEnabled();
    await expect(keep).toHaveAttribute("type", "submit");
    await expect(form).toHaveCount(1);

    // AND THE TOKEN IS NOT IN THE FORM. It is a bound server-action argument,
    // which Next encrypts; a hidden field carrying it would be the easy
    // implementation and would put a bearer credential in the markup.
    expect(await form.innerHTML()).not.toContain(draft.anonToken);
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
