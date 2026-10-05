"use client";

/**
 * The page itself, over its card's thumbnail, while a mouse rests on the card —
 * E06 task 016 (Arun: "yes live preview on hover can be good").
 *
 * ── WHEN ─────────────────────────────────────────────────────────────────────
 * Only on a device that can hover with a fine pointer — `(hover: hover) and
 * (pointer: fine)`, and the pointer must be a mouse — so a tap on a phone opens
 * the page detail exactly as before and never starts a fetch. Only after the
 * pointer has rested `HOVER_DELAY_MS`: sweeping across a wall fetches nothing.
 * Leaving the card, or the window losing focus, unmounts the frame and aborts a
 * fetch still in flight. Whether a card offers a preview at all is the caller's
 * (`preview` absent: a page that is not live, or too large to inline).
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────
 * The page cannot be framed by URL: the edge sends `frame-ancestors 'none'` and
 * `X-Frame-Options: DENY` with every hosted page, deliberately (AC35 leaves the
 * edge alone). So the caller's loader reads the page's bytes — the owner-only
 * download route — and the frame renders them through `srcdoc` in the same
 * sandbox every preview uses (`PageFrame`), with scripts allowed so a page built
 * by script looks the way it does live, and without `allow-same-origin`. One
 * read per page per version for the session: the HTML is kept here, keyed by id
 * and `updated_at`, so a replace or a rename reads it afresh.
 *
 * ── LOOK ─────────────────────────────────────────────────────────────────────
 * The page is laid out at a desktop width (`PREVIEW_WIDTH`) and scaled down to
 * the thumbnail, so the card shows what a visitor's screen shows rather than a
 * page squeezed into 300 px. It fades in over the gradient once it has loaded;
 * under reduced motion it simply appears — a preview is content, not motion.
 */
import { type PointerEvent, useEffect, useRef, useState } from "react";

import { PageFrame } from "@/components/kept/page-preview";
import { cn } from "@/lib/utils";

/**
 * Reads a page's HTML for its preview — `null` when it cannot be shown. A stable
 * function (the module-level `readPageHtml`), never a fresh closure: the hover
 * effect depends on it.
 */
export type PreviewLoader = (siteId: string, signal: AbortSignal) => Promise<string | null>;

/** How long the pointer rests on a card before the page is fetched. */
const HOVER_DELAY_MS = 350;

/** A device that hovers with a precise pointer: a mouse or a trackpad, not a finger. */
const FINE_HOVER = "(hover: hover) and (pointer: fine)";

/** The desktop width a preview lays the page out at, before scaling it to the card. */
const PREVIEW_WIDTH = 1280;

/** Each page's HTML, once read, for the session — keyed by id and version (`updated_at`). */
const htmlByVersion = new Map<string, string>();

/**
 * The hover state of one card. Spread the handlers on the card; render
 * `<HoverPreview>` over the thumbnail while `html` is set.
 */
export function useHoverPreview(
  site: { id: string; updatedAt: Date },
  load: PreviewLoader | undefined,
) {
  const [hovering, setHovering] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const { id } = site;
  const key = `${id}@${site.updatedAt.getTime()}`;

  useEffect(() => {
    if (!hovering || !load) return;
    const abort = new AbortController();
    const leave = () => setHovering(false);
    window.addEventListener("blur", leave);
    const timer = setTimeout(() => {
      const known = htmlByVersion.get(key);
      if (known !== undefined) {
        setHtml(known);
        return;
      }
      void load(id, abort.signal).then((page) => {
        if (page === null || abort.signal.aborted) return;
        htmlByVersion.set(key, page);
        setHtml(page);
      });
    }, HOVER_DELAY_MS);

    return () => {
      clearTimeout(timer);
      abort.abort();
      window.removeEventListener("blur", leave);
      setHtml(null);
    };
  }, [hovering, load, id, key]);

  return {
    html,
    onPointerEnter(event: PointerEvent) {
      if (load && event.pointerType === "mouse" && window.matchMedia(FINE_HOVER).matches) {
        setHovering(true);
      }
    },
    onPointerLeave() {
      setHovering(false);
    },
  };
}

/**
 * The page, scaled into the box it is mounted in (`absolute inset-0` over the
 * thumbnail). Measured with a `ResizeObserver`, so the scale follows the card.
 */
export function HoverPreview({ html, name }: { html: string; name: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = size && size.width > 0 ? size.width / PREVIEW_WIDTH : null;

  return (
    <div
      ref={box}
      data-testid="card-preview"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {scale === null || size === null ? null : (
        <PageFrame
          html={html}
          title={`Preview of ${name}`}
          scripts
          aria-hidden="true"
          tabIndex={-1}
          onLoad={() => setLoaded(true)}
          style={{
            width: PREVIEW_WIDTH,
            height: size.height / scale,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
          }}
          className={cn(
            "absolute left-0 top-0 opacity-0 motion-safe:transition-opacity motion-safe:duration-200 motion-safe:ease-[ease]",
            loaded && "opacity-100",
          )}
        />
      )}
    </div>
  );
}
