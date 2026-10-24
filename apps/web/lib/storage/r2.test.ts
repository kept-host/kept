/**
 * `R2Store` primitives E08 adds — binary `put`, `siteObjectKey`, `deleteMany`.
 * E08-multi-file-sites task 002.
 *
 * NO MOCKS (project rule): real dev R2 over the S3 API. R2 only — no KV write,
 * no purge, so no KV quota is spent. Every scratch key lives under
 * `sites/e08-test-{uuid}/` and is deleted by the tests themselves (`after`
 * sweeps whatever a failed assertion left behind).
 *
 * SKIPS without R2 credentials (CI on fork PRs has no secrets). Run with
 *
 *   pnpm --filter @kept/web exec tsx --test lib/storage/r2.test.ts
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_AUTO"] as const;
const missing = R2_VARS.filter((name) => !process.env[name]?.trim());
const skip: string | false =
  missing.length > 0
    ? `R2 credentials absent (${missing.join(", ")}) — run locally with apps/web/.env.local`
    : false;

const scratchSite = `e08-test-${crypto.randomUUID()}`;
const written = new Set<string>();

async function store() {
  const { r2Store } = await import("./r2");
  return r2Store();
}

after(async () => {
  if (skip || written.size === 0) return;
  await (await store()).deleteMany([...written]);
});

test("siteObjectKey spells the layout; pageObjectKey is its index.html", async () => {
  const { pageObjectKey, siteObjectKey } = await import("./r2");
  assert.equal(siteObjectKey("s", "v", "assets/app.js"), "sites/s/v/assets/app.js");
  assert.equal(pageObjectKey("s", "v"), "sites/s/v/index.html");
  assert.equal(pageObjectKey("s", "v"), siteObjectKey("s", "v", "index.html"));
});

test("put stores a Uint8Array byte-for-byte, including non-UTF-8 bytes", { skip }, async () => {
  const { siteObjectKey } = await import("./r2");
  const r2 = await store();
  const key = siteObjectKey(scratchSite, "binary", "img/raw.bin");
  // Lone continuation bytes, an overlong lead, 0xFE/0xFF and NUL: invalid UTF-8.
  const bytes = new Uint8Array([0x00, 0x80, 0xbf, 0xc0, 0xc1, 0xfe, 0xff, 0xe2, 0x28, 0xa1, 0x89, 0x50, 0x4e, 0x47]);
  written.add(key);
  await r2.put(key, bytes, "application/octet-stream");

  const stream = await r2.getStream(key);
  assert.ok(stream, "the object exists");
  const back = new Uint8Array(await new Response(stream).arrayBuffer());
  assert.deepEqual(back, bytes, "read back byte-equal");

  await r2.deleteMany([key]);
  assert.equal(await r2.get(key), null, "deleteMany removed it");
  written.delete(key);
});

test(
  "deleteMany over 1,203 keys (two requests) leaves none; a never-written key is not an error",
  { skip },
  async () => {
    const { siteObjectKey } = await import("./r2");
    const r2 = await store();
    const keys = Array.from({ length: 1203 }, (_, i) =>
      siteObjectKey(scratchSite, "batch", `f/${String(i).padStart(4, "0")}&<'x'>.txt`),
    );
    // Bounded concurrency: 1,203 PUTs without opening 1,203 sockets at once.
    for (let i = 0; i < keys.length; i += 50) {
      await Promise.all(
        keys.slice(i, i + 50).map(async (key) => {
          written.add(key);
          await r2.put(key, `scratch ${key}`, "text/plain; charset=utf-8");
        }),
      );
    }
    const neverWritten = siteObjectKey(scratchSite, "batch", "never-written.txt");

    await r2.deleteMany([...keys, neverWritten]);
    for (const key of keys) written.delete(key);

    // Spot-check across both requests (first, the 1,000/1,001 boundary, last)
    // rather than 1,203 GETs.
    for (const index of [0, 1, 499, 999, 1000, 1001, 1202]) {
      assert.equal(await r2.get(keys[index]!), null, `key ${index} is gone`);
    }
  },
);

test("deleteMany([]) sends nothing and resolves", { skip }, async () => {
  await (await store()).deleteMany([]);
});
