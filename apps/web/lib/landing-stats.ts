// Open-books figures the landing (and /stats) quote. One module, one set of
// numbers — no page may hardcode its own.
//
// Pre-launch zero baseline: nothing has been deployed yet, so there is nothing
// to report. Zero is the honest answer and must render as zero; `uptime` is
// `null` because no measurement window exists — it must never render as 100%.

/** Pages kept forever, right now. TODO(E09): replaced by a live snapshot from /stats. */
export const keptCount = 0;

/** Infrastructure spend this month, in EUR. TODO(E09): replaced by a live snapshot from /stats. */
export const infraCostMonth = 0;

/** Uptime percent, or `null` when not yet measured. TODO(E09): replaced by a live snapshot from /stats. */
export const uptime: number | null = null;
