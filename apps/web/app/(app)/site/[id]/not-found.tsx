/**
 * `/site/[id]` for a page that is not the reader's — PRD §9.2: "This page
 * doesn't exist or isn't yours." + Back. One sentence for both on purpose: a
 * page that exists but belongs to someone else must read exactly like one that
 * never existed (D17), and a malformed id lands here too.
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";

import { Wordmark } from "../../wordmark";
import { BackLink, TOP_BAR } from "./back-link";

export default function SiteNotFound() {
  return (
    <>
      <header className={TOP_BAR}>
        <Wordmark className="text-[22px] md:hidden" />
        <BackLink />
      </header>
      <main className="flex flex-col items-start gap-4 px-4 pt-12 pb-24 md:px-10">
        <h1
          data-testid="site-not-found"
          className="font-display text-[28px] leading-[1.15] font-semibold tracking-[-0.03em] text-balance text-text"
        >
          This page doesn&rsquo;t exist or isn&rsquo;t yours.
        </h1>
        <Button asChild variant="secondary" size="sm" className="font-body font-medium">
          <Link href="/dashboard">Back</Link>
        </Button>
      </main>
    </>
  );
}
