"use client";

import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { submitWaitlist } from "@/lib/waitlist/client";

/**
 * The landing's waitlist, for a deploy that is not yet open (`lib/launch.ts`).
 * It opens where a publish would have happened — a dropped, chosen or pasted
 * page — and from the nav, which offers it in place of sign-in.
 *
 * `joined` outlives a close on purpose: dropping a second page after joining
 * says "you're on the list" rather than asking again.
 */
export function WaitlistDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const failure = await submitWaitlist(email);
    setPending(false);
    if (failure) setError(failure);
    else setJoined(true);
  }

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
            {joined ? "You’re on the list." : "kept isn’t open yet"}
          </DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-text-secondary">
            {joined
              ? "We’ll email you the day kept opens. Your first page will be live in seconds."
              : "Publishing opens soon. Leave your email and we’ll tell you the moment you can drop a page and keep it."}
          </DialogDescription>
        </DialogHeader>

        {joined ? null : (
          <form onSubmit={submit} className="flex flex-col gap-2.5 sm:flex-row">
            <Input
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              aria-label="Email address"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
              className="text-[15px]"
            />
            <Button type="submit" disabled={pending} className="shrink-0">
              {pending ? "Joining…" : "Join the waitlist"}
            </Button>
          </form>
        )}

        {error ? (
          <p role="alert" data-testid="waitlist-error" className="text-sm leading-relaxed text-danger">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
