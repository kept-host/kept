"use client";

import { FOUNDING_NOTE_MAX } from "@kept/shared";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { EmailForm } from "./email-form";

const FOUNDING_SUCCESS_TEXT =
  "Check your inbox to confirm your email. Then your application goes to Arun.";

/**
 * The founding application (E06a §4): the shared `EmailForm` (email, consent,
 * Turnstile, every state) plus the social profile URL and the optional note,
 * posted as `source: founding` + `founding: { socialUrl, note }`. The server's
 * `waitlistJoinSchema` is the authority on both fields.
 */
export function FoundingForm() {
  const [note, setNote] = useState("");

  return (
    <EmailForm
      source="founding"
      submitLabel="Apply"
      successText={FOUNDING_SUCCESS_TEXT}
      extra={(data) => ({
        founding: {
          socialUrl: String(data.get("socialUrl") ?? ""),
          ...(note.trim() ? { note } : {}),
        },
      })}
    >
      <label className="flex flex-col gap-1.5 text-sm text-text">
        Your social profile URL
        <Input
          type="url"
          name="socialUrl"
          required
          maxLength={2048}
          placeholder="https://"
          className="text-[15px]"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm text-text">
        <span>
          What do you make with AI? <span className="text-text-muted">(optional)</span>
        </span>
        <Textarea
          name="note"
          maxLength={FOUNDING_NOTE_MAX}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          aria-describedby="founding-note-count"
        />
        <span id="founding-note-count" data-testid="note-count" className="mono-label self-end text-text-muted">
          {note.length}/{FOUNDING_NOTE_MAX}
        </span>
      </label>
    </EmailForm>
  );
}
