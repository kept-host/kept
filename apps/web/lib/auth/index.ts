/**
 * The configured Better Auth instance — E05 task 003.
 *
 * ONE module configures auth. Task 004 mounts it at `/api/auth/[...all]` and
 * adds the session helpers; nothing here reaches into a request.
 *
 * ── D1: UUID IDS ARE A DELIBERATE NON-DEFAULT CONFIGURATION ─────────────────
 * `advanced.database.generateId` below is the second half of task 002's uuid
 * columns (see the block comment above the auth tables in `lib/db/schema.ts`,
 * which owns the decision). Better Auth mints TEXT ids out of the box; the
 * `user`/`session`/`account`/`verification` tables in this database are `uuid`,
 * because `profiles.id` IS the auth user id and `sites.owner_id` is a `uuid` FK
 * onto it that already carries rows.
 *
 * Remove `generateId` and every auth insert fails on the uuid column. That
 * failure is the correct one — loud, immediate, and unable to corrupt data. The
 * tempting "fix" is to widen the column back to text; doing so silently undoes
 * D1 and is forbidden. **Every Better Auth table added from here on, in any
 * epic and including tables a plugin brings, must use uuid ids and uuid FKs.**
 *
 * ── D2: LINK ONLY ON A PROVIDER-VERIFIED EMAIL ──────────────────────────────
 * See `account.accountLinking` below and `./github-identity.ts`. The rule in one
 * sentence: *the provider's own verification signal, read at the callback, is
 * the only thing that authorises a link.*
 *
 * ── Lazy construction ───────────────────────────────────────────────────────
 * The instance is built on first *use*, never on import, exactly like
 * `lib/db/index.ts` and for the same reason: `next build` evaluates every route
 * module while collecting page data, and CI builds with no secrets at all, so
 * validating the environment at module scope would fail the build for anything
 * that imports this file. The environment is still read through
 * `lib/storage/env.ts`, so the first touch of `auth` — long before any OAuth
 * round trip, and never as an opaque provider error — throws
 * `Invalid or missing environment: GOOGLE_CLIENT_SECRET — ...`, naming the
 * variable. Nothing here is `NEXT_PUBLIC_`.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { Resend } from "resend";

import { db, schema } from "../db";
import { authConfig, githubOAuth, googleOAuth, resendConfig } from "../storage/env";

import { bootstrapProfile } from "./bootstrap-profile";
import { fetchGithubIdentity } from "./github-identity";

function createAuth() {
  const { secret, baseUrl } = authConfig();
  const github = githubOAuth();
  const google = googleOAuth();
  const resend = resendConfig();
  const mailer = new Resend(resend.apiKey);

  return betterAuth({
    appName: "kept",
    secret,
    // The CONTROL PLANE's origin, and the only origin any OAuth redirect URI is
    // registered against. Never `KEPT_BASE_DOMAIN` — the serving domain is
    // 100% Cloudflare and has no auth surface.
    baseURL: baseUrl,

    /**
     * E05a D3/D5 — PINNED, not defaulted.
     *
     * Left unset, Better Auth derives the trusted-origin list from `baseURL`
     * alone, so a mis-set `BETTER_AUTH_URL` silently moves both the origin the
     * cookie is minted on AND the origin allowed to redirect to it. Pinning it
     * to the same resolved value makes the intent explicit and keeps the
     * resolved set a single origin — the `app.` host and nothing else. Never a
     * hostname literal (E02): the value comes from `authConfig()`, and never
     * from `KEPT_BASE_DOMAIN`, which serves arbitrary user HTML.
     */
    trustedOrigins: [baseUrl],

    database: drizzleAdapter(db, { provider: "pg", schema }),

    /**
     * ── D3/D5: THE SESSION COOKIE IS `__Host-`, ON EVERY TRACK ────────────────
     *
     * kept serves arbitrary user-authored HTML, `<script>` included, at
     * `{slug}.kept.host` — and on dev at `{slug}.kept-dev.xyz`, which can never
     * be PSL-listed, so it will always share a registrable domain with
     * `app.kept-dev.xyz`. A hosted page can therefore write a cookie with
     * `Domain=kept-dev.xyz` that the control plane's browser will send.
     *
     * `__Secure-` — what Better Auth prepends automatically on an https
     * `baseURL` — does NOT stop that. It constrains nothing but the transport:
     * a hosted page can set `__Secure-<name>=…; Domain=kept-dev.xyz; Secure`
     * and shadow or fix the real session. `__Host-` is the control that works:
     * the BROWSER rejects any `__Host-` cookie carrying `Domain`, and forces
     * `Path=/` and `Secure`. No PSL entry, no server cooperation, identical
     * behaviour on dev and prod — which is exactly why the prefix is
     * unconditional here, local included (D5). If a browser refuses a `Secure`
     * cookie on plain http, the fix is https locally (`next dev
     * --experimental-https`), never a weaker cookie.
     *
     * FOUR HAZARDS, all verified against the installed better-auth@1.6.26
     * (`dist/cookies/index.mjs`, `createCookieGetter`):
     *
     * 1. THE PREFIX CONCATENATES. The emitted name is
     *    `${secureCookiePrefix}${configuredName}`. Configure `__Host-…` while
     *    the automatic prefix is live and the browser sees
     *    `__Secure-__Host-…` — a name with NO prefix semantics at all, which
     *    is strictly worse than doing nothing because it looks hardened.
     *    `useSecureCookies: false` is the only thing that suppresses it.
     * 2. SUPPRESSING THE PREFIX ALSO DROPS `Secure`. The same flag feeds
     *    `secure: !!secureCookiePrefix` on EVERY cookie the library mints —
     *    the OAuth `state`/`pkce`/`nonce` cookies, `dont_remember`,
     *    `session_data` — not just `session_token`.
     *    `defaultCookieAttributes: { secure: true }` is spread into all of
     *    them and is what puts `Secure` back. The two settings below are one
     *    change; removing either alone is a silent security downgrade.
     * 3. `crossSubDomainCookies` IS INCOMPATIBLE WITH `__Host-`. Enabling it
     *    adds a `Domain` attribute, and a `__Host-` cookie with `Domain` is
     *    REJECTED by the browser outright. It is also the precise mechanism
     *    that would hand sessions to hosted pages, which is the thing this
     *    whole block exists to prevent. Worse, the regression hides: better-call's
     *    serializer (`dist/cookies.mjs`) re-imposes `__Host-` semantics on any
     *    key carrying the prefix — forcing `Secure` and `Path=/` and DELETING
     *    `domain` — so the session cookie's own header would look untouched
     *    while every cookie WITHOUT the prefix (the OAuth `state` cookie among
     *    them) started shipping `Domain=kept.host` to every hosted page. It is
     *    deliberately absent, and `session-cookie.test.ts` asserts it absent at
     *    the config AND resolved-attribute level rather than trusting the
     *    header.
     * 4. THE PER-COOKIE `attributes` SPREAD WINS LAST, after the `maxAge`
     *    override Better Auth passes for `session_token`. Keep `maxAge` OUT of
     *    the override below or the cookie becomes a session cookie; the test
     *    asserts `Max-Age` on the emitted header for that reason.
     *
     * Reading is unaffected: `stripSecureCookiePrefix`
     * (`dist/cookies/cookie-utils.mjs`) already strips `__Host-` as well as
     * `__Secure-`.
     *
     * NO COMPATIBILITY SHIM for the old `better-auth.session_token` name. Dev
     * sessions minted before this signed in once more; no prod user exists. A
     * second accepted session cookie name is a second thing to attack.
     *
     * SESSION COOKIE CACHING IS NOT ENABLED (`session.cookieCache` is unset),
     * so `session_data` and `account_data` carry no authority today and are
     * only named here for completeness. If a later epic enables either, that
     * cookie becomes a bearer of session authority and MUST get identical
     * treatment — same `__Host-` name shape, same attributes — or the hardening
     * below is bypassed by the cache.
     */
    advanced: {
      // Suppress the automatic `__Secure-` (hazard 1) …
      useSecureCookies: false,
      // … and put `Secure` back on every cookie it mints (hazard 2).
      defaultCookieAttributes: { secure: true },
      cookies: {
        session_token: {
          // Explicit and readable; bypasses `cookiePrefix` entirely. No
          // `maxAge` here — see hazard 4.
          name: "__Host-kept.session_token",
          attributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
        },
      },
      // crossSubDomainCookies: DELIBERATELY ABSENT — see hazard 3.
      database: {
        // D1's other half. See the header, and `lib/db/schema.ts` for the
        // decision itself. Not `"uuid"` (Better Auth's built-in shorthand):
        // that defers to `gen_random_uuid()` on the column default, and these
        // columns deliberately have no default so an id can only ever arrive
        // from the application.
        generateId: () => crypto.randomUUID(),
      },
    },

    // Email + password is not a sign-in route kept offers. Three doors only:
    // GitHub, Google, magic link.
    emailAndPassword: { enabled: false },

    /**
     * D3 — KEPT'S HALF OF AN ACCOUNT IS MADE ON THE `user` ROW'S CREATION.
     *
     * One hook, all three doors, and any door added later: a `user` row cannot
     * come into existence without a `profiles` row following it, so there is no
     * sign-in path that produces a signed-in user with no owner id to hang
     * pages off. See `./bootstrap-profile.ts` for why the hook beats the three
     * callbacks, and `../db/queries/profile.ts` for the create-once itself.
     *
     * NOT `create.before`, which runs inside the OAuth transaction and before
     * the `user` row exists — `profiles.id` is an FK onto it. `after` is queued
     * past the commit and awaited, so this both succeeds and is allowed to fail
     * the sign-in if the database is unwell.
     */
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await bootstrapProfile(user);
          },
        },
      },
    },

    account: {
      /**
       * D2 — LINK ONLY ON A PROVIDER-VERIFIED EMAIL.
       *
       * `trustedProviders` is EMPTY, and that is the decision, not a default
       * left in place. A provider listed here is linked on a matching email
       * *regardless of what it says about verification* — trust by brand. D2
       * rejects exactly that: "it's an OAuth provider, so it's verified" is not
       * a verification signal. With the list empty, Better Auth's gate
       * (`!isTrustedProvider && !userInfo.emailVerified` → refuse) reduces to
       * "link iff the provider asserted this address verified", which is D2
       * literally.
       *
       * Per provider, why it is absent:
       *   - google — absent ON PURPOSE even though Google always verifies. The
       *     guarantee we act on is the `email_verified` claim read at the
       *     callback (see `socialProviders.google` below), not Google's
       *     reputation. A Google response that does not assert it is treated as
       *     unverified.
       *   - github — absent, and this is the security-critical one. GitHub's
       *     public profile email is an attacker-controlled display field.
       *     `./github-identity.ts` replaces `getUserInfo` so the address Better
       *     Auth ever sees is either GitHub-verified or a per-account noreply
       *     placeholder carrying `emailVerified: false`.
       *   - email magic link — not a social provider and never appears here. It
       *     verifies by construction: the plugin only signs a user in after the
       *     one-time token sent to that address comes back, and it stamps
       *     `emailVerified: true`. That is what makes a magic-link account a
       *     valid link target for a later Google or GitHub sign-in.
       *
       * `requireLocalEmailVerified` is left at its secure default (`true`), so
       * an implicit link also requires the EXISTING local row to be verified —
       * an attacker cannot pre-register an unverified row at a victim's address
       * and have the victim's real identity linked into it.
       *
       * `allowDifferentEmails: true` applies ONLY to the signed-in manual link
       * (`linkSocial`), never to sign-in. It is what stops D2's refusal being a
       * dead end: someone whose GitHub verified address differs from the
       * address they signed up with can link the two while already signed in to
       * the original account, where the SESSION is the proof of ownership
       * rather than an email string. That path still requires the provider to
       * report the address verified, so it grants no trust that sign-in denies.
       */
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        allowDifferentEmails: true,
      },
    },

    socialProviders: {
      /**
       * THE COPY A REFUSED USER SEES (task 003; rendered by task 005's sign-in
       * UI and E06's settings screen, written down here because the policy owns
       * it). It states the honest reason and the recovery, never claims a
       * credential was wrong, and never confirms to a stranger that the other
       * account exists:
       *
       *   We made you a separate account
       *
       *   GitHub didn't confirm an email address for that account, so we
       *   couldn't safely connect it to any account you might already have —
       *   an unconfirmed address isn't proof of who you are. You're signed in
       *   to a new, empty kept account.
       *
       *   Already have a kept account? Sign in to it the way you usually do,
       *   then add GitHub from Settings. Being signed in is the proof we need.
       *
       *   Want one account from here on? Verify your email address on GitHub,
       *   then sign in with GitHub again.
       */
      github: {
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        // Default scopes are `read:user` + `user:email`; `user:email` is what
        // makes `GET /user/emails` — and therefore D2 — possible at all.
        getUserInfo: async (token) => {
          if (!token.accessToken) return null;
          const result = await fetchGithubIdentity(token.accessToken);
          if (!result) return null;
          const { profile, identity } = result;
          return {
            user: {
              id: String(profile.id),
              name: profile.name || profile.login,
              email: identity.email,
              emailVerified: identity.emailVerified,
              image: profile.avatar_url ?? undefined,
            },
            data: profile,
          };
        },
      },

      // A peer of GitHub, configured in the same shape. Better Auth's default
      // Google scopes are exactly `email profile openid` — the non-sensitive
      // set, which is why the consent screen needs no Google verification
      // review — so no `scope` override is added; adding one would only append.
      google: {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        // D2, read at the callback: the claim decides, not the brand. Google's
        // id token carries `email_verified` as a boolean, but the string form
        // is permitted by OIDC; anything else — absent, false, "false" — is
        // unverified and refuses the link.
        mapProfileToUser: (profile: { email_verified?: unknown }) => ({
          emailVerified:
            profile.email_verified === true || profile.email_verified === "true",
        }),
      },
    },

    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const { error } = await mailer.emails.send({
            from: resend.from,
            to: email,
            subject: "Sign in to kept",
            text:
              `Open this link to sign in to kept:\n\n${url}\n\n` +
              `It works once and expires in 5 minutes. ` +
              `If you did not ask to sign in, ignore this email.`,
          });
          // REJECT, don't swallow. A magic link that silently fails to send is
          // indistinguishable from a broken product, and tasks 004/005 surface
          // this as a retryable error with a visible message rather than a
          // spinner that never resolves.
          if (error) {
            throw new Error(
              `Resend refused the magic-link email: ${error.name} — ${error.message}`,
            );
          }
        },
      }),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;

function getAuth(): Auth {
  if (!cached) cached = createAuth();
  return cached;
}

/**
 * The Better Auth instance. Reads resolve against the real instance on first
 * property access, so `auth.handler(...)` and `auth.api.getSession(...)` behave
 * exactly as if it were constructed eagerly, while merely importing this module
 * touches neither `process.env` nor the network.
 */
export const auth = new Proxy({} as Auth, {
  get: (_target, prop) => Reflect.get(getAuth(), prop),
});
