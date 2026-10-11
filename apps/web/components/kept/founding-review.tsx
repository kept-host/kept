"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

type State = "ready" | "deciding" | "approved" | "declined" | "expired" | "failed";

/**
 * The buttons on `/founding/review` (E06a §4, AC13). Rendering changes
 * nothing; only a press POSTs `/api/founding/review { t, decision }`. Without
 * a token (the page found the link expired or tampered) it starts expired.
 */
export function FoundingReview({ token }: { token: string | null }) {
  const [state, setState] = useState<State>(token ? "ready" : "expired");

  async function decide(decision: "approve" | "decline") {
    if (!token) return;
    setState("deciding");
    try {
      const response = await fetch("/api/founding/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: token, decision }),
      });
      if (response.status === 410) setState("expired");
      else if (response.ok) setState(decision === "approve" ? "approved" : "declined");
      else setState("failed");
    } catch {
      setState("failed");
    }
  }

  if (state === "approved" || state === "declined") {
    return (
      <p role="status" data-testid="review-done" className="text-lg text-text">
        {state === "approved" ? "Approved, the creator has been emailed" : "Declined"}
      </p>
    );
  }
  if (state === "expired") {
    return (
      <p role="alert" data-testid="review-expired" className="text-text-secondary">
        This review link has expired or is not valid. Use <code>admin:founding add</code> instead.
      </p>
    );
  }

  const pending = state === "deciding";
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex gap-3">
        <Button type="button" disabled={pending} onClick={() => void decide("approve")}>
          Approve
        </Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => void decide("decline")}>
          Decline
        </Button>
      </div>
      {state === "failed" ? (
        <p role="alert" className="text-sm text-danger">
          That didn’t go through, and nothing changed. Try again.
        </p>
      ) : null}
    </div>
  );
}
