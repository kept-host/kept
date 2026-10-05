"use client";

/**
 * Copy a page's link and say so in a toast — the home card's Copy link (E06
 * task 011) and the publish toast's **Copy link** action (task 015, the design's
 * `publish()`: "Published · {address} · Copy link", whose title becomes "Link
 * copied" in place).
 */
import { toast } from "sonner";

import { COPY_FAILED, LINK_COPIED_TOAST } from "@/lib/sites/display";

/**
 * Copy `liveUrl` and toast the outcome. With `id`, that toast is rewritten in
 * place — Sonner merges the update, so its action stays and a second press
 * copies again — instead of a second toast stacking on the first.
 */
export async function copyLink(liveUrl: string, id?: string | number): Promise<void> {
  const options = { id, description: new URL(liveUrl).host };
  try {
    await navigator.clipboard.writeText(liveUrl);
    toast.success(LINK_COPIED_TOAST, options);
  } catch {
    toast.error(COPY_FAILED, options);
  }
}

/** A toast about one page that ends in **Copy link** — every publish outcome. */
export function toastWithCopyLink(message: string, liveUrl: string, success: boolean): void {
  const show = success ? toast.success : toast;
  const id = show(message, {
    description: new URL(liveUrl).host,
    action: {
      label: "Copy link",
      onClick: (event) => {
        // Sonner closes a toast after its action unless told not to; this one
        // stays up and turns into "Link copied".
        event.preventDefault();
        void copyLink(liveUrl, id);
      },
    },
  });
}
