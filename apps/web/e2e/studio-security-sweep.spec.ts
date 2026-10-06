import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateAnonToken, publishErrorSchema } from "@kept/shared";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { eq } from "drizzle-orm";

import { closeDb, db, schema } from "../lib/db";

import { LIVE_STACK_TIMEOUT, warmDb } from "./live-stack";
import { pageHtml, publishViaApi, servingDomain } from "./live-publish";
import {
  cleanup,
  newScope,
  publishOwned,
  readSite,
  signInAs,
  SKIP_OWNER_UI,
  titledHtml,
  type OwnerScope,
} from "./owner-fixtures";

/**
 * AC44 — THE SWEEP. Every cookie-authenticated mutation route, in one place,
 * against the REAL dev stack — E06 task 014.
 *
 * Each route's own spec already proves its own refusals. This file exists for
 * the claim no single-route spec can make: that the set is COMPLETE. The route
 * list is read from the filesystem (every `route.ts` / `route.tsx` under
 * `app/api/` exporting POST, PUT, PATCH or DELETE), and every route found must
 * be either SWEPT below or named in `NOT_COOKIE_AUTHENTICATED` with the reason
 * it is not — so a mutation route added later without coverage fails the first
 * test here, with no network and no credentials needed.
 *
 * For every swept route, two halves:
 *
 *   (a) A REAL session cookie carrying a hosted page's `Origin` (the E05a threat
 *       model: `{slug}.{base}` is same-site with the control plane) is refused
 *       by `refuseUntrustedOrigin` with its existing flat 403 body — the same
 *       bytes on every route — and moves nothing. The requests are otherwise
 *       VALID: the delete names a real page, the account deletion types the
 *       real email, the anonymous keep carries a live token. Had the gate not
 *       run first, each would have landed.
 *   (b) User B acting on user A's page gets **404, never 403**, and the body is
 *       byte-identical to the one for an id that names nothing: "not yours" is
 *       not an existence oracle (D17).
 *
 * NO MOCKS. A's pages are published through `POST /api/sites` and the keyless
 * `POST /api/publish`; both users sign in through the real magic-link verify.
 * SKIPS (the live halves) without dev credentials: CI runs fork PRs with none.
 */

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** `apps/web/app/api/`, from this file's own location — never the cwd. */
const API_DIR = fileURLToPath(new URL("../app/api/", import.meta.url));

/**
 * The mutation routes that authenticate with something OTHER than the session
 * cookie, so the origin gate does not apply to them — each a decision, not an
 * omission (`lib/publish/origin.ts`, "the rule binds to cookie use").
 */
const NOT_COOKIE_AUTHENTICATED: Record<string, string> = {
  "POST /api/publish":
    "keyless: the bearer anon token is minted by the call itself — E08's agent path, callable from anywhere",
  "DELETE /api/anon/[anonToken]": "bearer: the anon token in the path",
  "POST /api/anon/[anonToken]/replace": "bearer: the anon token in the path",
  "POST /api/anon/[anonToken]/reminder": "bearer: the anon token in the path",
  "POST /api/cron/draft-reminder": "Authorization: Bearer CRON_SECRET, from GitHub Actions",
  "POST /api/cron/visits-sync": "Authorization: Bearer CRON_SECRET, from GitHub Actions",
  "POST /api/auth/[...all]":
    "Better Auth's own handler, behind its own trustedOrigins check (auth-providers.spec)",
};

/** What a swept request may act on. A's real things, or things that name nothing. */
interface Target {
  /** A kept, live page. */
  siteId: string;
  /** That page's current version. */
  versionId: string;
  /** An owned draft. */
  draftId: string;
  /** An anonymous draft's token. */
  anonToken: string;
  /** The account's email — the typed confirmation account deletion asks for. */
  email: string;
}

type Send = (
  ctx: APIRequestContext,
  baseURL: string,
  target: Target,
  headers: Record<string, string>,
) => Promise<APIResponse>;

interface SweptRoute {
  send: Send;
  /**
   * `true`: user B naming A's target must get the not-found answer. A string:
   * why this route has no "another user's page" — it only ever acts on the
   * caller's own account.
   */
  stranger: true | string;
}

const sweepName = () => `e06-014-sweep-${crypto.randomUUID().slice(0, 8)}`;

/** Every cookie-authenticated mutation route. The key is `METHOD /api/path`. */
const SWEPT: Record<string, SweptRoute> = {
  "POST /api/sites": {
    send: (ctx, base, _t, headers) =>
      ctx.post(`${base}/api/sites`, {
        headers: { ...headers, "content-type": "text/html" },
        data: titledHtml(sweepName()),
      }),
    stranger: "creates a page in the caller's own account; it names no page",
  },
  "PATCH /api/sites/[id]": {
    send: (ctx, base, t, headers) =>
      ctx.patch(`${base}/api/sites/${t.siteId}`, { headers, data: { title: sweepName() } }),
    stranger: true,
  },
  "DELETE /api/sites/[id]": {
    send: (ctx, base, t, headers) => ctx.delete(`${base}/api/sites/${t.siteId}`, { headers }),
    stranger: true,
  },
  "PATCH /api/sites/[id]/name": {
    send: (ctx, base, t, headers) =>
      ctx.patch(`${base}/api/sites/${t.siteId}/name`, { headers, data: { name: sweepName() } }),
    stranger: true,
  },
  "POST /api/sites/[id]/replace": {
    send: (ctx, base, t, headers) =>
      ctx.post(`${base}/api/sites/${t.siteId}/replace`, {
        headers,
        data: { html: titledHtml(sweepName()) },
      }),
    stranger: true,
  },
  "POST /api/sites/[id]/versions/[versionId]/restore": {
    send: (ctx, base, t, headers) =>
      ctx.post(`${base}/api/sites/${t.siteId}/versions/${t.versionId}/restore`, { headers }),
    stranger: true,
  },
  "POST /api/sites/[id]/keep": {
    send: (ctx, base, t, headers) => ctx.post(`${base}/api/sites/${t.draftId}/keep`, { headers }),
    stranger: true,
  },
  "POST /api/sites/[id]/demote": {
    send: (ctx, base, t, headers) => ctx.post(`${base}/api/sites/${t.siteId}/demote`, { headers }),
    stranger: true,
  },
  "POST /api/sites/swap": {
    send: (ctx, base, t, headers) =>
      ctx.post(`${base}/api/sites/swap`, {
        headers,
        data: { demote: t.siteId, keep: t.draftId },
      }),
    stranger: true,
  },
  "DELETE /api/account": {
    send: (ctx, base, t, headers) =>
      ctx.delete(`${base}/api/account`, { headers, data: { email: t.email } }),
    stranger: "deletes the session's own account; it names no page",
  },
  // Cookie-authenticated although its path carries a token: the keep attaches
  // the page to the SESSION's account, so it is gated like every route above.
  "POST /api/anon/[anonToken]/keep": {
    send: (ctx, base, t, headers) =>
      ctx.post(`${base}/api/anon/${t.anonToken}/keep`, { headers }),
    stranger: true,
  },
};

/** Every `METHOD /api/path` the filesystem declares, with its source. */
async function mutatingRoutes(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const files = (await readdir(API_DIR, { recursive: true })).filter((file) =>
    /(^|\/)route\.tsx?$/.test(file),
  );
  expect(files.length, `no route files under ${API_DIR}`).toBeGreaterThan(0);

  for (const file of files) {
    const source = await readFile(join(API_DIR, file), "utf8");
    // A re-export or a destructured export would hide a handler from the
    // pattern below. Refuse the shape rather than miss a route.
    expect(source, `${file}: export handlers as \`export async function\` or \`export const\``).not.toMatch(
      /export\s*(\*|\{)|export\s+const\s*\{/,
    );
    const path = `/api/${dirname(file)}`;
    for (const [, method] of source.matchAll(
      /export\s+(?:async\s+)?(?:function|const|let)\s+(POST|PUT|PATCH|DELETE)\b/g,
    )) {
      found.set(`${method} ${path}`, source);
    }
  }
  return found;
}

test("every mutation route under app/api is swept or named as not cookie-authenticated (AC44)", async () => {
  const routes = await mutatingRoutes();
  const swept = Object.keys(SWEPT);
  const exempt = Object.keys(NOT_COOKIE_AUTHENTICATED);

  expect(swept.filter((key) => exempt.includes(key)), "a route is either swept or exempt").toEqual([]);
  // THE COMPLETENESS CLAIM: a route added later lands in neither list and fails here.
  expect([...routes.keys()].sort()).toEqual([...swept, ...exempt].sort());
  for (const key of routes.keys()) {
    expect(MUTATING.some((method) => key.startsWith(`${method} `))).toBe(true);
  }

  // The table agrees with the code: swept routes call the gate, exempt ones do not.
  for (const [key, source] of routes) {
    expect(source.includes("refuseUntrustedOrigin"), key).toBe(key in SWEPT);
  }
});

test.describe("the sweep, on the wire (AC44)", () => {
  test.skip(!!SKIP_OWNER_UI, SKIP_OWNER_UI || undefined);
  test.describe.configure({ timeout: LIVE_STACK_TIMEOUT * 2 });

  const scope = newScope();

  test.beforeAll(async () => {
    if (SKIP_OWNER_UI) return;
    await warmDb();
  });

  test.afterAll(async () => {
    if (SKIP_OWNER_UI) return;
    await cleanup(scope);
    await closeDb();
  });

  const sameOrigin = (baseURL: string) => ({ origin: new URL(baseURL).origin });

  /** A keyless publish — an anonymous draft with bytes, a manifest and a token. */
  async function anonymousDraft(
    request: APIRequestContext,
    into: OwnerScope,
  ): Promise<{ token: string; siteId: string }> {
    const html = pageHtml(`e06-014-sweep-anon-${crypto.randomUUID().slice(0, 8)}`);
    const response = await publishViaApi(request, html);
    expect(response.status(), await response.text()).toBe(201);
    const { slug, anonToken } = (await response.json()) as { slug: string; anonToken: string };
    const [row] = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.slug, slug));
    into.siteIds.push(row!.id);
    into.slugs.add(slug);
    return { token: anonToken, siteId: row!.id };
  }

  /**
   * User A, signed in through `page`, holding one of everything the routes act
   * on: a kept page, an owned draft (a kept page demoted through the real
   * route), an anonymous draft A already kept (its token now resolves to
   * nothing) and an unclaimed anonymous draft (its token is live).
   */
  async function arrange(page: Page, request: APIRequestContext, baseURL: string) {
    const { userId, email } = await signInAs(page, baseURL, scope);
    const kept = await publishOwned(page, baseURL, scope, "E06 sweep kept");
    const draft = await publishOwned(page, baseURL, scope, "E06 sweep draft");
    const demoted = await page.request.post(`${baseURL}/api/sites/${draft.siteId}/demote`, {
      headers: sameOrigin(baseURL),
    });
    expect(demoted.status(), await demoted.text()).toBe(200);

    const claimed = await anonymousDraft(request, scope);
    const keep = await page.request.post(`${baseURL}/api/anon/${claimed.token}/keep`, {
      headers: sameOrigin(baseURL),
    });
    expect(keep.status(), await keep.text()).toBe(200);
    const unclaimed = await anonymousDraft(request, scope);

    const versionId = (await readSite(kept.siteId)).currentVersionId!;
    const ids = [kept.siteId, draft.siteId, claimed.siteId, unclaimed.siteId];
    const snapshot = () => Promise.all(ids.map((id) => readSite(id)));
    return {
      userId,
      kept,
      unclaimedId: unclaimed.siteId,
      target: { siteId: kept.siteId, versionId, draftId: draft.siteId, email },
      claimedToken: claimed.token,
      liveToken: unclaimed.token,
      snapshot,
    };
  }

  test("(a) a session cookie from a hosted page's origin is refused with E05a's one 403 body on every route, and nothing moves", async ({
    page,
    request,
    baseURL,
  }) => {
    const a = await arrange(page, request, baseURL!);
    const before = await a.snapshot();
    const foreign = { origin: `https://${a.kept.slug}.${servingDomain()}` };

    const bodies = new Map<string, string>();
    for (const [key, route] of Object.entries(SWEPT)) {
      // Valid in every other respect — the live token, the real email.
      const response = await route.send(page.request, baseURL!, { ...a.target, anonToken: a.liveToken }, foreign);
      expect(response.status(), `${key}: ${await response.text()}`).toBe(403);
      const body = publishErrorSchema.parse(await response.json());
      expect(body.error, key).toBe("invalid_request");
      expect(body.message, key).toContain(new URL(baseURL!).origin);
      bodies.set(key, await response.text());
    }
    // The gate's own body, not a per-route approximation of it.
    expect(new Set(bodies.values()).size, [...bodies.keys()].join(", ")).toBe(1);

    expect(await a.snapshot(), "no page moved").toEqual(before);
    expect((await readSite(a.unclaimedId)).ownerId, "the anonymous draft was not kept").toBeNull();
    expect(
      await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, a.userId)),
      "the account was not deleted",
    ).toHaveLength(1);
    const owned = await db
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(eq(schema.sites.ownerId, a.userId));
    expect(owned, "no page was created").toHaveLength(3);
  });

  test("(b) user B naming user A's page gets 404 — never 403 — byte-identical to an id that names nothing", async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const a = await arrange(page, request, baseURL!);
    const before = await a.snapshot();

    const strangerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const stranger = await strangerContext.newPage();
      await signInAs(stranger, baseURL!, scope);
      const nothing: Target = {
        siteId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        draftId: crypto.randomUUID(),
        anonToken: generateAnonToken(),
        email: a.target.email,
      };

      const exempted: string[] = [];
      for (const [key, route] of Object.entries(SWEPT)) {
        if (route.stranger !== true) {
          exempted.push(key);
          continue;
        }
        // Same-origin: B passes the gate, so the answer is about ownership.
        const theirs = await route.send(
          stranger.request,
          baseURL!,
          { ...a.target, anonToken: a.claimedToken },
          sameOrigin(baseURL!),
        );
        const absent = await route.send(stranger.request, baseURL!, nothing, sameOrigin(baseURL!));
        expect(theirs.status(), `${key}: ${await theirs.text()}`).toBe(404);
        expect(absent.status(), key).toBe(404);
        expect(await theirs.text(), `${key}: "not yours" must read as "not there"`).toBe(await absent.text());
      }
      expect(exempted.sort(), "only the account-scoped routes name no page").toEqual(
        ["DELETE /api/account", "POST /api/sites"].sort(),
      );
    } finally {
      await strangerContext.close();
    }

    expect(await a.snapshot(), "nothing B sent moved A's pages").toEqual(before);
  });
});
