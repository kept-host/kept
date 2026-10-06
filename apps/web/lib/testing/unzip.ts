/**
 * Info-ZIP's `unzip`, as the INDEPENDENT reader of the export zip — E06 tasks
 * 008 (`lib/sites/export.test.ts`) and 014 (`e2e/studio-story.spec.ts`).
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob in `apps/web/package.json`. The export is written by
 * `client-zip`; checking it with a second implementation (integrity with `-t`,
 * the entry list with `-Z1`, an entry's bytes with `-p`) is what makes "the zip
 * is valid" a claim rather than a round trip through the writer's own idea of
 * the format. A run without the binary skips with that reason.
 */
import { execFileSync } from "node:child_process";

/** Whether an `unzip` binary is on the PATH. */
export function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run `unzip` with `args`; its stdout. Throws on a non-zero exit (a bad archive). */
export function unzip(args: string[]): Buffer {
  return execFileSync("unzip", args, { maxBuffer: 64 * 1024 * 1024 });
}
