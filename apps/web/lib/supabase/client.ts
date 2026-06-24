import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseEnv } from "./env";

/**
 * Supabase browser client — for Client Components (frontend-specs §8).
 * Used for Auth (E2) and Realtime subscriptions (live counter / gauge).
 */
export function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
