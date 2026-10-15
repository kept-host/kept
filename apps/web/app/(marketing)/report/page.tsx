import { ABUSE_CONTACT_EMAIL, REPORT_URL_MAX } from "@kept/shared";
import type { Metadata } from "next";
import Link from "next/link";

import { LegalLinks } from "@/components/kept/legal-links";
import { ReportForm } from "@/components/kept/report-form";

/**
 * `/report` (apex, public, open and closed alike) — anyone reports a kept page
 * (E07 D10, §6.8). `?url=` prefills the link. The form posts `POST /api/reports`.
 */
export const metadata: Metadata = { title: "Report a page" };

type Props = { searchParams: Promise<{ url?: string | string[] }> };

export default async function ReportPage({ searchParams }: Props) {
  const { url } = await searchParams;
  const initialUrl = (Array.isArray(url) ? url[0] : url)?.slice(0, REPORT_URL_MAX) ?? "";

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">Report a page</p>
        <h1 className="font-display text-3xl font-semibold text-text">Tell us about a page.</h1>
        <p className="text-text-secondary">
          If a page on kept is a scam, steals logins, spreads malware or breaks the law, tell us
          here. We read every report. You can also email{" "}
          <a href={`mailto:${ABUSE_CONTACT_EMAIL}`} className="text-accent underline">
            {ABUSE_CONTACT_EMAIL}
          </a>
          .
        </p>
      </div>
      <ReportForm initialUrl={initialUrl} />
      <footer className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <Link href="/" className="mono-label text-xs text-accent hover:underline">
          ← Back to kept
        </Link>
        <LegalLinks />
      </footer>
    </main>
  );
}
