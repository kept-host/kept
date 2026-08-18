/**
 * The session cookie's shape, read off a real `Set-Cookie` — E05a task 005.
 *
 * A test that reads the config object and a browser that reads a header are
 * looking at two different things, and the whole hazard of this task lives in
 * the gap between them: better-auth CONCATENATES its automatic `__Secure-`
 * prefix onto a configured name, so a config that says `__Host-…` can emit
 * `__Secure-__Host-…` — a name with no prefix semantics at all. So the primary
 * assertions below are string assertions against the header better-auth itself
 * wrote, minted through the real magic-link verify endpoint.
 *
 * NO MOCKS (project rule). Real `auth` instance from `./index.ts`, real Drizzle
 * adapter, real dev Neon branch, real HTTP handler, real signed cookie. As in
 * `./session-lifecycle.test.ts`, the ONE thing not exercised is the email
 * transport: the verification value is written through the plugin's own storage
 * contract instead of arriving by Resend. Nothing about better-auth is stubbed
 * — the inbox is.
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
 * Fill only what is missing, exactly as `./session-lifecycle.test.ts` does: a
 * real value in `.env.local` always wins, so this can never hide a
 * misconfiguration. Constructing the auth instance validates all eight auth
 * variables; no code path below transmits the OAuth/Resend ones.
 */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "session-cookie-drill-secret-not-used-for-anything-real",
  BETTER_AUTH_URL: "https://localhost:3000",
  GITHUB_CLIENT_ID: "unprovisioned.github.invalid",
  GITHUB_CLIENT_SECRET: "unprovisioned.github.invalid",
  GOOGLE_CLIENT_ID: "unprovisioned.google.invalid",
  GOOGLE_CLIENT_SECRET: "unprovisioned.google.invalid",
  RESEND_API_KEY: "unprovisioned.resend.invalid",
  EMAIL_FROM: "drill@unprovisioned.invalid",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value;
}

const runId = crypto.randomUUID().slice(0, 8);
const email = `cookie-${runId}@kept-e05a-005.invalid`;

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

/** The `Set-Cookie` entry for `name`, as better-auth emitted it. */
function setCookieFor(response: Response, name: string): string {
  const entry = response.headers
    .getSetCookie()
    .find((value) => value.split("=", 1)[0]?.trim() === name);
  assert.ok(
    entry,
    `no Set-Cookie named ${name} — emitted: ${response.headers.getSetCookie().join(" | ")}`,
  );
  return entry;
}

test(
  "the session Set-Cookie is __Host- prefixed, Secure, and carries no Domain",
  { skip: skipLive },
  async () => {
    const { auth } = await import("./index");
    const { authConfig } = await import("../storage/env");

    const baseUrl = authConfig().baseUrl;
    const ctx = await auth.$context;

    // ── Mint a real session through the real endpoint ────────────────────────
    const token = crypto.randomUUID().replace(/-/g, "");
    await ctx.internalAdapter.createVerificationValue({
      identifier: token,
      value: JSON.stringify({ email, name: "Cookie Drill" }),
      expiresAt: new Date(Date.now() + 300_000),
    });

    const verified = await auth.handler(
      new Request(`${baseUrl}/api/auth/magic-link/verify?token=${token}`),
    );
    assert.equal(verified.status, 200, await verified.clone().text());
    const body = (await verified.json()) as { user: { id: string } };
    createdUserIds.push(body.user.id);

    // ── The emitted header, not the config object ────────────────────────────
    const sessionCookie = setCookieFor(verified, "__Host-kept.session_token");
    const name = sessionCookie.split("=", 1)[0] ?? "";

    assert.ok(name.startsWith("__Host-"), `emitted name must start __Host-: ${name}`);
    // THE TRAP. better-auth concatenates its automatic prefix onto a configured
    // name, so a live `useSecureCookies` would emit `__Secure-__Host-…` here —
    // a name the browser treats as ordinary while it looks hardened.
    assert.ok(
      !name.includes("__Secure-"),
      `the automatic __Secure- prefix must be suppressed, not concatenated: ${name}`,
    );
    assert.equal(name, "__Host-kept.session_token");

    const attributes = sessionCookie
      .split(";")
      .slice(1)
      .map((part) => part.trim().toLowerCase());

    assert.ok(attributes.includes("secure"), `Secure missing: ${sessionCookie}`);
    assert.ok(attributes.includes("httponly"), `HttpOnly missing: ${sessionCookie}`);
    assert.ok(attributes.includes("path=/"), `Path=/ missing: ${sessionCookie}`);
    assert.ok(attributes.includes("samesite=lax"), `SameSite=Lax missing: ${sessionCookie}`);
    // The per-cookie `attributes` object spreads AFTER better-auth's own
    // `maxAge` override, so an added `maxAge` there would silently eat this.
    assert.ok(
      attributes.some((attribute) => attribute.startsWith("max-age=")),
      `Max-Age missing — the session cookie must outlive the browser session: ${sessionCookie}`,
    );
    assert.ok(
      !attributes.some((attribute) => attribute.startsWith("domain=")),
      `a __Host- cookie carrying Domain is rejected by the browser: ${sessionCookie}`,
    );
    // …and the same check one layer up, which is where a `crossSubDomainCookies`
    // regression is actually visible. `better-call`'s serializer
    // (`dist/cookies.mjs`) re-imposes `__Host-` semantics on any key starting
    // with the prefix — it forces `Secure`, forces `Path=/` and DELETES
    // `domain` — so enabling `crossSubDomainCookies` would put `domain` in the
    // attributes, be silently swallowed on this cookie, and still ship
    // `Domain=kept.host` on every cookie WITHOUT the prefix (the OAuth `state`
    // cookie among them). The header alone cannot see that; this can.
    assert.ok(
      !("domain" in ctx.authCookies.sessionToken.attributes),
      `the session cookie must resolve with no domain attribute: ${JSON.stringify(
        ctx.authCookies.sessionToken.attributes,
      )}`,
    );

    // ── Correctly shaped is not enough; it must still be read back ───────────
    const cookie = verified.headers
      .getSetCookie()
      .map((entry) => entry.split(";", 1)[0])
      .join("; ");
    const read = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.equal(
      read?.user.id,
      body.user.id,
      "the __Host- cookie better-auth set must resolve back to the same user",
    );
  },
);

test(
  "every cookie better-auth mints keeps Secure, and crossSubDomainCookies is off",
  { skip: skipLive },
  async () => {
    const { auth } = await import("./index");
    const { authConfig } = await import("../storage/env");

    const ctx = await auth.$context;
    // Widened on purpose. `ctx.options.advanced` is inferred from the object
    // literal in `./index.ts`, so `crossSubDomainCookies` is not even a
    // property of its type today — reading it through this shape is what keeps
    // the assertion a runtime tripwire that fires the moment someone adds it,
    // rather than a compile error that a future author deletes to move on.
    const advanced: {
      useSecureCookies?: boolean;
      defaultCookieAttributes?: { secure?: boolean };
      crossSubDomainCookies?: unknown;
    } = ctx.options.advanced ?? {};

    // Both halves of the change, or `Secure` is dropped silently.
    assert.equal(advanced?.useSecureCookies, false);
    assert.equal(advanced?.defaultCookieAttributes?.secure, true);

    // `useSecureCookies: false` feeds `secure: !!secureCookiePrefix` on EVERY
    // cookie, so this is the assertion that proves the OAuth flow's cookies did
    // not quietly lose `Secure` when the prefix was suppressed.
    for (const [label, entry] of Object.entries(ctx.authCookies)) {
      assert.equal(entry.attributes.secure, true, `${label} lost Secure`);
      assert.equal(entry.attributes.httpOnly, true, `${label} lost HttpOnly`);
    }
    // `state` / `oauth_state` are the OAuth handshake's cookies; the last name
    // stands in for any cookie a future plugin mints through the same getter.
    for (const cookieName of ["state", "oauth_state", "dont_remember", "any_future_cookie"]) {
      assert.equal(
        ctx.createAuthCookie(cookieName).attributes.secure,
        true,
        `${cookieName} lost Secure`,
      );
    }

    // Asserted, not merely absent: enabling this sets a Domain attribute, and a
    // __Host- cookie with Domain is rejected outright — a silent, total,
    // environment-wide sign-in outage with no server-side error to find.
    assert.equal(
      advanced?.crossSubDomainCookies,
      undefined,
      "crossSubDomainCookies is incompatible with __Host- and must never be enabled",
    );

    // Pinned to the `app.` origin, from the env helper — never a literal.
    const baseUrl = authConfig().baseUrl;
    assert.deepEqual(ctx.options.trustedOrigins, [baseUrl]);
    assert.deepEqual(
      [...new Set(ctx.trustedOrigins)],
      [baseUrl],
      "the resolved trusted-origin set must be the app origin and nothing else",
    );
  },
);
