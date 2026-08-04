// @kept/edge — the ONE place an outgoing `Response` is constructed.
//
// Every byte this Worker serves is arbitrary HTML written by an anonymous
// stranger, on a subdomain of the same registrable domain as the control plane.
// These headers are the only thing standing between a hostile page and the rest
// of the product, so they are applied by *response construction* rather than
// sprinkled per branch: `buildResponse` is the only `new Response(...)` on the
// serve path, and a branch added in a later epic (E11's password-protected
// serving, EU bucket routing) inherits the whole set by construction instead of
// by remembering.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE CANNOT DO — the two honest limits.
//
//  1. COOKIE AND SAFE-BROWSING ISOLATION BETWEEN SUBDOMAINS IS NOT A HEADER
//     PROBLEM. `document.cookie = "x=1; domain=.kept.host"` from a hosted page
//     writes a cookie the browser will then send to the control plane, and no
//     response header can forbid it — CSP has no cookie directive, and the only
//     header-level lever (the CSP `sandbox` directive without
//     `allow-same-origin`) buys it by giving every hosted page an opaque origin,
//     which kills localStorage/sessionStorage/same-origin `fetch` for pages that
//     legitimately use them. The actual fix is **`kept.host` on the Public
//     Suffix List**, which makes `.kept.host` an invalid cookie domain outright;
//     that submission is a launch dependency owned by **E07** and cannot be
//     substituted for here. The same PSL entry is what gets Safe Browsing to
//     treat one bad slug as one bad site rather than as all of `kept.host`.
//     Until it lands, the control plane's own defence is host-only,
//     `__Host-`-prefixed cookies (E05) — a subdomain can neither read nor
//     overwrite those. What this file *does* contribute is `form-action 'self'`
//     and `connect-src 'self'`, which stop a hosted page from firing a
//     credentialed request at the control plane in the first place.
//  2. PASSWORD-PROTECTED SERVING IS **E11**. Nothing here authenticates a
//     visitor; every response built by this module is public.
// ─────────────────────────────────────────────────────────────────────────────
//
// NO CORS HEADER IS SET ANYWHERE — not `*`, not an allowlist. A hosted page is a
// document, not an API, and it must not become one by default. Absence is the
// policy; anything that needs cross-origin reads asks for them explicitly in a
// later epic.
//
// NO `Server` / `X-Powered-By` FINGERPRINT IS ADDED. Hono adds none, and we add
// none. The `Server: cloudflare` that a visitor sees is applied downstream by
// the edge itself and is not ours to remove.

/**
 * Which body this response carries, and therefore which CSP applies.
 *
 * - `user-page` — bytes a stranger uploaded (200 content, and the 304 that
 *   revalidates it).
 * - `kept-own` — markup and status responses kept itself produced: the branded
 *   system pages, the reserved-label redirect, the method rejection.
 */
export type ResponseKind = "user-page" | "kept-own";

/* ───────────────────────────────────────────────────────────────────────────
   The two CSPs.

   THE INLINE-CONTENT CONSTRAINT (user pages): kept's v1 product is a single
   self-contained HTML file whose CSS and JS are inline by definition. A textbook
   "untrusted content" CSP forbids `'unsafe-inline'` — and would therefore break
   every page kept hosts. It would also buy nothing, because the isolation that
   matters here comes from the ORIGIN: each page sits on its own subdomain, so
   the same-origin policy already separates pages from each other and from the
   control plane. There is no injection boundary inside a document whose entire
   body is the author's. `'unsafe-eval'` is granted for the same reason — with
   inline script already allowed it blocks no attacker and breaks real pages
   (template engines, wasm glue).

   So this CSP's job is NOT to sanitise the page's own body. It is to constrain
   what the page can reach outward and to stop it impersonating kept:

     - `frame-ancestors 'none'` + `X-Frame-Options: DENY` — a hosted page can
       never be framed, in particular not by `kept.host` and not by another
       hosted page. Both directions of the criterion are covered by one policy
       because the control plane sets its own framing headers. A future dashboard
       preview must render a screenshot, not an iframe.
     - `form-action 'self'` — the page cannot POST anywhere but itself, so it
       cannot aim a credentialed form at the control plane or at a look-alike.
     - `connect-src 'self'` — no `fetch`/XHR/WebSocket/`sendBeacon` off-origin.
       This is the directive that blocks `fetch('https://kept.host/…', {
       credentials: 'include' })`: CORS would stop the page *reading* that
       response, but the request would still be sent with the visitor's cookies.
       It is deliberately tighter than the passive directives below and it does
       cost hosted pages third-party API calls; loosening it is a product
       decision, not a security one.
     - `base-uri 'self'` — the page cannot rewrite its own resolution base.
     - `object-src 'none'` — no plugin content.

   Passive subresources (`script-src`/`style-src`/`img-src`/`font-src`/
   `media-src`/`frame-src`) allow `https:` because a page that can already run
   inline script gains no capability from a remote `<script src>`, and refusing
   remote images/fonts/CDN scripts would break a large share of legitimate pages
   for no gain. That does leave an exfiltration channel (an image URL carries
   query data) — stated plainly rather than pretended away, because a CSP is an
   allowlist and cannot deny an origin it has otherwise permitted.

   No COEP: `require-corp` would break exactly those cross-origin subresources,
   and nothing here needs cross-origin isolation.
   ─────────────────────────────────────────────────────────────────────────── */
const USER_PAGE_CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https:",
  "style-src 'self' 'unsafe-inline' blob: data: https:",
  "img-src 'self' blob: data: https:",
  "font-src 'self' blob: data: https:",
  "media-src 'self' blob: data: https:",
  "frame-src 'self' https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * kept's own markup gets a far stricter policy, because it has no reason to
 * permit anything remote: `system-pages.ts` bundles its CSS inline, draws the
 * mascot as inline SVG, inlines its icons, loads no font and runs no script. So
 * everything is denied by default and exactly one hole is opened — the inline
 * `<style>` block — with no `script-src` grant at all. If a future edit to a
 * system page needs script, this line is where it has to be argued for.
 */
const KEPT_OWN_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Headers every response carries, whoever wrote the body.
 *
 * - `X-Content-Type-Options: nosniff` — the other half of `r2.ts`'s
 *   Worker-owned `Content-Type` map. Deciding the type from the extension of a
 *   key we constructed is pointless if the browser may then sniff past it.
 * - `Referrer-Policy: strict-origin-when-cross-origin` — a visitor's full URL
 *   (which can carry a path or query the publisher put there) never leaves the
 *   origin. `same-origin` was considered and rejected: sending the bare origin
 *   outbound is ordinary web behaviour publishers expect for attribution, and
 *   the slug is public anyway.
 * - `X-Frame-Options: DENY` — the legacy companion to `frame-ancestors 'none'`,
 *   which both CSPs carry.
 * - `Cross-Origin-Resource-Policy: same-origin` — a hosted page's bytes cannot
 *   be embedded as a subresource by another origin. Top-level navigation is
 *   unaffected (CORP applies to `no-cors` subresource loads), so this is free
 *   for visitors and stops hotlinking kept's bandwidth.
 * - `Cross-Origin-Opener-Policy: same-origin` — severs `window.opener` between
 *   a hosted page and whatever opened it, so a page opened from the dashboard
 *   cannot reach back into it.
 * - `Permissions-Policy` — a hostile page prompting for camera/mic/geolocation
 *   under a `kept.host` subdomain damages the whole domain's reputation, and no
 *   hosted page in v1 needs any of them.
 */
const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
} as const;

/**
 * The finished header set per kind, built ONCE at module scope.
 *
 * The CSP strings are joined here rather than assembled per request, and these
 * two records are frozen so a branch cannot mutate the shared policy for
 * everyone. Only the small per-response record (`Content-Type`, `ETag`,
 * `Cache-Control`, `Location`, `Allow`) is allocated per request.
 */
const SECURITY_HEADERS: Readonly<Record<ResponseKind, Readonly<Record<string, string>>>> =
  Object.freeze({
    "user-page": Object.freeze({
      ...BASE_SECURITY_HEADERS,
      "Content-Security-Policy": USER_PAGE_CSP,
    }),
    "kept-own": Object.freeze({
      ...BASE_SECURITY_HEADERS,
      "Content-Security-Policy": KEPT_OWN_CSP,
    }),
  });

export interface ResponseSpec {
  /** HTTP status. */
  status: number;
  /** Whose body this is — selects the CSP. */
  kind: ResponseKind;
  /**
   * Per-response headers: `Content-Type`, `ETag`, `Cache-Control`, `Location`,
   * `Allow`. Applied AFTER the security set, so a branch can set its own
   * caching and content type but cannot quietly drop a security header by
   * omission — only by naming it, which is greppable.
   *
   * `Cache-Control` in particular stays the caller's (task 005's policy table):
   * nothing in this module reads or rewrites it, so `no-store` on a suspended
   * page survives untouched and `cache.ts` still reads the real policy off the
   * response it is handed.
   */
  headers?: Record<string, string>;
}

/**
 * Build an outgoing response. The only `new Response(...)` on the serve path.
 *
 * A `null` body is correct for 304/301/405; a `ReadableStream` from R2 is passed
 * through untouched so a page is never buffered into Worker memory.
 */
export function buildResponse(
  body: BodyInit | null,
  spec: ResponseSpec,
): Response {
  return new Response(body, {
    status: spec.status,
    headers: { ...SECURITY_HEADERS[spec.kind], ...spec.headers },
  });
}
