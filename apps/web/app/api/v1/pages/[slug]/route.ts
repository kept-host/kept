/**
 * `GET / PUT / DELETE /api/v1/pages/{slug}` — one of the key owner's pages
 * (E09 D8). A slug the owner does not have is `404 not_found`, whoever has it.
 *
 * PUT replaces the bytes at the same URL (the clock and kept-ness unchanged);
 * DELETE takes the page offline and archives it, the studio's delete. Bearer
 * key only (`lib/agents/v1-http.ts`); the rules are `lib/agents/pages.ts`'s.
 */
import { keyedDelete, keyedGet, keyedReplace } from "../../../../../lib/agents/pages";
import { v1Caller, v1Response } from "../../../../../lib/agents/v1-http";
import { publishPaused } from "../../../../../lib/launch";
import { readFileSet } from "../../../../../lib/publish/fileset/read";
import { keptClientFrom, publishPausedResponse } from "../../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes, or reads one owner's row. Never cacheable. */
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const caller = await v1Caller(request);
  if (caller instanceof Response) return caller;

  return v1Response(await keyedGet(caller, (await params).slug));
}

export async function PUT(request: Request, { params }: Context): Promise<Response> {
  // E09 task 011: the operator's pause comes first — it reads nothing.
  if (publishPaused()) return publishPausedResponse();

  const caller = await v1Caller(request);
  if (caller instanceof Response) return caller;

  const set = await readFileSet(request, { plan: caller.plan, uploaderId: caller.profileId });
  return v1Response(
    await keyedReplace(caller, (await params).slug, set, { client: keptClientFrom(request), publishedVia: "api" }),
  );
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const caller = await v1Caller(request);
  if (caller instanceof Response) return caller;

  return v1Response(await keyedDelete(caller, (await params).slug));
}
