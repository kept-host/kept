/**
 * The `?ref=` value (E10 D11, Q20) — read, validated and carried. Pure, with no
 * server import, so the landing, the auth hook and the tests share one rule.
 *
 * ── HOW `ref` TRAVELS ────────────────────────────────────────────────────────
 *
 *   kept.host/?ref=lena                     the landing renders its sign-in link
 *   app.kept.host/dashboard?ref=lena        `withRef` — a cookie on the apex is not readable on `app.` (03 §9)
 *   app.kept.host/auth?next=%2Fdashboard%3Fref%3Dlena
 *                                           the `(app)` gate keeps the query in `next` (`signInHref`)
 *   callbackURL=/dashboard?ref=lena         the sign-in form hands `next` to Better Auth
 *   databaseHooks.user.create.after         `refFromPath(callbackURL)` → `lib/referrals/capture.ts`
 *
 * `next` is validated as a same-origin path by `safeReturnPath`, so `ref` rides
 * inside a value that can never redirect off-site; and `ref` itself is
 * validated here before anything reads it.
 */
import { referralCodeSchema, slugSchema } from "@kept/shared";

/** The query parameter. */
export const REF_PARAM = "ref";

/** A base no URL can share an origin with, to parse relative paths. */
const PARSE_BASE = "https://ref.invalid";

/**
 * A `?ref=` value worth resolving — a referral code or a handle (a handle is a
 * slug: an old one still credits, Q3) — or `null`. Never throws.
 */
export function parseRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ref = value.trim().toLowerCase();
  return referralCodeSchema.safeParse(ref).success || slugSchema.safeParse(ref).success ? ref : null;
}

/** The valid `ref` carried by `path` (a path or an absolute URL), or `null`. */
export function refFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    return parseRef(new URL(path, PARSE_BASE).searchParams.get(REF_PARAM));
  } catch {
    return null;
  }
}

/** `href` with `ref` added to its query — unchanged when there is no valid `ref`. */
export function withRef(href: string, ref: unknown): string {
  const valid = parseRef(ref);
  if (!valid) return href;
  const url = new URL(href, PARSE_BASE);
  url.searchParams.set(REF_PARAM, valid);
  return url.origin === PARSE_BASE ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}
