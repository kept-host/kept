/**
 * The `/mcp` HTTP boundary (E09 D4, D5): who is calling, which session, and
 * the SDK's web-standard Streamable HTTP transport in STATELESS mode — one
 * server and one transport per request, closed when it answers, nothing kept
 * in memory between requests (Risk 1). The session lives in its signed id
 * (`./session.ts`); the tools are `./tools.ts`.
 *
 * WHO:
 *   - closed (E06a): `closedModeAccess` first, before the body is acted on. No
 *     door → a JSON-RPC error carrying `not_open` for each request in the body,
 *     or the middleware's 404 `notOpenResponse()` when there is no request to
 *     answer. An access token or an admin session → the keyless set at
 *     `keylessPlan(door)`; an admin's key → the keyed set.
 *   - `Authorization: Bearer kpt_live_…` that resolves → the keyed set; one
 *     that does not → 401 `unauthorized` (never a silent fall back to keyless,
 *     which would publish an anonymous draft the human thinks is in their
 *     account). No key → the keyless set.
 *
 * WHICH SESSION: `initialize` mints `Mcp-Session-Id`; every other POST and the
 * DELETE must carry a valid one — missing 400, tampered 404 (AC6).
 *
 * ⚠️ NEVER LOGS a session id, a key, or a body (tool arguments carry HTML).
 */
import { INLINE_BODY_MAX_BYTES } from "@kept/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest, isJSONRPCRequest, type RequestId } from "@modelcontextprotocol/sdk/types.js";

import { bearerApiKey, keyCallerFrom } from "../agents/keys";
import { closedModeAccess, keylessPlan } from "../launch-access";
import { notOpenResponse } from "../launch";
import { clientIp } from "../rate-limit";
import { inlineTooLarge } from "../publish/fileset/copy";
import { readBounded } from "../publish/fileset/read";
import { keptClientFrom, keyedErrorResponse, publisherFrom } from "../publish/http";

import { MCP_SESSION_HEADER, mintSessionId, sessionFrom, sessionOf } from "./session";
import { registerTools, type McpContext } from "./tools";

/** What `initialize` answers as `serverInfo`. */
const SERVER_INFO = { name: "kept", version: "1.0.0" } as const;

/** JSON-RPC's implementation-defined server error range (-32000…-32099). */
const SERVER_ERROR = -32000;
const SESSION_NOT_FOUND = -32001;
const PARSE_ERROR = -32700;

const NO_STORE = { "cache-control": "no-store" } as const;

function rpcError(status: number, code: number, message: string, id: RequestId | null = null): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id }, { status, headers: NO_STORE });
}

/** The session check's refusal, worded as the SDK's own stateful transport words it. */
function sessionRefusal(status: 400 | 404): Response {
  return status === 400
    ? rpcError(400, SERVER_ERROR, "Bad Request: Mcp-Session-Id header is required")
    : rpcError(404, SESSION_NOT_FOUND, "Session not found");
}

/**
 * A closed deploy's answer to a keyless caller: one JSON-RPC error per
 * request, carrying `notOpenResponse()`'s body as `data` so an agent reads the
 * same `not_open` the HTTP API returns. Notifications alone get the 404 itself.
 */
async function notOpen(messages: unknown[]): Promise<Response> {
  const requests = messages.filter(isJSONRPCRequest);
  const refusal = notOpenResponse();
  if (requests.length === 0) return refusal;
  const data = (await refusal.json()) as { message: string };
  const errors = requests.map((request) => ({
    jsonrpc: "2.0",
    error: { code: SERVER_ERROR, message: data.message, data },
    id: request.id,
  }));
  return Response.json(errors.length === 1 ? errors[0] : errors, { headers: NO_STORE });
}

export async function handleMcpPost(request: Request): Promise<Response> {
  const bytes = await readBounded(request, INLINE_BODY_MAX_BYTES);
  if (bytes === null) return rpcError(413, SERVER_ERROR, inlineTooLarge(INLINE_BODY_MAX_BYTES));
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return rpcError(400, PARSE_ERROR, "Parse error: Invalid JSON");
  }
  const messages = Array.isArray(body) ? body : [body];

  // Closed mode first: a caller with no door is refused before anything is minted or run.
  const door = await closedModeAccess(request);
  if (door === null) return notOpen(messages);

  const caller = door === "open" || door === "key" ? await keyCallerFrom(request) : null;
  if (caller === null && bearerApiKey(request) !== null) {
    return keyedErrorResponse(401, {
      error: "unauthorized",
      message: "This API key is not live. Create one in Settings → Agents and API keys, or remove the Authorization header to publish without an account.",
    });
  }

  const initialize = messages.some(isInitializeRequest);
  let sessionId: string | null = null;
  let session: string;
  if (initialize) {
    sessionId = mintSessionId();
    session = sessionOf(sessionId);
  } else {
    const check = sessionFrom(request);
    if (!check.ok) return sessionRefusal(check.status);
    session = check.session;
  }

  const base = { client: keptClientFrom(request), publisher: publisherFrom(request) };
  const context: McpContext = caller
    ? { kind: "keyed", caller, ...base }
    : { kind: "keyless", session, plan: keylessPlan(door), ip: clientIp(request), ...base };

  const server = new McpServer(SERVER_INFO);
  registerTools(server, context);
  // Stateless: no `sessionIdGenerator`, so the SDK keeps no session map — the
  // id is checked above and stamped on the `initialize` answer below.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  let response: Response;
  try {
    await server.connect(transport);
    response = await transport.handleRequest(request, { parsedBody: body });
  } finally {
    await server.close();
  }

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  if (sessionId !== null && response.ok) headers.set(MCP_SESSION_HEADER, sessionId);
  return new Response(response.body, { status: response.status, headers });
}

/** Stateless: there is nothing to free. A valid session is told so; a missing or forged one is refused as on POST. */
export function handleMcpDelete(request: Request): Response {
  const check = sessionFrom(request);
  return check.ok ? new Response(null, { status: 204, headers: NO_STORE }) : sessionRefusal(check.status);
}

/** No server-initiated stream: every answer rides its POST (`enableJsonResponse`). */
export function handleMcpGet(): Response {
  return new Response(null, { status: 405, headers: { ...NO_STORE, allow: "POST, DELETE" } });
}
