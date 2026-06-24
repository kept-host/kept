import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { getSupabaseEnv } from "./env";

/**
 * Supabase server client — for Server Components, Route Handlers, and Server
 * Actions (frontend-specs §8). Reads/writes auth cookies via next/headers so
 * the session is available during RSC reads. The setAll try/catch is the
 * documented no-op for Server Component contexts where cookies are read-only;
 * middleware (E2) refreshes the session there.
 */
export async function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component — cookies are read-only here.
          // Session refresh happens in middleware (E2).
        }
      },
    },
  });
}
