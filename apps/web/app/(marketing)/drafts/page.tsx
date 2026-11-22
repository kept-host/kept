import { DRAFT_TTL_DAYS } from "@kept/shared";
import type { Metadata } from "next";
import Link from "next/link";

import { LegalLinks } from "@/components/kept/legal-links";
import { Button } from "@/components/ui/button";

/**
 * `/drafts` (apex, public, open and closed alike) — E10 D4, Q14: what a draft
 * is, for a visitor who followed a draft's badge or found one expired. Static
 * and the same for every page: no countdown, nothing read. No imported design
 * (Q10): the marketing pages' layout and tokens; flagged for Arun's review.
 */
export const metadata: Metadata = { title: "Drafts" };

export default function DraftsPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">Drafts</p>
        <h1 className="font-display text-3xl font-semibold text-text">
          Drafts last {DRAFT_TTL_DAYS} days.
        </h1>
        <p className="text-text-secondary">
          The person who published this has the link to keep it.
        </p>
      </div>
      <div className="flex flex-col gap-3 text-text-secondary">
        <p>
          Every page on kept starts as a draft: it is live the moment it is published, and it
          stays up for {DRAFT_TTL_DAYS} days. When the publisher keeps it, it becomes a kept page
          and stays up for good.
        </p>
        <p>A draft nobody keeps goes offline when its {DRAFT_TTL_DAYS} days are up.</p>
      </div>
      <div>
        <Button asChild variant="secondary">
          <Link href="/">Publish a page of your own</Link>
        </Button>
      </div>
      <footer className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <Link href="/" className="mono-label text-xs text-accent hover:underline">
          ← Back to kept
        </Link>
        <LegalLinks />
      </footer>
    </main>
  );
}
