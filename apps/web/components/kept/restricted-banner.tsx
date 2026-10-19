"use client";

/**
 * The restricted banner (E07 §6.10, §9) — ONE component for the studio's
 * `/site/[id]` and the anonymous `/p/[anonToken]`. It replaces E06's flagged
 * banner and its `mailto:` appeal.
 *
 *   · under review — "This page is hidden while we take a look."
 *   · hidden (quarantined) — the same shape, firmer.
 *   · removed — the reason, then "Download until {date}" where the caller
 *     offers a download (the studio) and the bytes are not withheld (D13);
 *     otherwise the date the page is deleted for good.
 *   · every state: "Ask for a review", a short form posting to `appealUrl` —
 *     `POST /api/sites/:id/appeal` or `POST /api/anon/:token/appeal`, which
 *     answer one envelope (`appealErrorSchema`). An open appeal disables the
 *     button; a rejected one shows the decision note, and past the limit the
 *     date a new one is allowed.
 *
 * Copy is short, calm and blameless — the owner may be innocent and the check
 * may be wrong. It never names a rule or shows a probability: the view carries
 * only Appendix A's sentence and a person's note (`lib/moderation/restriction.ts`).
 */
import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";

import { APPEAL_MESSAGE_MAX, APPEAL_MESSAGE_MIN, appealErrorSchema } from "@kept/shared";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RestrictionView } from "@/lib/moderation/restriction";
import { formatUpdatedAt } from "@/lib/sites/display";
import { cn } from "@/lib/utils";

const HEADLINE: Record<RestrictionView["status"], string> = {
  under_review: "This page is hidden while we take a look.",
  quarantined: "This page is hidden. It stays offline unless a review brings it back.",
  removed: "This page was removed.",
};

const APPEAL_OPEN_NOTE = "We've got your request — we'll email you.";

const TOO_SHORT = `Tell us a little more — at least ${APPEAL_MESSAGE_MIN} characters.`;
const UNREACHABLE = "Couldn't send that — the request never reached us. Try again.";
const FAILED = "Couldn't send that. Try again in a moment.";

type Form = { state: "closed" } | { state: "open"; busy: boolean; error: string | null };

export function RestrictedBanner({
  view,
  appealUrl,
  downloadHref,
  className,
}: {
  view: RestrictionView;
  /** Where "Ask for a review" posts. */
  appealUrl: string;
  /** The owner's download, on a removed page the studio may still serve. Absent on `/p`. */
  downloadHref?: string;
  className?: string;
}) {
  const router = useRouter();
  const messageId = useId();
  const [form, setForm] = useState<Form>({ state: "closed" });
  const [message, setMessage] = useState("");
  // The request landed (or one was already open): the button stays off until
  // the refreshed view says otherwise.
  const [sent, setSent] = useState(false);

  const open = sent || view.appeal.state === "open";
  const limited = view.appeal.state === "limited" ? view.appeal.retryAt : null;
  const rejectedNote = view.appeal.state === "open" ? null : view.appeal.rejectedNote;
  const busy = form.state === "open" && form.busy;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (message.trim().length < APPEAL_MESSAGE_MIN) {
      setForm({ state: "open", busy: false, error: TOO_SHORT });
      return;
    }
    setForm({ state: "open", busy: true, error: null });

    let response: Response;
    try {
      response = await fetch(appealUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
    } catch {
      setForm({ state: "open", busy: false, error: UNREACHABLE });
      return;
    }

    if (response.status === 201) {
      setSent(true);
      setForm({ state: "closed" });
      router.refresh();
      return;
    }
    const refusal = appealErrorSchema.safeParse(await response.json().catch(() => null));
    if (!refusal.success) {
      setForm({ state: "open", busy: false, error: FAILED });
      return;
    }
    const { code, message: sentence } = refusal.data.error;
    if (code === "appeal_open") {
      setSent(true);
      setForm({ state: "closed" });
      router.refresh();
      return;
    }
    // The page changed under the form (restored, or past its window): the
    // refresh brings the screen that is true now; the sentence says why.
    if (code === "not_restricted" || code === "not_found") router.refresh();
    setForm({ state: "open", busy: false, error: sentence });
  }

  return (
    <section
      role="status"
      aria-label="Page restricted"
      data-testid="restricted-banner"
      data-state={view.status}
      className={cn(
        "flex flex-col gap-2 rounded-[var(--r-lg)] border border-[color-mix(in_srgb,var(--warning)_45%,var(--surface))] bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] px-5 py-4",
        className,
      )}
    >
      <p className="text-[15px] font-medium text-text">{HEADLINE[view.status]}</p>
      {view.reason ? (
        <p data-testid="restricted-reason" className="text-sm leading-relaxed text-pretty text-text">
          {view.reason}
        </p>
      ) : null}
      {view.note ? (
        <p data-testid="restricted-note" className="text-sm leading-relaxed text-pretty text-text">
          A note from the person who reviewed it: {view.note}
        </p>
      ) : null}

      {view.status === "removed" && view.deletesOn ? (
        view.downloadable && downloadHref ? (
          <Button asChild variant="secondary" size="sm" className="self-start font-body font-medium">
            <a href={downloadHref} data-testid="restricted-download" download>
              <Download aria-hidden="true" strokeWidth={1.5} />
              Download until {formatUpdatedAt(view.deletesOn)}
            </a>
          </Button>
        ) : (
          <p data-testid="restricted-deadline" className="text-sm text-text-secondary">
            It will be deleted for good on {formatUpdatedAt(view.deletesOn)}.
          </p>
        )
      ) : null}

      {rejectedNote && !open ? (
        <p data-testid="appeal-rejected" className="text-sm leading-relaxed text-pretty text-text">
          We looked at your last request again, and the decision stands: {rejectedNote}
        </p>
      ) : null}
      {open ? (
        <p data-testid="appeal-open" className="text-sm text-text">
          {APPEAL_OPEN_NOTE}
        </p>
      ) : limited ? (
        <p data-testid="appeal-limited" className="text-sm text-text-secondary">
          You can ask for another review on {formatUpdatedAt(limited)}.
        </p>
      ) : null}

      {form.state === "open" && !open ? (
        <form onSubmit={submit} noValidate className="flex flex-col gap-2 pt-1" data-testid="appeal-form">
          <label htmlFor={messageId} className="text-sm text-text">
            Why should it come back?
          </label>
          <Textarea
            id={messageId}
            data-testid="appeal-message"
            value={message}
            maxLength={APPEAL_MESSAGE_MAX}
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
            aria-invalid={form.error ? true : undefined}
            aria-describedby={`${messageId}-count${form.error ? ` ${messageId}-error` : ""}`}
            className="min-h-24 text-[15px]"
          />
          <span id={`${messageId}-count`} className="mono-label self-end text-text-muted">
            {message.length}/{APPEAL_MESSAGE_MAX}
          </span>
          {form.error ? (
            <p id={`${messageId}-error`} role="alert" data-testid="appeal-error" className="text-[13px] text-danger">
              {form.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" data-testid="appeal-submit" disabled={busy} className="font-body font-medium">
              {busy ? "Sending…" : "Send"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setForm({ state: "closed" })}
              className="font-body font-medium"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="appeal-button"
          disabled={open || limited !== null}
          onClick={() => setForm({ state: "open", busy: false, error: null })}
          className="self-start font-body font-medium"
        >
          Ask for a review
        </Button>
      )}
    </section>
  );
}
