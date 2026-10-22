/**
 * D6 — the bounded zip reader. A zip is spooled to a temp file and read with
 * `yauzl` from there.
 *
 * WHY A TEMP FILE FOR THE INLINE ZIP TOO (not `fromBuffer`): one code path. The
 * presigned `upload_id` leg (task 009) streams an R2 object to disk, so the
 * reader that leg relies on is exactly the one every inline zip exercises, and
 * the archive's bytes leave the JS heap once spooled — only the inflated files
 * are held, never the zip beside them. `yauzl.open` reads the central
 * directory by random access, so nothing past it is read until asked.
 *
 * Bounds, all enforced on bytes actually inflated, never on header sizes:
 * the plan's `siteFiles` and `siteBytes`, and a compression ratio of at most
 * `MAX_COMPRESSION_RATIO` per entry (a zip bomb). Encrypted entries, symlinks
 * (Unix mode `0o120000` in the external attributes), absolute or `..` names
 * (yauzl's `decodeStrings` validation) and anything yauzl cannot parse are
 * `invalid_archive`. Temp files live under `os.tmpdir()/kept-fileset-*` and
 * are removed in `finally` on every path.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { limitsFor, type Plan } from "@kept/shared";
import yauzl, { type Entry, type ZipFile } from "yauzl";

import { fail, type PublishFailure } from "../pipeline";
import { invalidArchive, siteTooLarge, tooManyFiles } from "./copy";
import { isIgnored } from "./normalise";
import type { RawFile } from "./types";

/** Prefix of every temp directory this reader makes — tests count them. */
export const TEMP_PREFIX = "kept-fileset-";

/** D6: an entry inflating to more than this many times its compressed size is a bomb. */
export const MAX_COMPRESSION_RATIO = 100;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const EMPTY = new Uint8Array(0);

function archiveFailure(): PublishFailure {
  return fail(400, { error: "invalid_archive", message: invalidArchive() });
}

/**
 * Spool `stream` to a fresh temp directory, read it with `readZipFile`, and
 * remove the directory whatever happened.
 */
export async function readZipStream(
  stream: ReadableStream<Uint8Array>,
  plan: Plan,
): Promise<RawFile[] | PublishFailure> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const path = join(dir, "archive.zip");
    await pipeline(
      Readable.fromWeb(stream as NodeReadableStream<Uint8Array>),
      createWriteStream(path),
    );
    return await readZipFile(path, plan);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The files of the zip at `path`, in archive order. Directory entries are
 * skipped; a path D7 will drop (`isIgnored`) is passed through with no bytes
 * and is neither inflated nor counted, so a Finder zip's `__MACOSX/` twin of
 * every file costs nothing and still lands in `ignored`.
 *
 * Past a cap the reader stops inflating but keeps reading names, so the
 * refusal can say how many files (or, from the headers, roughly how many
 * bytes) the archive holds.
 */
export async function readZipFile(path: string, plan: Plan): Promise<RawFile[] | PublishFailure> {
  const { siteFiles, siteBytes } = limitsFor(plan);
  let zipfile: ZipFile;
  try {
    zipfile = await yauzl.openPromise(path, {
      lazyEntries: true,
      validateEntrySizes: true,
      decodeStrings: true,
      autoClose: false,
    });
  } catch {
    return archiveFailure();
  }

  try {
    const files: RawFile[] = [];
    let fileCount = 0;
    let inflated = 0;
    let declared = 0;
    let over: "files" | "bytes" | null = null;

    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName.endsWith("/")) continue;
      if (entry.isEncrypted() || isSymlink(entry)) return archiveFailure();
      if (isIgnored(entry.fileName)) {
        files.push({ path: entry.fileName, bytes: EMPTY });
        continue;
      }
      fileCount += 1;
      declared += entry.uncompressedSize;
      if (over !== null) continue;
      if (fileCount > siteFiles) {
        over = "files";
        continue;
      }
      const bytes = await inflate(zipfile, entry, siteBytes - inflated);
      if (bytes === "bomb") return archiveFailure();
      if (bytes === "over") {
        over = "bytes";
        inflated = siteBytes + 1;
        continue;
      }
      inflated += bytes.length;
      files.push({ path: entry.fileName, bytes });
    }

    if (over === "files") {
      return fail(413, { error: "too_many_files", message: tooManyFiles(fileCount, plan, siteFiles) });
    }
    if (over === "bytes") {
      const size = Math.max(declared, inflated);
      return fail(413, { error: "site_too_large", message: siteTooLarge(size, plan, siteBytes) });
    }
    return files;
  } catch {
    // yauzl's own refusals: a `..` or absolute name, a size that disagrees with
    // its header, a truncated or corrupt archive.
    return archiveFailure();
  } finally {
    zipfile.close();
  }
}

function isSymlink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK;
}

/**
 * One entry's bytes, counted as they inflate: `"bomb"` once they pass
 * `MAX_COMPRESSION_RATIO` × the compressed size, `"over"` once they pass
 * `budget` (what is left of `siteBytes`). The stream is destroyed either way.
 */
async function inflate(
  zipfile: ZipFile,
  entry: Entry,
  budget: number,
): Promise<Uint8Array<ArrayBuffer> | "bomb" | "over"> {
  const ratioLimit = entry.compressedSize * MAX_COMPRESSION_RATIO;
  if (entry.uncompressedSize > ratioLimit) return "bomb";

  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > ratioLimit) return "bomb";
      if (size > budget) return "over";
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
