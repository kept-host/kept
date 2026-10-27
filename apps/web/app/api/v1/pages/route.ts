/**
 * `POST /api/v1/pages` — publish a page into the key owner's account (E09 D8):
 * kept while a slot is free, else a draft; `{ live_url, studio_url, slug,
 * kept, expires_at }`, no claim link. `GET /api/v1/pages?cursor=` — the
 * owner's pages, newest first.
 *
 * Bearer key only (`lib/agents/v1-http.ts`): no origin check, no cookie. The
 * body is any of `readFileSet`'s inputs — `html`, `files[]`, `archive`,
 * `upload_id` — on the owner's plan. The rules are `lib/agents/pages.ts`'s.
 */
import { keyedList, keyedPublish } from "../../../../lib/agents/pages";
import { v1Caller, v1Response } from "../../../../lib/agents/v1-http";
import { publishPaused } from "../../../../lib/launch";
import { readFileSet } from "../../../../lib/publish/fileset/read";
import { keptClientFrom, publishPausedResponse, publisherFrom } from "../../../../lib/publish/http";

/** `postgres-js` needs TCP sockets and `aws4fetch` signs with Node's crypto. */
export const runtime = "nodejs";

/** Writes, or reads one owner's rows. Never cacheable. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // E09 task 011: the operator's pause comes first — it reads nothing.
  if (publishPaused()) return publishPausedResponse();

  const caller = await v1Caller(request);
  if (caller instanceof Response) return caller;

  const set = await readFileSet(request, { plan: caller.plan, uploaderId: caller.profileId });
  return v1Response(
    await keyedPublish(caller, set, publisherFrom(request), { client: keptClientFrom(request), publishedVia: "api" }),
  );
}

export async function GET(request: Request): Promise<Response> {
  const caller = await v1Caller(request);
  if (caller instanceof Response) return caller;

  return v1Response(await keyedList(caller, new URL(request.url).searchParams.get("cursor")));
}
