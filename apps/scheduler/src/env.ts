// @kept/scheduler — typed Worker environment. No bindings: the scheduler
// reaches the control plane over HTTPS and nothing else.

export interface Env {
  /** Control-plane origin the cron routes live on; full origin, no trailing slash. */
  KEPT_APP_ORIGIN: string;
  /** Comma-separated jobs this environment runs (`src/jobs.ts`). */
  CRON_JOBS: string;
  /** Bearer the cron routes check; a Worker secret, never a var. */
  CRON_SECRET: string;
}
