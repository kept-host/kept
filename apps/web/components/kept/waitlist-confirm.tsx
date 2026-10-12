"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { confirmWaitlistToken } from "@/lib/waitlist/client";

import { EmailForm } from "./email-form";

type State = "ready" | "confirming" | "confirmed" | "confirmed_founding" | "expired" | "network";

/**
 * The `/waitlist/confirm` states (E06a §3, "UI states"): ready → confirming →
 * confirmed (with the founding line after a founding application, §4), or
 * expired with the rejoin form. Rendering this changes nothing;
 * only the button's POST confirms (D1). Without a token it starts expired.
 */
export function WaitlistConfirm({ token }: { token: string | null }) {
  const [state, setState] = useState<State>(token ? "ready" : "expired");

  async function confirm() {
    if (!token) return;
    setState("confirming");
    setState(await confirmWaitlistToken(token));
  }

  if (state === "confirmed" || state === "confirmed_founding") {
    return (
      <p role="status" data-testid="confirm-done" className="text-lg text-text">
        {state === "confirmed_founding"
          ? "You’re on the list, and your founding application is with Arun. You’ll hear back by email."
          : "You’re on the list. We’ll email you when kept opens."}
      </p>
    );
  }

  if (state === "expired") {
    return (
      <div data-testid="confirm-expired" className="flex flex-col gap-4">
        <p className="text-text-secondary">
          This link has expired or was already used. Enter your email again and we’ll send a
          fresh one.
        </p>
        <EmailForm source="landing_nav" submitLabel="Send a new link" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <Button type="button" onClick={confirm} disabled={state === "confirming"}>
        {state === "confirming" ? "Confirming…" : "Confirm my email"}
      </Button>
      {state === "network" ? (
        <p role="alert" className="text-sm text-danger">
          kept couldn’t be reached. Check your connection and press the button again.
        </p>
      ) : null}
    </div>
  );
}
