// @kept/shared — single source of truth for constants, enums, zod schemas,
// shared types, and the KV manifest contract. Consumed as source by both
// apps/web and apps/edge via `workspace:*`. The barrel's only runtime dep is
// zod: `obscenity` is reachable solely through the `@kept/shared/names`
// subpath, which this file must never re-export (see `./names`).

export const SHARED_PACKAGE = "@kept/shared" as const;

export * from "./constants";
export * from "./enums";
export * from "./schemas";
export * from "./types";
export * from "./kv-manifest";
export * from "./publish";
export * from "./keep";
export * from "./manage";
export * from "./plans";
