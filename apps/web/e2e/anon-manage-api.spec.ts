import { setTimeout as sleep } from "node:timers/promises";

import { DRAFT_TTL_DAYS, publishErrorSchema } from "@kept/shared";
import { test, expect, type APIRequestContext } from "@playwright/test";

import {
  deleteDraft,
  pageHtml,
  probeEdge,
  publishViaApi,
  SKIP_LIVE_PUBLISH,
} from "./live-publish";

/**
 * The three anonymous manage routes over the wire — `POST .../replace`,
 * `DELETE /api/anon/:token` and `POST .../reminder` — as an agent or a `curl`
 * user calls them, with no browser anywhere.
 *
 * `anon-screens.spec.ts` drives replace, delete and the reminder through the
 * `/p` console, and `pointer-ordering.spec.ts` proves the DELETE route inherits
 * the pointer-before-KV ordering. Neither of them asserts the API contract those
 * screens are clients of: the response *shapes*, the idempotence of a repeated
 * delete, and — the security property this file exists for — that all three
 * routes are indistinguishable from each other about a token they will not act
 * on.
 *
 * THE NO-ORACLE PROPERTY IS THE LOAD-BEARING ONE. A bearer token is guessable in
 * principle, and these three routes are the only places a guess gets a reply. If
 * replace said "not found" for an unknown token and "gone" for an archived one,
 * or if the reminder route were quicker to answer a token that resolves, the
 * pair would be a probe for whether somebody else's page exists. So the drills
 * below compare the WHOLE BODY, byte for byte, across every route and every
 * reason — unknown, malformed, and archived — rather than checking each is
 * "a 404".
 *
 * Live stores, no mocks, so the file skips without dev credentials, exactly like
 * every other live spec here; `publish-api.spec.ts` carries the always-running
 * gate test that says so out loud.
 */

const marker = () => `e04-010-manage-${crypto.randomUUID().slice(0, 8)}`;

/** How long a replaced page gets to serve its new bytes before we call it broken. */
const SERVE_TIMEOUT_MS = 30_000;
const SERVE_INTERVAL_MS = 1_500;

/** Exactly the fields `ReplaceResponse` promises — no token, no `deduped`. */
const REPLACE_FIELDS = ["expires_at", "expires_in", "live_url", "slug"] as const;

interface Draft {
  slug: string;
  live_url: string;
  anonToken: string;
  expires_at: string;
}

/** Poll a live URL until it serves the bytes we just put there. */
async function waitForBody(url: string, expected: string) {
  const deadline = Date.now() + SERVE_TIMEOUT_MS;
  let last = await probeEdge(url);
  while (last.body !== expected && Date.now() < deadline) {
    await sleep(SERVE_INTERVAL_MS);
    last = await probeEdge(url);
  }
  return last;
}

test.describe("the anonymous manage API", () => {
  test.skip(!!SKIP_LIVE_PUBLISH, String(SKIP_LIVE_PUBLISH));

  const published: string[] = [];

  async function publish(request: APIRequestContext, html: string): Promise<Draft> {
    const res = await publishViaApi(request, html);
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as Draft;
    published.push(body.anonToken);
    return body;
  }

  test.afterEach(async ({ request }) => {
    for (const token of published.splice(0)) await deleteDraft(request, token);
  });

  test("all three routes answer an unknown or malformed token with one identical body", async ({
    request,
  }) => {
    // A token-shaped string that resolves to nothing, and a string that is not
    // token-shaped at all (rejected structurally, before Postgres is touched).
    // The two take DIFFERENT code paths — `resolveAnonToken` returns `null` from
    // its regex guard for one and from an empty query for the other — and must
    // still be indistinguishable to the caller.
    const tokens = {
      "well-formed but unknown": "A".repeat(43),
      malformed: "not-a-token",
    };

    const bodies: string[] = [];

    for (const [reason, token] of Object.entries(tokens)) {
      const routes = {
        replace: await request.post(`/api/anon/${token}/replace`, {
          headers: { "content-type": "application/json" },
          data: { html: pageHtml(marker()) },
        }),
        delete: await request.delete(`/api/anon/${token}`),
        reminder: await request.post(`/api/anon/${token}/reminder`, {
          headers: { "content-type": "application/json" },
          data: { reminderEmail: "probe@example.com" },
        }),
      };

      for (const [route, res] of Object.entries(routes)) {
        const label = `${route} / ${reason}`;
        expect(res.status(), `${label}: ${await res.text()}`).toBe(404);
        // Not cacheable: a 404 for a token that is about to be minted, cached
        // by anything in between, would break the page it was minted for.
        expect(res.headers()["cache-control"], label).toBe("no-store");

        const raw = (await res.json()) as Record<string, unknown>;
        const parsed = publishErrorSchema.safeParse(raw);
        expect(parsed.success, `${label} is not a valid error body`).toBe(true);
        // `invalid_request`, because `PUBLISH_ERROR_CODES` is a CLOSED enum
        // shared with the publish route — the 404 status is what distinguishes
        // this from a malformed body, not a bespoke code.
        expect(parsed.data!.error, label).toBe("invalid_request");
        // Nothing in the answer names the token, which would put a bearer
        // credential into whatever logs the response.
        expect(parsed.data!.message, label).not.toContain(token);

        bodies.push(JSON.stringify(raw));
      }
    }

    // THE ASSERTION THIS FILE EXISTS FOR: six replies, one string. Not "all
    // 404" — byte-identical, so no route and no reason is distinguishable from
    // any other, and a token guess learns nothing at all.
    expect(new Set(bodies).size, `distinguishable 404s: ${bodies.join("\n")}`).toBe(1);
  });

  test("replace swaps the bytes at the same URL, echoes no token, and never extends the clock", async ({
    request,
  }) => {
    test.setTimeout(90_000);

    const original = pageHtml(marker());
    const draft = await publish(request, original);
    expect((await waitForBody(draft.live_url, original)).status).toBe(200);

    const replacement = pageHtml(marker());
    const res = await request.post(`/api/anon/${draft.anonToken}/replace`, {
      headers: { "content-type": "application/json" },
      data: { html: replacement },
    });

    expect(res.status(), await res.text()).toBe(200);
    const raw = (await res.json()) as Record<string, unknown>;

    // FOUR fields, not seven. A replace is not a publish: the caller already
    // holds the token, so echoing a bearer credential back into a body it did
    // not have to be in is a needless copy — and `deduped` is meaningless for
    // an explicit act that is never collapsed.
    expect(Object.keys(raw).sort()).toEqual([...REPLACE_FIELDS]);
    expect(raw.anonToken).toBeUndefined();
    expect(raw.deduped).toBeUndefined();

    // Same page, same address — the whole point of replace over re-publish.
    expect(raw.slug).toBe(draft.slug);
    expect(raw.live_url).toBe(draft.live_url);

    // ⚠️ THE CLOCK DOES NOT MOVE, and that is the rule the endpoint turns on:
    // if re-dropping a file restarted the window, a weekly `curl` would hold a
    // page forever for free and "keep it" would stop meaning anything.
    expect(raw.expires_at).toBe(draft.expires_at);
    expect(raw.expires_in).toBe(`${DRAFT_TTL_DAYS}d`);

    // …and the new bytes are really being served, at the address that did not
    // change. The purge is load-bearing here in a way it is not on publish: a
    // replaced slug ALWAYS has a cached predecessor, and the live TTL is a year.
    const served = await waitForBody(draft.live_url, replacement);
    expect(served.status).toBe(200);
    expect(
      served.body,
      "the edge is still serving the previous version — the purge did not land",
    ).toBe(replacement);
  });

  test("a dropped file replaces as well as pasted markup — one endpoint, both transports", async ({
    request,
  }) => {
    test.setTimeout(90_000);

    const draft = await publish(request, pageHtml(marker()));
    const replacement = pageHtml(marker());

    // What the `/p` dropzone sends for a dropped `.html`. It reaches the same
    // handler through the same `readPageBody`, so a divergence between the two
    // transports here would be a divergence the console silently inherits.
    const res = await request.post(`/api/anon/${draft.anonToken}/replace`, {
      multipart: {
        html: {
          name: "replacement.html",
          mimeType: "text/html",
          buffer: Buffer.from(replacement),
        },
      },
    });

    expect(res.status(), await res.text()).toBe(200);
    const raw = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([...REPLACE_FIELDS]);
    expect(raw.slug).toBe(draft.slug);
    expect(raw.expires_at).toBe(draft.expires_at);

    expect((await waitForBody(draft.live_url, replacement)).body).toBe(replacement);
  });

  test("the reminder route stores, overwrites and clears behind one indistinguishable answer", async ({
    request,
  }) => {
    const draft = await publish(request, pageHtml(marker()));

    const reminder = (body: unknown) =>
      request.post(`/api/anon/${draft.anonToken}/reminder`, {
        headers: { "content-type": "application/json" },
        data: body,
      });

    // Store, overwrite, then clear two ways. `""` and `null` both clear;
    // ABSENCE is not accepted, because it would be ambiguous between "clear it"
    // and "leave it alone" and this is a bearer-token endpoint.
    const answers: string[] = [];
    for (const value of [
      "first@example.com",
      "second@example.com",
      "",
      null,
    ]) {
      const res = await reminder({ reminderEmail: value });
      expect(res.status(), `${JSON.stringify(value)}: ${await res.text()}`).toBe(200);
      answers.push(JSON.stringify(await res.json()));
    }

    // FOUR different transitions, ONE answer. The address is the only piece of
    // personal data an anonymous page carries, so a stranger holding a leaked
    // link must not be able to learn from the reply whether one was ever set.
    expect(new Set(answers).size, `distinguishable answers: ${answers.join(" ")}`).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({ ok: true });

    // A malformed address is a validation failure, not a silent no-op — the
    // publisher would otherwise believe they had left a way to be warned.
    const malformed = await reminder({ reminderEmail: "not-an-address" });
    expect(malformed.status(), await malformed.text()).toBe(400);
    expect(publishErrorSchema.parse(await malformed.json()).error).toBe(
      "invalid_request",
    );

    // Absent, rather than empty — the ambiguity the schema refuses to guess at.
    const absent = await reminder({});
    expect(absent.status(), await absent.text()).toBe(400);

    // The reminder body is JSON only: it carries one short field, never a file,
    // and a second parser for it would be a second place for the shape to drift.
    const wrongType = await request.post(
      `/api/anon/${draft.anonToken}/reminder`,
      { headers: { "content-type": "text/html" }, data: "reminderEmail=x" },
    );
    expect(wrongType.status(), await wrongType.text()).toBe(400);
  });

  test("delete is idempotent, and an archived page is indistinguishable from one that never existed", async ({
    request,
  }) => {
    const draft = await publish(request, pageHtml(marker()));

    const first = await request.delete(`/api/anon/${draft.anonToken}`);
    expect(first.status(), await first.text()).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    // A SECOND DELETE IS A SUCCESS, not a 404 and not a 500. A retrying agent
    // or a double-clicked button must not see an error for reaching the state
    // it asked for — `deletePage` resolves with `requireLive: false` and
    // short-circuits on `archived` precisely so this holds.
    const second = await request.delete(`/api/anon/${draft.anonToken}`);
    expect(second.status(), await second.text()).toBe(200);
    expect(await second.json()).toEqual({ ok: true });

    // …but the page is no longer MANAGEABLE, and says so in the same words it
    // uses for a token that never existed. Resurrecting an archived page is not
    // a flow that exists, and admitting the page is merely archived would tell
    // a stranger holding a stale link that it was once real.
    const unknown = await request.post(`/api/anon/${"A".repeat(43)}/replace`, {
      headers: { "content-type": "application/json" },
      data: { html: pageHtml(marker()) },
    });
    const unknownBody = JSON.stringify(await unknown.json());

    const routes = {
      replace: await request.post(`/api/anon/${draft.anonToken}/replace`, {
        headers: { "content-type": "application/json" },
        data: { html: pageHtml(marker()) },
      }),
      reminder: await request.post(`/api/anon/${draft.anonToken}/reminder`, {
        headers: { "content-type": "application/json" },
        data: { reminderEmail: "probe@example.com" },
      }),
    };

    for (const [route, res] of Object.entries(routes)) {
      expect(res.status(), `${route}: ${await res.text()}`).toBe(404);
      expect(
        JSON.stringify(await res.json()),
        `${route} distinguishes an archived page from an unknown token`,
      ).toBe(unknownBody);
    }

    // The screens agree with the API: both answer the archived token with the
    // friendly not-found, never a 500 and never a hint that it once resolved.
    for (const prefix of ["/p", "/keep"]) {
      const res = await request.get(`${prefix}/${draft.anonToken}`);
      expect(res.status(), `${prefix} on an archived token`).toBe(404);
    }
  });
});
