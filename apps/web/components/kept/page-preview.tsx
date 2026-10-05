import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The frame every preview of a published page draws it in — this card, and the
 * studio card's hover preview (E06 task 016, `hover-preview.tsx`).
 *
 * WHY `srcDoc` AND NOT `src`. The obvious implementation — an iframe pointing at
 * the live URL — cannot work and must not be attempted: the Worker serves every
 * hosted page with `Content-Security-Policy: frame-ancestors 'none'` and
 * `X-Frame-Options: DENY` (`apps/edge/src/headers.ts`), which is a deliberate
 * clickjacking defence for user pages and is not up for renegotiation by a
 * control-plane screen. Those headers govern a NAVIGATED frame; an iframe whose
 * document comes from `srcdoc` has no response and therefore no headers, so the
 * caller reads the page's bytes itself and hands them here.
 *
 * THE SANDBOX. Never `allow-same-origin`: the document is stranger-authored HTML
 * on the AUTHENTICATED origin, and without that token it lives in an opaque
 * origin of its own — no cookies, no storage, no reach into this page, and every
 * request it makes says `Origin: null`, which the cookie-authenticated routes
 * refuse (`lib/publish/origin.ts`). Never navigation, popups, forms or modals.
 * By default not even scripts (`sandbox=""`, the maximally restrictive value);
 * `scripts` grants exactly `allow-scripts`, for a preview whose point is to show
 * the page as it actually runs. `pointer-events-none` makes it a picture rather
 * than a thing to click, and `no-referrer` tells nothing it loads where it is.
 */
export function PageFrame({
  html,
  title,
  scripts = false,
  className,
  ...frame
}: {
  html: string;
  title: string;
  /** Grant `allow-scripts` — and nothing else. */
  scripts?: boolean;
  className?: string;
} & Pick<ComponentProps<"iframe">, "aria-hidden" | "loading" | "onLoad" | "style" | "tabIndex">) {
  return (
    <iframe
      title={title}
      srcDoc={html}
      sandbox={scripts ? "allow-scripts" : ""}
      referrerPolicy="no-referrer"
      // `bg-white` rather than a kept surface token on purpose: an author's page
      // is written against a browser's white default and an iframe paints no
      // background of its own, so a themed backdrop would show dark-mode kept
      // behind somebody else's black text.
      className={cn("pointer-events-none border-0 bg-white", className)}
      {...frame}
    />
  );
}

/**
 * A look at the published page itself — shared by `/p/[anonToken]` (task 008)
 * and `/keep/[anonToken]` (task 009), where a human who was handed a link by an
 * agent has to work out what they are being asked to keep, and by the studio's
 * page detail (E06 task 012). The caller reads the page's bytes server-side.
 *
 * `html === null` is a normal state, not an error: the bytes may be too large to
 * inline, or the object read may have failed. The card still names the page.
 */
export function PagePreview({
  liveUrl,
  html,
  className,
  frameClassName = "aspect-[16/10] w-full",
}: {
  liveUrl: string;
  /** The page's HTML, already read server-side, or `null` when unavailable. */
  html: string | null;
  className?: string;
  /**
   * The rendering area's box. A 16:10 card by default; page detail (E06 task
   * 012) sizes it to its desktop / phone-width toggle instead.
   */
  frameClassName?: string;
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

      <div className={cn("bg-bg", frameClassName)}>
        {html === null ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">
            Preview unavailable — open the page to see it.
          </div>
        ) : (
          <PageFrame html={html} title={`Preview of ${host}`} loading="lazy" className="h-full w-full" />
        )}
      </div>

      <figcaption className="sr-only">
        A preview of the page published at {host}.
      </figcaption>
    </figure>
  );
}
