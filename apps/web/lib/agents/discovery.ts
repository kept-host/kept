/**
 * The agent-facing discovery files (E09 task 004): `/skill.md`, `/llms.txt`,
 * `/.well-known/skills/index.json`, `/install.sh`. Each is a pure function of
 * `@kept/shared`'s agent copy (D12) and the landing origin.
 *
 * ⚠️ The base URL comes from configuration (`NEXT_PUBLIC_APP_URL` → its apex),
 * never from the request — see CLAUDE.md "Never derive an origin from the
 * request". Locally there is no apex, so the one origin serves both halves.
 *
 * Served on prod and on localhost only (`discoveryServed`): a deployed dev or
 * preview origin answers 404, so nothing an agent reads there names it.
 */
import { KEPT_PROD_ORIGIN } from "@kept/shared";

import { apexUrl } from "@/lib/email/waitlist";

/** The landing origin every agent-facing URL is built on, without a trailing slash. */
export function agentBase(): string {
  return new URL(apexUrl("/")).origin;
}

/** Whether this deployment serves `/agents` and the discovery files: prod, or a local run. */
export function discoveryServed(): boolean {
  const base = agentBase();
  if (base === KEPT_PROD_ORIGIN) return true;
  const { hostname } = new URL(base);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** A discovery file: public, cached five minutes at the edge and in the browser. */
export function discoveryResponse(body: string, contentType: string): Response {
  if (!discoveryServed()) return new Response("Not found", { status: 404 });
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
    },
  });
}
