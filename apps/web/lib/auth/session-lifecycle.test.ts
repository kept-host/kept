/**
 * The session round trip — E05 task 004.
 *
 * `getSession()` and `requireSession()` cannot be imported here: they call
 * `next/headers`, which throws outside a Next request scope. What they wrap
 * *can* be, and that is what this file exercises — `auth.handler(...)` minting
 * a session, `auth.api.getSession({ headers })` reading it back, and
 * `/sign-out` ending it. If this contract holds, the helpers around it are two
 * lines of glue; if it does not, no amount of testing the glue would say so.
 *
 * NO MOCKS (project rule). Real `auth` instance from `./index.ts`, real Drizzle
 * adapter, real dev Neon branch, real HTTP handler, real signed cookie. The
 * cookie asserted below is the one Better Auth itself wrote into `Set-Cookie`,
 * not one this file constructed.
 *
 * WHAT IS SKIPPED, AND WHY IT IS NOT A MOCK: the **email transport**. The
 * magic-link plugin writes a verification value and then hands the URL to
 * Resend; with no `RESEND_API_KEY` provisioned, that hand-off cannot happen. So
 * this file writes the verification value through the plugin's own storage
 * contract (`createVerificationValue`, identifier = the plain token, exactly
 * what `sendMagicLink` would have carried) and then calls the REAL
 * `/api/auth/magic-link/verify` endpoint with it. Nothing about Better Auth is
 * stubbed, replaced or patched — the inbox is. The live OAuth handshakes are
 * task 012's, and they are the one thing a test without credentials cannot
 * prove.
 *
 * SKIPS without `DATABASE_URL`: CI runs `pnpm test` on fork PRs with no
 * secrets. Run locally with `pnpm --filter @kept/web test:unit`.
 *
 * EVERY IMPORT OF `./index` AND `../db` IS DYNAMIC AND INSIDE A TEST, because
 * both reach `process.env` on first use and a static import would turn
 * "skipped" into "the file failed to load".
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/**
 * Fill only what is missing, exactly as `./linking-refusal.test.ts` does: a real
 * value in `.env.local` always wins, so this can never hide a misconfiguration.
 * Constructing the auth instance validates all eight auth variables, and the
 * OAuth/Resend credentials are not provisioned yet. No code path below
 * transmits them — no OAuth endpoint, no token exchange, no Resend call is
 * reached — so they are configuration the flow never uses, not a stub standing
 * in for a service.
 */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "session-lifecycle-drill-secret-not-used-for-anything-real",
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "unprovisioned.github.invalid",
  GITHUB_CLIENT_SECRET: "unprovisioned.github.invalid",
  GOOGLE_CLIENT_ID: "unprovisioned.google.invalid",
  GOOGLE_CLIENT_SECRET: "unprovisioned.google.invalid",
  RESEND_API_KEY: "unprovisioned.resend.invalid",
  EMAIL_FROM: "drill@unprovisioned.invalid",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

const baseUrl = (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL)!.replace(
  /\/+$/,
  "",
);

const runId = crypto.randomUUID().slice(0, 8);
const email = `session-${runId}@kept-e05-004.invalid`;

const createdUserIds: string[] = [];

after(async () => {
  if (skipLive) return;
  const { db, schema } = await import("../db");
  const { inArray } = await import("drizzle-orm");
  if (createdUserIds.length) {
    // Cascades `profiles`, `session`, `account` and `verification`.
    await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
  }
  await db.$client.end();
});

/** The session cookie out of a real `Set-Cookie`, as a `Cookie` request header. */
function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.length > 0, "the verify endpoint must set at least one cookie");
  return setCookies.map((entry) => entry.split(";", 1)[0]).join("; ");
}

test(
  "a real session is minted, read back, and ended by sign-out",
  { skip: skipLive },
  async () => {
    const { auth } = await import("./index");
    const { db, schema } = await import("../db");
    const { eq } = await import("drizzle-orm");

    const ctx = await auth.$context;

    // ── The inbox, and only the inbox ────────────────────────────────────────
    // `sendMagicLink` would have carried this token in a URL. `storeToken`
    // defaults to "plain", so the identifier IS the token.
    const token = crypto.randomUUID().replace(/-/g, "");
    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "Session Drill" }),
      expiresAt: new Date(Date.now() + 300_000),
    });

    // ── The real endpoint. No `callbackURL`, so it answers JSON ──────────────
    const verified = await auth.handler(
      new Request(`${baseUrl}/api/auth/magic-link/verify?token=${token}`),
    );
    assert.equal(verified.status, 200, await verified.clone().text());

    const body = (await verified.json()) as {
      user: { id: string; email: string; emailVerified: boolean };
      session: { token: string };
    };
    createdUserIds.push(body.user.id);
    assert.equal(body.user.email, email);
    assert.equal(
      body.user.emailVerified,
      true,
      "a magic link verifies by construction — that is what makes it a valid link target (D2)",
    );
    // D1, incidentally proved again: the adapter minted a uuid, not a text id.
    assert.match(
      body.user.id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "advanced.database.generateId must mint uuids (D1)",
    );

    // The session is a row, not only a cookie.
    const rows = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, body.user.id));
    assert.equal(rows.length, 1, "exactly one session row for the new user");

    // ── What `getSession()` wraps ────────────────────────────────────────────
    const cookie = cookieHeaderFrom(verified);
    const read = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.equal(
      read?.user.id,
      body.user.id,
      "the cookie Better Auth set must resolve back to the same user",
    );
    assert.equal(read?.session.userId, body.user.id);

    // ── The signed-out branch the gate redirects on ──────────────────────────
    assert.equal(
      await auth.api.getSession({ headers: new Headers() }),
      null,
      "no cookie is no session — this is the branch `requireSession()` redirects on",
    );
    assert.equal(
      await auth.api.getSession({
        // The REAL cookie name (E05a task 005 renamed it to `__Host-…`), read
        // off the instance so this stays a forged *session* cookie rather than
        // an unrelated name that would resolve to null for the wrong reason.
        headers: new Headers({
          cookie: `${ctx.authCookies.sessionToken.name}=forged.signature`,
        }),
      }),
      null,
      "an unsigned/forged cookie must not resolve to a session",
    );

    // ── Sign-out clears the session and re-gates ─────────────────────────────
    // `origin` is not decoration: Better Auth's CSRF check rejects a
    // state-changing request without one (403 MISSING_OR_NULL_ORIGIN). A browser
    // always sends it; this request is a browser's, so it does too.
    const signedOut = await auth.handler(
      new Request(`${baseUrl}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin: baseUrl, "content-type": "application/json" },
      }),
    );
    assert.equal(signedOut.status, 200, await signedOut.clone().text());

    assert.equal(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
      null,
      "after sign-out the same cookie resolves to nothing — a later (app)/* hit re-gates",
    );
    const afterSignOut = await db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, body.user.id));
    assert.deepEqual(afterSignOut, [], "the session row is revoked, not merely un-cookied");
  },
);
