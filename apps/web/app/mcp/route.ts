/**
 * `/mcp` — kept's remote MCP server (E09 D4): Streamable HTTP, keyless by
 * default, the keyed tool set with `Authorization: Bearer kpt_live_…`.
 *
 * THE HTTP BOUNDARY AND NOTHING ELSE. Identity, closed mode, the signed session
 * and the SDK transport are `lib/mcp/http.ts`; the tools are `lib/mcp/tools.ts`
 * over the publish pipeline and `lib/agents/pages.ts`. Served on both hosts and
 * never redirected (`ANY_HOST_PATHS`); the handler enforces closed mode itself.
 */
import { handleMcpDelete, handleMcpGet, handleMcpPost } from "../../lib/mcp/http";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Every call is per-caller and most write. Never cacheable. */
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleMcpPost(request);
}

export function GET(): Response {
  return handleMcpGet();
}

export function DELETE(request: Request): Response {
  return handleMcpDelete(request);
}
