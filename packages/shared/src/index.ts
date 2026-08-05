// @kept/shared — single source of truth for constants, enums, zod schemas,
// shared types, and the KV manifest contract. Consumed as source by both
// apps/web and apps/edge via `workspace:*`. Only runtime dep: zod.

export const SHARED_PACKAGE = "@kept/shared" as const;

export * from "./constants";
export * from "./enums";
export * from "./schemas";
export * from "./types";
export * from "./kv-manifest";
export * from "./publish";
