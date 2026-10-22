/**
 * E08 task 010 — the studio's choice of door for a drop (`owner-upload.ts`),
 * the parts that need no browser: the plan's size pre-flight, and the inline
 * branch of `prepareOwnedBody` (pack → `archive`). The presigned branch PUTs
 * with `XMLHttpRequest`, which Node does not have; it is exercised in the
 * browser by `e2e/studio-multi-file.spec.ts` once the dev bucket's CORS rule
 * exists (epic Human step 2).
 *
 * Real `File`s and the real packer; no store, no request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { limitsFor } from "@kept/shared";

import { siteTooLarge } from "../publish/fileset/copy";
import type { UploadIntent } from "../publish/pack";
import { checkUpload, prepareOwnedBody, progressNotice, type UploadProgress } from "./owner-upload";

const page = (name: string, body: string) => new File([body], name, { type: "text/html" });

function set(bytes: number): UploadIntent {
  return {
    kind: "files",
    label: "dist",
    entries: [
      { path: "dist/index.html", file: page("index.html", "<!doctype html><title>big</title>") },
      { path: "dist/big.bin", file: new File([new Uint8Array(bytes)], "big.bin") },
    ],
  };
}

test("checkUpload: a set past the plan's siteBytes is site_too_large with §8's sentence — locked on Free only", () => {
  const free = limitsFor("free").siteBytes;
  const over = set(free + 1);
  const total = free + 1 + 33;

  const refused = checkUpload(over, "free");
  console.log("[owner-upload] free refusal:", refused?.error.message, "locked:", refused?.locked);
  assert.deepEqual(refused, {
    error: { code: "site_too_large", message: siteTooLarge(total, "free", free) },
    locked: true,
  });

  // The same set is within Premium's cap: no pre-flight refusal (it goes presigned).
  assert.equal(checkUpload(over, "premium"), null);

  const premium = limitsFor("premium").siteBytes;
  const premiumOver = checkUpload(set(premium + 1), "premium");
  assert.equal(premiumOver?.error.code, "site_too_large");
  assert.equal(premiumOver?.locked, false, "Premium has no Pro to upsell");
});

test("checkUpload passes a single page and a dropped .zip — those are checkPageFile's and the server's", () => {
  const html: UploadIntent = { kind: "html", file: page("a.html", "<p>a"), label: "a.html" };
  const zip: UploadIntent = { kind: "zip", file: new File([new Uint8Array(8)], "a.zip"), label: "a.zip" };
  assert.equal(checkUpload(html, "free"), null);
  assert.equal(checkUpload(zip, "free"), null);
});

test("prepareOwnedBody: a page is { html, spa }; a small set is packed into one inline archive, with progress", async () => {
  const markup = "<!doctype html><title>one</title><h1>one</h1>";
  const single = await prepareOwnedBody(
    { kind: "html", file: page("one.html", markup), label: "one.html" },
    { plan: "free", spa: true, onProgress: () => assert.fail("a page is not packed") },
  );
  assert.deepEqual(single, { ok: true, body: { html: markup, spa: true } });

  const seen: UploadProgress[] = [];
  const packed = await prepareOwnedBody(set(1024), { plan: "free", spa: false, onProgress: (p) => seen.push(p) });
  assert.ok(packed.ok && "archive" in packed.body, JSON.stringify(packed));
  assert.equal(packed.body.spa, false);
  assert.ok(packed.body.archive.size > 1024);
  console.log("[owner-upload] progress:", seen.map(progressNotice), seen.map((p) => p.fraction));
  assert.equal(progressNotice(seen[0]!), "Packing 2 files…");
  assert.equal(seen.at(-1)!.fraction, 1);
  assert.ok(seen.every((p) => p.phase === "packing"), "an inline set never uploads");
});

test("prepareOwnedBody refuses a Free set past siteBytes before packing a byte", async () => {
  const outcome = await prepareOwnedBody(set(limitsFor("free").siteBytes), {
    plan: "free",
    spa: false,
    onProgress: () => assert.fail("nothing is packed for a refused set"),
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.error.code === "site_too_large" && outcome.locked);
});

test("progressNotice: §8's two lines", () => {
  assert.equal(progressNotice({ phase: "packing", files: 1, fraction: 0 }), "Packing 1 file…");
  assert.equal(progressNotice({ phase: "uploading", bytes: 12 * 1024 * 1024, fraction: 0.5 }), "Uploading 12.0 MB…");
});
