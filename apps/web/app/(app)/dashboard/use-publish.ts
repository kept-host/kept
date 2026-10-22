"use client";

/**
 * Publishing from the Pages home — D9, PRD §5.1 (E06 tasks 011, 015).
 *
 * One path for every way a page arrives — a file dropped anywhere on the
 * screen, a file dropped on or chosen in the sheet's zone, pasted HTML — and it
 * ends at `POST /api/sites`, never the keyless `/api/publish`.
 *
 *   1. Pre-flight: `checkPageFile` / `checkPageHtml` (in the drop target and
 *      here), the same courtesy checks the landing runs, against the same
 *      `MAX_PAGE_BYTES` the server enforces; and for a folder or file list the
 *      plan's `siteBytes` (`checkUpload`, E08 §5.7). A refused drop never
 *      becomes a request (AC7) and its sentence is `error`, shown where it was
 *      dropped — with the locked row when it is Free's size cap. The server
 *      re-validates every byte and is the only authority.
 *   2. The request leaves: `onSend` closes the sheet (the design's `publish()`)
 *      and the mint card stands where the page will land (`minting`, `sending`).
 *      A set is packed and, past one inline request, uploaded first
 *      (`prepareOwnedBody`); the mint card says "Packing…" / "Uploading…".
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

import type { Plan } from "@kept/shared";

import { toastWithCopyLink } from "@/components/kept/link-toast";
import { prefersReducedMotion } from "@/lib/motion";
import { checkPageHtml, publishErrorText } from "@/lib/publish/client";
import type { UploadIntent } from "@/lib/publish/pack";
import {
  ALREADY_PUBLISHED_NOTICE,
  atLimitPublishToast,
  PUBLISHED_KEPT_TOAST,
} from "@/lib/sites/display";
import { publishOwned } from "@/lib/sites/owner-client";
import { checkUpload, prepareOwnedBody, type UploadProgress } from "@/lib/sites/owner-upload";

import type { Arrival } from "./use-arrival";

/** How long the mint card's mascot hops before the real card takes its place. */
export const MINT_HOP_MS = 450;

/** The page that is arriving, and what Try again would send. */
export type Minting = {
  /** The file's or folder's name, or "Pasted HTML". */
  label: string;
  intent: UploadIntent;
  spa: boolean;
} & (
  | { phase: "sending"; progress: UploadProgress | null }
  | { phase: "landed" }
  | { phase: "failed"; error: string }
);

/** A refusal before anything was sent, and whether it earns the locked row (E06 D15). */
export interface PublishRefusal {
  message: string;
  locked: boolean;
}

export interface Publisher {
  minting: Minting | null;
  /** A publish is in flight — the drop targets stand down. */
  busy: boolean;
  /** A pre-flight refusal, for the drop target that was used. */
  error: PublishRefusal | null;
  /** "Serve as a single-page app" (D12) — sent with the next publish. */
  spa: boolean;
  setSpa: (spa: boolean) => void;
  /** What a drop target handed over. */
  publish: (intent: UploadIntent) => Promise<void>;
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
  plan,
  keptLimit,
  onSend,
  arrive,
}: {
  plan: Plan;
  keptLimit: number;
  /** The request is leaving. Stable (a callback), or every drop target re-binds. */
  onSend: () => void;
  arrive: (next: Arrival, before?: () => void) => void;
}): Publisher {
  const [minting, setMinting] = useState<Minting | null>(null);
  const [error, setError] = useState<PublishRefusal | null>(null);
  const [spa, setSpa] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // An answer arriving after the screen is gone must not set state on it. The
  // write itself is not undone — the page is published either way. An upload
  // still in flight is abandoned with it.
  useEffect(() => {
    return () => abort.current?.abort();
  }, []);

  const send = useCallback(
    async (intent: UploadIntent, withSpa: boolean) => {
      // The plan's size cap, before the sheet closes: the refusal (and Free's
      // locked row) shows where the set was dropped, and nothing is sent.
      const refused = checkUpload(intent, plan);
      if (refused) {
        setError({ message: refused.error.message, locked: refused.locked });
        return;
      }

      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const { label } = intent;
      const failed = (message: string) =>
        setMinting({ label, intent, spa: withSpa, phase: "failed", error: message });

      setError(null);
      setMinting({ label, intent, spa: withSpa, phase: "sending", progress: null });
      onSend();
      const prepared = await prepareOwnedBody(intent, {
        plan,
        spa: withSpa,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted) {
            setMinting({ label, intent, spa: withSpa, phase: "sending", progress });
          }
        },
      });
      if (controller.signal.aborted) return;
      if (!prepared.ok) return failed(prepared.error.message);
      // Packed and uploaded: what is left is the publish itself — "Keeping it…".
      setMinting({ label, intent, spa: withSpa, phase: "sending", progress: null });

      const outcome = await publishOwned(prepared.body, controller.signal);
      if (controller.signal.aborted) return;
      if (!outcome.ok) return failed(outcome.error.message);

      const { site, duplicate, ignored } = outcome.page;
      toastWithCopyLink(
        duplicate
          ? ALREADY_PUBLISHED_NOTICE
          : site.expiresAt !== null
            ? atLimitPublishToast(keptLimit)
            : PUBLISHED_KEPT_TOAST,
        site.liveUrl,
        !duplicate,
        ignored,
      );

      setMinting({ label, intent, spa: withSpa, phase: "landed" });
      if (!prefersReducedMotion()) await pause(MINT_HOP_MS, controller.signal);
      if (controller.signal.aborted) return;
      arrive({ id: site.id, kind: duplicate ? "duplicate" : "published" }, () => setMinting(null));
    },
    [plan, keptLimit, onSend, arrive],
  );

  const publish = useCallback((intent: UploadIntent) => send(intent, spa), [send, spa]);

  const publishHtml = useCallback(
    async (html: string) => {
      const refusal = checkPageHtml(html);
      if (refusal) {
        setError({ message: publishErrorText(refusal), locked: false });
        return;
      }
      const label = "Pasted HTML";
      await send({ kind: "html", file: new File([html], label, { type: "text/html" }), label }, spa);
    },
    [send, spa],
  );

  const retry = useCallback(() => {
    if (minting?.phase === "failed") void send(minting.intent, minting.spa);
  }, [minting, send]);

  const refuse = useCallback((message: string) => setError({ message, locked: false }), []);
  const clearError = useCallback(() => setError(null), []);
  const dismiss = useCallback(() => setMinting(null), []);

  return {
    minting,
    busy: minting !== null && minting.phase !== "failed",
    error,
    spa,
    setSpa,
    publish,
    publishHtml,
    refuse,
    clearError,
    retry,
    dismiss,
  };
}
