/**
 * The waitlist's request schema — what `POST /api/waitlist` accepts and the
 * address it stores. Pure: the schema decides the dedup key (the table's
 * primary key is the stored address), so two spellings of one inbox must parse
 * to the same string.
 *
 * The write itself is asserted end to end against the real dev database by
 * `e2e/waitlist.spec.ts`, which skips without `DATABASE_URL`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { waitlistRequestSchema } from "./join";

test("an address is trimmed and lowercased, so one inbox is one row", () => {
  for (const email of ["Ada@Example.com", "  ada@example.com ", "ADA@EXAMPLE.COM"]) {
    assert.deepEqual(waitlistRequestSchema.parse({ email }), { email: "ada@example.com" });
  }
});

test("anything that is not one plausible address is refused", () => {
  for (const body of [
    {},
    null,
    "ada@example.com",
    { email: "" },
    { email: "   " },
    { email: "ada" },
    { email: "ada@" },
    { email: "ada@example" },
    { email: "two@example.com, three@example.com" },
    { email: `${"a".repeat(250)}@example.com` },
    { email: 42 },
  ]) {
    assert.equal(waitlistRequestSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});
