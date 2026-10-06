/**
 * The browser's half of `POST /api/waitlist`, for the landing's waitlist
 * dialog. Never throws: it resolves to `null` when the address is on the list,
 * or to the sentence the dialog shows.
 */
import { publishErrorSchema } from "@kept/shared";

const UNREACHABLE = "kept couldn't be reached. Check your connection and try again.";

export async function submitWaitlist(email: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch {
    return UNREACHABLE;
  }
  if (response.ok) return null;

  const parsed = publishErrorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? parsed.data.message
    : `That didn't go through (HTTP ${response.status}). Try again in a moment.`;
}
