/**
 * The link previews of the apex, `/founding` (E06a §8) and `/agents` (E09): their copy and the
 * `Metadata` that carries it. Every string is true today or framed as "when kept
 * opens in December" (E06a §7). The images are drawn by `./brand.tsx` and
 * served `force-static` from `/og.png` and `/founding/og.png` — dotted paths, so
 * the middleware never sees them and they answer on every host, open or closed.
 */
import type { Metadata } from "next";

import { apexUrl } from "../email/waitlist";
import { keptOpen } from "../launch";

import type { BrandCardCopy } from "./brand";
import { OG_CARD_HEIGHT, OG_CARD_WIDTH } from "./card-url";

export const LANDING_CARD: BrandCardCopy = {
  kicker: "Page hosting for humans and AI agents",
  headline: "Drop an HTML file. Get a link. Kept — forever.",
};

export const FOUNDING_CARD: BrandCardCopy = {
  kicker: "Founding creators",
  headline: "Become a founding creator.",
};

export const AGENTS_CARD: BrandCardCopy = {
  kicker: "kept for agents",
  headline: "Let your agent publish. Get a link.",
};

const LANDING_PITCH =
  "Drop an HTML file, or let your AI agent publish one, and get a link that stays up. Free and open source.";

interface Preview {
  /** The `<title>` (absolute) and `og:title`. */
  title: string;
  description: string;
  /** The card's path on the apex, e.g. `/og.png`. */
  image: string;
}

function previewMetadata({ title, description, image }: Preview): Metadata {
  // Absolute, from configuration — never from the request (root CLAUDE.md).
  const url = apexUrl(image);
  const images = [{ url, width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT, alt: title }];
  return {
    title: { absolute: title },
    description,
    openGraph: { title, description, images, siteName: "kept", type: "website" },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

/** The apex landing. A closed deploy frames the pitch with the opening date. */
export function landingMetadata(): Metadata {
  return previewMetadata({
    // Unchanged from the root layout's default: smoke, routes and host-split pin it.
    title: "kept",
    description: keptOpen() ? LANDING_PITCH : `kept opens in December. ${LANDING_PITCH}`,
    image: "/og.png",
  });
}

/** `/founding`: PRD §4's facts only. */
export function foundingMetadata(): Metadata {
  return previewMetadata({
    title: "Become a founding creator · kept",
    description:
      "Founding creators get kept Pro free when kept opens in December. Hand-picked: Arun looks at every application.",
    image: "/founding/og.png",
  });
}

/** `/agents`: per-agent setup (E09 task 004). */
export function agentsMetadata(): Metadata {
  return previewMetadata({
    title: "kept for agents · kept",
    description:
      "Set up Codex, Claude Code, Cursor or any agent to publish to kept: a live link and a claim link, no account.",
    image: "/agents/og.png",
  });
}
