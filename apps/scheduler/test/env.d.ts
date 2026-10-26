// Types the `env` that `cloudflare:test` hands the suite as the Worker's own `Env`.

import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}
  }
}

export {};
