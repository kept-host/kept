"use client";

/**
 * Publishing from the Pages home — D9, PRD §5.1 (E06 tasks 011, 015).
 *
 * One path for every way a page arrives — a file dropped anywhere on the
 * screen, a file dropped on or chosen in the sheet's zone, pasted HTML — and it
 * ends at `POST /api/sites`, never the keyless `/api/publish`.
 *
 *   1. Pre-flight: `checkPageFile` / `checkPageHtml`, the same courtesy checks
 *      the landing runs, against the same `MAX_PAGE_BYTES` the server enforces.
 *      A refused file never becomes a request (AC7) and its sentence is
 *      `error`, shown where it was dropped. The server re-validates every byte
 *      and is the only authority.
 *   2. The request leaves: `onSend` closes the sheet (the design's `publish()`)
 *      and the mint card stands where the page will land (`minting`, `sending`).
 *   3. The answer: the PRD's toast — kept, at the limit, or "already published"
 *      — with Copy link; the mint card's mascot hops (`landed`); then one
 *      transition swaps the mint card for the real one, arriving (AC8: on a
 *      duplicate, the existing card).
 *
 * A failed request turns the mint card into its error (`failed`) in the
 * server's own words, with Try again (the same bytes again) and dismiss — the
 * sheet is closed by then, so PRD §9.1's "inline error on the drop zone" has no
 * zone to sit on.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { toastWithCopyLink } from "@/components/kept/link-toast";
import { prefersReducedMotion } from "@/lib/motion";
import { checkPageHtml, publishErrorText } from "@/lib/publish/client";
import {
  ALREADY_PUBLISHED_NOTICE,
  atLimitPublishToast,
  PUBLISHED_KEPT_TOAST,
} from "@/lib/sites/display";
import { publishOwnedHtml } from "@/lib/sites/owner-client";

import type { Arrival } from "./use-arrival";

/** How long the mint card's mascot hops before the real card takes its place. */
export const MINT_HOP_MS = 450;

/** The page that is arriving, and what Try again would send. */
export type Minting = {
  /** The file's name, or "Pasted HTML". */
  label: string;
  html: string;
} & ({ phase: "sending" } | { phase: "landed" } | { phase: "failed"; error: string });

export interface Publisher {
  minting: Minting | null;
  /** A publish is in flight — the drop targets stand down. */
  busy: boolean;
  /** A pre-flight refusal, for the drop target that was used. */
  error: string | null;
  /** A file that passed `DropTarget`'s pre-flight. */
  publishFile: (file: File) => Promise<void>;
  /** Pasted markup. */
  publishHtml: (html: string) => Promise<void>;
  /** A pre-flight refusal from a drop target, shown where the error goes. */
  refuse: (message: string) => void;
  clearError: () => void;
  /** Send the failed page again. */
  retry: () => void;
  /** Put the failed mint card away. */
  dismiss: () => void;
}

/** Resolve after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function usePublish({
  keptLimit,
  onSend,
  arrive,
}: {
  keptLimit: number;
  /** The request is leaving. Stable (a callback), or every drop target re-binds. */
  onSend: () => void;
  arrive: (next: Arrival, before?: () => void) => void;
}): Publisher {
  const [minting, setMinting] = useState<Minting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // An answer arriving after the screen is gone must not set state on it. The
  // write itself is not undone — the page is published either way.
  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  const send = useCallback(
    async (html: string, label: string) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      setError(null);
      setMinting({ label, html, phase: "sending" });
      onSend();
      const outcome = await publishOwnedHtml(html, controller.signal);
      if (controller.signal.aborted) return;

      if (!outcome.ok) {
        setMinting({ label, html, phase: "failed", error: outcome.error.message });
        return;
      }

      const { site, duplicate } = outcome.page;
      toastWithCopyLink(
        duplicate
          ? ALREADY_PUBLISHED_NOTICE
          : site.expiresAt !== null
            ? atLimitPublishToast(keptLimit)
            : PUBLISHED_KEPT_TOAST,
        site.liveUrl,
        !duplicate,
      );

      setMinting({ label, html, phase: "landed" });
      if (!prefersReducedMotion()) await pause(MINT_HOP_MS, controller.signal);
      if (controller.signal.aborted) return;
      arrive({ id: site.id, kind: duplicate ? "duplicate" : "published" }, () => setMinting(null));
    },
    [keptLimit, onSend, arrive],
  );

  const publishFile = useCallback(
    async (file: File) => {
      let html: string;
      try {
        html = await file.text();
      } catch {
        setError("That file could not be read. Try choosing it again.");
        return;
      }
      await send(html, file.name);
    },
    [send],
  );

  const publishHtml = useCallback(
    async (html: string) => {
      const refusal = checkPageHtml(html);
      if (refusal) {
        setError(publishErrorText(refusal));
        return;
      }
      await send(html, "Pasted HTML");
    },
    [send],
  );

  const retry = useCallback(() => {
    if (minting?.phase === "failed") void send(minting.html, minting.label);
  }, [minting, send]);

  const refuse = useCallback((message: string) => setError(message), []);
  const clearError = useCallback(() => setError(null), []);
  const dismiss = useCallback(() => setMinting(null), []);

  return {
    minting,
    busy: minting !== null && minting.phase !== "failed",
    error,
    publishFile,
    publishHtml,
    refuse,
    clearError,
    retry,
    dismiss,
  };
}
