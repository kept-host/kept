"use client";

import type { WaitlistJoinRequest } from "@kept/shared";
import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { CHECK_INBOX_TEXT, EmailForm } from "./email-form";

/** The landing's three doors; `founding` has its own page. */
export type LandingSource = Exclude<WaitlistJoinRequest["source"], "founding">;

/** What the dialog says before joining, per door (E06a §7). */
const PITCH: Record<LandingSource, { title: string; description: string }> = {
  landing_drop: {
    title: "kept isn’t open yet",
    description:
      "Your page will publish the moment kept opens in December. Get the email.",
  },
  landing_nav: {
    title: "kept isn’t open yet",
    description:
      "kept opens in December. Leave your email and we’ll tell you the moment you can drop a page and keep it.",
  },
  landing_notify: {
    title: "Get notified",
    description:
      "Leave your email and we’ll tell you when kept opens in December — agent publishing included.",
  },
};

/**
 * The landing's email dialog. It opens where a publish would have happened on
 * a deploy that is not yet open (`lib/launch.ts`) — a dropped, chosen or
 * pasted page (`landing_drop`) — from the nav (`landing_nav`), which offers it
 * in place of sign-in, and from the agents section's "Get notified"
 * (`landing_notify`). The form is the shared `EmailForm` (double opt-in, E06a §3).
 *
 * `joined` outlives a close on purpose: dropping a second page after joining
 * says "check your inbox" rather than asking again.
 */
export function WaitlistDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: LandingSource;
}) {
  const [joined, setJoined] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Above the landing's own fixed layers — the sticky nav is z 60 and
          the traveling tile higher — which the shared z-50 would sit under. */}
      <DialogContent
        data-testid="waitlist-dialog"
        className="z-[110] w-[calc(100%-2rem)] max-w-md"
        overlayClassName="z-[110]"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold tracking-[-0.02em]">
            {joined ? "Check your inbox." : PITCH[source].title}
          </DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-text-secondary">
            {joined
              ? CHECK_INBOX_TEXT
              : PITCH[source].description}
          </DialogDescription>
        </DialogHeader>

        {/* Mounted only while the dialog is open, so Turnstile's script loads
            on first open — never with the landing. */}
        {joined ? null : <EmailForm source={source} onSuccess={() => setJoined(true)} />}
      </DialogContent>
    </Dialog>
  );
}
