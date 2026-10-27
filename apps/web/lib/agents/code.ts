/**
 * Agent sign-in by emailed code (E09 D7, Q3) — `POST /api/agent/request-code`
 * and `POST /api/agent/verify-code`. The routes are the HTTP boundary; this
 * module decides.
 *
 * The agent asks for a code, the human reads it from their mail and tells the
 * agent, the agent trades it for a new API key. No session and no cookie, ever.
 *
 * ── NOTHING SAYS WHETHER AN ADDRESS HAS AN ACCOUNT ──────────────────────────
 * Request answers ONE 202 `{ ok: true }` past the per-IP limit and the body:
 * a new address, an existing account, a closed deploy's non-admin and an
 * address over its hourly limit read the same. Verify fails ONE way, 400
 * `invalid_code`, for a wrong, expired, spent, locked or never-sent code.
 *
 * ── THE ACCOUNT IS BETTER AUTH'S ────────────────────────────────────────────
 * A first verify creates the user through Better Auth's internal adapter
 * (`internalAdapter.createUser`), the call its magic-link verifier makes, so
 * `databaseHooks.user.create` runs: `before` refuses a closed deploy's
 * non-admin (`closed-sign-in.ts`), `after` writes the profile
 * (`bootstrap-profile.ts`) — and so will any hook a later epic adds. Verified
 * on better-auth 1.6.26: `createWithHooks` awaits `create.before`, and outside
 * a transaction `queueAfterTransactionHook` runs `create.after` at once,
 * awaited. No session is created, so the session hook never runs; the closed
 * rule is therefore checked here too (`maySignIn`), before any mail and again
 * before any account or key.
 */
import { randomInt } from "node:crypto";

import {
  AGENT_CODE_DIGITS,
  AGENT_CODE_TTL_MINUTES,
  AGENT_RATE_LIMITS,
  API_KEY_LIMIT_MESSAGE,
  agentCodeRequestSchema,
  agentCodeVerifyResponseSchema,
  agentCodeVerifySchema,
  hashToken,
  type AgentCodeVerifyResponse,
  type KeyedError,
} from "@kept/shared";

import { auth } from "../auth";
import { maySignIn } from "../auth/closed-sign-in";
import { consumeAgentCode, upsertAgentCode } from "../db/queries/agent-codes";
import { emailFooter } from "../email/footer";
import { sendEmail } from "../email/send";
import { emailKey, hit, ipKey } from "../rate-limit";
import { appOrigin } from "../storage/env";

import { createKey } from "./keys";

type Failure = { ok: false; status: number; body: KeyedError };

export const CODE_SENT = { ok: true } as const;

export type RequestCodeOutcome = { ok: true; status: 202; body: typeof CODE_SENT } | Failure;
export type VerifyCodeOutcome = { ok: true; status: 200; body: AgentCodeVerifyResponse } | Failure;

const INVALID_CODE: Failure = {
  ok: false,
  status: 400,
  body: { error: "invalid_code", message: "That code is wrong or has expired. Ask for a new one." },
};

/** A uniform `AGENT_CODE_DIGITS`-digit code (`randomInt` rejects modulo bias). */
export function generateAgentCode(): string {
  return String(randomInt(0, 10 ** AGENT_CODE_DIGITS)).padStart(AGENT_CODE_DIGITS, "0");
}

async function sendCodeEmail(email: string, code: string, client: string | null): Promise<void> {
  const asker = client ? `An agent (${client})` : "An agent";
  await sendEmail((from) => ({
    to: email,
    subject: `Your kept code: ${code}`,
    text:
      `${asker} asked to sign in to kept as this address and create an API key.\n\n` +
      `Your code: ${code}\n\n` +
      `Tell it to the agent. It works once and expires in ${AGENT_CODE_TTL_MINUTES} minutes. ` +
      `If you didn't ask, ignore this.\n\n` +
      emailFooter({ from, origin: appOrigin() }).text,
  }));
}

/**
 * `POST /api/agent/request-code { email }`. Only the per-IP limit and a bad
 * body answer anything but the 202; a mail that fails to send is logged
 * (without the address or the code) and still answers 202.
 */
export async function requestAgentCode(
  raw: unknown,
  clientIp: string,
  client: string | null,
): Promise<RequestCodeOutcome> {
  const perIp = await hit(await ipKey("agent-code", clientIp), AGENT_RATE_LIMITS.agentCodePerIp);
  if (!perIp.allowed) {
    return {
      ok: false,
      status: 429,
      body: {
        error: "rate_limited",
        message: "Too many codes asked for, try again in a bit.",
        retry_after_seconds: perIp.retryAfterSeconds,
      },
    };
  }

  const parsed = agentCodeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, body: { error: "invalid_request", message: "Enter a valid email address." } };
  }
  const { email } = parsed.data;
  const sent = { ok: true, status: 202, body: CODE_SENT } as const;

  const perEmail = await hit(await emailKey("agent-code", email), AGENT_RATE_LIMITS.agentCodePerEmail);
  if (!perEmail.allowed || !maySignIn(email)) return sent;

  const code = generateAgentCode();
  await upsertAgentCode(email, await hashToken(code), client);
  try {
    await sendCodeEmail(email, code, client);
  } catch (err) {
    console.error(`[kept] agent code: mail failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  return sent;
}

/** The account's id for `email`, created through Better Auth if none exists, marked verified. */
async function accountFor(email: string): Promise<string> {
  const { internalAdapter } = await auth.$context;
  const found = await internalAdapter.findUserByEmail(email);
  if (found) {
    if (!found.user.emailVerified) await internalAdapter.updateUser(found.user.id, { emailVerified: true });
    return found.user.id;
  }
  const created = await internalAdapter.createUser({ email, name: "", emailVerified: true });
  if (!created) throw new Error("agent code: Better Auth created no user");
  return created.id;
}

/**
 * `POST /api/agent/verify-code { email, code, keyName }` → a new key, once.
 * The code is spent by the time an account or key is made, so a 409
 * `key_limit_reached` costs the agent a new code.
 */
export async function verifyAgentCode(raw: unknown): Promise<VerifyCodeOutcome> {
  const parsed = agentCodeVerifySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_request", message: "Send the email, the 6-digit code and a keyName (1 to 60 characters)." },
    };
  }
  const { email, code, keyName } = parsed.data;

  const consumed = await consumeAgentCode(email, await hashToken(code));
  // A code minted before the address left the allowlist must not outlive it.
  if (!consumed || !maySignIn(email)) return INVALID_CODE;

  const created = await createKey(await accountFor(email), keyName);
  if (!created) {
    return { ok: false, status: 409, body: { error: "key_limit_reached", message: API_KEY_LIMIT_MESSAGE } };
  }
  return {
    ok: true,
    status: 200,
    body: agentCodeVerifyResponseSchema.parse({ api_key: created.apiKey, key_name: created.summary.name }),
  };
}
