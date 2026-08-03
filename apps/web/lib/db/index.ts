/**
 * Typed Drizzle client over Neon Postgres.
 *
 * All Postgres data access goes through this client.
 *
 * Runtime connection: `DATABASE_URL` is the Neon *pooled* URL
 * (`ep-xxx-pooler.<region>.aws.neon.tech`), which is PgBouncer in transaction
 * mode. Transaction pooling does not support prepared statements, so
 * `prepare: false` is required.
 *
 * `idle_timeout` is functional, not cosmetic: Railway puts a service to sleep
 * only after 10 minutes with no *outbound* packets, and explicitly names a
 * held-open database pool as something that prevents sleeping. Letting idle
 * connections close is what makes Serverless on the dev environment actually
 * save money. It also lets Neon's own scale-to-zero (5 min idle) kick in.
 *
 * Migrations use the *direct* (non-pooled) URL and are run by drizzle-kit, not
 * this client — see drizzle.config.ts.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Missing DATABASE_URL. Set the Neon pooled connection string (see apps/web/.env.example).",
    );
  }
  return url;
}

const client = postgres(getDatabaseUrl(), {
  // Not supported by PgBouncer transaction mode (Neon's pooled endpoint).
  prepare: false,
  max: 5,
  idle_timeout: 30,
});

export const db = drizzle(client, { schema });

export { schema };
