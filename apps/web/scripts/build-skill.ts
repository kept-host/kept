/**
 * Writes the skill repo's generated files into `skill/` (E09 task 010, Q1):
 * `SKILL.md`, `server.json` and the plugin manifests, from `@kept/shared`'s
 * agent copy. Run after changing the copy, then commit `skill/`;
 * `lib/agents/skill-drift.test.ts` fails until you do.
 *
 *   pnpm --filter @kept/web exec tsx scripts/build-skill.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SKILL_BUILD_BASE, skillFiles } from "../lib/agents/skill-files";

const root = resolve(import.meta.dirname, "../../../skill");

for (const [path, content] of Object.entries(skillFiles(SKILL_BUILD_BASE))) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`skill/${path}`);
}
