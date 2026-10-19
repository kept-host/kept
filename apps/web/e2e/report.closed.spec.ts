import { reportFlow } from "./report-flow";

/**
 * Reports on a CLOSED deploy (E07 edge case 16, AC15): `/report` and
 * `POST /api/reports` pass the closed gate. Run with
 * `pnpm --filter @kept/web test:e2e:closed`. The flow is `report-flow.ts`.
 */
reportFlow("closed");
