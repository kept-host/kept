// @kept/scheduler — once a minute, POST each due cron route (D-88).
//
// Every job is idempotent and loops internally until nothing is due or
// `JOB_DEADLINE_SECONDS` (50 s) runs out, so one call per due tick is the whole
// contract. A 502/503/504 is retried (dev Railway sleeps, and its first request
// can 502 while it wakes); anything else is logged and fails the invocation, so
// it shows as an error in the Worker's cron events and Workers Logs.

import type { Env } from "./env";
import { dueJobs, parseCronJobs, type CronJob } from "./jobs";

/** Per attempt. A job answers within ~60 s; worst case stays inside the 15 min limit. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Waits before the 2nd and 3rd attempt. */
const RETRY_DELAYS_MS = [10_000, 30_000];
const RETRY_STATUSES = new Set([502, 503, 504]);
const LOGGED_BODY_CHARS = 500;

async function runJob(env: Env, job: CronJob): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${env.KEPT_APP_ORIGIN}/api/cron/${job}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.text()).slice(0, LOGGED_BODY_CHARS);
    if (response.ok) {
      console.log(`${job}: ${response.status} ${body}`);
      return;
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (!RETRY_STATUSES.has(response.status) || delay === undefined) {
      throw new Error(`${job}: ${response.status} ${body}`);
    }
    console.warn(`${job}: ${response.status}, retrying in ${delay / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

export default {
  async scheduled(controller, env) {
    const due = dueJobs(controller.scheduledTime, parseCronJobs(env.CRON_JOBS));
    if (due.length === 0) return;
    if (!env.CRON_SECRET) throw new Error("CRON_SECRET is not set");

    const results = await Promise.allSettled(due.map((job) => runJob(env, job)));
    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    if (failures.length > 0) throw new Error(failures.join("; "));
  },
} satisfies ExportedHandler<Env>;
