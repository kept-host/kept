/**
 * E08 task 003 — `readFileSet` over real `Request` objects, the same thing a
 * route handler receives: the three legacy single-HTML forms and the four new
 * ones (AC3, the reader half of AC1, AC9, AC12 end to end, D10's hash rules).
 *
 * The ONLY test file that drives the reader's zip spool, so its
 * `kept-fileset-*` temp-directory counts are not raced by another file (node's
 * runner runs files in parallel, tests within a file in order). Touches no
 * store: no KV or R2 quota is spent.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { INLINE_BODY_MAX_BYTES, MAX_PAGE_BYTES, SITE_FILE_TYPES, hashContent } from "@kept/shared";
import { downloadZip } from "client-zip";

import { buildZip } from "../../testing/zip-fixture";
import type { PublishFailure } from "../pipeline";
import { readFileSet } from "./read";
import { isFailure, type FileSet, type FileSetCaller } from "./types";
import { TEMP_PREFIX } from "./zip";

const URL_ = "https://app.kept.test/api/publish";
const ANON: FileSetCaller = { plan: "free", uploaderId: null };
const SIGNED_IN: FileSetCaller = { plan: "free", uploaderId: "00000000-0000-4000-8000-000000000001" };

/** A real 1×1 PNG. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const ABOUT = "<!doctype html><title>About</title><h1>About</h1>";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const tempDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)).length;

function json(body: unknown): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function html(body: string): Request {
  return new Request(URL_, { method: "POST", headers: { "content-type": "text/html" }, body });
}

function multipart(parts: [name: string, value: string | Blob, filename?: string][]): Request {
  const form = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, filename);
  }
  return new Request(URL_, { method: "POST", body: form });
}

async function zip(entries: Record<string, string | Uint8Array>): Promise<Blob> {
  const response = downloadZip(
    Object.entries(entries).map(([name, input]) => ({ name, input, lastModified: new Date(0) })),
  );
  return new Blob([await response.arrayBuffer()]);
}

function ok(result: FileSet | PublishFailure): FileSet {
  if (isFailure(result)) assert.fail(`expected a set, got ${result.status} ${JSON.stringify(result.body)}`);
  return result;
}

function refused(result: FileSet | PublishFailure, code: string, status: number): string {
  if (!isFailure(result)) assert.fail(`expected ${code}, got ${result.entries.map((e) => e.path).join(", ")}`);
  assert.equal(result.body.error, code, result.body.message);
  assert.equal(result.status, status, `${code} status`);
  return result.body.message;
}

const shape = (set: FileSet) => set.entries.map(({ path, sha256, contentType }) => ({ path, sha256, contentType }));

test("AC3: a lone about.html through each of the six inputs is stored as index.html", async () => {
  const inputs: [string, Request][] = [
    ["legacy JSON", json({ html: ABOUT })],
    ["text/html", html(ABOUT)],
    ["multipart html", multipart([["html", new Blob([ABOUT]), "about.html"]])],
    ["multipart files", multipart([["files", new Blob([ABOUT]), "about.html"]])],
    ["multipart archive", multipart([["archive", await zip({ "about.html": ABOUT }), "site.zip"]])],
    ["JSON files[]", json({ files: [{ path: "about.html", content: ABOUT }] })],
  ];
  for (const [label, request] of inputs) {
    const set = ok(await readFileSet(request, ANON));
    assert.deepEqual(shape(set), [
      { path: "index.html", sha256: sha256(ABOUT), contentType: SITE_FILE_TYPES.html.contentType },
    ], label);
    assert.equal(set.contentHash, sha256(ABOUT), `${label}: a one-file set hashes to its file`);
    assert.equal(set.totalBytes, Buffer.byteLength(ABOUT), label);
  }
});

test("AC17 through the reader: the legacy forms hash exactly as hashContent(html)", async () => {
  const doc = "<!doctype html><p>café — 🚀</p>";
  for (const request of [json({ html: doc }), html(doc), multipart([["html", doc]])]) {
    assert.equal(ok(await readFileSet(request, ANON)).contentHash, await hashContent(doc));
  }
});

test("AC1 (reader half): files, archive and JSON files[] yield identical entries and hash", async () => {
  const index = "<!doctype html><script src=assets/app.js></script><img src=assets/logo.png>";
  const app = "console.log('kept');";
  const fromFiles = ok(
    await readFileSet(
      multipart([
        ["files", new Blob([index]), "index.html"],
        ["files", new Blob([app]), "assets/app.js"],
        ["files", new Blob([PNG]), "assets/logo.png"],
      ]),
      ANON,
    ),
  );
  const fromArchive = ok(
    await readFileSet(
      multipart([["archive", await zip({ "index.html": index, "assets/app.js": app, "assets/logo.png": PNG }), "site.zip"]]),
      ANON,
    ),
  );
  const fromJson = ok(
    await readFileSet(
      json({
        files: [
          { path: "index.html", content: index },
          { path: "assets/app.js", content: app, encoding: "utf8" },
          { path: "assets/logo.png", content: Buffer.from(PNG).toString("base64"), encoding: "base64" },
        ],
      }),
      ANON,
    ),
  );
  assert.deepEqual(shape(fromArchive), shape(fromFiles));
  assert.deepEqual(shape(fromJson), shape(fromFiles));
  assert.equal(fromArchive.contentHash, fromFiles.contentHash);
  assert.equal(fromJson.contentHash, fromFiles.contentHash);
  assert.deepEqual(
    shape(fromFiles).map((e) => e.contentType),
    [SITE_FILE_TYPES.html.contentType, SITE_FILE_TYPES.js.contentType, SITE_FILE_TYPES.png.contentType],
  );
});

test("a synthetic Vite dist/ in a zip: folder stripped, Finder junk skipped, types mapped", async () => {
  const before = tempDirs();
  const set = ok(
    await readFileSet(
      multipart([
        [
          "archive",
          await zip({
            "dist/index.html": '<!doctype html><script type="module" src="/assets/index-B9kQ2x.js"></script>',
            "dist/assets/index-B9kQ2x.js": "export {}",
            "dist/assets/index-Cx81aZ.css": "body{margin:0}",
            "dist/vite.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
            "__MACOSX/dist/._index.html": "fork",
            "dist/.DS_Store": "junk",
          }),
          "dist.zip",
        ],
        ["spa", "true"],
      ]),
      SIGNED_IN,
    ),
  );
  assert.deepEqual(
    set.entries.map((e) => [e.path, e.contentType]),
    [
      ["index.html", SITE_FILE_TYPES.html.contentType],
      ["assets/index-B9kQ2x.js", SITE_FILE_TYPES.js.contentType],
      ["assets/index-Cx81aZ.css", SITE_FILE_TYPES.css.contentType],
      ["vite.svg", SITE_FILE_TYPES.svg.contentType],
    ],
  );
  assert.deepEqual(set.ignored, ["__MACOSX/dist/._index.html", "dist/.DS_Store"]);
  assert.equal(set.spa, true);
  assert.equal(set.has404, false);
  assert.equal(tempDirs(), before, "the spooled zip's temp directory is gone");
});

test("D10: an HTML file from a zip is hashed as raw bytes — a BOM survives", async () => {
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(ABOUT)]);
  const set = ok(await readFileSet(multipart([["archive", await zip({ "index.html": bom }), "a.zip"]]), ANON));
  assert.deepEqual([...set.entries[0]!.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(set.contentHash, sha256(bom));
  assert.notEqual(set.contentHash, await hashContent(ABOUT));
});

test("has404, spa and the shared optionals ride along", async () => {
  const set = ok(
    await readFileSet(
      json({
        files: [
          { path: "index.html", content: "<p>" },
          { path: "404.html", content: "<p>gone" },
        ],
        spa: true,
        turnstileToken: "tok",
        reminderEmail: "me@example.com",
      }),
      ANON,
    ),
  );
  assert.equal(set.has404, true);
  assert.equal(set.spa, true);
  assert.equal(set.turnstileToken, "tok");
  assert.equal(set.reminderEmail, "me@example.com");
  assert.equal(ok(await readFileSet(json({ html: "<p>" }), ANON)).spa, false);
  assert.equal(ok(await readFileSet(json({ html: "<p>", spa: true }), ANON)).spa, true);
  assert.equal(ok(await readFileSet(multipart([["html", "<p>"], ["spa", "true"]]), ANON)).spa, true);
  assert.equal(ok(await readFileSet(multipart([["files", new Blob(["<p>"]), "index.html"], ["spa", "yes"]]), ANON)).spa, false);
});

test("legacy semantics unchanged: empty → empty_page, an HTML string over MAX_PAGE_BYTES → page_too_large", async () => {
  refused(await readFileSet(json({ html: "" }), ANON), "empty_page", 400);
  refused(await readFileSet(html(""), ANON), "empty_page", 400);
  refused(await readFileSet(multipart([["turnstileToken", "t"]]), ANON), "empty_page", 400);
  refused(await readFileSet(json({}), ANON), "invalid_request", 400);
  refused(await readFileSet(json({ html: "x".repeat(MAX_PAGE_BYTES + 1) }), ANON), "page_too_large", 413);
});

test("JSON files[]: a non-text type needs base64; malformed base64 is invalid_request", async () => {
  const utf8Png = await readFileSet(
    json({ files: [{ path: "index.html", content: "<p>" }, { path: "logo.png", content: "not an image" }] }),
    ANON,
  );
  assert.match(refused(utf8Png, "invalid_request", 400), /^logo\.png: send this file with/);
  for (const bad of ["abc", "ab!d", "YWJj=ZGVm", "YQ==="]) {
    const result = await readFileSet(
      json({ files: [{ path: "index.html", content: bad, encoding: "base64" }] }),
      ANON,
    );
    assert.match(refused(result, "invalid_request", 400), /not valid base64/, bad);
  }
  // A text type may be base64 too.
  const b64 = ok(
    await readFileSet(
      json({ files: [{ path: "index.html", content: Buffer.from(ABOUT).toString("base64"), encoding: "base64" }] }),
      ANON,
    ),
  );
  assert.equal(b64.contentHash, sha256(ABOUT));
});

test("a mixed envelope is invalid_request, not whichever branch matched first", async () => {
  refused(
    await readFileSet(json({ html: "<p>", files: [{ path: "index.html", content: "<p>" }] }), ANON),
    "invalid_request",
    400,
  );
  refused(
    await readFileSet(multipart([["html", "<p>"], ["files", new Blob(["<p>"]), "index.html"]]), ANON),
    "invalid_request",
    400,
  );
  refused(await readFileSet(multipart([["files", "index.html"]]), ANON), "invalid_request", 400);
  refused(await readFileSet(multipart([["archive", new Blob(["x"]), "site.rar"]]), ANON), "invalid_request", 400);
  refused(
    await readFileSet(
      multipart([["files", new Blob(["<p>"]), "index.html"], ["reminderEmail", "not-an-email"]]),
      ANON,
    ),
    "invalid_request",
    400,
  );
});

test("an unsupported content type or unparseable JSON is invalid_request", async () => {
  const plain = new Request(URL_, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  assert.match(refused(await readFileSet(plain, ANON), "invalid_request", 400), /Unsupported content type "text\/plain"/);
  const broken = new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  refused(await readFileSet(broken, ANON), "invalid_request", 400);
});

test("D5: upload_id is upload_not_found for anonymous callers (and, until task 009, for everyone)", async () => {
  const body = { upload_id: "00000000-0000-4000-8000-0000000000aa" };
  const anon = refused(await readFileSet(json(body), ANON), "upload_not_found", 404);
  const signedIn = refused(await readFileSet(json(body), SIGNED_IN), "upload_not_found", 404);
  assert.equal(anon, signedIn, "one sentence: never reveals whether the upload exists");
  refused(await readFileSet(json({ upload_id: "nope" }), ANON), "invalid_request", 400);
});

test("AC9: Content-Length over INLINE_BODY_MAX_BYTES is refused before any parse — no temp file", async () => {
  const before = tempDirs();
  const form = new FormData();
  form.append("archive", await zip({ "index.html": ABOUT }), "site.zip");
  const serialised = new Response(form);
  const contentType = serialised.headers.get("content-type")!;
  const encoded = new Uint8Array(await serialised.arrayBuffer());
  const request = new Request(URL_, {
    method: "POST",
    headers: { "content-type": contentType, "content-length": String(INLINE_BODY_MAX_BYTES + 1) },
    body: encoded,
  });
  const message = refused(await readFileSet(request, ANON), "site_too_large", 413);
  assert.match(message, /^This upload is over 10\.0 MB/);
  assert.equal(tempDirs(), before, "no temp file was created");
  // The same body without the inflated header publishes — the refusal was the header.
  ok(await readFileSet(new Request(URL_, { method: "POST", headers: { "content-type": contentType }, body: encoded }), ANON));
});

test("AC9: with no Content-Length the body is counted as it streams and dropped at the cap", async () => {
  const chunk = 1024 * 1024;
  const total = INLINE_BODY_MAX_BYTES + 4 * chunk;
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) return controller.close();
      controller.enqueue(new Uint8Array(chunk).fill(0x61));
      pulled += chunk;
    },
  });
  const request = new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal(request.headers.get("content-length"), null);
  const before = tempDirs();
  refused(await readFileSet(request, ANON), "site_too_large", 413);
  assert.ok(pulled < total, `the read stopped at the cap: pulled ${pulled} of ${total}`);
  assert.equal(tempDirs(), before);
});

test("AC12 end to end: a bomb or a symlink zip is invalid_archive and the temp file is gone", async () => {
  const before = tempDirs();
  const bomb = buildZip([{ name: "index.html", data: new Uint8Array(4 * 1024 * 1024), deflate: true }]);
  const symlink = buildZip([
    { name: "index.html", data: "<p>" },
    { name: "link.txt", data: "/etc/passwd", unixMode: 0o120777 },
  ]);
  for (const archive of [bomb, symlink]) {
    refused(
      await readFileSet(multipart([["archive", new Blob([archive]), "site.zip"]]), ANON),
      "invalid_archive",
      400,
    );
    assert.equal(tempDirs(), before, "temp directory removed after a refusal");
  }
});

test("the pure stages run on every input: caps, paths and types refuse multipart and JSON alike", async () => {
  refused(
    await readFileSet(multipart([["files", new Blob(["<p>"]), "index.html"], ["files", new Blob(["%PDF"]), "a.pdf"]]), ANON),
    "file_type_not_allowed",
    400,
  );
  refused(
    await readFileSet(json({ files: [{ path: "index.html", content: "<p>" }, { path: "../x.css", content: "" }] }), ANON),
    "invalid_path",
    400,
  );
  refused(
    await readFileSet(json({ files: [{ path: "a.html", content: "<p>" }, { path: "b.html", content: "<p>" }] }), ANON),
    "missing_index",
    400,
  );
});
