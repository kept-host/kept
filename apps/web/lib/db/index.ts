/**
 * Typed Drizzle client over Supabase Postgres (task 006).
 *
 * All Postgres data access goes through this client; the Supabase JS client is
 * retained only for Auth + Realtime.
 *
 * Runtime connection: `DATABASE_URL` is the Supabase connection-pooler URL
 * (Transaction mode, port 6543). Transaction pooling does NOT support prepared
 * statements, so `prepare: false` is required — see
 * https://orm.drizzle.team/docs/connect-supabase. Migrations use the session/
 * direct connection (port 5432) and are run by drizzle-kit, not this client
 * (see drizzle.config.ts).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Missing DATABASE_URL. Set the Supabase Postgres connection string (see apps/web/.env.example).",
    );
  }
  return url;
}

// Disable prefetch — not supported in Supabase "Transaction" pool mode.
const client = postgres(getDatabaseUrl(), { prepare: false });

export const db = drizzle(client, { schema });

export { schema };
