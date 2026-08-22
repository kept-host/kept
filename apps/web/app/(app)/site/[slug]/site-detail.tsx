"use client";

/**
 * The body of `/site/[slug]` — E06 task 008.
 *
 * ── WHY THE SHELL IS A CLIENT COMPONENT AND THE PAGE IS NOT ──────────────────
 * Two facts on this screen move without a navigation: the page's **clock** (keep
 * sets it to null, demote sets a fresh one, a swap does both to two pages) and
 * the account's **allowance**. The status chip in the aside, the Keep/Demote
 * button and the replace zone's clock sentence all read them, so they have to
 * live above all three. Everything else — the row itself, the bytes, the QR — is
 * settled on the server and arrives as props.
 *
 * The dashboard solves the same problem with `KeepStateProvider`, and this
 * screen deliberately does NOT mount it. That provider exists to let a single
 * `SwapResult` repaint two cards on a wall of twenty; here there is one page,
 * and `useSiteClock` is written to fall back to its `serverValue` when no
 * provider is present — which is exactly the seam this component uses to hand
 * `SiteState` a live clock. Mounting the provider would also mean a plain
 * demote had nowhere to land: it has no `applyDemote`, and adding one is an edit
 * to a file task 009 owns.
 *
 * ── THE CLOCK COMPONENT IS TASK 003'S, AND THERE IS STILL ONE INTERVAL ───────
 * `ClockProvider` is mounted by the server component above; `SiteState` reads it.
 * No second `setInterval` is started here, and the phase comes from the clock —
 * never from `status`, because an expired-but-unswept row still says `live`
 * until E07's sweep runs.
 *
 * ── THE LINK CHIP IS COMPOSED, NOT COPIED ────────────────────────────────────
 * `LiveUrlBlock` is a hero: an `<h1>` at `clamp(1.9rem, 5.2vw, 2.9rem)`, centred.
 * This screen's `<h1>` is the page's *name*, and a second one for its address
 * would be two competing headings. So it composes the parts `LiveUrlBlock`
 * itself is built from — `CopyLinkButton` directly, and `SiteStatusDot` through
 * `SiteState` — which is why task 003 split them out. The clipboard's failure
 * branch and its live region travel with the button and are not re-implemented
 * here, and the dot is still driven by `SiteStatus` rather than by the fact that
 * a screen rendered.
 *
 * DESIGNED FROM TOKENS, NOT IMPORTED — see the note at the top of `./page.tsx`.
 */
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, QrCode as QrIcon } from "lucide-react";

import type { KeptQuota } from "@kept/shared";

import { PagePreview } from "@/components/kept/page-preview";
import { CopyLinkButton } from "@/components/kept/live-url";
import { OwnerReplaceDrop } from "@/components/kept/owner-replace-drop";
import { ProRows } from "@/components/kept/pro-rows";
import type { SwapPage } from "@/components/kept/swap-dialog";
import { Button } from "@/components/ui/button";
import { managementRefusal } from "@/lib/sites/display";

import { SiteState } from "../../dashboard/clock";
import { ActionsPanel } from "./actions-panel";
import { RenameField } from "./rename-field";

/** The subject, serialised for the browser. `expiresAt` is the server's seed. */
export interface DetailPage extends SwapPage {
  /** The draft clock as ISO, or `null` when kept. The ONLY split there is. */
  expiresAt: string | null;
}

export function SiteDetail({
  site,
  size,
  fileWrittenAt,
  changedAt,
  html,
  previewTooLarge,
  quota: initialQuota,
  candidates,
  qr,
  renamedFrom,
}: {
  site: DetailPage;
  /** Already formatted by `formatBytes`; `null` when the row records no size. */
  size: string | null;
  /**
   * When the CURRENT version's bytes were written, and when the row itself last
   * moved. Two different facts: a rename or a keep changes the second and not
   * the first, and an owner looking for "did my replace land" wants the first.
   * Both are pre-formatted by `formatUpdatedAt` — locale- and timezone-pinned,
   * so the server's string and the hydrated one are identical.
   */
  fileWrittenAt: { label: string; iso: string } | null;
  changedAt: { label: string; iso: string };
  /** The page's own bytes, or `null` when they could not be inlined. */
  html: string | null;
  /** Why they could not: over `PREVIEW_MAX_BYTES`, rather than a failed read. */
  previewTooLarge: boolean;
  quota: KeptQuota;
  /** Every clockless page the account owns — the swap chooser's candidates. */
  candidates: SwapPage[];
  /** The QR, encoded in the server component. No encoder in this bundle. */
  qr: React.ReactNode;
  /**
   * The slug this page was renamed from, when this navigation is the rename's
   * own. Read from `?renamedFrom=` by the server component and passed straight
   * through — see the header of `./rename-field.tsx` for why the notice has to
   * travel in the URL at all.
   */
  renamedFrom?: string | null;
}) {
  const [clock, setClock] = useState<Date | null>(
    site.expiresAt === null ? null : new Date(site.expiresAt),
  );
  const [quota, setQuota] = useState(initialQuota);
  const [qrOpen, setQrOpen] = useState(false);
  const router = useRouter();
  const qrPanelId = useId();
  const refusalId = useId();

  const refusal = managementRefusal(site.status);
  // The slug is the part that is theirs; the suffix is ours. Split on the real
  // host so no hostname literal lands in this file.
  const hostSuffix = new URL(site.liveUrl).host.slice(site.slug.length);

  return (
    <>
      <header className="mt-6 border-b border-border pb-8">
        <p className="mono-label text-[11px] text-text-muted">Your page</p>
        {/* The page is named by its page, not by its id — `title ?? slug`, from
            `pageName`. The title is untrusted stranger-authored input: React
            escapes it, task 001 trims and caps it at storage, and the clamp is a
            visual limit on top of that. */}
        <h1 className="mt-3 line-clamp-3 break-words font-display text-[clamp(1.9rem,5vw,2.8rem)] font-bold leading-tight text-text">
          {site.name}
        </h1>

        {refusal ? (
          <p
            id={refusalId}
            data-testid="site-refusal"
            className="mt-5 max-w-[68ch] rounded-[var(--r-md)] border border-border bg-sunken px-4 py-3 text-sm leading-relaxed text-text-secondary"
          >
            {refusal}
          </p>
        ) : null}
      </header>

      <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-10">
        {/* ── The page itself, and the two things that change it ───────────── */}
        <div className="min-w-0 space-y-8">
          <section>
            <h2 className="mono-label text-[11px] text-text-muted">Preview</h2>
            <PagePreview liveUrl={site.liveUrl} html={html} className="mt-3" />
            {html === null ? (
              <p className="mt-3 max-w-[62ch] text-xs leading-relaxed text-text-muted">
                {previewTooLarge
                  ? "This page is too large to render inline, so it is shown as a notice rather than a frame. Open it at its link to see it — the page itself is unaffected."
                  : "kept could not read this page's file just now, so there is nothing to render. The page itself is unaffected — open it at its link to see it."}
              </p>
            ) : null}
          </section>

          <section className="rounded-[var(--r-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] md:p-6">
            <h2 className="font-display text-base font-semibold text-text">
              Replace the file
            </h2>
            <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-text-secondary">
              Drop a new HTML file over this page. The address does not move, so
              every link already shared keeps working.
            </p>
            <OwnerReplaceDrop
              siteId={site.id}
              name={site.name}
              // The LIVE clock, not the server's seed: after a keep there is no
              // draft window left to reassure anybody about, and the component's
              // `REPLACE_CLOCK_NOTE` must not still be promising one.
              expiresAt={clock}
              status={site.status}
              variant="panel"
              // The bytes on screen are now the old ones, and `ReplaceResult`
              // carries the new version id but NOT the new HTML — so the only
              // honest repaint is to ask the server again. `router.refresh()`
              // re-renders this route's server tree and hands down fresh `html`;
              // it does not disturb the clock or the quota above, which a
              // replace does not change and which this component would keep
              // through the refresh in any case.
              onReplaced={() => router.refresh()}
              className="mt-4"
            />
          </section>

          <RenameField
            siteId={site.id}
            slug={site.slug}
            liveUrl={site.liveUrl}
            hostSuffix={hostSuffix}
            refusal={refusal}
            refusalId={refusal ? refusalId : undefined}
            renamedFrom={renamedFrom}
          />
        </div>

        {/* ── What it is, and everything you can do to it ──────────────────── */}
        {/* Deliberately NOT sticky. This column runs to three stacked panels,
            which is taller than a laptop viewport — a sticky element taller than
            the viewport pins its top and puts its bottom permanently out of
            reach, which here would be the delete button. */}
        <aside className="min-w-0 space-y-6">
          <section className="rounded-[var(--r-lg)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <SiteState
              siteId={site.id}
              status={site.status}
              // `useSiteClock` finds no provider on this screen and hands this
              // value straight back, which is what makes the chip live.
              expiresAt={clock}
            />

            <p className="mono-label mt-4 break-all text-[11px] text-text-secondary">
              {site.slug}
              <span className="text-text-muted">{hostSuffix}</span>
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <CopyLinkButton
                liveUrl={site.liveUrl}
                variant="secondary"
                size="sm"
                label={
                  <>
                    Copy
                    <span className="sr-only"> the link for {site.slug}</span>
                  </>
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setQrOpen((open) => !open)}
                aria-expanded={qrOpen}
                aria-controls={qrPanelId}
              >
                <QrIcon aria-hidden="true" />
                QR
              </Button>
              <Button variant="ghost" size="sm" asChild>
                {/* `noreferrer` alongside `noopener`: the page being opened is
                    stranger-authored HTML and has no business reading which of
                    its owner's screens the click came from. */}
                <a href={site.liveUrl} target="_blank" rel="noopener noreferrer">
                  Open
                  <ArrowUpRight aria-hidden="true" />
                  <span className="sr-only"> {site.slug}</span>
                </a>
              </Button>
            </div>

            <div id={qrPanelId} hidden={!qrOpen} className="mt-4">
              <div className="inline-flex flex-col items-center gap-2 rounded-[var(--r-md)] border border-border bg-surface p-3 shadow-[var(--shadow-sm)]">
                {qr}
                <span className="mono-label text-[10px] text-text-muted">
                  Scan to open
                </span>
              </div>
            </div>

            <dl className="mt-5 space-y-2 border-t border-border pt-4">
              <Meta label="Size" value={size ?? "Not recorded"} />
              <Meta
                label="File written"
                value={
                  fileWrittenAt ? (
                    <time dateTime={fileWrittenAt.iso} title={fileWrittenAt.iso}>
                      {fileWrittenAt.label}
                    </time>
                  ) : (
                    // A row whose current version has gone missing keeps its
                    // place on its owner's screens (the LEFT join) and simply
                    // has no date to show, rather than a confident wrong one.
                    "Not recorded"
                  )
                }
              />
              <Meta
                label="Last change"
                value={
                  <time dateTime={changedAt.iso} title={changedAt.iso}>
                    {changedAt.label}
                  </time>
                }
              />
            </dl>
          </section>

          <ActionsPanel
            site={site}
            clock={clock}
            quota={quota}
            candidates={candidates}
            html={html}
            refusalId={refusal ? refusalId : undefined}
            onClock={setClock}
            onQuota={setQuota}
          />

          <ProRows />
        </aside>
      </div>
    </>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="mono-label text-[10px] text-text-muted">{label}</dt>
      <dd className="text-right text-xs text-text-secondary">{value}</dd>
    </div>
  );
}
