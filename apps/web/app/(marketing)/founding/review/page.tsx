import type { Metadata } from "next";

import { FoundingReview } from "@/components/kept/founding-review";
import { readFoundingReview } from "@/lib/founding/review";

/**
 * `/founding/review?t=…` — the link in Arun's application mail (E06a §4,
 * AC13). A GET renders the applicant card and the Approve / Decline buttons
 * and changes nothing; mail scanners open every link. An expired or tampered
 * `t` renders the expired state.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Founding application",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function FoundingReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { t } = await searchParams;
  const application = typeof t === "string" ? await readFoundingReview(t) : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">Founding review</p>
        <h1 className="font-display text-3xl font-semibold text-text">Founding application</h1>
      </div>
      {application && typeof t === "string" ? (
        <>
          <dl
            data-testid="applicant-card"
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-[var(--r-md)] border border-border bg-surface p-5 text-sm"
          >
            <dt className="text-text-muted">Email</dt>
            <dd className="break-all text-text">{application.email}</dd>
            <dt className="text-text-muted">Social</dt>
            <dd className="break-all">
              {application.socialUrl ? (
                <a
                  href={application.socialUrl}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  className="text-accent underline"
                >
                  {application.socialUrl}
                </a>
              ) : (
                <span className="text-text-muted">none</span>
              )}
            </dd>
            <dt className="text-text-muted">Makes with AI</dt>
            <dd className="whitespace-pre-wrap text-text">
              {application.note || <span className="text-text-muted">no note</span>}
            </dd>
            <dt className="text-text-muted">Status</dt>
            <dd data-testid="applicant-status" className="text-text">
              {application.foundingStatus}
            </dd>
          </dl>
          <FoundingReview token={t} />
        </>
      ) : (
        <FoundingReview token={null} />
      )}
    </main>
  );
}
