/**
 * R2 writes from the control plane, over the S3-compatible API (aws4fetch
 * SigV4). `apps/web` WRITES R2; `apps/edge` reads it through its binding and
 * never calls back — the one-directional serve-path rule.
 *
 * Promoted from `scripts/lib/smoke-stores.ts` (E00 task 005 / E02 task 008)
 * unchanged in behaviour: this signing is the only thing that has ever been
 * proven against live Cloudflare, so it is moved, not re-derived. The smoke
 * scripts now import this module, which keeps one signing site in the repo.
 *
 * Layout is keyed by `siteId`, never by slug — `sites/{siteId}/{versionId}/
 * index.html` — which is what makes E06's rename a KV-only change with no file
 * move. The slug pointer object (`slugs/{slug}.json`, contract §7) is written
 * through `putJson` by the manifest helper, not from here.
 *
 * Stateless and constructed at call time: no module-level singleton, so no
 * credential survives a hot reload.
 */
import { createHash } from "node:crypto";

import { README_OBJECT } from "@kept/shared";
import { AwsClient } from "aws4fetch";

import { r2Config } from "./env";

/**
 * The object key of one file of a version: `sites/{siteId}/{versionId}/{path}`
 * (E08 D1 — every version is a file set; `path` is a validated set path such as
 * `index.html` or `assets/app.js`).
 *
 * KEYED BY `siteId`, NEVER BY SLUG. That is the whole reason E06's rename is a
 * KV-only write with no file move, and why a slug is free to change without any
 * object ever being copied. A pure formatter — it touches no store — and the
 * single place the layout is expressed, so publish (E04 task 005), replace
 * (task 006) and E07's hard delete all name the same object.
 *
 * The version id is part of the key, so versions never overwrite each other and
 * a replace is a new object rather than a mutation of a cached one.
 */
export function siteObjectKey(siteId: string, versionId: string, path: string): string {
  return `sites/${siteId}/${versionId}/${path}`;
}

/** The entry document of a version — `siteObjectKey(…, "index.html")`. */
export function pageObjectKey(siteId: string, versionId: string): string {
  return siteObjectKey(siteId, versionId, "index.html");
}

/**
 * The README page's object (E10 D6): `sites/{siteId}/_kept/readme.html` — per
 * site, beside the version prefixes, so editing a README makes no version. It
 * is not in `site_version_files`; whoever deletes a site's objects names it.
 */
export function readmeObjectKey(siteId: string): string {
  return `sites/${siteId}/${README_OBJECT}`;
}

/** S3 `DeleteObjects` accepts at most this many keys per request. */
const R2_DELETE_MAX_KEYS = 1000;

/** XML-escape a key for the `DeleteObjects` body. */
function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Content type every page object is stored with. Matches what the Worker serves
 * for `.html` (`apps/edge/src/r2.ts`), so the byte stream and its declared type
 * agree end to end.
 */
export const PAGE_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * An object body: text, or raw bytes. `Uint8Array<ArrayBuffer>`, not any
 * `ArrayBufferLike` — a view over a `SharedArrayBuffer` is not a fetch body.
 */
type ObjectBody = string | Uint8Array<ArrayBuffer>;

export interface R2Store {
  bucket: string;
  /** Put an object with an explicit content type — text or raw bytes. */
  put(key: string, body: ObjectBody, contentType: string): Promise<void>;
  /**
   * Put an `application/json` object (contract §7.2 requires that content type
   * on the slug pointer).
   *
   * Takes an ALREADY-SERIALIZED string, not a value: the pointer and the KV
   * manifest must be byte-identical, so the caller stringifies once and hands
   * the same bytes to both stores. A `putJson(key, object)` that stringified
   * again would be a second serialization that only happens to agree.
   */
  putJson(key: string, json: string): Promise<void>;
  get(key: string): Promise<string | null>;
  /**
   * The object's bytes as they arrive — the response body itself, never
   * buffered — or `null` when there is no such object. For downloads and the
   * export (D13), which stream a page through to the browser.
   *
   * `signal` aborts the read: the caller that stops consuming the stream (an
   * export the browser cancelled) aborts it, so the R2 socket is released
   * rather than left to the garbage collector.
   */
  getStream(key: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  /**
   * Delete many objects — S3 `DeleteObjects`, at most 1,000 keys per request,
   * as many requests as the list needs. A key that was never written is not an
   * error (S3 reports it deleted); any key R2 refuses throws, naming the first.
   * An empty list sends nothing.
   */
  deleteMany(keys: readonly string[]): Promise<void>;
  /**
   * A SigV4 query-signed PUT URL for `key`, valid `expiresSeconds` (E08 D5).
   * `content-length` and `content-type` are SIGNED: a PUT of any other length
   * or type is refused by R2. The origin is this store's endpoint, built from
   * `r2Config()` — never from a request. The URL is a bearer credential until
   * it expires: never log it.
   */
  presignPut(key: string, sizeBytes: number, contentType: string, expiresSeconds: number): Promise<string>;
  // No `list`. The authority on what objects should exist is Postgres
  // (contract §7.5 / the E07 divergence audit): a previous version's objects are
  // still present after a replace, so a listing is unbounded and answers a
  // different question than the one anyone asking it means to ask.
}

export function r2Store(): R2Store {
  const { accountId, accessKeyId, secretAccessKey, bucket } = r2Config();

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = (key: string) =>
    `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const bucketUrl = `${endpoint}/${bucket}`;

  /**
   * Sign with aws4fetch, then dispatch with a PLAIN init object rather than
   * letting `aws.fetch` dispatch the `Request` it built.
   *
   * ⚠️ THIS IS NOT A STYLE CHOICE — `aws.fetch` returns HTTP 411 from R2 inside
   * a Next.js server. Next patches the global `fetch`, and when the input is a
   * `Request` instance it rebuilds it as
   * `new Request(input.url, { body: input._ogBody || input.body, … })`
   * (`next/dist/server/lib/patch-fetch`). `input.body` on an already-built
   * Request is a ReadableStream, and `_ogBody` is Next's own private field that
   * a third-party signer does not set — so the rebuilt request is sent with
   * `transfer-encoding: chunked` and no `content-length`. The S3 PUT API
   * requires a length, and answers **411 Length Required**.
   *
   * Passing `(url, init)` with the original string body takes Next's other
   * branch, which preserves `init.body` verbatim, so the length is known and
   * the request is identical to the one signed. Outside Next this is a plain
   * `fetch` and behaves exactly as before. A `Uint8Array` body takes the same
   * branch and keeps its known length, so binary files are safe too.
   *
   * The bug is invisible to `tsx`-run scripts and unit tests — there is no
   * patched fetch there — and appears only in the deployed control plane, which
   * is exactly why it is written down here.
   *
   * ⚠️ AND A SIGNAL IS ALWAYS PASSED, for the same patched fetch (E08 task 009).
   * Next de-duplicates every signal-less GET by `tee()`ing its body and parking
   * the second branch in a cache nobody reads: the whole object is buffered in
   * memory beside the stream the caller reads, and cancelling the caller's
   * branch never resolves (a tee's cancel waits for both branches) — so a 404's
   * `body.cancel()`, or abandoning an over-size upload mid-read, hung the
   * request. A signal is Next's documented opt-out of that de-duplication; one
   * that never fires changes nothing else.
   */
  const send = async (
    target: string,
    init: { method: string; body?: ObjectBody; headers?: Record<string, string> },
    signal?: AbortSignal,
  ): Promise<Response> => {
    const signed = await aws.sign(target, init);
    return fetch(signed.url, {
      method: init.method,
      headers: signed.headers,
      body: init.body,
      signal: signal ?? new AbortController().signal,
    });
  };

  const getStream = async (key: string, signal?: AbortSignal) => {
    const res = await send(url(key), { method: "GET" }, signal);
    if (res.ok && res.body) return res.body;
    // Not a body anyone will read: release the connection now.
    await res.body?.cancel();
    if (res.status === 404) return null;
    throw new Error(`R2 GET ${key} → HTTP ${res.status} on "${bucket}"`);
  };

  const put = async (key: string, body: ObjectBody, contentType: string) => {
    const res = await send(url(key), {
      method: "PUT",
      body,
      headers: { "content-type": contentType },
    });
    if (!res.ok) {
      throw new Error(`R2 PUT ${key} → HTTP ${res.status} on "${bucket}"`);
    }
  };

  return {
    bucket,
    put,
    async putJson(key, json) {
      await put(key, json, "application/json");
    },
    async get(key) {
      const body = await getStream(key);
      return body ? new Response(body).text() : null;
    },
    getStream,
    async delete(key) {
      const res = await send(url(key), { method: "DELETE" });
      // R2 answers 204 for a delete of a key that was never there.
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} → HTTP ${res.status} on "${bucket}"`);
      }
    },
    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += R2_DELETE_MAX_KEYS) {
        const batch = keys.slice(i, i + R2_DELETE_MAX_KEYS);
        const body =
          "<Delete><Quiet>true</Quiet>" +
          batch.map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`).join("") +
          "</Delete>";
        const res = await send(`${bucketUrl}?delete`, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/xml",
            // DeleteObjects requires the body's MD5 (S3 and R2 alike).
            "content-md5": createHash("md5").update(body).digest("base64"),
          },
        });
        const text = await res.text();
        if (!res.ok) {
          throw new Error(`R2 DELETE (batch of ${batch.length}) → HTTP ${res.status} on "${bucket}"`);
        }
        // Quiet mode lists only failures; a missing key is not one.
        const failed = /<Error>([\s\S]*?)<\/Error>/.exec(text)?.[1];
        if (failed !== undefined) {
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(failed)?.[1] ?? "(unnamed key)";
          const code = /<Code>([\s\S]*?)<\/Code>/.exec(failed)?.[1] ?? "error";
          throw new Error(`R2 DELETE ${key} → ${code} on "${bucket}"`);
        }
      }
    },
    async presignPut(key, sizeBytes, contentType, expiresSeconds) {
      const target = new URL(url(key));
      // aws4fetch defaults a query signature to 24 h unless this is set first.
      target.searchParams.set("X-Amz-Expires", String(expiresSeconds));
      const signed = await aws.sign(target.toString(), {
        method: "PUT",
        headers: { "content-length": String(sizeBytes), "content-type": contentType },
        // `allHeaders`: aws4fetch leaves content-length/-type unsigned by default.
        aws: { signQuery: true, allHeaders: true },
      });
      return signed.url;
    },
  };
}
