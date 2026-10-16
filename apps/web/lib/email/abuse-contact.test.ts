/**
 * `ABUSE_CONTACT_EMAIL` — the one address abuse reports and moderation appeals
 * go to (Arun's decision 3, 2026-10-04). The quarantined / under-review banner
 * builds its `mailto:` from it, so the constant is the only place CODE may
 * spell the address. The legal texts (`content/legal/*.md`) are prose that must
 * name it; they are pinned byte for byte, and `lib/legal/legal.test.ts` asserts
 * they carry the constant's value.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ABUSE_CONTACT_EMAIL } from "@kept/shared";
import { z } from "zod";

test("ABUSE_CONTACT_EMAIL is the decided address, and a valid one", () => {
  assert.equal(ABUSE_CONTACT_EMAIL, "abuse@kept.host");
  assert.ok(z.string().email().safeParse(ABUSE_CONTACT_EMAIL).success);
});

test("no app or package source spells an abuse@ address except the constant", () => {
  const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  let hits: string[] = [];
  try {
    hits = execFileSync(
      "git",
      ["grep", "--untracked", "-l", "abuse@", "--", "apps", "packages", ":!*.test.ts", ":!apps/web/content/legal/*.md"],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  assert.deepEqual(hits, ["packages/shared/src/constants.ts"]);
});
