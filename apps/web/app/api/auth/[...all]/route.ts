/**
 * `GET|POST /api/auth/*` — Better Auth's own handler, mounted and nothing else.
 *
 * Every auth endpoint lives behind this one catch-all: `/api/auth/sign-in/*`,
 * `/api/auth/sign-out`, `/api/auth/get-session`, the magic-link verify path
 * (`/api/auth/magic-link/verify`) and — the ones an external service has to
 * match exactly — the OAuth callbacks:
 *
 *     {authConfig().baseUrl}/api/auth/callback/github
 *     {authConfig().baseUrl}/api/auth/callback/google
 *
 * Those two strings are registered in the GitHub OAuth app and the Google Cloud
 * client (E05 task 003 / task 012). Moving or renaming this file changes them
 * and breaks sign-in with an opaque provider error, so it does not move.
 *
 * NO LOGIC HERE. Configuration is `lib/auth/index.ts`; session reads are
 * `lib/auth/session.ts`. This file is the HTTP mount point, the same way
 * `api/publish/route.ts` is only the HTTP boundary over the publish pipeline.
 */
import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

// `postgres-js` opens TCP sockets, exactly as every other route here declares.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The handler is wrapped in an arrow rather than passed as `auth.handler`,
 * because `auth` is a lazy Proxy: reading `.handler` at module scope would
 * construct the instance — and therefore validate all eight auth environment
 * variables — while `next build` is collecting page data, which CI does with no
 * secrets at all. Deferring the read to call time keeps the build green and
 * still fails loudly, naming the variable, on the first real request.
 */
const handlers = toNextJsHandler((request: Request) => auth.handler(request));

export const GET = handlers.GET;
export const POST = handlers.POST;
