/**
 * Who may wear the minimal badge (E10 D3, Q19). `badge_style = 'minimal'` is a
 * Pro choice: a profile that chose it and is no longer Pro gets `standard` from
 * the sync (`lib/badge/badge-data.ts`), with no write to the profile. E11 swaps
 * the body for its entitlements; every caller asks this one function.
 */
import type { Plan } from "@kept/shared";

export function mayUseMinimalBadge(plan: Plan): boolean {
  return plan === "premium";
}
