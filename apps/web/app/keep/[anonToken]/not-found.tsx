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
        <p>
          kept gives a single web page a permanent home, free — and a link like
          this one is how a page gets kept. No page matches this one. It may be
          mistyped or cut short, or the page may have been taken down or run out
          of time; we can&rsquo;t tell you which, because this link is the key to
          somebody&rsquo;s page and we answer the same way to everybody who holds
          one.
        </p>
        <p>
          If someone sent you the link, check you have the whole address — the
          part after <span className="font-mono text-text">/keep/</span> is long
          and messaging apps often break it across lines.
        </p>
      </div>
      <Link href="/" className="mono-label text-xs text-accent hover:underline">
        ← See what kept is
      </Link>
    </main>
  );
}
