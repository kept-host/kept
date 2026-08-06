/**
 * `/auth/callback/done` — what happened to the page you just kept. Task 009.
 *
 * The last screen of the zero-context flow: a stranger opened a link an agent
 * handed them, pressed one button, signed in, and this says where their page
 * stands. Six outcomes, one card, and every one of them has a way onward —
 * nobody who has just signed in may dead-end.
 *
 * IT READS NO COOKIE AND WRITES NO ROW. `../page.tsx` did both and redirected
 * here with the outcome in the address bar, which is what makes this screen
 * survive a refresh and a back button; see the reasoning in that file. All the
 * durations and the cap come from `@kept/shared`.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlert, Check, Clock } from "lucide-react";

import { DRAFT_GRACE_DAYS, KEPT_PAGE_LIMIT } from "@kept/shared";

import { DraftChip } from "@/components/kept/draft-chip";
import { Button } from "@/components/ui/button";
import { APP_HOME } from "@/lib/auth/return-path";
import { liveUrl } from "@/lib/publish/pipeline";

import { AuthShell } from "../../auth-shell";
import { isKeepOutcomeCode, type KeepOutcomeCode } from "./outcomes";

/** `liveUrl` reads the base domain from the environment at request time. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your page",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The slug is the page's own hostname, so it is rendered — but it arrives from
 * the address bar and goes into `liveUrl()`, so it is held to the shape the
 * publisher pipeline mints: lowercase words and digits joined by hyphens.
 */
function safeSlug(value: string | undefined): string | null {
  return value && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value) ? value : null;
}

/** An ISO instant from the address bar, or `null`. Never `Invalid Date`. */
function safeInstant(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const TONE: Record<"live" | "warning" | "danger" | "muted", string> = {
  live: "text-accent",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-text-muted",
};

interface Panel {
  tone: keyof typeof TONE;
  icon: React.ReactNode;
  heading: string;
  body: string;
  primary: { href: string; label: string };
  secondary?: { href: string; label: string };
  chip?: React.ReactNode;
}

function panelFor(
  outcome: KeepOutcomeCode,
  slug: string | null,
  expiresAt: Date | null,
): Panel {
  const url = slug ? liveUrl(slug) : null;
  const host = url ? new URL(url).host : "Your page";
  const dashboard = { href: APP_HOME, label: "Go to your dashboard" };
  const open = url
    ? { href: url, label: "Open the page" }
    : undefined;

  switch (outcome) {
    case "kept":
      return {
        tone: "live",
        icon: <Check aria-hidden="true" className="size-5" strokeWidth={2.4} />,
        heading: "Kept forever",
        body: `${host} is permanent. Same link, same file, no clock — nothing about the page moved, and nothing expires.`,
        primary: dashboard,
        secondary: open,
      };
    case "restored":
      return {
        tone: "live",
        icon: <Check aria-hidden="true" className="size-5" strokeWidth={2.4} />,
        heading: "It is back",
        body: `${host} is answering again — same file, same address — and it is permanent now. No clock, no expiry.`,
        primary: dashboard,
        secondary: open,
      };
    case "draft":
      // THE CAP IS A BRANCH, NOT AN ERROR. The page is owned and still serving;
      // it simply kept its clock. The swap chooser is E06 — this is the prompt
      // and the entry point.
      return {
        tone: "warning",
        icon: <Clock aria-hidden="true" className="size-5" />,
        heading: "Saved to your account — as a draft",
        body: `You're keeping ${KEPT_PAGE_LIMIT} pages. This one is saved to your account as a draft — swap it in, or upgrade for more. It is still live at ${host}, on the clock below.`,
        chip: expiresAt ? <DraftChip expiresAt={expiresAt} /> : undefined,
        primary: { href: APP_HOME, label: "Swap it in" },
        secondary: open,
      };
    case "gone":
      // Task 008 answers unknown, already-kept and past-grace identically, and
      // this copy must not pretend to know which of them happened.
      return {
        tone: "muted",
        icon: <CircleAlert aria-hidden="true" className="size-5" />,
        heading: "This page has already been kept, or the link has expired",
        body: `Keeping a page retires its old link, so a link that has already been used stops opening — and an expired draft can only be brought back within ${DRAFT_GRACE_DAYS} days of its deadline. If the page is already yours, it is in your dashboard.`,
        primary: dashboard,
      };
    case "signed-out":
      return {
        tone: "danger",
        icon: <CircleAlert aria-hidden="true" className="size-5" />,
        heading: "You are not signed in yet",
        body: "Nothing was changed, and the page is exactly where it was. Open the keep link you were given again and finish signing in — it takes one more click.",
        primary: { href: "/auth", label: "Sign in" },
      };
    default:
      // A retry cannot be a button here: it would have to carry the bearer token
      // back into the document, and no recovery is worth that. The link the
      // visitor already holds is the retry.
      return {
        tone: "danger",
        icon: <CircleAlert aria-hidden="true" className="size-5" />,
        heading: "We could not finish keeping that page",
        body: "Nothing was left half-written and you are signed in. Open the keep link you were given again to retry — if it still will not go through, the page is untouched and still serving.",
        primary: dashboard,
      };
  }
}

export default async function KeepDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = firstValue(params.outcome);
  // An unrecognised value gets the generic failure rather than a blank screen.
  const outcome: KeepOutcomeCode = isKeepOutcomeCode(raw) ? raw : "failed";
  const panel = panelFor(
    outcome,
    safeSlug(firstValue(params.slug)),
    safeInstant(firstValue(params.expires)),
  );

  return (
    <AuthShell>
      <div className="rounded-[var(--r-xl)] border border-border bg-surface p-8 shadow-[var(--shadow-lg)]">
        <div className={`mb-3 ${TONE[panel.tone]}`}>{panel.icon}</div>
        <h1 className="mb-2 font-display text-[1.625rem] font-bold tracking-[-0.02em] text-text">
          {panel.heading}
        </h1>
        <p className="text-sm leading-[1.55] text-text-secondary">{panel.body}</p>

        {panel.chip ? <div className="mt-4">{panel.chip}</div> : null}

        <div className="mt-[26px] flex flex-col gap-3">
          <Button asChild className="h-auto w-full py-3.5 text-[0.9375rem]">
            <Link href={panel.primary.href}>{panel.primary.label}</Link>
          </Button>
          {panel.secondary ? (
            <Button
              asChild
              variant="secondary"
              className="h-auto w-full py-3.5 text-[0.9375rem]"
            >
              {/* The hosted page is a different origin. `no-referrer` is set in
                  this route's metadata, so this screen's address does not
                  travel with the click. */}
              <a
                href={panel.secondary.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {panel.secondary.label}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </AuthShell>
  );
}
