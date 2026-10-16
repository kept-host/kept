"use client";

/**
 * The moderated page, two ways (E07 D12, §6.11, AC20): a Preview — the bytes
 * in `PageFrame` with `scripts`, i.e. `<iframe sandbox="allow-scripts"
 * srcdoc>`, an opaque origin that cannot read `app.` cookies or navigate this
 * window — and Source, the first `ADMIN_SOURCE_PREVIEW_BYTES` as escaped text.
 *
 * A child-sexual-abuse item (D13, AC39 admin half) renders `HiddenPreview`:
 * no bytes are in this page at all until "Show" fetches them — one request,
 * on click, never prefetched.
 */
import { ADMIN_SOURCE_PREVIEW_BYTES } from "@kept/shared";
import { useState } from "react";

import { PageFrame } from "@/components/kept/page-preview";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sourcePreview } from "@/lib/moderation/admin-rules";

export function PreviewPanel({ html, slug }: { html: string; slug: string }) {
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
        <PageFrame
          html={html}
          title={`Preview of ${slug}`}
          scripts
          className="pointer-events-auto h-[560px] w-full rounded-[var(--r-md)] border border-border"
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

  if (html !== null) return <PreviewPanel html={html} slug={slug} />;

  async function show() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/moderation/sites/${siteId}/source`, { cache: "no-store" });
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
