import { epicDrill } from "./epic-drill";

/**
 * The E07 epic drill on a CLOSED deploy (task 012): keyless publishing with the
 * run's access token, `/report` reaching the admin, the admin screen. Run with
 * `pnpm --filter @kept/web test:e2e:closed`. The flow is `epic-drill.ts`.
 */
epicDrill("closed");
