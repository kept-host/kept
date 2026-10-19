/**
 * The `expire` and `purge` jobs for the epic drill (E07 task 012), fenced to the
 * drill's own pages, run in a child process.
 *
 * WHY FENCED: the cron routes sweep the whole dev database by design, and a
 * drill that called them while the rest of the suite runs would expire or purge
 * other specs' fixtures. So the drill runs the jobs' own sweeps — `expireDue` /
 * `purgeDue`, the code the routes run under `withJobRun` — scoped to the site
 * ids it passes (the same fence `lib/lifecycle/lifecycle.test.ts` uses). The
 * routes themselves are called once, unscoped, by task 012's AC32 check.
 *
 * WHY A CHILD PROCESS: both reach `lib/publish/pipeline.ts`, whose hooks import
 * `next/server`, which Playwright's ESM loader cannot resolve and `tsx` can —
 * the reason `./appeal-decision.ts` runs this way too.
 *
 * AN EXPIRE WAITS FOR ITS SECOND PURGE before the process exits, as the
 * long-lived server it stands in for would: the delayed re-purge is an
 * in-process timer, and a drill that probes the edge for the 410 before it
 * lands can re-cache the page's last 200 from a stale KV read (the "will bite
 * you" list in `.agent/System/06-edge-and-infrastructure.md`). A purge does not
 * wait: nothing probes a purged page.
 *
 *   tsx e2e/lifecycle-sweep.ts <expire|purge> <siteId>...
 *
 * Prints the job's counts as JSON on its last line. Not a spec: no `.spec.ts`.
 */
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
/** Past the re-purge timer: long enough for its Cloudflare call to return. */
const SECOND_PURGE_SLACK_MS = 5_000;

/** Run `job` over exactly `siteIds`; the job's counts. */
export async function sweep(job: "expire" | "purge", siteIds: string[]): Promise<Record<string, number>> {
  const { stdout } = await promisify(execFile)("pnpm", ["exec", "tsx", SELF, job, ...siteIds], {
    cwd: APP_ROOT,
    encoding: "utf8",
  });
  const last = stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(last) as Record<string, number>;
}

async function main(argv: string[]): Promise<void> {
  const [job, ...siteIds] = argv;
  if ((job !== "expire" && job !== "purge") || siteIds.length === 0) {
    throw new Error("usage: tsx e2e/lifecycle-sweep.ts <expire|purge> <siteId>...");
  }
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  const { closeDb } = await import("../lib/db");
  try {
    if (job === "expire") {
      const counts = await (await import("../lib/lifecycle/expire")).expireDue(siteIds);
      if (counts.expired > 0) {
        const { KV_REPURGE_DELAY_MS } = await import("../lib/storage/manifest");
        await sleep(KV_REPURGE_DELAY_MS + SECOND_PURGE_SLACK_MS);
      }
      process.stdout.write(`\n${JSON.stringify(counts)}\n`);
    } else {
      const counts = await (await import("../lib/lifecycle/purge")).purgeDue(siteIds);
      process.stdout.write(`\n${JSON.stringify(counts)}\n`);
    }
  } finally {
    await closeDb();
  }
}

if (process.argv[1] === SELF) await main(process.argv.slice(2));
