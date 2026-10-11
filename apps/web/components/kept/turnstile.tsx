"use client";

import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile, managed mode (E06a §5, D5). The script is loaded from
 * `challenges.cloudflare.com` the first time a widget MOUNTS — never with the
 * landing — and shared by every widget after that. No npm package.
 *
 * Tokens are single-use: after a failed submit the parent remounts this
 * component (`key`) to get a fresh one. The site key is public and inlined
 * (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`); e2e runs on Cloudflare's test key.
 */

interface TurnstileApi {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      theme: "light";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing"));
    script.onerror = () => {
      scriptLoad = null;
      script.remove();
      reject(new Error("turnstile script failed"));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

export function Turnstile({
  onToken,
  onFailure,
}: {
  /** A fresh token, or `null` when the last one expired. */
  onToken: (token: string | null) => void;
  /** The widget could not load or the challenge errored. */
  onFailure: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  // The latest callbacks without re-rendering the widget when they change.
  const callbacks = useRef({ onToken, onFailure });
  callbacks.current = { onToken, onFailure };

  useEffect(() => {
    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    if (!siteKey) {
      callbacks.current.onFailure();
      return;
    }
    let widgetId: string | undefined;
    let api: TurnstileApi | undefined;
    let cancelled = false;

    loadTurnstile().then(
      (loaded) => {
        if (cancelled || !container.current) return;
        api = loaded;
        widgetId = loaded.render(container.current, {
          sitekey: siteKey,
          theme: "light",
          callback: (token) => callbacks.current.onToken(token),
          "error-callback": () => callbacks.current.onFailure(),
          "expired-callback": () => callbacks.current.onToken(null),
        });
      },
      () => {
        if (!cancelled) callbacks.current.onFailure();
      },
    );

    return () => {
      cancelled = true;
      if (api && widgetId !== undefined) api.remove(widgetId);
    };
  }, []);

  return <div ref={container} data-testid="turnstile" className="min-h-[65px]" />;
}
