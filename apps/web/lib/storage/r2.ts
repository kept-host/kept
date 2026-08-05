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
import { AwsClient } from "aws4fetch";

import { r2Config } from "./env";

/**
 * The page object key: `sites/{siteId}/{versionId}/index.html`.
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
export function pageObjectKey(siteId: string, versionId: string): string {
  return `sites/${siteId}/${versionId}/index.html`;
}

/**
 * Content type every page object is stored with. Matches what the Worker serves
 * for `.html` (`apps/edge/src/r2.ts`), so the byte stream and its declared type
 * agree end to end.
 */
export const PAGE_CONTENT_TYPE = "text/html; charset=utf-8";

export interface R2Store {
  bucket: string;
  /** Put an object with an explicit content type. */
  put(key: string, body: string, contentType: string): Promise<void>;
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
  delete(key: string): Promise<void>;
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
   * `fetch` and behaves exactly as before.
   *
   * The bug is invisible to `tsx`-run scripts and unit tests — there is no
   * patched fetch there — and appears only in the deployed control plane, which
   * is exactly why it is written down here.
   */
  const send = async (
    key: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<Response> => {
    const signed = await aws.sign(url(key), init);
    return fetch(signed.url, {
      method: init.method,
      headers: signed.headers,
      body: init.body,
    });
  };

  const put = async (key: string, body: string, contentType: string) => {
    const res = await send(key, {
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
      const res = await send(key, { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`R2 GET ${key} → HTTP ${res.status} on "${bucket}"`);
      }
      return res.text();
    },
    async delete(key) {
      const res = await send(key, { method: "DELETE" });
      // R2 answers 204 for a delete of a key that was never there.
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} → HTTP ${res.status} on "${bucket}"`);
      }
    },
  };
}
