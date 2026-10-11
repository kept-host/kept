"use client";

import {
  WAITLIST_CONSENT_TEXT,
  type WaitlistJoinRequest,
} from "@kept/shared";
import { type FormEvent, type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { farewellHref } from "@/lib/routing/host-split";
import { submitWaitlist } from "@/lib/waitlist/client";

import { LegalLinks } from "./legal-links";
import { Turnstile } from "./turnstile";

/**
 * The one email form every apex surface uses (E06a §3, §5, AC21): the field,
 * the consent line, Turnstile, the Impressum · Privacy links, and every state
 * the PRD lists. It posts `POST /api/waitlist`; the server is the authority —
 * the browser's `type=email` check is a convenience.
 *
 * `children` renders extra fields inside the form and `extra` turns them into
 * body fields (task 006's founding form adds `founding` this way).
 */

export const CHECK_INBOX_TEXT =
  "Check your inbox and click the link to confirm. Nothing else arrives until you do.";

const ERRORS = {
  rate_limited: "Too many tries, try again in a bit.",
  turnstile: "The verification didn’t pass. Complete it again, then retry.",
  network: "kept couldn’t be reached. Check your connection and try again.",
} as const;

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "invalid"; message: string }
  | { kind: keyof typeof ERRORS };

/** The consent line, with its markdown link made a real (apex) link. */
function ConsentLine() {
  const landing = farewellHref(process.env.NEXT_PUBLIC_APP_URL);
  const parts = WAITLIST_CONSENT_TEXT.split(/(\[[^\]]+\]\([^)]+\))/);
  return (
    <p data-testid="consent-line" className="text-xs leading-relaxed text-text-muted">
      {parts.map((part, index) => {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (!link) return part;
        const [, label, path] = link;
        const href = landing === "/" ? path! : new URL(path!, landing).href;
        return (
          <a key={index} href={href} className="text-accent underline">
            {label}
          </a>
        );
      })}
    </p>
  );
}

export function EmailForm({
  source,
  submitLabel = "Join the waitlist",
  successText = CHECK_INBOX_TEXT,
  onSuccess,
  children,
  extra,
}: {
  source: WaitlistJoinRequest["source"];
  submitLabel?: string;
  successText?: string;
  onSuccess?: () => void;
  children?: ReactNode;
  extra?: (data: FormData) => Partial<WaitlistJoinRequest>;
}) {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [widget, setWidget] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  if (status.kind === "success") {
    return (
      <p role="status" data-testid="email-form-success" className="text-[15px] leading-relaxed text-text">
        {successText}
      </p>
    );
  }

  /** Tokens are single-use: a refused submit gets a fresh widget. */
  function freshWidget() {
    setToken(null);
    setWidget((n) => n + 1);
  }

  async function submit(form: HTMLFormElement) {
    if (status.kind === "submitting") return;
    if (!token) {
      setStatus({ kind: "turnstile" });
      return;
    }
    setStatus({ kind: "submitting" });
    const result = await submitWaitlist({
      email,
      source,
      turnstileToken: token,
      ...extra?.(new FormData(form)),
    } as WaitlistJoinRequest);
    if (result.kind === "ok") {
      setStatus({ kind: "success" });
      onSuccess?.();
      return;
    }
    if (result.kind !== "network") freshWidget();
    setStatus(result.kind === "invalid" ? { kind: "invalid", message: result.message } : { kind: result.kind });
  }

  const pending = status.kind === "submitting";
  const error =
    status.kind === "invalid"
      ? status.message
      : status.kind in ERRORS
        ? ERRORS[status.kind as keyof typeof ERRORS]
        : null;

  return (
    <form
      data-testid="email-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <Input
          type="email"
          name="email"
          required
          maxLength={254}
          autoComplete="email"
          placeholder="you@example.com"
          aria-label="Email address"
          aria-invalid={status.kind === "invalid" || undefined}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
          className="text-[15px]"
        />
        <Button type="submit" disabled={pending} className="shrink-0">
          {pending ? "Sending…" : submitLabel}
        </Button>
      </div>

      {children}

      <Turnstile
        key={widget}
        onToken={(next) => {
          setToken(next);
          if (next && status.kind === "turnstile") setStatus({ kind: "idle" });
        }}
        onFailure={() => {
          setToken(null);
          setStatus({ kind: "turnstile" });
        }}
      />

      {error ? (
        <div className="flex items-center gap-3">
          <p role="alert" data-testid="email-form-error" className="text-sm leading-relaxed text-danger">
            {error}
          </p>
          {status.kind === "network" ? (
            <Button type="submit" variant="secondary" size="sm" className="shrink-0">
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConsentLine />
      <LegalLinks />
    </form>
  );
}
