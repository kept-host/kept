"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, QrCode as QrIcon } from "lucide-react";

import type { SiteStatus } from "@kept/shared";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The live URL and the three things a publisher does with it — copy, QR, open.
 * Shared by `/p/[anonToken]` (task 008) and `/keep/[anonToken]` (task 009);
 * neither screen may grow its own copy of this block.
 *
 * THE QR ARRIVES AS A PROP, ALREADY RENDERED. The encoder runs in a server
 * component and the finished SVG is passed down (`components/kept/qr.tsx`), so
 * this client bundle carries no encoder and this screen makes no request for an
 * image. Toggling the panel is state; generating the code is not.
 *
 * THE LIVE DOT IS DATA. It is driven by the row's `status`, not switched on
 * because the screen rendered — a page that is not `live` must not claim to be.
 */

const STATUS_LABEL: Record<SiteStatus, string> = {
  live: "Live",
  archived: "Not serving",
  expired: "Expired",
  quarantined: "Under review",
  under_review: "Under review",
  removed: "Removed",
};

/** Only `live` gets the green pulse; everything else is a stated problem. */
function statusTone(status: SiteStatus): { dot: string; text: string } {
  return status === "live"
    ? { dot: "bg-live motion-safe:animate-[keptLive_2s_ease-in-out_infinite]", text: "text-live" }
    : { dot: "bg-text-muted", text: "text-text-muted" };
}

export function LiveUrlBlock({
  liveUrl,
  slug,
  status,
  qr,
  className,
}: {
  liveUrl: string;
  slug: string;
  status: SiteStatus;
  /** The pre-rendered QR SVG. Omit to hide the QR control entirely. */
  qr?: React.ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const [qrOpen, setQrOpen] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qrPanelId = useId();

  // A pending flash timer after unmount would set state on a dead component.
  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  function flash(result: "done" | "failed") {
    setCopied(result);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setCopied("idle"), 1600);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(liveUrl);
      flash("done");
    } catch {
      // Clipboard access can be refused outright (permissions, an insecure
      // context). Say so instead of flashing a "Copied" that did not happen —
      // this link is the only handle the visitor has.
      flash("failed");
    }
  }

  const tone = statusTone(status);
  // The slug is the part that is theirs; the suffix is ours. Splitting on the
  // real host keeps the domain out of this file — no hostname literal.
  const hostSuffix = new URL(liveUrl).host.slice(slug.length);

  return (
    <div className={cn("flex flex-col items-center gap-5", className)}>
      <span
        className={cn(
          "mono-label inline-flex items-center gap-2 text-xs",
          tone.text,
        )}
      >
        <span aria-hidden="true" className={cn("size-2 rounded-full", tone.dot)} />
        {STATUS_LABEL[status]}
      </span>

      <h1 className="break-words font-display text-[clamp(1.9rem,5.2vw,2.9rem)] font-bold text-text">
        {slug}
        <span className="text-text-muted">{hostSuffix}</span>
      </h1>

      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Button type="button" onClick={copy} className="min-w-[8.5rem]">
          {copied === "done" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy link"}
        </Button>

        {qr ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setQrOpen((open) => !open)}
            aria-expanded={qrOpen}
            aria-controls={qrPanelId}
          >
            <QrIcon aria-hidden="true" />
            QR
          </Button>
        ) : null}

        <Button variant="secondary" asChild>
          {/* `noreferrer` alongside `noopener`: the manage URL carries a bearer
              token in its path, and a `Referer` header would hand that token to
              the hosted page. */}
          <a href={liveUrl} target="_blank" rel="noopener noreferrer">
            Open
            <ArrowUpRight aria-hidden="true" />
          </a>
        </Button>
      </div>

      {/* One polite live region for both outcomes, so a screen reader hears the
          result of a copy it cannot see flash. */}
      <span aria-live="polite" className="sr-only">
        {copied === "done"
          ? "Link copied to the clipboard."
          : copied === "failed"
            ? "Could not copy the link. Select it and copy manually."
            : ""}
      </span>

      {qr ? (
        <div id={qrPanelId} hidden={!qrOpen}>
          <div className="inline-flex flex-col items-center gap-2 rounded-[var(--r-lg)] border border-border bg-surface p-4 shadow-[var(--shadow-md)]">
            {qr}
            <span className="mono-label text-[10px] text-text-muted">
              Scan to open
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
