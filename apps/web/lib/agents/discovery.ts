/**
 * The agent-facing discovery files (E09 task 004): `/skill.md`, `/llms.txt`,
 * `/.well-known/skills/index.json`, `/install.sh`. Each is a pure function of
 * `@kept/shared`'s agent copy (D12) and the landing origin.
 *
 * ⚠️ The base URL comes from configuration (`NEXT_PUBLIC_APP_URL` → its apex),
 * never from the request — see CLAUDE.md "Never derive an origin from the
 * request". Locally there is no apex, so the one origin serves both halves.
 */
import { apexUrl } from "@/lib/email/waitlist";

/** The landing origin every agent-facing URL is built on, without a trailing slash. */
export function agentBase(): string {
  return new URL(apexUrl("/")).origin;
}

/** A discovery file: public, cached five minutes at the edge and in the browser. */
export function discoveryResponse(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
    },
  });
}
