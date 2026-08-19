import Link from "next/link";

/**
 * The friendly end of every unresolvable claim link — unknown token, malformed
 * token, deleted page, expired-past-grace page, moderated page.
 *
 * ONE ANSWER FOR ALL OF THEM, mirroring `resolveAnonToken` returning `null` for
 * every one of those reasons. Naming the reason would be an oracle: it turns a
 * guessed token into a probe for whether somebody's page exists, and it tells a
 * stranger holding a stale link more than they are entitled to know.
 *
 * The audience is the difference from `/p/[anonToken]`'s version: this reader
 * was handed a link by somebody else and may never have heard of kept, so this
 * page says what kept is and does not talk about publishing something they never
 * published.
 */
export default function ClaimNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">Nothing here</p>
        <h1 className="font-display text-3xl font-semibold text-text">
          This link doesn&rsquo;t open a page
        </h1>
      </div>
      <div className="flex flex-col gap-4 text-text-secondary">
        {/* MOST LIKELY FIRST. Keeping a page nulls its `anon_token_hash`, so a
            keep link stops resolving the moment it is used — the commonest way
            to land here is someone revisiting a link they already kept. The old
            copy led with a mistyped address, which is the rarer case.

            Saying a keep link expires once used describes how keep links work;
            it does not say which reason applies to THIS one. The indistinguish-
            able answer survives, because the app genuinely cannot tell a kept
            page from a token that never existed. */}
        <p>
          A keep link stops working once it&rsquo;s been used — if you already
          kept this page, it&rsquo;s live at its own address. The link may also
          be incomplete: the part after{" "}
          <span className="font-mono text-text">/keep/</span> is long, and
          messaging apps often break it across lines.
        </p>
        <p>kept gives a single web page a permanent home, free.</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {/* The exit that was missing. Someone who kept the page and came back
            to check on it had nowhere to go but the marketing site.

            Relative on purpose: `/keep/*` is redirected from the apex to the
            `app.` origin, so this screen is always already on `app.` and a bare
            path lands on the right host without reading an env var. */}
        <Link
          href="/dashboard"
          className="mono-label text-xs text-accent hover:underline"
        >
          Find your page in the dashboard →
        </Link>
        <Link
          href="/"
          className="mono-label text-xs text-text-secondary hover:underline"
        >
          See what kept is
        </Link>
      </div>
    </main>
  );
}
