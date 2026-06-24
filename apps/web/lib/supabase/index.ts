// Supabase client surface. Import the browser client in Client Components and
// the server client in Server Components / Route Handlers / Server Actions.
export { createClient as createBrowserSupabaseClient } from "./client";
export { createClient as createServerSupabaseClient } from "./server";
export { getSupabaseEnv } from "./env";
