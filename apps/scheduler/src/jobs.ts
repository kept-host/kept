// @kept/scheduler — which `/api/cron/<job>` routes are due at a given minute.
//
// Each entry is the job's old GitHub crontab, as a predicate on the UTC hour
// and minute. The 12-minute jobs are offset (:03 and :07) so they never share a
// tick; the dailies sit at quiet minutes between 03:00 and 09:00 UTC.

type Due = (hour: number, minute: number) => boolean;

const SCHEDULE = {
  "scan-retry": (_h, m) => m % 12 === 3, // 3-59/12 * * * *
  repurge: (_h, m) => m % 12 === 7, // 7-59/12 * * * *
  expire: (_h, m) => m === 23, // 23 * * * *
  "visits-sync": (h, m) => h === 3 && m === 17, // 17 3 * * *
  "waitlist-prune": (h, m) => h === 4 && m === 41, // 41 4 * * *
  purge: (h, m) => h === 5 && m === 29, // 29 5 * * *
  "draft-reminder": (h, m) => h === 9 && m === 0, // 0 9 * * *
} satisfies Record<string, Due>;

export type CronJob = keyof typeof SCHEDULE;

function isCronJob(name: string): name is CronJob {
  return Object.hasOwn(SCHEDULE, name);
}

/** Parses `CRON_JOBS` ("repurge,expire"); an unknown name throws. */
export function parseCronJobs(value: string): CronJob[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of names) {
    if (!isCronJob(name)) throw new Error(`CRON_JOBS names an unknown job: "${name}"`);
  }
  return [...new Set(names as CronJob[])];
}

/** The enabled jobs due in the UTC minute containing `scheduledTime` (epoch ms). */
export function dueJobs(scheduledTime: number, enabled: readonly CronJob[]): CronJob[] {
  const at = new Date(scheduledTime);
  const hour = at.getUTCHours();
  const minute = at.getUTCMinutes();
  return enabled.filter((job) => SCHEDULE[job](hour, minute));
}
