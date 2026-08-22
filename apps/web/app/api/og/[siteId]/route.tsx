/**
 * `GET /api/og/:siteId` — the generated card for one page. E06 task 010.
 *
 * A still image, **not a screenshot**. A real screenshot needs a browser in the
 * deployment; Railway is not going to enjoy that, and the PRD is explicit.
 *
 * ── IT CANNOT REQUIRE A SESSION, AND EVERYTHING BELOW FOLLOWS FROM THAT ──────
 *
 * The card is consumed as an `<img>` on the dashboard and as `og:image` by
 * crawlers that carry no cookie. So it is public, which makes it (a) an
 * existence oracle on site ids and (b) a disclosure surface for whatever it
 * draws. Two consequences, both load-bearing:
 *
 *   1. **It draws only what is already public.** The page's own `<title>` —
 *      which the page itself serves to the world — or its slug, which is its
 *      hostname. Plus the draft/kept chip and the brand mark. Nothing else; see
 *      `lib/og/card.tsx` and the five-column read in
 *      `lib/db/queries/og-card.ts`.
 *   2. **Unknown, malformed and non-existent ids answer exactly like real
 *      ones**: HTTP 200, `image/png`, the same `Cache-Control`, the same
 *      dimensions, the same frame, the same brand mark. A 404 for one and a 200
 *      for the other would turn a UUID guess into a membership test, which is
 *      why there is no error path in this file at all.
 *
 *      ⚠️ **The uniformity is of the response, not of the pixels, and it cannot
 *      be otherwise.** A real card's entire job is to show a page's public name,
 *      so its bytes necessarily differ from the generic card's. What an attacker
 *      gains from a *successful* guess is the slug — already world-readable at
 *      `{slug}.{base domain}` — and nothing more. What they cannot get is a
 *      cheap probe: status, headers and content type are identical, so nothing
 *      short of decoding the image distinguishes the two. That is the achievable
 *      property, and stating it exactly is better than implying a stronger one.
 *
 * ── NOT ORIGIN-GATED, DELIBERATELY ──────────────────────────────────────────
 *
 * The origin gate in `lib/publish/origin.ts` guards **cookie-authenticated
 * mutations** (E05a D3): ambient session authority plus a state change is the
 * combination that needs it. This route has neither. It reads one row, writes
 * nothing, and authenticates nobody — and it is fetched cross-origin *by
 * design*, from crawlers and social previews that send no `Origin` at all.
 * Gating it would break every consumer it exists for while protecting nothing.
 *
 * That absence is **pinned**, not merely asserted here: `origin.test.ts` greps
 * this file's source in its "public read routes do not import the gate" case,
 * alongside `/api/health`. Which is also why this paragraph names the module
 * rather than the function — the pin is a source grep, and it should stay one.
 */
import { ImageResponse } from "next/og";
import { z } from "zod";

import { getOgCardSite } from "../../../../lib/db/queries/og-card";
import {
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  type OgCardPhase,
  OgCard,
  clampOgTitle,
} from "../../../../lib/og/card";
import { ogFonts } from "../../../../lib/og/font";
import { servingBaseDomain } from "../../../../lib/storage/env";

/**
 * `postgres-js` needs TCP sockets and the font loader reads the filesystem.
 * Both rule out the edge runtime; this route runs on Railway exactly as Next
 * builds it, alongside the rest of the control plane.
 */
export const runtime = "nodejs";

/**
 * One year, `immutable`, and **identical for every response this route emits** —
 * real page, unknown id, malformed id alike. A shorter TTL for the generic card
 * would be the existence oracle re-introduced through a header.
 *
 * `immutable` is honest because the URL carries a revision token: consumers link
 * through `ogCardPath`, which puts `current_version_id` plus the draft/kept bit
 * in `?v=`, so a replace or a keep changes the address and the old bytes are
 * simply never asked for again. See `lib/og/card-url.ts`.
 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * A UUID and nothing else. Rejected ids fall through to the generic card rather
 * than to a 400 — a 400 would say "that is not even a well-formed id", which is
 * one bit more than this route is willing to tell a stranger.
 */
const siteIdSchema = z.string().uuid();

/**
 * The statuses whose page may be named on a card.
 *
 * A `quarantined`, `removed`, `archived` or `expired` page renders the **generic
 * card**: it is either not serving or actively flagged, and an `og:image` is a
 * promotional surface with a year-long cache on it. `under_review` is included
 * because E07's review flag does not stop a page serving and the page is still
 * the owner's; the card must not pre-judge it.
 */
const NAMEABLE: ReadonlySet<string> = new Set(["live", "under_review"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteId: string }> },
): Promise<ImageResponse> {
  const { siteId } = await params;

  const parsed = siteIdSchema.safeParse(siteId);
  const site = parsed.success ? await getOgCardSite(parsed.data) : null;

  let headline: string | null = null;
  let host: string | null = null;
  let phase: OgCardPhase | null = null;

  if (site && NAMEABLE.has(site.status)) {
    // `title ?? slug` — the fallback migration `0004` deliberately does not
    // backfill, clamped to what the card can hold. The title is untrusted,
    // stranger-authored input: `extractPageTitle` already trimmed, collapsed and
    // capped it at write time, and `clampOgTitle` bounds it again for *this*
    // surface, because a storage cap is not a layout.
    headline = clampOgTitle(site.title ?? site.slug);
    // `isDraft = expires_at != null`. Nothing else decides the chip.
    phase = site.expiresAt === null ? "kept" : "draft";
    host = servingHost(site.slug);
  }

  return new ImageResponse(<OgCard headline={headline} host={host} phase={phase} />, {
    width: OG_CARD_WIDTH,
    height: OG_CARD_HEIGHT,
    fonts: await ogFonts(),
    headers: { "cache-control": CACHE_CONTROL },
  });
}

/**
 * `{slug}.{KEPT_BASE_DOMAIN}` — the address the page is actually served at.
 *
 * `servingBaseDomain()` throws when the variable is missing or malformed, which
 * is the right behaviour for the publish path and the wrong one here: a
 * misconfigured environment would turn every real card into a 500 while unknown
 * ids kept answering 200, which is precisely the oracle this route is built to
 * avoid. So the line is dropped and the rest of the card still renders.
 */
function servingHost(slug: string): string | null {
  try {
    return `${slug}.${servingBaseDomain()}`;
  } catch {
    return null;
  }
}
