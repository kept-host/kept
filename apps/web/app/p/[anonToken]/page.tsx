/**
 * `/p/[anonToken]` — the anonymous manage screen. E04 task 008.
 *
 * For a visitor with no account this URL is the ONLY handle they have on their
 * page: it is what copies the link, replaces the file, deletes the page and
 * starts the keep. Everything below is a client of the APIs tasks 005 and 006
 * already built; this screen adds no server behaviour of its own.
 *
 * THE URL IS A BEARER CREDENTIAL, and this file is where that has consequences:
 *
 * - `robots: noindex, nofollow` — a manage link in a search index is somebody
 *   else's delete button.
 * - `referrer: "no-referrer"` — every outbound navigation from this document
 *   would otherwise carry the token in a `Referer` header to whatever it lands
 *   on, including the visitor's own hosted page. The metadata sets it for the
 *   whole document; `LiveUrlBlock` also pins `rel="noopener noreferrer"` on the
 *   one link that leaves the origin.
 * - The token is never logged. The failure log below names the site id and the
 *   slug, which diagnose everything and grant nothing.
 *
 * THE READ IS A DIRECT POSTGRES READ from a server component, per the repo's
 * architecture rule, through the ONE token resolver
 * (`lib/publish/anon-token.ts`). No second hashing, no second 404 shape.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { DraftChip } from "@/components/kept/draft-chip";
import { PagePreview } from "@/components/kept/page-preview";
import { QrCode } from "@/components/kept/qr";
import { keptCount } from "@/lib/landing-stats";
import { resolveAnonToken, type AnonSite } from "@/lib/publish/anon-token";
import { liveUrl } from "@/lib/publish/pipeline";
import { pageObjectKey, r2Store } from "@/lib/storage/r2";
import { ResultScreen } from "./result-screen";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** A bearer-token screen showing live state. Never cached, never prerendered. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your page",
  description: "Copy, replace, delete or keep the page you just published.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Bytes of published HTML the preview will inline. `MAX_PAGE_BYTES` is 5 MB and
 * this markup is serialized into the RSC payload of every render, so a page
 * above this cap gets the card without the render rather than a slow screen.
 */
const PREVIEW_MAX_BYTES = 256 * 1024;

/**
 * The page's own bytes, for the preview — read from R2, which is the authority
 * on them, rather than from the edge (whose hosted-page CSP forbids framing
 * anyway; see `components/kept/page-preview.tsx`).
 *
 * BEST EFFORT BY DESIGN. A preview is worth zero outages: if the object read
 * fails or the store is unconfigured, the screen still renders with everything
 * that actually matters — the URL, the clock and the four actions.
 */
async function readPreviewHtml(site: AnonSite): Promise<string | null> {
  if (!site.currentVersionId) return null;
  if (site.sizeBytes !== null && site.sizeBytes > PREVIEW_MAX_BYTES) return null;

  try {
    return await r2Store().get(pageObjectKey(site.id, site.currentVersionId));
  } catch (err) {
    console.error(
      `[kept] result: preview read failed for site ${site.id} (slug "${site.slug}") — ${
        err instanceof Error ? err.message : String(err)
      }. Rendering the screen without it.`,
    );
    return null;
  }
}

export default async function ResultPage({
  params,
}: {
  params: Promise<{ anonToken: string }>;
}) {
  const { anonToken } = await params;

  // Unknown, malformed, archived, expired-past-grace, moderated: all `null`,
  // all the same friendly 404 (`./not-found.tsx`). A distinguishable answer
  // would turn a token guess into a probe for somebody else's page.
  const site = await resolveAnonToken(anonToken);
  if (!site) notFound();

  const url = liveUrl(site.slug);
  const html = await readPreviewHtml(site);

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-[1100px] items-center justify-between px-6">
          <Link
            href="/"
            className="font-display text-xl font-bold tracking-[-0.03em] text-text"
          >
            kept
          </Link>
          <span
            title="pages kept forever, right now"
            className="mono-label text-xs text-text-secondary"
          >
            {keptCount.toLocaleString("en-US")} pages kept
          </span>
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-6 py-12">
        <ResultScreen
          anonToken={anonToken}
          liveUrl={url}
          slug={site.slug}
          status={site.status}
          // The chip, the preview and the QR are rendered HERE, on the server:
          // the chip so its countdown cannot disagree with a hydrated clock, the
          // QR so the encoder never reaches the browser bundle, the preview so
          // the page's bytes are read with a credential the browser never sees.
          chip={<DraftChip expiresAt={site.expiresAt} />}
          preview={<PagePreview liveUrl={url} html={html} />}
          qr={<QrCode value={url} label={`QR code for ${url}`} />}
        />
      </main>
    </div>
  );
}
