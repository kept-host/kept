/**
 * The Content-Security-Policy of `/admin/*` (E07 task 011, Risk 8) — the first
 * CSP in `apps/web`, and scoped to that prefix only: nothing else on `app.`
 * gets it, and nothing here relaxes anything elsewhere.
 *
 * `middleware.ts` mints a nonce per request and sets this policy on BOTH the
 * request (Next reads the nonce from the request's
 * `Content-Security-Policy` header and stamps it on every script it renders)
 * and the response. Pure, so the policy is unit-tested without a request.
 *
 * ── THE PREVIEW IFRAME (D-69) ──────────────────────────────────────────────
 * A `srcdoc` document inherits its embedder's policy, and a `<meta>` policy can
 * only tighten one, so a `srcdoc` preview ran none of the page's scripts. The
 * preview is therefore a URL — `/api/admin/moderation/sites/:id/preview`, which
 * the middleware never stamps — answered under `ADMIN_PREVIEW_CSP` below, and
 * this policy allows framing `'self'` for it and nothing more.
 */

/**
 * The preview route's policy: `sandbox allow-scripts` puts the page in an
 * opaque origin even when opened top-level (no `app.` cookies, no reach into
 * the admin window, no forms, popups or navigation of the top); inline script
 * and style run; nothing loads from the network (data: images and fonts
 * only), so the reviewer's IP never reaches the page's author; only `app.`
 * itself may frame it.
 */
export const ADMIN_PREVIEW_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
].join("; ");

/** The prefix the policy applies to. */
export const ADMIN_PATH_PREFIX = "/admin";

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PATH_PREFIX || pathname.startsWith(`${ADMIN_PATH_PREFIX}/`);
}

/**
 * The policy for one response. `dev`: `next dev` evaluates code (webpack's
 * eval source maps, React's dev stacks), so `'unsafe-eval'` is added under
 * `next dev` and nowhere else.
 *
 * NOT A TRACK FORK. `configured-origins.test.ts` bans a `NODE_ENV` branch in
 * the files that decide ORIGINS, because dev and prod deploy one artefact. This
 * branch decides no origin, and both deploy tracks run `next build` output, so
 * they get the same policy; only a local `next dev` differs. That is why the
 * read lives here, as a default the tests can override, and not in
 * `middleware.ts`.
 */
export function adminContentSecurityPolicy(
  nonce: string,
  dev: boolean = process.env.NODE_ENV === "development",
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // React `style` attributes and Next's font CSS. Styles only — never scripts.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    // The preview iframe: `/api/admin/moderation/sites/:id/preview`, under its own policy.
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}
