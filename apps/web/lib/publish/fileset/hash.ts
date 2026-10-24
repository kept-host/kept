/**
 * D10 — every entry's SHA-256 and the set's content hash, over the bytes that
 * will be stored. Never a decode/re-encode: an HTML file from a zip is hashed
 * as it arrived, so a BOM survives into the digest. For the legacy single-HTML
 * forms those bytes are `TextEncoder`'s, so the set hash is `hashContent(html)`.
 */
import { hashBytes, hashFileSet } from "@kept/shared";

import type { TypedFile } from "./checks";
import type { FileSetEntry } from "./types";

export async function hashSet(
  files: readonly TypedFile[],
): Promise<{ entries: FileSetEntry[]; contentHash: string }> {
  const entries = await Promise.all(
    files.map(async ({ path, bytes, contentType }) => ({
      path,
      bytes,
      sha256: await hashBytes(bytes),
      contentType,
    })),
  );
  return { entries, contentHash: await hashFileSet(entries) };
}
