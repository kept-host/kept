/**
 * The five things a resumed keep can end as, and the URL that says which.
 *
 * ONE MODULE SO THE TWO SIDES CANNOT DRIFT: `../page.tsx` builds the link and
 * `./page.tsx` parses it, and a typo in a query key would otherwise be a screen
 * that silently falls back to the generic failure. It is plain data — no server
 * imports — so both a server component and a spec can read it.
 *
 * NOTHING SECRET TRAVELS. The slug is the public hostname the page already
 * serves at and the deadline is on the visitor's own screen anyway; the bearer
 * token is not here and must never be. A visitor who hand-edits these parameters
 * changes what one static screen says and nothing about their account — Postgres
 * is the authority, and the dashboard is one click away on every branch.
 */
import type { AnonOutcome } from "@/lib/publish/anon-manage";
import type { AnonKeepResponse } from "@/lib/sites/anon-keep";


export const KEEP_OUTCOME_CODES = [
  /** Permanent, first time. */
  "kept",
  /** Permanent, and brought back from inside its grace window. */
  "restored",
  /** At `KEPT_PAGE_LIMIT`: owned, still on its clock, swap prompt shown. */
  "draft",
  /** Task 008's one indistinguishable 404 — already kept, or too late. */
  "gone",
  /** The keep threw. Logged server-side with the site id; never detailed here. */
  "failed",
  /** The round trip came back without a session. */
  "signed-out",
] as const;

export type KeepOutcomeCode = (typeof KEEP_OUTCOME_CODES)[number];

export const DONE_PATH = "/auth/callback/done";

export function isKeepOutcomeCode(value: unknown): value is KeepOutcomeCode {
  return (
    typeof value === "string" &&
    (KEEP_OUTCOME_CODES as readonly string[]).includes(value)
  );
}

/** The result screen's URL. `slug` and `expiresAt` are only read where relevant. */
export function doneHref(result: {
  outcome: KeepOutcomeCode;
  slug?: string;
  expiresAt?: string;
}): string {
  const params = new URLSearchParams({ outcome: result.outcome });
  if (result.slug) params.set("slug", result.slug);
  if (result.expiresAt) params.set("expires", result.expiresAt);
  return `${DONE_PATH}?${params.toString()}`;
}

/**
 * `keepAnonymousPage`'s answer, as the URL that explains it.
 *
 * ONE MAPPING FOR TWO CALLERS. A visitor who was signed out reaches the keep
 * through `/auth/callback` after the round trip; a visitor who was already
 * signed in never leaves the server action, because there is no round trip to
 * survive. Both end here, so the four outcomes cannot be worded one way on one
 * path and another way on the other.
 */
export function doneHrefForKeep(
  result: AnonOutcome<AnonKeepResponse>,
): string {
  if (!result.ok) {
    // 404 is task 008's one indistinguishable answer: already kept, expired past
    // its grace window, or never a real token. Anything else is a real failure,
    // already logged there with the site id.
    return doneHref({ outcome: result.status === 404 ? "gone" : "failed" });
  }

  const body = result.body;
  if (body.outcome === "owned_draft") {
    // THE CAP IS A BRANCH, NOT AN ERROR. The page is owned and still serving; it
    // simply kept its clock, which travels so the screen can show the countdown.
    return doneHref({
      outcome: "draft",
      slug: body.slug,
      expiresAt: body.expiresAt,
    });
  }

  return doneHref({
    outcome: body.restored ? "restored" : "kept",
    slug: body.slug,
  });
}
