import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";
import { ogCardPath } from "../lib/og/card-url";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import {
  deleteDraft,
  newApiContext,
  pageHtml,
  publishViaApi,
  SKIP_LIVE_PUBLISH,
} from "./live-publish";

/**
 * `GET /api/og/:siteId` over the wire — E06 task 010.
 *
 * Real dev stack: pages published through the real `POST /api/publish`, replaced
 * through the real `POST /api/anon/:token/replace`, and the site ids read out of
 * the real dev Neon branch. Nothing here is stubbed, and the route is exercised
 * exactly as an `<img>` or a crawler would fetch it — no cookie, no header, no
 * origin.
 *
 * ── WHY THIS ASSERTS BYTES AND NOT PIXELS ───────────────────────────────────
 *
 * The criterion asks for "an image containing the title". Reading the title back
 * out of a PNG means OCR, which is a dependency, a flake source and a thing that
 * would have to be maintained forever to answer a question that has a cheaper
 * exact answer: publish two pages whose ONLY difference is their `<title>`, and
 * assert the two cards differ. Identical inputs but for the title, differing
 * outputs — the title is in the image, and no glyph recognition was involved.
 * `lib/og/card.tsx` and its unit tests cover what the headline *says* and that
 * the template holds edge case 17's titles; this file covers that the pipeline
 * carries it, that the cache key moves (D10) and that a non-`live` page is not
 * named (AC45).
 */

/** The card's shape, asserted identically for every response the route emits. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";
/** Anything smaller than this is an error page or an empty render, not a card. */
const MIN_CARD_BYTES = 5_000;

/** The dev row behind a freshly published slug. */
async function siteBySlug(slug: string) {
  const [row] = await db
    .select({
      id: schema.sites.id,
      updatedAt: schema.sites.updatedAt,
      title: schema.sites.title,
    })
    .from(schema.sites)
    .where(eq(schema.sites.slug, slug))
    .limit(1);
  return row;
}

test.describe("OG card", () => {
  test.describe.configure({ mode: "serial", timeout: LIVE_STACK_TIMEOUT });
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

  const marker = crypto.randomUUID().slice(0, 8);
  const titleA = `E06-010 card alpha ${marker}`;
  const titleB = `E06-010 card bravo ${marker}`;

  const tokens: string[] = [];
  let siteId = "";
  let slugA = "";
  let firstCard = Buffer.alloc(0);

  test.beforeAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_LIVE_PUBLISH) return;
    const api = await newApiContext();
    try {
      for (const token of tokens) await deleteDraft(api, token);
    } finally {
      await api.dispose();
      await closeDb();
    }
  });

  test("a real page renders a card carrying its title", async ({ request }) => {
    const res = await publishViaApi(request, pageHtml(titleA));
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { slug: string; anonToken: string };
    tokens.push(body.anonToken);

    const row = await siteBySlug(body.slug);
    expect(row, "the published slug must exist in the dev branch").toBeTruthy();
    // Task 001's extraction on the publish path — the card has a title to draw.
    expect(row!.title).toBe(titleA);
    siteId = row!.id;
    slugA = body.slug;

    const card = await request.get(ogCardPath(row!));
    expect(card.status()).toBe(200);
    expect(card.headers()["content-type"]).toContain("image/png");
    expect(card.headers()["cache-control"]).toBe(CACHE_CONTROL);

    firstCard = Buffer.from(await card.body());
    expect(firstCard.byteLength).toBeGreaterThan(MIN_CARD_BYTES);
    // A PNG, not an error body that happened to arrive with a 200.
    expect(firstCard.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  test("two pages differing only in their title render different cards", async ({
    request,
  }) => {
    const res = await publishViaApi(request, pageHtml(titleB));
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { slug: string; anonToken: string };
    tokens.push(body.anonToken);

    const row = await siteBySlug(body.slug);
    expect(row!.title).toBe(titleB);

    const card = Buffer.from(await (await request.get(ogCardPath(row!))).body());
    // Same layout, same chip, same brand mark, same-length slug — the title is
    // the only input that moved, so a byte-identical card would mean the title
    // never reached the render.
    expect(card.equals(firstCard)).toBe(false);
  });

  test("replacing the page moves the cache key and the card behind it", async ({
    request,
  }) => {
    const before = await siteBySlug(slugA);
    const beforePath = ogCardPath(before!);

    const replaced = await request.post(`/api/anon/${tokens[0]}/replace`, {
      headers: { "content-type": "text/html" },
      data: pageHtml(`${titleA} replaced`),
    });
    expect(replaced.status()).toBe(200);

    // The slug is unchanged by a replace — same URL, new bytes — so the same
    // lookup finds the row again.
    const after = await siteBySlug(slugA);

    // The replace is an `UPDATE sites`, so `$onUpdate` moved `updated_at` — the
    // revision token — and every cache in the world misses and re-fetches. That
    // is the entire invalidation strategy (D10): there is no purge call on this
    // path and there must not be one. Rename (task 006) and title edits (task
    // 012) assert the same column moves; this file asserts the URL follows it.
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    expect(ogCardPath(after!)).not.toBe(beforePath);
    // Task 001 re-extracts on replace: a title set on publish but not on replace
    // would leave the card confidently showing the previous page's name.
    expect(after!.title).toBe(`${titleA} replaced`);

    const card = Buffer.from(await (await request.get(ogCardPath(after!))).body());
    expect(card.equals(firstCard)).toBe(false);
  });

  test("AC45: a page that is not live gets the generic card, with no title", async ({
    request,
  }) => {
    // Flagged by hand — E07 owns the real flip; E06 only renders it.
    await db
      .update(schema.sites)
      .set({ status: "under_review" })
      .where(eq(schema.sites.id, siteId));
    try {
      const row = await siteBySlug(slugA);
      const flagged = await request.get(ogCardPath(row!));
      expect(flagged.status()).toBe(200);
      expect(flagged.headers()["content-type"]).toContain("image/png");
      expect(flagged.headers()["cache-control"]).toBe(CACHE_CONTROL);

      // No OCR needed: the generic card is ONE image, so "contains no title"
      // is "is byte-identical to the card an id that names nothing gets".
      const generic = await request.get(`/api/og/${crypto.randomUUID()}`);
      expect(Buffer.from(await flagged.body()).equals(Buffer.from(await generic.body()))).toBe(
        true,
      );
    } finally {
      await db
        .update(schema.sites)
        .set({ status: "live" })
        .where(eq(schema.sites.id, siteId));
    }
  });

  test("an unknown id answers exactly like a real one", async ({ request }) => {
    const real = await request.get(`/api/og/${siteId}`);
    const unknown = await request.get(`/api/og/${crypto.randomUUID()}`);

    // No 404, no 400, no differing cache TTL. A status or header that moved with
    // existence would turn a UUID guess into a membership test, which is the one
    // thing this route is built not to be.
    expect(unknown.status()).toBe(real.status());
    expect(unknown.status()).toBe(200);
    expect(unknown.headers()["content-type"]).toBe(real.headers()["content-type"]);
    expect(unknown.headers()["cache-control"]).toBe(real.headers()["cache-control"]);
    expect(unknown.headers()["cache-control"]).toBe(CACHE_CONTROL);

    const body = Buffer.from(await unknown.body());
    expect(body.byteLength).toBeGreaterThan(MIN_CARD_BYTES);
    expect(body.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  test("a malformed id answers the same way too", async ({ request }) => {
    // Not a UUID at all. A 400 here would say "that is not even a well-formed
    // id", which is one bit more than a stranger is owed.
    const malformed = await request.get("/api/og/not-a-uuid");
    const unknown = await request.get(`/api/og/${crypto.randomUUID()}`);

    expect(malformed.status()).toBe(200);
    expect(malformed.headers()["content-type"]).toContain("image/png");
    expect(malformed.headers()["cache-control"]).toBe(CACHE_CONTROL);
    // Same generic card, byte for byte: nothing about the shape of the input
    // survives into the response.
    expect(Buffer.from(await malformed.body()).equals(Buffer.from(await unknown.body()))).toBe(
      true,
    );
  });
});
