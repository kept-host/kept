"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveReminder } from "./manage-client";

/**
 * The optional reminder address — a client of `POST /api/sites/:token/reminder`.
 *
 * NOT A SIGNUP WALL, and the copy has to keep proving it. Nothing here creates
 * an account, asks for a password or blocks anything: the page is already live
 * and stays live whether or not this field is ever filled in. The field exists
 * for exactly one failure mode — the publisher closes the tab and loses the only
 * link they had.
 *
 * WHAT IS TRUE TODAY. E04 STORES the address; E05 owns the cron that sends
 * anything to it. The confirmation below therefore says the address is stored
 * and what it is for, and stops there — it must not claim an email has been
 * scheduled, because none has.
 *
 * WHAT IS NEVER SHOWN. Any address already on the row is not read or rendered.
 * `updateReminderEmail` deliberately answers identically whether one was stored,
 * overwritten or cleared, so that a stranger holding a leaked link cannot learn
 * that the publisher left an email address — printing it here would hand over
 * the one piece of personal data an anonymous page can carry.
 */

const HELPER =
  "Optional. One address, kept with this page and used for that reminder only — no account, no password, no list. Leave it empty and save to remove an address you added earlier.";

type Status = "idle" | "saving" | "saved" | "cleared" | "error";

export function ReminderForm({ anonToken }: { anonToken: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const fieldId = useId();
  const helpId = useId();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim();

    setStatus("saving");
    setError("");

    const result = await saveReminder(anonToken, value);
    if (!result.ok) {
      setStatus("error");
      setError(result.message);
      return;
    }

    setStatus(value === "" ? "cleared" : "saved");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Label htmlFor={fieldId}>Email me before this draft expires</Label>

      <div className="flex gap-2">
        <Input
          id={fieldId}
          type="email"
          name="reminderEmail"
          autoComplete="email"
          placeholder="you@example.com"
          aria-describedby={helpId}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (status !== "idle") setStatus("idle");
          }}
          className="flex-1"
        />
        <Button type="submit" variant="secondary" disabled={status === "saving"}>
          {status === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>

      <p id={helpId} className="text-xs leading-relaxed text-text-muted">
        {HELPER}
      </p>

      <p
        aria-live="polite"
        className={
          status === "error"
            ? "text-xs text-danger"
            : "text-xs text-text-secondary"
        }
      >
        {status === "saved"
          ? "Saved. It's stored with this page for the expiry reminder, and used for nothing else."
          : status === "cleared"
            ? "Cleared. No address is stored for this page."
            : status === "error"
              ? error
              : ""}
      </p>
    </form>
  );
}
