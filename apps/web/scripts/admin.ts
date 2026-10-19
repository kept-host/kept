/**
 * The admin CLI's entry (E06a §9, task 009). All logic is `lib/admin/cli.ts`;
 * this loads apps/web/.env.local like every script here, runs one command and
 * closes the pool so the process exits.
 *
 *   pnpm --filter @kept/web admin:token new
 *   pnpm --filter @kept/web admin:founding add <email> <socialUrl> [--note …]
 *   pnpm --filter @kept/web admin:waitlist stats | export [--confirmed] [--founding approved]
 *   pnpm --filter @kept/web admin:scan --unscanned | --all-live --dry-run|--apply [--limit <n>]
 */
import { config } from "dotenv";

import { runAdmin } from "../lib/admin/cli";
import { closeDb } from "../lib/db";

config({ path: ".env.local", quiet: true });

runAdmin(process.argv.slice(2), {
  out: (line) => console.log(line),
  info: (line) => console.error(line),
})
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
