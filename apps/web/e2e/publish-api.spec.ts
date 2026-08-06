import { setTimeout as sleep } from "node:timers/promises";

import {
  DRAFT_TTL_DAYS,
  MAX_PAGE_BYTES,
  publishErrorSchema,
  publishResponseSchema,
  type PublishResponse,
} from "@kept/shared";
import { test, expect, type APIRequestContext } from "@playwright/test";

import {
  isReservedSlug,
  SLUG_ALPHABET,
  SLUG_LENGTH,
} from "../lib/publish/slug";
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

/**
 * The shape a minted slug must have, COMPOSED FROM THE MINTER'S OWN CONSTANTS.
 * Writing `/^[0-9a-z]{8}$/` here would pass for an alphabet that had quietly
 * grown an `i`, an `l`, an `o` or a `u` back — the four characters Crockford
 * base32 drops precisely so a slug survives being read aloud and retyped.
 */
const SLUG_SHAPE = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LENGTH}}$`);

/** Assert everything that is true of every slug this API ever hands out. */
function expectWellFormedSlug(slug: string, label: string) {
  expect(slug, `${label}: length`).toHaveLength(SLUG_LENGTH);
  expect(slug, `${label}: alphabet`).toMatch(SLUG_SHAPE);
  // Stated separately from the alphabet regex: these four are the *reason* the
  // alphabet is what it is, and a spec that only tested the regex would go
  // green the day somebody "fixed" the alphabet by adding them back.
  expect(slug, `${label}: ambiguous characters`).not.toMatch(/[ilou]/);
  // `www`, `api`, `p`, `keep`, `stats`, `dashboard`… — a minted slug that
  // collides with a reserved label is a page the edge or the control plane
  // will never serve, handed out as if it worked.
  expect(isReservedSlug(slug), `${label}: "${slug}" is a reserved label`).toBe(false);
}

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

  test("all three documented content types mint a page, and every slug is well-formed", async ({
    request,
  }) => {
    test.setTimeout(60_000);

    // `lib/publish/http.ts` documents exactly three ways in, for three real
    // callers: JSON (the hero and E08's MCP tools), multipart (a dropped
    // `.html` file), and raw `text/html` (the epic's literal `curl` case).
    // `publish-flow.spec.ts` drives two of them through the browser; nothing
    // until now proved multipart and JSON answer the same contract over the
    // wire, which is what an agent author reading the PRD would assume.
    const jsonHtml = pageHtml(marker());
    const multipartHtml = pageHtml(marker());
    const rawHtml = pageHtml(marker());

    const responses = {
      "application/json": await request.post("/api/publish", {
        headers: { "content-type": "application/json" },
        data: { html: jsonHtml },
      }),
      "multipart/form-data": await request.post("/api/publish", {
        multipart: {
          html: {
            name: "page.html",
            mimeType: "text/html",
            buffer: Buffer.from(multipartHtml),
          },
        },
      }),
      "text/html": await publishViaApi(request, rawHtml),
    };

    const slugs: string[] = [];
    for (const [contentType, res] of Object.entries(responses)) {
      expect(res.status(), `${contentType}: ${await res.text()}`).toBe(201);

      const fields = (await res.json()) as Record<string, unknown>;
      const body = contract(fields);
      published.push(body.anonToken);

      // The SAME seven fields regardless of how the bytes arrived — an agent
      // that switches transports must not have to switch parsers.
      expect(Object.keys(fields).sort(), contentType).toEqual([...CONTRACT_FIELDS]);
      expect(body.deduped, contentType).toBe(false);
      expectWellFormedSlug(body.slug, contentType);
      expect(new URL(body.live_url).host, contentType).toBe(
        `${body.slug}.${servingDomain()}`,
      );
      slugs.push(body.slug);
    }

    // Three distinct documents, so three distinct pages — a shared slug would
    // mean the minter is not actually random, and dedup does not apply here.
    expect(new Set(slugs).size, `slugs collided: ${slugs.join(", ")}`).toBe(3);
  });

  test("a caller-chosen slug is ignored, and no minted URL carries an unset value", async ({
    request,
  }) => {
    // The PRD rules custom slugs out at publish — renaming is E06's. A caller
    // who sends one anyway must not get it, and must not get an error either:
    // `publishRequestSchema` has no `slug`, so zod strips the key silently.
    // Rejecting it would break agents that send a superset body; honouring it
    // would hand out `api`, `www` or somebody else's slug on request.
    const chosen = "caller-chosen-slug";
    const res = await request.post("/api/publish", {
      headers: { "content-type": "application/json" },
      data: { html: pageHtml(marker()), slug: chosen },
    });

    expect(res.status(), await res.text()).toBe(201);
    const body = contract(await res.json());
    published.push(body.anonToken);

    expect(body.slug).not.toBe(chosen);
    expectWellFormedSlug(body.slug, "caller-chosen slug ignored");
    expect(body.live_url).not.toContain(chosen);

    // Task 003's failure mode, stated as an assertion: a missing
    // `KEPT_BASE_DOMAIN` or `NEXT_PUBLIC_APP_URL` used to be interpolated
    // straight into a link, so the publisher was handed
    // `https://abcd1234.undefined/` and only found out when it did not
    // resolve. Missing config must fail loudly, never mint a broken URL.
    for (const [field, url] of Object.entries({
      live_url: body.live_url,
      claim_url: body.claim_url,
    })) {
      expect(url, field).not.toMatch(/undefined|null|\[object/i);
      // …and it parses to a real host with a non-empty path, which the string
      // match alone would not catch for `https:///keep/` — the shape an empty
      // (rather than absent) base produces.
      const parsed = new URL(url);
      expect(parsed.hostname.length, `${field}: ${url}`).toBeGreaterThan(0);
      expect(parsed.pathname, `${field}: ${url}`).not.toContain("//");
    }
    // The live URL's host is checked against the CONFIGURED serving domain
    // above and in the seven-field test; the claim URL is on the control
    // plane, which is `localhost` in a local run — so no domain literal here.
  });

  test("the draft window is DRAFT_TTL_DAYS wide, and says so in the same words", async ({
    request,
  }) => {
    const before = Date.now();
    const body = await publish(request, pageHtml(marker()));
    const after = Date.now();

    // The human phrasing is composed from the constant, not typed out — the
    // one string a publisher reads back off the response.
    expect(body.expires_in).toBe(`${DRAFT_TTL_DAYS}d`);

    // …and the machine-readable instant agrees with it. Bracketed by the two
    // clock reads around the request rather than compared to a single `now`,
    // so the assertion is exact rather than a tolerance guess: the deadline is
    // DRAFT_TTL_DAYS after some instant during the call, and nothing else.
    const window = DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(body.expires_at).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + window);
    expect(expiresAt).toBeLessThanOrEqual(after + window);

    // `purge_after` (= expires_at + DRAFT_GRACE_DAYS) is deliberately NOT in
    // the seven-field contract — it is E07's column, not the caller's — so it
    // is asserted against Postgres in `lib/publish/pipeline.test.ts`, not here.
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
