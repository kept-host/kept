/**
 * The client address `lib/rate-limit` keys its per-IP buckets on (E06a §5).
 *
 * The apex is proxied by Cloudflare, which sets `CF-Connecting-IP`; `app.` is
 * DNS-only, so there the address is whatever Railway forwards. A caller can
 * forge either header on `app.` — that only gets round the per-IP limits; the
 * per-email and global caps still hold (PRD §5).
 *
 * The raw address is hashed by `ipKey` and dropped: never stored, never logged.
 */
import { forwardedIp } from "../publish/http";

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || forwardedIp(request);
}
