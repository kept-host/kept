import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [".next/**", "node_modules/**", ".turbo/**", "next-env.d.ts"],
  },
  ...compat.config({
    extends: ["next/core-web-vitals", "next/typescript"],
  }),
  // `docs/edge-purge-contract.md` §7.3, enforced instead of merely commented.
  // Every KV manifest mutation must go through `lib/storage/manifest.ts`, which
  // owns the pointer → KV → purge ordering. A direct `kv.put(slug, …)` anywhere
  // else writes a manifest with no slug pointer and no cache purge — a stale
  // edge for up to a year, or a deleted page resurrected through the pointer.
  // The exemptions are the helper itself, the client's own module, the smoke
  // re-export (whose probes write a `__smoke__:` key, never a manifest), and the
  // three DRILL FILES — which must delete a KV key BY HAND to force the miss
  // that makes the pointer ordering observable at all. None of them writes a
  // manifest through the client: `anon-manage.test.ts` and
  // `e2e/pointer-ordering.spec.ts` use it to force the miss their delete drills
  // depend on, exactly as `manifest.test.ts` does.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    ignores: [
      "lib/storage/manifest.ts",
      "lib/storage/manifest.test.ts",
      "lib/storage/kv.ts",
      "lib/publish/anon-manage.test.ts",
      "e2e/pointer-ordering.spec.ts",
      "scripts/lib/smoke-stores.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/storage/kv", "./kv"],
              message:
                "Import writeManifest/removeManifest from lib/storage/manifest instead — a manifest write must be preceded by a slug-pointer write and followed by a purge (docs/edge-purge-contract.md §5, §7.3).",
            },
          ],
        },
      ],
    },
  },
];
