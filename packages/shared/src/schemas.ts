// @kept/shared — base zod schemas. Framework-agnostic so they can drive
// react-hook-form on the web side (frontend-specs §8) and validate API payloads
// on both apps. Inferred TS types live alongside each schema.

import { z } from "zod";

import { MAX_PAGE_BYTES } from "./constants";
import { planEnum, regionEnum, siteStatusEnum } from "./enums";

/**
 * UTF-8 byte length of a string. Pure JS so the package stays isomorphic
 * (no DOM/Node `TextEncoder` lib typings) and runs unchanged in the Worker.
 */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a full surrogate pair encodes to 4 bytes.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * A site's public slug: lowercase alphanumeric + hyphens, no leading/trailing or
 * doubled hyphens. Becomes the first label of `{slug}.kept.host`.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug must be lowercase alphanumeric with single hyphens between segments.",
  );

/** Payload to publish (or re-publish) a page. Slug is optional (auto-assigned). */
export const publishPayloadSchema = z.object({
  /** Raw HTML for the single page (v1 is single-file). */
  html: z
    .string()
    .min(1, "Page is empty.")
    .refine(
      (html) => utf8ByteLength(html) <= MAX_PAGE_BYTES,
      `Page exceeds the ${MAX_PAGE_BYTES}-byte limit.`,
    ),
  /** Optional desired slug; assigned by the control plane when omitted. */
  slug: slugSchema.optional(),
  /** Data residency; defaults to `auto`. */
  region: regionEnum.default("auto"),
});

export type PublishPayload = z.infer<typeof publishPayloadSchema>;

/** A site record (control-plane source of truth; Drizzle table mirrors this). */
export const siteSchema = z.object({
  id: z.string(),
  slug: slugSchema,
  status: siteStatusEnum,
  region: regionEnum,
  /** Current published version → R2 prefix. */
  currentVersionId: z.string().nullable(),
  /** Owner profile id; null while a page is still anonymous/unclaimed. */
  ownerId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Site = z.infer<typeof siteSchema>;

/** A user profile record. */
export const profileSchema = z.object({
  id: z.string(),
  /** Display handle; null until the user sets one. */
  handle: z.string().nullable(),
  email: z.string().email().nullable(),
  plan: planEnum,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Profile = z.infer<typeof profileSchema>;
