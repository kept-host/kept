import { setTimeout as sleep } from "node:timers/promises";

import {
  MAX_PAGE_BYTES,
  publishErrorSchema,
  publishResponseSchema,
  type PublishResponse,
} from "@kept/shared";
import { test, expect, type APIRequestContext } from "@playwright/test";

import {
  deleteDraft,
  pageHtml,
  probeEdge,
  publishViaApi,
  servingDomain,
  SKIP_LIVE_PUBLISH,
} from "./live-publish";

/**
 * `POST /api/publish` over the wire, with no browser anywhere in the picture.
 *
 * THE API IS THE PRODUCT and an agent is its primary caller, so the contract has
 * to hold for a bare `curl -X POST` — an HTML body, no cookie, no auth header,
 * no Turnstile token. `publish-flow.spec.ts` (task 007) drives the same endpoint
 * through the hero and belongs to that task; this file drives it as an API, which
 * is the shape E08's MCP tools will use.
 *
 * EVERY BODY IS PARSED WITH THE SHARED SCHEMA rather than picked at field by
 * field. `publishResponseSchema` / `publishErrorSchema` are what task 002 froze
 * and what an agent will generate its own client from; asserting through them is
 * what makes this a contract test instead of four `expect(body.slug)` calls.
 *
 * Live stores, no mocks, so the whole file skips without dev credentials — CI
 * runs `pnpm test` with none (fork PRs). A skip here is NOT coverage: see the
 * gate test at the bottom, which always runs and says so out loud.
 */

/** Publish, then poll the minted URL until the edge answers. */
const SERVE_TIMEOUT_MS = 25_000;
const SERVE_INTERVAL_MS = 1_000;

/** The seven fields the PRD promises, in one place. */
const CONTRACT_FIELDS = [
  "anonToken",
  "claim_url",
  "deduped",
  "expires_at",
  "expires_in",
  "live_url",
  "slug",
] as const;

const marker = () => `e04-010-api-${crypto.randomUUID().slice(0, 8)}`;

/** Parse a 201 through the frozen schema, failing loudly on any drift. */
function contract(body: unknown): PublishResponse {
  const parsed = publishResponseSchema.safeParse(body);
  expect(
    parsed.success,
    parsed.success ? "" : JSON.stringify(parsed.error?.issues),
  ).toBe(true);
  return parsed.data!;
}

/** Poll a freshly minted URL until it serves, or give up and report what it did. */
async function waitForServe(url: string) {
  const deadline = Date.now() + SERVE_TIMEOUT_MS;
  let last = await probeEdge(url);
  while (last.status !== 200 && Date.now() < deadline) {
    await sleep(SERVE_INTERVAL_MS);
    last = await probeEdge(url);
  }
  return last;
}

test.describe("the publish API, as an agent calls it", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

  const published: string[] = [];

  async function publish(
    request: APIRequestContext,
    html: string,
    headers?: Record<string, string>,
  ): Promise<PublishResponse> {
    const res = await publishViaApi(request, html, headers);
    expect(res.status(), await res.text()).toBe(201);
    const body = contract(await res.json());
    published.push(body.anonToken);
    return body;
  }

  test.afterEach(async ({ request }) => {
    for (const token of published.splice(0)) await deleteDraft(request, token);
  });

  test("a bare POST of an HTML body answers the full seven-field contract", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    const html = pageHtml(marker());
    const res = await publishViaApi(request, html);

    expect(res.status(), await res.text()).toBe(201);

    const headers = res.headers();
    // The response carries the raw anon token exactly once. Nothing between
    // here and the caller may keep a copy of it.
    expect(headers["cache-control"]).toBe("no-store");
    // No session was created: this endpoint is keyless and stays keyless.
    expect(headers["set-cookie"]).toBeUndefined();

    const raw = (await res.json()) as Record<string, unknown>;
    const body = contract(raw);
    // Registered for teardown BEFORE any assertion that can throw: a failing
    // contract check must not also leave a real draft live on the dev track.
    published.push(body.anonToken);

    // Exactly seven fields — no more. An extra key is as much a contract break
    // as a missing one when somebody is code-generating a client from this.
    expect(Object.keys(raw).sort()).toEqual([...CONTRACT_FIELDS]);
    expect(body.deduped).toBe(false);

    // The minted host is the CONFIGURED serving domain — dev serves
    // `*.kept-dev.xyz`, so a literal here would fail for the wrong reason.
    const live = new URL(body.live_url);
    expect(live.protocol).toBe("https:");
    expect(live.host).toBe(`${body.slug}.${servingDomain()}`);

    // The claim link is on the control plane, wherever this run points it.
    expect(body.claim_url.endsWith(`/keep/${body.anonToken}`)).toBe(true);

    // A draft, with a deadline in the future and a human phrasing of it.
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(body.expires_in.length).toBeGreaterThan(0);

    // …and it actually serves, over HTTPS, within seconds of the 201.
    const served = await waitForServe(body.live_url);
    expect(served.status).toBe(200);
    expect(served.body).toBe(html);
    expect(served.contentType).toContain("text/html");
  });

  test("the same bytes from the same publisher converge on one page, with a rotated token", async ({
    request,
  }) => {
    const html = pageHtml(marker());

    const first = await publish(request, html);
    const second = await publish(request, html);

    // One page: same slug, same deadline, and the second call says so.
    expect(second.slug).toBe(first.slug);
    expect(second.expires_at).toBe(first.expires_at);
    expect(second.deduped).toBe(true);
    expect(first.deduped).toBe(false);

    // The token ROTATES and is not compared for equality: tokens are stored
    // hashed, so the original raw token is unrecoverable and the dedup path
    // mints a fresh one (task 005). The old one stops working.
    expect(second.anonToken).not.toBe(first.anonToken);
    expect(second.claim_url).toBe(
      first.claim_url.replace(first.anonToken, second.anonToken),
    );

    // That the convergence is ONE `sites` row and ONE R2 object — not two rows
    // agreeing on a slug — is asserted against the database and the bucket in
    // `lib/publish/pipeline.test.ts`. It is not re-derived over HTTP here.
    const stale = await request.get(`/p/${first.anonToken}`);
    expect(stale.status()).toBe(404);
  });

  test("dedup does not cross publishers: identical bytes from a second client mint a second page", async ({
    request,
  }) => {
    const html = pageHtml(marker());

    const mine = await publish(request, html);
    // `publisher_hash` is a salted digest of IP + user agent, so a different
    // agent string from this machine is a different publisher. This is the
    // security property the column exists for — a global dedup would hand a
    // stranger the manage token for somebody else's page.
    const theirs = await publish(request, html, {
      "user-agent": `kept-e2e-second-publisher/${crypto.randomUUID()}`,
    });

    expect(theirs.slug).not.toBe(mine.slug);
    expect(theirs.anonToken).not.toBe(mine.anonToken);
    expect(theirs.deduped).toBe(false);
  });

  test("refusals are machine-parseable and the messages are written for a human", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    const cases: { name: string; res: Awaited<ReturnType<typeof publishViaApi>>; status: number; code: string }[] =
      [
        {
          name: "empty body",
          res: await publishViaApi(request, ""),
          status: 400,
          code: "empty_page",
        },
        {
          name: "oversized body",
          // One byte over the SHARED cap — the same constant the client checks.
          res: await publishViaApi(request, "x".repeat(MAX_PAGE_BYTES + 1)),
          status: 413,
          code: "page_too_large",
        },
        {
          name: "unsupported content type",
          res: await publishViaApi(request, pageHtml(marker()), {
            "content-type": "text/plain",
          }),
          status: 400,
          code: "invalid_request",
        },
      ];

    for (const { name, res, status, code } of cases) {
      expect(res.status(), `${name}: ${await res.text()}`).toBe(status);

      const parsed = publishErrorSchema.safeParse(await res.json());
      expect(parsed.success, `${name} is not a valid error body`).toBe(true);
      expect(parsed.data!.error, name).toBe(code);

      // Actionable, not a restated code: a sentence, in words, that a person
      // reading a terminal can act on.
      const { message } = parsed.data!;
      expect(message, name).not.toBe(code);
      expect(message.length, name).toBeGreaterThan(20);
      expect(message.trim().endsWith("."), `${name}: ${message}`).toBe(true);
    }
  });
});

/**
 * ALWAYS RUNS. A suite that skipped every live test still reports "all green",
 * and this is the one line in the report that refuses to let that read as
 * coverage.
 */
test("the live-publish gate states what it is skipping", async () => {
  if (SKIP_LIVE_PUBLISH) {
    console.warn(
      `\n  ⚠ E04 live publish specs SKIPPED — ${SKIP_LIVE_PUBLISH}\n` +
        "    Nothing in this run exercised the publish path, the stores or the edge.\n",
    );
  }
  // Either the credentials are all present, or the reason names every one that
  // is not — there is no third state in which the skip is silent.
  expect(SKIP_LIVE_PUBLISH === false || SKIP_LIVE_PUBLISH.length > 0).toBe(true);
});
