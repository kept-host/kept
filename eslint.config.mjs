// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Shared root ESLint config consumed by all workspace members.
 * Apps/packages extend this and may add framework-specific configs.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/.wrangler/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // One-way serve-path rule: apps/edge may import packages/shared but NEVER apps/web.
  {
    files: ["apps/edge/**/*.{ts,tsx,js,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@kept/web", "@kept/web/*", "**/apps/web/**", "apps/web/*"],
              message:
                "Serve-path violation: apps/edge must never import from apps/web. Communicate one-directionally via R2/KV.",
            },
          ],
        },
      ],
    },
  }
);
