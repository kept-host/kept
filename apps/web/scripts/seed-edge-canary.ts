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
 * deleted. This script is the reference implementation of that ordering.
 *
 * It does NOT purge the edge cache — that is the control plane's job (contract
 * §5), and E03 code never calls `purge_cache`. After a re-seed that changes the
 * status or the bytes, purge the slug's URL forms yourself per §4, and expect
 * the KV `cacheTtl` floor of §6 on top of it.
 */
import { config } from "dotenv";

import { MANIFEST_STATUSES, type ManifestStatus } from "@kept/shared";

import { readOption, requireUrl } from "./lib/cli-args";
import {
  canaryHtml,
  canaryManifest,
  canaryObjectKey,
  canaryPointerKey,
  canarySlug,
  CANARY_CONTENT_TYPE,
} from "./lib/edge-canary";
import { kvStore, r2Store } from "./lib/smoke-stores";

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

async function main(): Promise<void> {
  const edgeUrl = requireUrl("edge-url", "SMOKE_EDGE_URL");
  const slug = canarySlug(edgeUrl);
  const remove = process.argv.includes("--remove");

  const r2 = r2Store();
  const kv = kvStore();
  const objectKey = canaryObjectKey();
  const pointerKey = canaryPointerKey(slug);

  console.log("kept · edge serve canary\n");
  console.log(`      slug:   ${slug}`);
  console.log(`      bucket: ${r2.bucket}`);
  console.log(`      kv ns:  ${kv.namespaceId.slice(0, 6)}…\n`);

  if (remove) {
    // Reverse of the write order: pointer first, then KV, then the object.
    await r2.delete(pointerKey);
    console.log(`      deleted R2  ${pointerKey}`);
    await kv.delete(slug);
    console.log(`      deleted KV  ${slug}`);
    await r2.delete(objectKey);
    console.log(`      deleted R2  ${objectKey}`);
    console.log("\nCANARY REMOVED — purge the slug's URL forms (contract §4).");
    return;
  }

  const status = readStatus();
  const manifest = canaryManifest(status);
  const value = JSON.stringify(manifest);

  await r2.put(objectKey, canaryHtml(slug), CANARY_CONTENT_TYPE);
  console.log(`      wrote R2    ${objectKey}`);
  await r2.put(pointerKey, value, "application/json");
  console.log(`      wrote R2    ${pointerKey}`);
  await kv.put(slug, value, "application/json");
  console.log(`      wrote KV    ${slug}  (status=${status})`);

  console.log(`\nCANARY SEEDED — ${edgeUrl}`);
  console.log("      purge the slug's URL forms if it was already cached (contract §4).");
}

main().catch((err: unknown) => {
  console.error(`SEED FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
