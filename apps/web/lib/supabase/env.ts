/**
 * Supabase environment contract (frontend-specs §8).
 *
 * Required, public (safe to expose to the browser):
 *   NEXT_PUBLIC_SUPABASE_URL       — project URL, e.g. https://<ref>.supabase.co
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY  — anon/publishable key
 *
 * Auth flows (GitHub OAuth + email magic link) land in E2; the service-role key
 * and DB connection string (Drizzle) arrive with task 006. This module only
 * resolves the two values both client kinds need.
 */
export function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see apps/web/.env.example).",
    );
  }

  return { url, anonKey };
}
