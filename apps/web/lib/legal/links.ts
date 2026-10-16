/**
 * Where the legal pages live (E06a, PRD §6 / D8; E07 added acceptable use) — client-safe, no `fs`.
 *
 * The pages are apex pages. On the `app.` host, and in every email, the links
 * must therefore be ABSOLUTE apex URLs, derived FROM CONFIGURATION
 * (`NEXT_PUBLIC_APP_URL`), never from the request. The apex is worked out by
 * `farewellHref` — the one place `host-split.ts` pairs `app.` with its apex — so
 * there is no second derivation to drift. With a single origin (local
 * development) it is `/`, and the links stay relative.
 */
import { farewellHref } from "../routing/host-split";

export const LEGAL_DOCS = ["impressum", "privacy", "acceptable-use"] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/** The link labels — exactly these words, English only (Arun, 2026-10-11). */
export const LEGAL_LABELS: Record<LegalDoc, string> = {
  impressum: "Impressum",
  privacy: "Privacy",
  "acceptable-use": "Acceptable use",
};

export function isLegalDoc(value: string): value is LegalDoc {
  return (LEGAL_DOCS as readonly string[]).includes(value);
}

/** `/legal/{doc}`, made absolute on the apex when this deploy has one. */
export function legalHref(doc: LegalDoc, appUrl: string | undefined): string {
  const path = `/legal/${doc}`;
  const landing = farewellHref(appUrl);
  return landing === "/" ? path : new URL(path, landing).href;
}
