/**
 * Joining the waitlist — the one write a closed deploy (`lib/launch.ts`)
 * accepts. `app/api/waitlist/route.ts` is the HTTP boundary; validation and the
 * write's failure handling are here, the SQL in `lib/db/queries/waitlist.ts`.
 *
 * Failures use the publish error shape so the route answers through the same
 * `errorResponse` the publish family does, and the dialog reads `message`.
 */
import { z } from "zod";

import { addToWaitlist } from "../db/queries/waitlist";
import type { PublishFailure } from "../publish/pipeline";

/**
 * The body `POST /api/waitlist` accepts. Trimmed and lowercased before the
 * check, so the stored address is the table's dedup key; 254 is the longest
 * address SMTP can carry.
 */
export const waitlistRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export type WaitlistOutcome = { ok: true; status: 200; body: { ok: true } } | PublishFailure;

export async function joinWaitlist(raw: unknown): Promise<WaitlistOutcome> {
  const parsed = waitlistRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_request", message: "Enter a valid email address." },
    };
  }

  try {
    await addToWaitlist(parsed.data.email);
  } catch (err) {
    // The address is not logged: it is the one thing in this request that is
    // personal data, and an error log is the easiest place for it to leak.
    console.error(
      `[kept] waitlist: Postgres write failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      status: 500,
      body: {
        error: "internal_error",
        message: "That didn't go through. Try again in a moment.",
      },
    };
  }

  return { ok: true, status: 200, body: { ok: true } };
}
