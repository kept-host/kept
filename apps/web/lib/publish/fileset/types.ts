/**
 * The `FileSet` (E08 PRD §5.1) — what every publish and replace body becomes,
 * whichever of its seven forms it arrived in, before any store is touched.
 *
 * `bytes` is `Uint8Array<ArrayBuffer>` (never a pooled Node `Buffer` view) so an
 * entry goes to `R2Store.put` as it is.
 */
import type { Plan } from "@kept/shared";

import type { PublishFailure } from "../pipeline";

/** One file as an input delivered it: a path not yet normalised, and its bytes. */
export interface RawFile {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** A file that passed every check: its stored path, bytes, digest and served type. */
export interface FileSetEntry {
  /** NFC, `/`-separated, relative to the site root (`validateSitePath`). */
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** SHA-256 of `bytes`, lowercase hex. */
  sha256: string;
  /** From `SITE_FILE_TYPES` by extension — never the uploader's. */
  contentType: string;
}

export interface FileSet {
  entries: FileSetEntry[];
  /** Every entry's bytes together — what `site_versions.size_bytes` stores. */
  totalBytes: number;
  /** D10: `hashFileSet(entries)` — `hashContent(html)` for a single-HTML page. */
  contentHash: string;
  /** D12 opt-in, read from every form. */
  spa: boolean;
  /** D13: a root `404.html` is in the set. */
  has404: boolean;
  /** Paths D7 dropped (OS junk, dotfiles), in input order — "Skipped {n} files". */
  ignored: string[];
  turnstileToken?: string;
  reminderEmail?: string;
  /** D5: the upload object this set was read from — deleted once the publish lands (used once). */
  uploadKey?: string;
}

/** Who is publishing: the plan whose caps apply, and the profile that may own an `upload_id`. */
export interface FileSetCaller {
  plan: Plan;
  /** The signed-in profile, or `null` for anonymous and keyless callers (D5: no uploads). */
  uploaderId: string | null;
}

/** Narrow a stage's result: every stage returns its value or a `PublishFailure`. */
export function isFailure<T>(result: T | PublishFailure): result is PublishFailure {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}
