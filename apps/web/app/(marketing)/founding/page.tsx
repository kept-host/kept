import type { Metadata } from "next";

import { FoundingForm } from "@/components/kept/founding-form";
import { foundingMetadata } from "@/lib/og/preview";

/**
 * `/founding` (apex) — the founding-creator offer and its application form
 * (E06a §4). The explainer is the PRD's text verbatim: decided facts only — no
 * duration, price, own domains or proposed-only Pro features.
 */
/**
 * Resolved per request: the preview's absolute image URL comes from
 * `NEXT_PUBLIC_APP_URL`, which a build without app env (CI) does not have — a
 * module-scope `metadata` const would read it at build time and fail it.
 */
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return foundingMetadata();
}

export default function FoundingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">Founding creators</p>
        <h1 className="font-display text-3xl font-semibold text-text">
          Become a founding creator.
        </h1>
        <p className="text-text-secondary">
          Founding creators get kept Pro free when kept opens in December — including the wall
          editor, so your page wall looks the way you want. Hand-picked: Arun looks at every
          application. No posting obligation.
        </p>
      </div>
      <FoundingForm />
    </main>
  );
}
