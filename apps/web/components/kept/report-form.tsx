"use client";

import {
  ABUSE_CONTACT_EMAIL,
  REPORT_CATEGORIES,
  REPORT_DETAILS_MAX,
  REPORT_DETAILS_MIN,
  REPORT_URL_MAX,
  REPORTER_NAME_MAX,
  reportRequestSchema,
  type ReportCategory,
} from "@kept/shared";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { submitReport } from "@/lib/reports/client";

import { Turnstile } from "./turnstile";

/**
 * The report form (E07 D10, §6.8, §9). Built from E06a's `EmailForm` patterns
 * (Turnstile remount on a refused submit, one status machine, inline alerts) —
 * no Claude Design skin was imported for it. The server is the authority; the
 * inline field errors come from the same shared schema, minus the token.
 */

type Field = "url" | "category" | "details" | "name" | "email" | "goodFaith";

const FIELD_ERRORS: Record<Field, string> = {
  url: "Paste the link to the page.",
  category: "Choose what's wrong.",
  details: `Tell us why in ${REPORT_DETAILS_MIN} to ${REPORT_DETAILS_MAX} characters.`,
  name: `Keep your name under ${REPORTER_NAME_MAX} characters.`,
  email: "Enter a valid email address, or leave it empty.",
  goodFaith: "Confirm you're reporting in good faith.",
};

const ERRORS = {
  not_a_kept_page: "That link isn't a kept page.",
  rate_limited: "Too many reports from here — try again later.",
  turnstile: "The verification didn't pass. Complete it again, then send.",
  error: `Couldn't send that. Email ${ABUSE_CONTACT_EMAIL} instead.`,
} as const;

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "sent"; withEmail: boolean }
  | { kind: keyof typeof ERRORS };

const formSchema = reportRequestSchema.omit({ turnstileToken: true });

function FieldError({ field, errors }: { field: Field; errors: Partial<Record<Field, string>> }) {
  const message = errors[field];
  return message ? (
    <span id={`report-${field}-error`} data-testid={`report-${field}-error`} className="text-sm text-danger">
      {message}
    </span>
  ) : null;
}

export function ReportForm({ initialUrl }: { initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [details, setDetails] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [goodFaith, setGoodFaith] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [widget, setWidget] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

  if (status.kind === "sent") {
    return (
      <div role="status" data-testid="report-sent" className="flex flex-col gap-2">
        <p className="font-display text-xl font-semibold text-text">Thanks — we&rsquo;ve got it.</p>
        <p className="text-text-secondary">
          We&rsquo;ll look at the page and act if it breaks our rules.
          {status.withEmail ? " We’ll email you what we decide." : null}
        </p>
      </div>
    );
  }

  /** Tokens are single-use: a refused submit gets a fresh widget. */
  function freshWidget() {
    setToken(null);
    setWidget((n) => n + 1);
  }

  async function submit() {
    if (status.kind === "submitting") return;
    const parsed = formSchema.safeParse({ url, category, details, name, email, goodFaith });
    if (!parsed.success) {
      const found: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field;
        found[field] ??= FIELD_ERRORS[field];
      }
      setErrors(found);
      setStatus({ kind: "idle" });
      return;
    }
    setErrors({});
    if (!token) {
      setStatus({ kind: "turnstile" });
      return;
    }
    setStatus({ kind: "submitting" });
    const result = await submitReport({ ...parsed.data, turnstileToken: token });
    if (result.kind === "ok") {
      setStatus({ kind: "sent", withEmail: parsed.data.email !== undefined });
      return;
    }
    freshWidget();
    if (result.kind === "invalid") {
      // The server disagreed with a field the form accepted; say so generally.
      setStatus({ kind: "error" });
      return;
    }
    setStatus({ kind: result.kind });
  }

  const pending = status.kind === "submitting";
  const alert = status.kind in ERRORS ? ERRORS[status.kind as keyof typeof ERRORS] : null;
  const describedBy = (field: Field) => (errors[field] ? `report-${field}-error` : undefined);

  return (
    <form
      data-testid="report-form"
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-6"
    >
      <fieldset disabled={pending} className="flex flex-col gap-6">
        <label className="flex flex-col gap-1.5 text-sm text-text">
          Link to the page
          <Input
            type="url"
            name="url"
            inputMode="url"
            maxLength={REPORT_URL_MAX}
            placeholder="https://"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            aria-invalid={errors.url ? true : undefined}
            aria-describedby={describedBy("url")}
            className="text-[15px]"
          />
          <FieldError field="url" errors={errors} />
        </label>

        <fieldset
          className="flex flex-col gap-2"
          aria-invalid={errors.category ? true : undefined}
          aria-describedby={describedBy("category")}
        >
          <legend className="mb-1 text-sm text-text">What&rsquo;s wrong?</legend>
          {REPORT_CATEGORIES.map(({ reason, label }) => (
            <label key={reason} className="flex items-center gap-2.5 text-[15px] text-text">
              <input
                type="radio"
                name="category"
                value={reason}
                checked={category === reason}
                onChange={() => setCategory(reason)}
                className="size-4 accent-accent"
              />
              {label}
            </label>
          ))}
          <FieldError field="category" errors={errors} />
        </fieldset>

        <label className="flex flex-col gap-1.5 text-sm text-text">
          Tell us what you saw
          <Textarea
            name="details"
            maxLength={REPORT_DETAILS_MAX}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            aria-invalid={errors.details ? true : undefined}
            aria-describedby={describedBy("details") ?? "report-details-count"}
            className="min-h-32 text-[15px]"
          />
          <span id="report-details-count" className="mono-label self-end text-text-muted">
            {details.trim().length}/{REPORT_DETAILS_MAX}
          </span>
          <FieldError field="details" errors={errors} />
        </label>

        <div className="flex flex-col gap-3">
          {category === "child_sexual_abuse" ? (
            <p data-testid="report-csam-note" className="text-sm text-text-secondary">
              For this kind of report you don&rsquo;t need to give your name or email.
            </p>
          ) : null}
          <label className="flex flex-col gap-1.5 text-sm text-text">
            <span>
              Your name <span className="text-text-muted">(optional)</span>
            </span>
            <Input
              name="name"
              autoComplete="name"
              maxLength={REPORTER_NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy("name")}
              className="text-[15px]"
            />
            <FieldError field="name" errors={errors} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm text-text">
            <span>
              Your email <span className="text-text-muted">(optional — so we can tell you what happened)</span>
            </span>
            <Input
              type="email"
              name="email"
              autoComplete="email"
              maxLength={254}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={describedBy("email")}
              className="text-[15px]"
            />
            <FieldError field="email" errors={errors} />
          </label>
        </div>

        <label className="flex items-start gap-2.5 text-sm text-text">
          <input
            type="checkbox"
            name="goodFaith"
            checked={goodFaith}
            onChange={(event) => setGoodFaith(event.target.checked)}
            aria-invalid={errors.goodFaith ? true : undefined}
            aria-describedby={describedBy("goodFaith")}
            className="mt-0.5 size-4 accent-accent"
          />
          <span className="flex flex-col gap-1">
            I believe in good faith that what I&rsquo;m reporting is accurate and complete.
            <FieldError field="goodFaith" errors={errors} />
          </span>
        </label>
      </fieldset>

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

      {alert ? (
        <p role="alert" data-testid="report-error" className="text-sm leading-relaxed text-danger">
          {alert}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Sending…" : "Send report"}
      </Button>
    </form>
  );
}
