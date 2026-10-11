import { foundingFlow } from "./founding-flow";

/**
 * Founding applications on a CLOSED deploy (E06a §4): `/founding*` and
 * `/api/founding/review` pass the closed gate. Run with
 * `pnpm --filter @kept/web test:e2e:closed`. The flow is `founding-flow.ts`.
 */
foundingFlow("closed");
