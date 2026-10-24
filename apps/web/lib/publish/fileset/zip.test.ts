/**
 * E08 task 003 — the bounded zip reader (D6, AC12) over real archives on disk:
 * well-formed ones from `client-zip`, hostile ones byte-built by
 * `lib/testing/zip-fixture.ts`. Touches no store.
 *
 * These call `readZipFile` on fixtures this file writes to its own temp
 * directory (`kept-zipfixture-*`, removed in `after`), so the reader's own
 * `kept-fileset-*` spool count — asserted in `read.test.ts` — is never raced.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { limitsFor } from "@kept/shared";
import { downloadZip } from "client-zip";

import { buildZip, type FixtureEntry } from "../../testing/zip-fixture";
import type { PublishFailure } from "../pipeline";
import { isFailure, type RawFile } from "./types";
import { MAX_COMPRESSION_RATIO, readZipFile } from "./zip";

const dir = mkdtempSync(join(tmpdir(), "kept-zipfixture-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let fixtures = 0;
function onDisk(bytes: Uint8Array): string {
  const path = join(dir, `${++fixtures}.zip`);
  writeFileSync(path, bytes);
  return path;
}

async function clientZip(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const response = downloadZip(
    Object.entries(entries).map(([name, input]) => ({ name, input, lastModified: new Date(0) })),
  );
  return new Uint8Array(await response.arrayBuffer());
}

function ok(result: RawFile[] | PublishFailure): RawFile[] {
  if (isFailure(result)) assert.fail(`expected files, got ${JSON.stringify(result.body)}`);
  return result;
}

function refused(result: RawFile[] | PublishFailure, code: string): string {
  if (!isFailure(result)) assert.fail(`expected ${code}, got ${result.map((f) => f.path).join(", ")}`);
  assert.equal(result.body.error, code, result.body.message);
  return result.body.message;
}

const hostile = async (entries: FixtureEntry[]) => readZipFile(onDisk(buildZip(entries)), "free");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("a client-zip archive reads back, in archive order, byte for byte", async () => {
  const png = randomBytes(300);
  const files = ok(
    await readZipFile(
      onDisk(await clientZip({ "index.html": "<h1>hi</h1>", "assets/app.js": "1", "logo.png": png })),
      "free",
    ),
  );
  assert.deepEqual(files.map((f) => f.path), ["index.html", "assets/app.js", "logo.png"]);
  assert.equal(text(files[0]!.bytes), "<h1>hi</h1>");
  assert.deepEqual(Buffer.from(files[2]!.bytes), png);
  assert.ok(files.every((f) => f.bytes.buffer instanceof ArrayBuffer && f.bytes.byteOffset === 0));
});

test("a deflated archive inflates (method 8)", async () => {
  const html = "<p>" + "kept ".repeat(20) + "</p>";
  const files = ok(await hostile([{ name: "index.html", data: html, deflate: true }]));
  assert.equal(text(files[0]!.bytes), html);
});

test("directory entries are skipped; junk passes through empty and uncounted", async () => {
  const { siteFiles } = limitsFor("free");
  const entries: FixtureEntry[] = [{ name: "site/", data: "" }];
  for (let i = 0; i < siteFiles; i++) {
    entries.push({ name: `site/f${i}.txt`, data: "x" });
    entries.push({ name: `__MACOSX/site/._f${i}.txt`, data: "resource fork" });
  }
  const files = ok(await hostile(entries));
  assert.equal(files.length, siteFiles * 2, "every junk twin is listed, none is counted");
  const junk = files.filter((f) => f.path.startsWith("__MACOSX/"));
  assert.ok(junk.every((f) => f.bytes.length === 0), "junk is never inflated");
});

test("AC12: a ratio bomb (one deflated run of zeros) → invalid_archive", async () => {
  const zeros = new Uint8Array(4 * 1024 * 1024);
  const bomb = buildZip([{ name: "index.html", data: zeros, deflate: true }]);
  assert.ok(zeros.length / bomb.length > MAX_COMPRESSION_RATIO, "the fixture really is a bomb");
  const message = refused(await readZipFile(onDisk(bomb), "free"), "invalid_archive");
  assert.equal(message, "That .zip couldn't be opened. Re-create it and try again.");
});

test("AC12: a bomb whose header lies small is still caught (counted, never trusted)", async () => {
  const zeros = new Uint8Array(4 * 1024 * 1024);
  refused(await hostile([{ name: "index.html", data: zeros, deflate: true, declaredSize: 10 }]), "invalid_archive");
});

test("AC12: a symlink entry (mode 0o120000) → invalid_archive", async () => {
  refused(
    await hostile([
      { name: "index.html", data: "<p>" },
      { name: "secrets.txt", data: "/etc/passwd", unixMode: 0o120777 },
    ]),
    "invalid_archive",
  );
});

test("AC12: an encrypted entry → invalid_archive", async () => {
  refused(await hostile([{ name: "index.html", data: "<p>", encrypted: true }]), "invalid_archive");
});

test("AC12: a `..` or absolute entry name → invalid_archive", async () => {
  refused(await hostile([{ name: "../escape.html", data: "<p>" }]), "invalid_archive");
  refused(await hostile([{ name: "a/../../escape.html", data: "<p>" }]), "invalid_archive");
  refused(await hostile([{ name: "/etc/index.html", data: "<p>" }]), "invalid_archive");
  refused(await hostile([{ name: "C:/index.html", data: "<p>" }]), "invalid_archive");
});

test("AC12: a truncated or corrupt archive → invalid_archive", async () => {
  const good = await clientZip({ "index.html": "<p>hello</p>", "a.css": "b{}" });
  refused(await readZipFile(onDisk(good.subarray(0, good.length - 30)), "free"), "invalid_archive");
  refused(await readZipFile(onDisk(good.subarray(0, 40)), "free"), "invalid_archive");
  refused(await readZipFile(onDisk(randomBytes(4096)), "free"), "invalid_archive");
  refused(await readZipFile(onDisk(new Uint8Array(0)), "free"), "invalid_archive");
});

test("AC12: a header claiming fewer bytes than the entry holds → invalid_archive", async () => {
  refused(await hostile([{ name: "index.html", data: "x".repeat(4096), declaredSize: 16 }]), "invalid_archive");
});

test("extraction stops at siteFiles, and the refusal counts every file in the archive", async () => {
  const { siteFiles } = limitsFor("free");
  const entries = Array.from({ length: siteFiles + 5 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }));
  assert.equal(
    refused(await hostile(entries), "too_many_files"),
    `This site has ${siteFiles + 5} files. Free sites can have up to ${siteFiles}.`,
  );
  // The same archive fits Pro.
  assert.equal(ok(await readZipFile(onDisk(buildZip(entries)), "premium")).length, siteFiles + 5);
});

test("extraction stops at siteBytes, counted as bytes inflate", async () => {
  const { siteBytes, fileBytes } = limitsFor("free");
  // Random (incompressible) stored entries, each under fileBytes, summing past siteBytes.
  const part = Math.floor(fileBytes * 0.8);
  const count = Math.ceil((siteBytes + 1) / part);
  const entries = Array.from({ length: count }, (_, i) => ({ name: `blob${i}.bin`, data: randomBytes(part) }));
  const message = refused(await hostile(entries), "site_too_large");
  assert.match(message, /^This site is [\d.]+ MB\. Free sites can be up to 20\.0 MB\.$/);
  ok(await readZipFile(onDisk(buildZip(entries)), "premium"));
});
