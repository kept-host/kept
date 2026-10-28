import { remixPrompt } from "@kept/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { CodeBlock } from "@/components/kept/code-block";
import { LegalLinks } from "@/components/kept/legal-links";
import { Button } from "@/components/ui/button";
import { OG_CARD_HEIGHT, OG_CARD_WIDTH } from "@/lib/og/card-url";
import { remixPageData } from "@/lib/remix/read";

/**
 * `/remix/{slug}` (apex, public, open and closed alike) — E10 D7, D8, AC12.
 * A kept, live page whose owner allows remixing: its card, its title, "Made
 * with {model}", and the remix prompt from `@kept/shared` to copy or open in
 * Claude. Anything else 404s (`remixPageData`). No ChatGPT button (E09 D11), no
 * click logging (E15 D6). No imported design (Q10): built from the marketing
 * pages' layout and tokens; flagged for Arun's review.
 */
export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

const pageData = cache(remixPageData);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await pageData((await params).slug);
  if (!data) return { title: "Page not found" };
  const title = `Remix ${data.title} · kept`;
  const images = [{ url: data.ogImageUrl, width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT }];
  return {
    title: { absolute: title },
    openGraph: { title, images, siteName: "kept", type: "website" },
    twitter: { card: "summary_large_image", title, images },
  };
}

export default async function RemixPage({ params }: Props) {
  const data = await pageData((await params).slug);
  if (!data) notFound();

  const prompt = remixPrompt({ pageUrl: data.pageUrl, shownPrompt: data.shownPrompt });
  const q = encodeURIComponent(prompt);

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">Remix</p>
        <h1 className="font-display text-3xl font-semibold break-words text-text">{data.title}</h1>
        {data.model ? <p className="text-text-secondary">Made with {data.model}</p> : null}
      </div>

      <a href={data.pageUrl} className="block overflow-hidden rounded-lg border border-border bg-sunken">
        {/* The OG card is already a sized, immutable PNG; nothing for next/image to do. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={data.ogImageUrl}
          alt={`${data.title}, on kept`}
          width={OG_CARD_WIDTH}
          height={OG_CARD_HEIGHT}
          decoding="async"
          className="h-auto w-full"
        />
      </a>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold text-text">Make one like it</h2>
        <p className="text-text-secondary">
          Paste this into your AI. It builds a page like this one and publishes it with kept.
        </p>
        <CodeBlock code={prompt} label="the remix prompt" />
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <a href={`https://claude.ai/new?q=${q}`} target="_blank" rel="noopener noreferrer">
              Open in Claude
            </a>
          </Button>
          <Button asChild variant="secondary" className="hidden pointer-fine:inline-flex">
            <a href={`claude://claude.ai/new?q=${q}`}>Open in Claude desktop</a>
          </Button>
        </div>
      </section>

      <footer className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <Link href="/" className="mono-label text-xs text-accent hover:underline">
          ← Back to kept
        </Link>
        <LegalLinks />
      </footer>
    </main>
  );
}
