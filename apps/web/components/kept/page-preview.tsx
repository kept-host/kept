import { cn } from "@/lib/utils";

/**
 * A look at the published page itself — shared by `/p/[anonToken]` (task 008)
 * and `/keep/[anonToken]` (task 009), where a human who was handed a link by an
 * agent has to work out what they are being asked to keep.
 *
 * WHY `srcDoc` AND NOT `src`. The obvious implementation — an iframe pointing at
 * the live URL — cannot work and must not be attempted: the Worker serves every
 * hosted page with `Content-Security-Policy: frame-ancestors 'none'` and
 * `X-Frame-Options: DENY` (`apps/edge/src/headers.ts`), which is a deliberate
 * clickjacking defence for user pages and is not up for renegotiation by a
 * control-plane screen. Those headers govern a NAVIGATED frame; an iframe whose
 * document comes from `srcdoc` has no response and therefore no headers, so the
 * caller reads the page's bytes server-side and hands them here.
 *
 * The frame is `sandbox=""` — the maximally restrictive value. No scripts, no
 * forms, no same-origin, no navigation, no popups. A preview of an arbitrary
 * stranger-authored document is exactly the place to grant nothing at all, and
 * `pointer-events-none` makes it a picture rather than a thing to click.
 *
 * `html === null` is a normal state, not an error: the bytes may be too large to
 * inline, or the object read may have failed. The card still names the page.
 */
export function PagePreview({
  liveUrl,
  html,
  className,
}: {
  liveUrl: string;
  /** The page's HTML, already read server-side, or `null` when unavailable. */
  html: string | null;
  className?: string;
}) {
  const host = new URL(liveUrl).host;

  return (
    <figure
      className={cn(
        "overflow-hidden rounded-[var(--r-lg)] border border-border bg-surface shadow-[var(--shadow-md)]",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-border bg-sunken px-4 py-2.5">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2 rounded-full bg-border" />
          <span className="size-2 rounded-full bg-border" />
          <span className="size-2 rounded-full bg-border" />
        </span>
        <span className="truncate font-mono text-[11px] text-text-muted">
          {host}
        </span>
      </div>

      <div className="aspect-[16/10] w-full bg-bg">
        {html === null ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">
            Preview unavailable — open the page to see it.
          </div>
        ) : (
          <iframe
            title={`Preview of ${host}`}
            srcDoc={html}
            sandbox=""
            referrerPolicy="no-referrer"
            loading="lazy"
            // `bg-white` rather than a kept surface token on purpose: an
            // author's page is written against a browser's white default and an
            // iframe paints no background of its own, so a themed backdrop
            // would show dark-mode kept behind somebody else's black text.
            className="pointer-events-none h-full w-full border-0 bg-white"
          />
        )}
      </div>

      <figcaption className="sr-only">
        A preview of the page published at {host}.
      </figcaption>
    </figure>
  );
}
