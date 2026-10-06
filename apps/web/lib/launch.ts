/**
 * The launch gate — whether kept is open to the public on this deploy.
 *
 * **Open** is the product: publish from the landing or the API, sign in, keep
 * pages. **Closed** is the waitlist: the landing still renders in full, but a
 * dropped page opens the waitlist dialog instead of publishing, and every
 * surface that publishes or signs in is gone — `decideClosedAction` in
 * `lib/routing/host-split.ts` sends its pages to the landing and 404s its APIs
 * before a route handler runs, so no page can be published and no session can
 * be minted.
 *
 * ⚠️ IT FAILS CLOSED. Only the exact string `true` opens; unset, empty or any
 * other value is the waitlist. Prod has never been deployed and has dozens of
 * variables to set, so a forgotten one must not open publishing and sign-in to
 * the world. Every track that should be open — dev, CI, local — sets
 * `NEXT_PUBLIC_KEPT_OPEN=true` (the Playwright harness defaults it for you).
 *
 * `NEXT_PUBLIC_` because the landing (a client component) and `middleware.ts`
 * (the edge bundle) both need it, and those are inlined into every bundle at
 * build time — see `parseAppOrigin` in `host-split.ts` for why a server-only
 * read in the middleware bundle is not safe. So flipping it takes a rebuild,
 * which Railway does on any variable change. Not a secret: it says whether the
 * doors are open.
 *
 * A function rather than a constant so the unit suite, which runs the
 * middleware under `tsx` where nothing is inlined, can set it per case — the
 * same reason `middleware.ts` reads `NEXT_PUBLIC_APP_URL` at call time.
 */
export function keptOpen(): boolean {
  return process.env.NEXT_PUBLIC_KEPT_OPEN?.trim() === "true";
}
