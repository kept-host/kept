"use client";

/**
 * Publishing from the Pages home — D9, PRD §5.1 (E06 task 011).
 *
 * One path for every way a page arrives — a file dropped anywhere on the
 * screen, a file dropped on or chosen in the sheet's zone, pasted HTML — and it
 * ends at `POST /api/sites`, never the keyless `/api/publish`.
 *
 *   1. Pre-flight: `checkPageFile` / `checkPageHtml`, the same courtesy checks
 *      the landing runs, against the same `MAX_PAGE_BYTES` the server enforces.
 *      A refused file never becomes a request (AC7). The server re-validates
 *      every byte and is the only authority.
 *   2. While the request is in flight, a placeholder card in the mint state
 *      stands where the page will land (`minting`).
 *   3. On the answer: the PRD's toast — kept, at the limit, or "already
 *      published" — then `router.refresh()` inside a transition, so the mint
 *      card gives way to the real one in the same commit and the new (or
 *      existing, on a duplicate) card is highlighted (AC8).
 *
 * A failure is kept as `error` for the caller to show inline on the drop zone
 * that was used, in the server's or the pre-flight's own words.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { checkPageHtml, publishErrorText } from "@/lib/publish/client";
import {
  ALREADY_PUBLISHED_NOTICE,
  atLimitPublishToast,
  PUBLISHED_KEPT_TOAST,
} from "@/lib/sites/display";
import { publishOwnedHtml } from "@/lib/sites/owner-client";

/** How long a just-published (or duplicate) card stays ringed. */
const HIGHLIGHT_MS = 4000;

/** The placeholder card shown while a publish is in flight. */
export interface Minting {
  /** What is arriving — the file's name, or "Pasted HTML". */
  label: string;
}

export interface Publisher {
  minting: Minting | null;
  error: string | null;
  highlightId: string | null;
  /** A file that passed `DropTarget`'s pre-flight. Resolves `true` when it landed. */
  publishFile: (file: File) => Promise<boolean>;
  /** Pasted markup. Resolves `true` when it landed. */
  publishHtml: (html: string) => Promise<boolean>;
  /** A pre-flight refusal from a drop target, shown where the error goes. */
  refuse: (message: string) => void;
  clearError: () => void;
}

export function usePublish({ keptLimit }: { keptLimit: number }): Publisher {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [minting, setMinting] = useState<Minting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // An answer arriving after the screen is gone must not set state on it. The
  // write itself is not undone — the page is published either way.
  useEffect(() => {
    return () => {
      abort.current?.abort();
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  const send = useCallback(
    async (html: string, label: string): Promise<boolean> => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;

      setError(null);
      setMinting({ label });
      const outcome = await publishOwnedHtml(html, controller.signal);
      if (controller.signal.aborted) return false;

      if (!outcome.ok) {
        setMinting(null);
        setError(outcome.error.message);
        return false;
      }

      const { site, duplicate } = outcome.page;
      const host = new URL(site.liveUrl).host;
      if (duplicate) toast(ALREADY_PUBLISHED_NOTICE, { description: host });
      else if (site.expiresAt !== null) toast.success(atLimitPublishToast(keptLimit), { description: host });
      else toast.success(PUBLISHED_KEPT_TOAST, { description: host });

      // One transition: the mint card leaves, the real card arrives ringed.
      startTransition(() => {
        setMinting(null);
        setHighlightId(site.id);
        router.refresh();
      });
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
      return true;
    },
    [keptLimit, router],
  );

  const publishFile = useCallback(
    async (file: File) => {
      let html: string;
      try {
        html = await file.text();
      } catch {
        setError("That file could not be read. Try choosing it again.");
        return false;
      }
      return send(html, file.name);
    },
    [send],
  );

  const publishHtml = useCallback(
    async (html: string) => {
      const refusal = checkPageHtml(html);
      if (refusal) {
        setError(publishErrorText(refusal));
        return false;
      }
      return send(html, "Pasted HTML");
    },
    [send],
  );

  const refuse = useCallback((message: string) => setError(message), []);
  const clearError = useCallback(() => setError(null), []);

  return { minting, error, highlightId, publishFile, publishHtml, refuse, clearError };
}
