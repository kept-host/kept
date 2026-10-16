import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LegalLinks } from "@/components/kept/legal-links";
import { legalPlaceholdersRemain, legalTitle, renderLegal } from "@/lib/legal";
import { isLegalDoc, LEGAL_DOCS } from "@/lib/legal/links";

/** Only the `LEGAL_DOCS` texts exist; any other `/legal/*` is a 404. */
export const dynamicParams = false;

export function generateStaticParams() {
  return LEGAL_DOCS.map((doc) => ({ doc }));
}

type Props = { params: Promise<{ doc: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { doc } = await params;
  if (!isLegalDoc(doc)) return {};
  return { title: legalTitle(doc) };
}

export default async function LegalPage({ params }: Props) {
  const { doc } = await params;
  if (!isLegalDoc(doc)) notFound();

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-16">
      {legalPlaceholdersRemain() && (
        <p
          role="status"
          className="rounded-md border border-warning bg-sunken px-4 py-3 font-mono text-sm text-text"
        >
          <strong>DRAFT</strong> — this text still contains placeholders and is
          not final.
        </p>
      )}
      <article
        className="flex flex-col gap-4 text-text-secondary [&_a]:text-accent [&_a]:underline [&_code]:font-mono [&_h1]:font-display [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:text-text [&_h2]:mt-4 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-text [&_h3]:font-display [&_h3]:font-semibold [&_h3]:text-text [&_li]:ml-5 [&_ol]:list-decimal [&_strong]:text-text [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1"
        dangerouslySetInnerHTML={{ __html: renderLegal(doc) }}
      />
      <footer className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <Link
          href="/"
          className="mono-label text-xs text-accent hover:underline"
        >
          ← Back to kept
        </Link>
        <LegalLinks />
      </footer>
    </main>
  );
}
