import Link from "next/link";

/**
 * The friendly end of every unresolvable manage link — unknown token, malformed
 * token, deleted page, expired-past-grace page, moderated page.
 *
 * ONE ANSWER FOR ALL OF THEM, mirroring `notFound()` in
 * `lib/publish/anon-token.ts`. Naming the reason would be an oracle: it turns a
 * guessed token into a probe for whether somebody's page exists, and it tells a
 * stranger holding a stale link more than they are entitled to know. The copy is
 * therefore vague on purpose and says so as warmly as it can.
 */
export default function ResultNotFound() {
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
          No page matches it. The address may be mistyped, or the page it managed
          may have been deleted or have expired — we can&rsquo;t tell you which,
          because a link like this one is the key to somebody&rsquo;s page and we
          answer the same way to everybody who holds one.
        </p>
        <p>
          If you published the page, check the link you were given when it went
          live — it is the whole address, including the part after{" "}
          <span className="font-mono text-text">/p/</span>.
        </p>
      </div>
      <Link href="/" className="mono-label text-xs text-accent hover:underline">
        ← Publish a page
      </Link>
    </main>
  );
}
