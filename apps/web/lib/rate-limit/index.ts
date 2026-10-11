/**
 * Fixed-window rate limiting on Postgres (E06a D4; E07 reuses it).
 *
 * WHY POSTGRES. The control plane may run as more than one Railway instance, so
 * an in-memory counter undercounts; Cloudflare's rate limiting can't cover
 * `app.`, which is DNS-only. Neon is already on every request path that needs a
 * limit, and one upsert per hit is cheap at waitlist volumes.
 *
 * BUCKETS NEVER HOLD AN IDENTITY. A bucket is `route:sha256(...)`: an IP is
 * hashed with a salt that changes every UTC day, so a bucket can't be linked to
 * an address or to the same address yesterday; an email is hashed plainly
 * (the per-email cap must hold across days). Global caps use a fixed bucket.
 */
import { createHmac } from "node:crypto";

import { hashToken, RATE_LIMIT_RETENTION_DAYS, type RateLimitRule } from "@kept/shared";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { rateLimitSecret } from "../storage/env";

export { clientIp } from "./client-ip";

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** HMAC-SHA256(`RATE_LIMIT_SECRET`, UTC `YYYY-MM-DD`), hex. */
function dailySalt(now: Date): string {
  return createHmac("sha256", rateLimitSecret())
    .update(now.toISOString().slice(0, 10))
    .digest("hex");
}

/** `route:sha256(ip + dailySalt)` — the per-IP bucket for today (UTC). */
export async function ipKey(route: string, ip: string, now: Date = new Date()): Promise<string> {
  return `${route}:${await hashToken(ip + dailySalt(now))}`;
}

/** `route:sha256(email)` — the per-address bucket. Pass the normalised address. */
export async function emailKey(route: string, email: string): Promise<string> {
  return `${route}:${await hashToken(email)}`;
}

/**
 * Count one hit against `bucket` and say whether it is within `rule`.
 *
 * One atomic upsert: concurrent hits serialise on the row, so the count is
 * exact. The window is aligned to the database clock (`floor(epoch / window)`),
 * so every instance agrees on it, and `retryAfterSeconds` is the time left in
 * that window — what a `Retry-After` header carries.
 */
export async function hit(bucket: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const { limit, windowSeconds } = rule;
  const rows = await db.execute<{ count: number; retry_after: number }>(sql`
    insert into rate_limits (bucket, window_start, count)
    values (
      ${bucket},
      to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}),
      1
    )
    on conflict (bucket, window_start) do update set count = rate_limits.count + 1
    returning
      count,
      greatest(
        1,
        ceil(extract(epoch from window_start) + ${windowSeconds} - extract(epoch from now()))
      )::int as retry_after
  `);
  const row = rows[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  return row.count <= limit
    ? { allowed: true }
    : { allowed: false, retryAfterSeconds: row.retry_after };
}

/**
 * Whether `bucket` is already full in the current window, WITHOUT counting a
 * hit. For a cap that must be checked before the caller knows whether it will
 * spend from it — the waitlist's global confirmation-mail cap is checked before
 * the row's state is read (so the 429 says nothing about the address) and
 * `hit` only when a mail is actually sent.
 */
export async function peek(bucket: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const { limit, windowSeconds } = rule;
  const rows = await db.execute<{ count: number; retry_after: number }>(sql`
    select
      count,
      greatest(
        1,
        ceil(extract(epoch from window_start) + ${windowSeconds} - extract(epoch from now()))
      )::int as retry_after
    from rate_limits
    where bucket = ${bucket}
      and window_start = to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds})
  `);
  const row = rows[0];
  return !row || row.count < limit
    ? { allowed: true }
    : { allowed: false, retryAfterSeconds: row.retry_after };
}

/** Delete buckets older than `RATE_LIMIT_RETENTION_DAYS`; returns how many. */
export async function pruneBuckets(): Promise<number> {
  const rows = await db.execute(sql`
    delete from rate_limits
    where window_start < now() - make_interval(days => ${RATE_LIMIT_RETENTION_DAYS})
    returning 1
  `);
  return rows.length;
}
