/**
 * The closed deploy's back door — E06a task 002.
 *
 * `closedModeAccess` is the first line of every publish route while kept is
 * closed: an access token or an admin session passes, anything else does not.
 * The token half is pure hashing; the session half runs against the real auth
 * instance, the real Drizzle adapter and the real dev Neon branch, with the
 * session minted through the real magic-link verify endpoint (only the inbox is
 * skipped, as in `lib/auth/session-cookie.test.ts`).
 *
 * Every case that reaches the session lookup SKIPS without `DATABASE_URL`, and
 * the auth/db imports stay dynamic for the same reason as in that file.
 *
 * Nothing here prints a token, a digest or an address.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import { config } from "dotenv";

import { mintAccessToken } from "./access-token";
import { isAdminEmail } from "./auth/closed-sign-in";
import { closedModeAccess } from "./launch-access";

config({ path: ".env.local", quiet: true });

const skipLive = process.env.DATABASE_URL
  ? false
  : "DATABASE_URL absent — run locally with apps/web/.env.local";

/** Fill only what is missing — a real value in `.env.local` always wins. */
for (const [name, value] of Object.entries({
  BETTER_AUTH_SECRET: "launch-access-drill-secret-not-used-for-anything-real",
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
const adminEmail = `admin-${runId}@kept-e06a-002.invalid`;
const otherEmail = `other-${runId}@kept-e06a-002.invalid`;

const issued = await mintAccessToken();
const createdUserIds: string[] = [];
const cookies = new Map<string, string>();

/** This file owns these two for its whole run; the dev values are not read. */
process.env.KEPT_ADMIN_EMAILS = ` ${adminEmail.toUpperCase()} , someone-else@kept.invalid`;
process.env.KEPT_ACCESS_TOKEN_HASHES = `${"0".repeat(64)},${issued.hash}`;

function setOpen(open: boolean): void {
  if (open) process.env.NEXT_PUBLIC_KEPT_OPEN = "true";
  else delete process.env.NEXT_PUBLIC_KEPT_OPEN;
}

function publishRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://localhost:3000/api/publish", {
    method: "POST",
    headers,
  });
}

/** A real session for `email`, as the `name=value` cookie a browser would send. */
async function signIn(email: string): Promise<string> {
  const { auth } = await import("./auth");
  const { authConfig } = await import("./storage/env");
  const ctx = await auth.$context;

  const token = crypto.randomUUID().replace(/-/g, "");
  await ctx.internalAdapter.createVerificationValue({
    identifier: token,
    value: JSON.stringify({ email, name: "Launch Access Drill" }),
    expiresAt: new Date(Date.now() + 300_000),
  });
  const verified = await auth.handler(
    new Request(`${authConfig().baseUrl}/api/auth/magic-link/verify?token=${token}`),
  );
  assert.equal(verified.status, 200, "magic-link verify did not sign the drill user in");
  createdUserIds.push(((await verified.json()) as { user: { id: string } }).user.id);

  const cookie = verified.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-kept.session_token="));
  assert.ok(cookie, "no session cookie was minted");
  return cookie.split(";", 1)[0]!;
}

before(async () => {
  if (skipLive) return;
  // Minted while open, so a closed-mode sign-in refusal (task 003) cannot
  // stop the fixture; every assertion below sets the gate itself.
  setOpen(true);
  cookies.set(adminEmail, await signIn(adminEmail));
  cookies.set(otherEmail, await signIn(otherEmail));
});

after(async () => {
  if (skipLive) return;
  const { db, schema } = await import("./db");
  const { inArray } = await import("drizzle-orm");
  if (createdUserIds.length) {
    // Cascades `profiles`, `session`, `account` and `verification`.
    await db.delete(schema.user).where(inArray(schema.user.id, createdUserIds));
  }
  await db.$client.end();
});

test("a minted token is kpt_access_ + 32 random base64url bytes, and its hash is its SHA-256 hex", async () => {
  const second = await mintAccessToken();
  for (const { token, hash } of [issued, second]) {
    assert.match(token, /^kpt_access_[A-Za-z0-9_-]{43}$/);
    assert.equal(hash, createHash("sha256").update(token).digest("hex"));
  }
  assert.notEqual(issued.token, second.token);
});

test("admin emails compare trimmed and lowercased", () => {
  assert.equal(isAdminEmail(adminEmail), true);
  assert.equal(isAdminEmail(` ${adminEmail.toUpperCase()} `), true);
  assert.equal(isAdminEmail(otherEmail), false);
});

test("open: every request may publish — the check is not consulted (D9)", async () => {
  setOpen(true);
  assert.equal(await closedModeAccess(publishRequest()), true);
  assert.equal(
    await closedModeAccess(publishRequest({ authorization: "Bearer kpt_access_unknown" })),
    true,
  );
});

test("closed: a configured access token passes", async () => {
  setOpen(false);
  assert.equal(
    await closedModeAccess(publishRequest({ authorization: `Bearer ${issued.token}` })),
    true,
  );
  assert.equal(
    await closedModeAccess(publishRequest({ authorization: `bearer  ${issued.token}` })),
    true,
  );
});

test(
  "closed: anything but a configured token, with no session, is refused",
  { skip: skipLive },
  async () => {
    setOpen(false);
    const unknown = await mintAccessToken();
    for (const authorization of [
      undefined,
      `Bearer ${unknown.token}`,
      `Bearer ${issued.token}x`,
      `Bearer ${issued.token.slice("kpt_access_".length)}`,
      `Bearer ${issued.hash}`,
      `Basic ${issued.token}`,
      issued.token,
    ]) {
      const headers: Record<string, string> = authorization ? { authorization } : {};
      assert.equal(await closedModeAccess(publishRequest(headers)), false, "refused shape");
    }
  },
);

test("closed: an admin's session passes; anyone else's does not", { skip: skipLive }, async () => {
  setOpen(false);
  assert.equal(await closedModeAccess(publishRequest({ cookie: cookies.get(adminEmail)! })), true);
  assert.equal(await closedModeAccess(publishRequest({ cookie: cookies.get(otherEmail)! })), false);
  // A forged cookie value is no session at all.
  assert.equal(
    await closedModeAccess(publishRequest({ cookie: "__Host-kept.session_token=forged.value" })),
    false,
  );
  // An unknown token does not spoil a valid admin session on the same request.
  const unknown = await mintAccessToken();
  assert.equal(
    await closedModeAccess(
      publishRequest({
        cookie: cookies.get(adminEmail)!,
        authorization: `Bearer ${unknown.token}`,
      }),
    ),
    true,
  );
});
