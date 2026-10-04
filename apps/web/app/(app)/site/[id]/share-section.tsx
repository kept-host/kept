"use client";

/**
 * General → Share — PRD §5.2 item 5, AC38. E06 task 012.
 *
 * The QR the screen shows (`components/kept/qr.tsx`, rendered on the server so
 * the encoder never reaches this bundle), and three downloads:
 *
 *   · **Download SVG** — `qrSvg(pageUrl)`, the same geometry as a standalone
 *     file with its own colours (a file cannot resolve the studio's tokens).
 *   · **Download PNG** — that SVG rasterised HERE, at `QR_PNG_SIZE` px, on a
 *     canvas: no server round trip. Smoothing is off so every module edge stays
 *     a hard edge a scanner can read.
 *   · **Download page** — the page's own file, `GET /api/sites/{id}/download`.
 *
 * The QR and its two files are offered while the page is reachable at its link
 * (live, or live behind a review notice); a page that is not being served keeps
 * only its own file. States: QR rendered · PNG rasterising · download error.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

import { Section } from "./section";

/** Edge length of the downloaded PNG, in pixels (PRD §5.2). */
const QR_PNG_SIZE = 1024;

type PngPhase = "idle" | "rasterising" | "failed";

/** Hand `blob` to the browser as a download, revoking the URL once it has been taken. */
function save(blob: Blob, filename: string): () => void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // The click is handled synchronously; the URL is only needed until then.
  const timer = setTimeout(() => URL.revokeObjectURL(url), 0);
  return () => clearTimeout(timer);
}

/** The SVG, drawn onto a `size`×`size` canvas and encoded as PNG. */
function rasterise(svg: string, size: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("No 2D canvas."));
        return;
      }
      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0, size, size);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed."))), "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG decode failed."));
    };
    image.src = url;
  });
}

export function ShareSection({
  siteId,
  slug,
  host,
  qr,
  qrSvg,
  reachable,
}: {
  siteId: string;
  slug: string;
  /** `{name}.{base}` — what the QR opens. */
  host: string;
  /** The QR as the screen shows it, rendered on the server. */
  qr: ReactNode;
  /** The same QR as a standalone SVG document (`qrSvg`). */
  qrSvg: string;
  /** Served at its link (live, or behind a review notice): the QR is offered. */
  reachable: boolean;
}) {
  const [png, setPng] = useState<PngPhase>("idle");
  const cleanups = useRef<(() => void)[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const pending = cleanups.current;
    return () => {
      mounted.current = false;
      for (const cleanup of pending) cleanup();
    };
  }, []);

  function downloadSvg() {
    cleanups.current.push(save(new Blob([qrSvg], { type: "image/svg+xml" }), `${slug}-qr.svg`));
  }

  async function downloadPng() {
    setPng("rasterising");
    try {
      const blob = await rasterise(qrSvg, QR_PNG_SIZE);
      if (!mounted.current) return;
      cleanups.current.push(save(blob, `${slug}-qr.png`));
      setPng("idle");
    } catch {
      if (mounted.current) setPng("failed");
    }
  }

  return (
    <Section title="Share" testId="share-section">
      {reachable ? (
        <div className="flex flex-wrap items-center gap-5">
          <div className="rounded-[var(--r-md)] border border-border bg-surface p-2">{qr}</div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="text-[13px] text-text-secondary">
              Scan to open <span className="font-mono text-text">{host}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="download-qr-svg"
                onClick={downloadSvg}
                className="font-body font-medium"
              >
                <Download aria-hidden="true" strokeWidth={1.5} />
                Download SVG
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="download-qr-png"
                disabled={png === "rasterising"}
                onClick={downloadPng}
                className="font-body font-medium"
              >
                <Download aria-hidden="true" strokeWidth={1.5} />
                {png === "rasterising" ? "Preparing PNG…" : "Download PNG"}
              </Button>
            </div>
            {png === "failed" ? (
              <p role="alert" className="text-[13px] text-danger">
                The PNG couldn&rsquo;t be made in this browser. Download the SVG instead.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={reachable ? "border-t border-border pt-3" : undefined}>
        <Button asChild variant="secondary" size="sm" className="font-body font-medium">
          <a href={`/api/sites/${siteId}/download`} data-testid="download-page" download>
            <Download aria-hidden="true" strokeWidth={1.5} />
            Download page
          </a>
        </Button>
      </div>
    </Section>
  );
}
