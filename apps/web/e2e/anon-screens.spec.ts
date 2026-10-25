import {
  DRAFT_GRACE_DAYS,
  DRAFT_TTL_DAYS,
  generateAnonToken,
  hashToken,
  KEPT_PAGE_LIMIT,
  MODERATION_REASON_SENTENCES,
  type ModerationReason,
  type SiteStatus,
} from "@kept/shared";
import { test, expect, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

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
import { closeDb, db, schema } from "../lib/db";
import { formatUpdatedAt } from "../lib/sites/display";
import { PENDING_KEEP_COOKIE } from "../lib/auth/pending-keep";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { cleanup, newScope, signInAs, SKIP_OWNER_UI } from "./owner-fixtures";

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

  /**
   * "Keep it forever →" on `/p` IS the keep — not a link to the claim page,
   * which greets the publisher as "someone shared this page with you" and asks
   * for a second press. Both identities are drilled: signed out the intent is
   * parked in the pending-keep cookie and spent by `/auth/callback` after
   * sign-in; signed in the keep happens in the submit itself. Either way the
   * visitor never lands on `/keep/`, and the published page ends kept.
   *
   * A kept page outlives the anonymous DELETE in `afterEach` (keeping kills the
   * token), so each test unwinds its account and page through `cleanup`.
   */
  for (const signedIn of [false, true]) {
    test(`/p — 'Keep it forever →' keeps the page from this screen (${signedIn ? "signed in" : "signed out"})`, async ({
      page,
      baseURL,
    }) => {
      test.skip(!!SKIP_OWNER_UI, String(SKIP_OWNER_UI));
      const scope = newScope();
      try {
        const userId = signedIn ? (await signInAs(page, baseURL!, scope)).userId : null;

        const visited: string[] = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
        });

        await page.goto(`/p/${draft.anonToken}`);
        await page.getByRole("button", { name: "Keep it forever →" }).click();

        if (!signedIn) {
          // Handed straight to sign-in, the intent parked in the cookie.
          await expect(page).toHaveURL("/auth/keep", { timeout: 30_000 });
          const cookies = await page.context().cookies();
          expect(cookies.find((cookie) => cookie.name === PENDING_KEEP_COOKIE)).toBeDefined();
          await signInAs(page, baseURL!, scope);
          await page.goto("/auth/callback");
        }

        // Same budget as `anon-keep-flow.spec.ts`'s KEEP_TIMEOUT: a keep is
        // ~10 round trips to remote Neon.
        await expect(page).toHaveURL(`/auth/callback/done?outcome=kept&slug=${draft.slug}`, {
          timeout: 30_000,
        });
        await expect(page.getByRole("heading", { name: "Kept forever" })).toBeVisible();
        expect(visited.filter((path) => path.startsWith("/keep/"))).toEqual([]);
        if (signedIn) expect(visited).not.toContain("/auth/keep");

        const [row] = await db
          .select()
          .from(schema.sites)
          .where(eq(schema.sites.slug, draft.slug));
        expect(row?.ownerId).toBe(userId ?? scope.userIds[0]);
        expect(row?.expiresAt, "kept means no clock").toBeNull();
        expect(row?.anonTokenHash, "keeping retires the manage link").toBeNull();
      } finally {
        await cleanup(scope);
      }
    });
  }

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

/**
 * `/p/[anonToken]` on a restricted page (E07 §6.10, AC38): the token holder
 * manages the page, so they see its status — the banner, the reason and the
 * appeal form — and nothing that touches the bytes. Every other non-live case
 * stays the uniform 404.
 *
 * Rows straight into Postgres with a real token's digest, and NO bytes: a
 * restricted view that tried to preview would have nothing to read, which is
 * the point. No KV, no R2, no publish (and no publish rate limit).
 */
test.describe("the restricted /p view", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT });

  const DAY = 24 * 60 * 60 * 1000;
  const siteIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    if (siteIds.length > 0) {
      // Appeals cascade with the site; the moderation log only NULLs its id.
      await db.delete(schema.moderationActions).where(inArray(schema.moderationActions.siteId, siteIds));
      await db.delete(schema.sites).where(inArray(schema.sites.id, siteIds));
    }
    await closeDb();
  });

  /** An anonymous draft in `status`, managed by the returned token. */
  async function anonPage(
    status: SiteStatus,
    { reason = "phishing", purgeAfter }: { reason?: ModerationReason; purgeAfter?: Date } = {},
  ) {
    const id = crypto.randomUUID();
    const token = generateAnonToken();
    const slug = `e07-009-p-${id.slice(0, 8)}`;
    const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * DAY);
    await db.insert(schema.sites).values({
      id,
      slug,
      publisherHash: "e07-009-e2e",
      anonTokenHash: await hashToken(token),
      status,
      moderationReason: status === "live" || status === "expired" || status === "archived" ? null : reason,
      expiresAt,
      purgeAfter: purgeAfter ?? new Date(expiresAt.getTime() + DRAFT_GRACE_DAYS * DAY),
      contentHash: `e07-009-${id}`,
      sizeBytes: 128,
    });
    siteIds.push(id);
    return { id, slug, token };
  }

  async function expectNothingThatTouchesTheBytes(page: Page) {
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /copy/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /replace|delete|keep|stop serving/i })).toHaveCount(0);
    await expect(page.locator("a[download]")).toHaveCount(0);
    await expect(page.getByTestId("restricted-download")).toHaveCount(0);
  }

  test("AC38: under review, hidden and removed-before-purge show the banner, the reason and the appeal — no preview, download, copy-link, replace, keep or delete", async ({
    page,
  }) => {
    const cases = [
      { status: "under_review", headline: "This page is hidden while we take a look." },
      { status: "quarantined", headline: "This page is hidden. It stays offline unless a review brings it back." },
      { status: "removed", headline: "This page was removed." },
    ] as const;
    for (const { status, headline } of cases) {
      const purgeAfter = status === "removed" ? new Date(Date.now() + 20 * DAY) : undefined;
      const site = await anonPage(status, { reason: "crypto_scam", purgeAfter });
      const response = await page.goto(`/p/${site.token}`);
      expect(response?.status(), status).toBe(200);

      const banner = page.getByTestId("restricted-banner");
      await expect(banner, status).toHaveAttribute("data-state", status);
      await expect(banner).toContainText(headline);
      await expect(banner.getByTestId("restricted-reason")).toHaveText(
        MODERATION_REASON_SENTENCES.crypto_scam.sentence,
      );
      await expect(page.getByText(site.slug)).toBeVisible();
      await expect(banner.getByTestId("appeal-button")).toBeEnabled();
      if (purgeAfter) {
        await expect(banner.getByTestId("restricted-deadline")).toHaveText(
          `It will be deleted for good on ${formatUpdatedAt(purgeAfter)}.`,
        );
      }
      await expectNothingThatTouchesTheBytes(page);
    }
  });

  test("AC19 + AC38: the token holder appeals through the form — one open appeal, recorded as anonymous", async ({
    page,
  }) => {
    const site = await anonPage("quarantined");
    await page.goto(`/p/${site.token}`);
    const banner = page.getByTestId("restricted-banner");
    await banner.getByTestId("appeal-button").click();
    const message = "I made this page for my own wallet app's beta testers. Nothing on it asks for keys.";
    await banner.getByTestId("appeal-message").fill(message);
    await banner.getByTestId("appeal-submit").click();
    await expect(banner.getByTestId("appeal-open")).toHaveText("We've got your request — we'll email you.", {
      timeout: LIVE_STACK_TIMEOUT,
    });
    await expect(banner.getByTestId("appeal-button")).toBeDisabled();

    const rows = await db.select().from(schema.appeals).where(eq(schema.appeals.siteId, site.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "open", message, submittedByUserId: null });

    await page.reload();
    await expect(page.getByTestId("appeal-open")).toBeVisible();
    await expectNothingThatTouchesTheBytes(page);
  });

  test("every other non-live page is still the uniform 404 — archived, expired, removed past its purge date", async ({
    page,
  }) => {
    const gone = [
      await anonPage("archived"),
      await anonPage("expired"),
      await anonPage("removed", { purgeAfter: new Date(Date.now() - 60_000) }),
    ];
    for (const site of gone) {
      const response = await page.goto(`/p/${site.token}`);
      expect(response?.status(), site.slug).toBe(404);
      await expect(page.getByRole("heading", { name: /doesn.t open a page/ })).toBeVisible();
      await expect(page.getByTestId("restricted-banner")).toHaveCount(0);
    }
  });
});
