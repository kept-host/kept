"use client";

/**
 * The moderated page, two ways (E07 D12, §6.11, AC20): a Preview — an
 * `<iframe sandbox="allow-scripts">` on `/api/admin/moderation/sites/:id/preview`,
 * which answers under its own sandboxed, no-network CSP so the page's scripts
 * run (D-69) in an opaque origin that cannot read `app.` cookies or navigate
 * this window — and Source, the first `ADMIN_SOURCE_PREVIEW_BYTES` as escaped
 * text.
 *
 * A child-sexual-abuse item (D13, AC39 admin half) renders `HiddenPreview`:
 * no bytes are in this page, and no URL names them, until "Show" — one
 * request for the Source, on click, never prefetched, and the frame's
 * `?show=1` after it.
 */
import { ADMIN_SOURCE_PREVIEW_BYTES } from "@kept/shared";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { adminPageUrl, sourcePreview } from "@/lib/moderation/admin-rules";

export function PreviewPanel({
  html,
  siteId,
  slug,
  shown = false,
}: {
  html: string;
  siteId: string;
  slug: string;
  /** Opened through "Show": the frame's URL carries the intent too. */
  shown?: boolean;
}) {
  const source = sourcePreview(html);
  return (
    <Tabs defaultValue="preview">
      <TabsList className="w-fit">
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="source" data-testid="source-tab">
          Source
        </TabsTrigger>
      </TabsList>
      <TabsContent value="preview">
        {/* `bg-white`, not a token: an author's page assumes a browser's white default (`PageFrame`). */}
        <iframe
          title={`Preview of ${slug}`}
          src={adminPageUrl(siteId, "preview", shown)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-[560px] w-full rounded-[var(--r-md)] border border-border bg-white"
        />
      </TabsContent>
      <TabsContent value="source">
        <pre
          data-testid="source-view"
          className="max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-md)] border border-border bg-sunken p-4 font-mono text-xs text-text"
        >
          {source.text}
        </pre>
        {source.truncated ? (
          <p className="mt-2 text-xs text-text-muted">Showing the first {ADMIN_SOURCE_PREVIEW_BYTES / 1024} KB of the source.</p>
        ) : null}
      </TabsContent>
    </Tabs>
  );
}

export function HiddenPreview({ siteId, slug }: { siteId: string; slug: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (html !== null) return <PreviewPanel html={html} siteId={siteId} slug={slug} shown />;

  async function show() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(adminPageUrl(siteId, "source", true), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setHtml(await response.text());
    } catch (err) {
      setError(`Couldn't load the page (${err instanceof Error ? err.message : "error"}).`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="preview-hidden" className="flex flex-col items-start gap-3 rounded-[var(--r-md)] border border-border bg-sunken p-5">
      <p className="text-sm text-text">
        Reported or detected as child sexual abuse material. The preview and source stay off until you ask for them.
      </p>
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={show} className="font-body font-medium">
        {pending ? "Loading…" : "Show"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
