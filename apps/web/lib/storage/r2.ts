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

  const put = async (key: string, body: string, contentType: string) => {
    const res = await aws.fetch(url(key), {
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
      const res = await aws.fetch(url(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`R2 GET ${key} → HTTP ${res.status} on "${bucket}"`);
      }
      return res.text();
    },
    async delete(key) {
      const res = await aws.fetch(url(key), { method: "DELETE" });
      // R2 answers 204 for a delete of a key that was never there.
      if (!res.ok && res.status !== 404) {
        throw new Error(`R2 DELETE ${key} → HTTP ${res.status} on "${bucket}"`);
      }
    },
  };
}
