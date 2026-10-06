/**
 * The waitlist's one statement. `lib/waitlist/join.ts` owns validation and the
 * answer; this module owns the SQL.
 */
import { db } from "../index";
import { waitlist } from "../schema";

/**
 * Put an address on the list. Already on it is not an error: the primary key
 * is the dedup, and the caller gets the same answer either way, so the endpoint
 * never tells anyone whether an address was already there.
 */
export async function addToWaitlist(email: string): Promise<void> {
  await db.insert(waitlist).values({ email }).onConflictDoNothing();
}
