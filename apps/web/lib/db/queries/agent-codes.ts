/**
 * Every SQL statement about agent sign-in codes (E09 D7) — the only module that
 * reads or writes `agent_codes`.
 *
 * Only a code's SHA-256 reaches this module. One live code per address: a new
 * request replaces it, a correct verify consumes it, `AGENT_CODE_MAX_ATTEMPTS`
 * tries kill it, `AGENT_CODE_TTL_MINUTES` expires it.
 */
import { AGENT_CODE_MAX_ATTEMPTS, AGENT_CODE_TTL_MINUTES } from "@kept/shared";
import { sql } from "drizzle-orm";

import { db } from "../index";
import { agentCodes } from "../schema";

const MAX_ATTEMPTS = sql.raw(String(AGENT_CODE_MAX_ATTEMPTS));

/** Store a fresh code for the address, replacing any earlier one and its tries. */
export async function upsertAgentCode(
  email: string,
  codeHash: string,
  client: string | null
): Promise<void> {
  const expiresAt = sql`now() + make_interval(mins => ${AGENT_CODE_TTL_MINUTES})`;
  await db
    .insert(agentCodes)
    .values({ email, codeHash, expiresAt, client })
    .onConflictDoUpdate({
      target: agentCodes.email,
      set: { codeHash, expiresAt, attempts: 0, client },
    });
}

/**
 * Try a code, in one statement. A match on a live code with tries left deletes
 * the row (single use) and returns its `client`; anything else counts a try
 * against a live code and returns `null`. After `AGENT_CODE_MAX_ATTEMPTS` wrong
 * tries the right code is refused too, until a new one is requested.
 *
 * Concurrent tries serialise on the row lock, and each re-reads `attempts`
 * after the wait, so neither the cap nor single use can be raced.
 */
export async function consumeAgentCode(
  email: string,
  codeHash: string
): Promise<{ client: string | null } | null> {
  const live = sql`email = ${email} and expires_at > now() and attempts < ${MAX_ATTEMPTS}`;
  const [row] = await db.execute<{ client: string | null }>(sql`
    with consumed as (
      delete from ${agentCodes}
      where ${live} and code_hash = ${codeHash}
      returning client
    ), tried as (
      update ${agentCodes} set attempts = attempts + 1
      where ${live} and not exists (select 1 from consumed)
    )
    select client from consumed
  `);
  return row ? { client: row.client } : null;
}
