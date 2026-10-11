/**
 * A fresh client address for `lib/rate-limit`'s per-IP buckets (E06a §5).
 *
 * Every local request comes from one machine, so without this the magic-link
 * limit (5 an hour per IP) is shared by every drill in every run and the sixth
 * send of the hour fails for a reason no test is about. A drill sends it as
 * `CF-Connecting-IP` — the header `clientIp()` reads first — from the IPv6
 * documentation range (2001:db8::/32), so it can never be a real visitor.
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob.
 */
export function drillIp(): string {
  const group = () => Math.floor(Math.random() * 0x10000).toString(16);
  return `2001:db8:${group()}:${group()}::${group()}`;
}
