// Types the `env` that `cloudflare:test` hands the suite as the Worker's own
// `Env`, so a binding rename in `src/env.ts` breaks the tests at typecheck
// rather than at runtime.
//
// `cloudflare:test` types its `env` as `Cloudflare.Env` (the namespace
// `wrangler types` generates), so the augmentation goes there rather than on the
// older `ProvidedEnv` interface.

import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}
  }
}

export {};
