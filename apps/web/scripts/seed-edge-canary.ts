/**
 * Seed (or remove) the edge serve canary — E03 task 009.
 *
 * Writes by hand what the control plane will write once E04 exists: the page
 * object in R2, the slug pointer, and the KV manifest. `smoke-release.ts` then
 * asserts the Worker serves it. Run it once per environment; re-running is
 * idempotent and rewrites identical bytes.
 *
 *   pnpm --filter @kept/web seed:canary --edge-url https://{slug}.{base-domain}
 *   pnpm --filter @kept/web seed:canary --status quarantined   # flip the status
 *   pnpm --filter @kept/web seed:canary --remove               # tear it down
 *
 * The target comes from `--edge-url` / `SMOKE_EDGE_URL` — the same value the
 * smoke probes — and store credentials from `R2_*` / `KV_NAMESPACE_ID` /
 * `CLOUDFLARE_API_TOKEN`. No hostname literal, no `if (env === "prod")` fork.
 *
 * WRITE ORDER IS NOT ARBITRARY. `docs/edge-purge-contract.md` §7.3: object →
 * pointer → KV on write, pointer → KV → object on removal. The pointer must
 * never be staler than KV, or a KV miss resurrects a page that was changed or
 * deleted.
 *
 * This script USED to be the reference implementation of that ordering; E04
 * task 004 turned it into a caller. `lib/storage/manifest.ts` now owns the
 * sequence — pointer → KV → purge, and its inverse — and the seeder writes only
 * the page object around it. Two implementations of an ordering rule is exactly
 * the drift that made this refactor mandatory.
 *
 * It therefore now DOES purge the slug's URL forms (§4/§5), because the helper
 * does. A purge failure is logged and never fatal; the KV `cacheTtl` floor of §6
 * still applies on top of a successful one.
 */
import { config } from "dotenv";

import { MANIFEST_STATUSES, type ManifestStatus } from "@kept/shared";

import {
  pointerKey,
  removeManifest,
  writeManifest,
  type ManifestRemoveResult,
  type ManifestWriteResult,
} from "../lib/storage/manifest";
import { readOption, requireUrl } from "./lib/cli-args";
import {
  canaryHtml,
  canaryManifest,
  canaryObjectKey,
  canarySlug,
  CANARY_CONTENT_TYPE,
} from "./lib/edge-canary";
import { r2Store } from "./lib/smoke-stores";

config({ path: ".env.local" });

function readStatus(): ManifestStatus {
  const raw = readOption("status", "CANARY_STATUS") ?? "live";
  if (!(MANIFEST_STATUSES as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown --status "${raw}". Expected one of: ${MANIFEST_STATUSES.join(", ")}.`,
    );
  }
  return raw as ManifestStatus;
}

/** A failed pointer or KV step is fatal to a seed; a failed purge never is. */
function purgeOutcome(
  result: ManifestWriteResult | ManifestRemoveResult,
  action: string,
): string {
  if (!result.ok) {
    throw new Error(`${action} failed at the "${result.step}" step — ${result.error}`);
  }
  return result.purge.ok
    ? "      purged      both URL forms"
    : `      purge FAILED (non-fatal) — ${result.purge.error}`;
}

async function main(): Promise<void> {
  const edgeUrl = requireUrl("edge-url", "SMOKE_EDGE_URL");
  const slug = canarySlug(edgeUrl);
  const remove = process.argv.includes("--remove");

  const r2 = r2Store();
  const objectKey = canaryObjectKey();

  console.log("kept · edge serve canary\n");
  console.log(`      slug:   ${slug}`);
  console.log(`      bucket: ${r2.bucket}\n`);

  if (remove) {
    // Pointer → KV → purge, then the object. Manifest first: while the object
    // is still there a stale pointer would keep serving it (contract §7.3).
    const removed = purgeOutcome(await removeManifest(slug), "canary removal");
    console.log(`      deleted R2  ${pointerKey(slug)}`);
    console.log(`      deleted KV  ${slug}`);
    console.log(removed);
    await r2.delete(objectKey);
    console.log(`      deleted R2  ${objectKey}`);
    console.log("\nCANARY REMOVED");
    return;
  }

  const status = readStatus();

  await r2.put(objectKey, canaryHtml(slug), CANARY_CONTENT_TYPE);
  console.log(`      wrote R2    ${objectKey}`);
  const seeded = purgeOutcome(await writeManifest(slug, canaryManifest(status)), "canary seed");
  console.log(`      wrote R2    ${pointerKey(slug)}`);
  console.log(`      wrote KV    ${slug}  (status=${status})`);
  console.log(seeded);

  console.log(`\nCANARY SEEDED — ${edgeUrl}`);
}

main().catch((err: unknown) => {
  console.error(`SEED FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
