import { waitlistHref } from "./routing/host-split";

/**
 * The launch gate — whether kept is open to the public on this deploy.
 *
 * **Open** is the product: publish from the landing or the API, sign in, keep
 * pages. **Closed** is the waitlist: the landing still renders in full, but a
 * dropped page opens the waitlist dialog instead of publishing, and every
 * surface that publishes or signs in is narrowed to the admins (E06a §1) —
 * `decideClosedAction` in `lib/routing/host-split.ts` 404s every API it does not
 * allow before a route handler runs, the publish routes check for an access
 * token or an admin session first (`lib/launch-access.ts`), and Better Auth
 * refuses sign-in to anyone but an admin.
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

/**
 * The operator's publish pause (E09 task 011) — `KEPT_PUBLISH_PAUSED=true` and
 * every route that lands new page content (publish, replace, upload; keyless,
 * studio, `/api/v1`, MCP) answers 503 `publishing_paused` before it reads
 * anything (`publishPausedResponse` in `lib/publish/http.ts`). Serving, keeps,
 * renames, deletes, restores, reports and moderation stay up: a takedown must
 * never be blocked by the pause. No admin bypass — it means "nothing new lands".
 *
 * Server-only and read per call, never at module load: Railway restarts the
 * service on a variable change, so flipping it needs no rebuild. Only the exact
 * string `true` pauses; unset or anything else is publishing on.
 */
export function publishPaused(): boolean {
  return process.env.KEPT_PUBLISH_PAUSED?.trim() === "true";
}

/**
 * The answer to a blocked API call on a closed deploy (E06a §1) — from the
 * middleware, and from a publish handler whose caller is neither an access
 * token nor an admin. A 404, so a closed deploy says no more about its routes
 * than that kept is not open; the waitlist link is built from configuration.
 */
export function notOpenResponse(): Response {
  return Response.json(
    {
      error: "not_open",
      message: "kept opens in December.",
      waitlist: waitlistHref(process.env.NEXT_PUBLIC_APP_URL),
    },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}
