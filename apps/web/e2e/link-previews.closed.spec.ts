import { linkPreviewsFlow } from "./link-previews";

/**
 * Link previews and favicons on a CLOSED deploy (E06a §8). Run with
 * `pnpm --filter @kept/web test:e2e:closed`. The flow is `link-previews.ts`.
 */
linkPreviewsFlow("closed");
