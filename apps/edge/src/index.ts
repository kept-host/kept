// @kept/edge — Hono Worker serving plane. Worker scaffolded in task 004.
// May import @kept/shared, NEVER @kept/web (enforced by ESLint no-restricted-imports).
import { SHARED_PACKAGE } from "@kept/shared";

export const EDGE_APP = `${SHARED_PACKAGE}:edge` as const;
