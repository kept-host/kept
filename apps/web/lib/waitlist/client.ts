/**
 * The browser's half of the waitlist API (E06a §3), for `EmailForm` and the
 * confirm page. Never throws: every outcome is a value the UI renders.
 */
import { publishErrorSchema, type WaitlistJoinRequest } from "@kept/shared";

export type JoinResult =
  | { kind: "ok" }
  | { kind: "invalid"; message: string }
  | { kind: "rate_limited" }
  | { kind: "turnstile" }
  | { kind: "network" };

export async function submitWaitlist(body: WaitlistJoinRequest): Promise<JoinResult> {
  let response: Response;
  try {
    response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "network" };
  }
  if (response.status === 202) return { kind: "ok" };
  if (response.status === 429) return { kind: "rate_limited" };

  const parsed = publishErrorSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { kind: "network" };
  if (parsed.data.error === "turnstile_failed") return { kind: "turnstile" };
  if (parsed.data.error === "invalid_request") return { kind: "invalid", message: parsed.data.message };
  return { kind: "network" };
}

/** `confirmed_founding`: the address confirmed and its founding application went to Arun. */
export type ConfirmResult = "confirmed" | "confirmed_founding" | "expired" | "network";

export async function confirmWaitlistToken(token: string): Promise<ConfirmResult> {
  try {
    const response = await fetch("/api/waitlist/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { founding?: unknown } | null;
      return body?.founding === true ? "confirmed_founding" : "confirmed";
    }
    if (response.status === 410) return "expired";
    return "network";
  } catch {
    return "network";
  }
}
