/**
 * Publish and replace bodies for the drills, read the way the routes read them
 * — through the real `readFileSet` over a real `Request` (E08 D3), never a
 * hand-built `FileSet`, so a drill's set has the same hash, types and paths a
 * caller's would (no mocks).
 *
 * Test-only: nothing in the app imports it, and its name keeps it outside the
 * unit-test glob. It imports the pipeline (and so the database module), so a
 * drill that imports the pipeline dynamically imports this dynamically too.
 */
import type { Plan } from "@kept/shared";

import { readFileSet } from "../publish/fileset/read";
import { isFailure, type FileSet } from "../publish/fileset/types";
import type { FileSetReader, PublishFailure } from "../publish/pipeline";

function jsonRequest(body: unknown): Request {
  return new Request("https://kept.test/api/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The set (or the refusal) a studio route reads from a JSON body — `publishOwnedSite`, `replaceOwnedSite`. */
export function readJsonSet(body: unknown, plan: Plan = "free"): Promise<FileSet | PublishFailure> {
  return readFileSet(jsonRequest(body), { plan, uploaderId: null });
}

/** The reader a keyless route binds, over a JSON body — `publishPage`, `replacePage`. */
export function jsonBody(body: unknown, plan: Plan = "free"): FileSetReader {
  return () => readJsonSet(body, plan);
}

/** A valid JSON body's set — `publishOwnedPage`, `replaceSite`. Throws on a refusal. */
export async function fileSet(body: unknown, plan: Plan = "free"): Promise<FileSet> {
  const set = await readJsonSet(body, plan);
  if (isFailure(set)) throw new Error(`fixture body refused: ${set.body.error} — ${set.body.message}`);
  return set;
}
