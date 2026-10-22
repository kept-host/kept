"use client";

/**
 * Replace one page's files from the studio — the home card's drop and the
 * Versions tab's zone (E06 tasks 011, 012; E08 §5.7). One path for both: the
 * plan's size pre-flight, packing and the presigned upload
 * (`prepareOwnedBody`), `POST /api/sites/:id/replace`, then the shared replace
 * toast. Every refusal — before a request or from the server — goes to
 * `onRefuse`, which each surface shows where it has room.
 */
import { useEffect, useRef, useState } from "react";

import type { Plan } from "@kept/shared";

import type { UploadIntent } from "@/lib/publish/pack";
import { replacePage } from "@/lib/sites/owner-client";
import {
  prepareOwnedBody,
  uploadRefusal,
  type UploadProgress,
  type UploadRefusal,
} from "@/lib/sites/owner-upload";

import { toastReplaced } from "./replace-toast";

export function useReplace({
  siteId,
  host,
  plan,
  refresh,
  onRefuse,
}: {
  siteId: string;
  /** `{name}.{base}` — the page the toasts are about. */
  host: string;
  plan: Plan;
  refresh: () => void;
  onRefuse: (refusal: UploadRefusal) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const abort = useRef<AbortController | null>(null);

  // A screen that is gone sets no state; an upload still in flight is abandoned.
  useEffect(() => () => abort.current?.abort(), []);

  async function replace(intent: UploadIntent, spa: boolean) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { signal } = controller;

    setReplacing(true);
    const prepared = await prepareOwnedBody(intent, {
      plan,
      spa,
      signal,
      onProgress: (next) => {
        if (!signal.aborted) setProgress(next);
      },
    });
    if (!signal.aborted) setProgress(null);
    const outcome = prepared.ok
      ? await replacePage(siteId, prepared.body, signal)
      : ({ ok: false, error: prepared.error } as const);
    if (signal.aborted) return;
    setReplacing(false);
    setProgress(null);

    if (!outcome.ok) return onRefuse(uploadRefusal(outcome.error, plan));
    toastReplaced({ page: outcome.page, host, plan, refresh });
  }

  return { replacing, progress, replace };
}
