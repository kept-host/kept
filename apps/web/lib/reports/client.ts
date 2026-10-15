/**
 * The browser's half of `POST /api/reports` (E07 §6.8), for the report form.
 * Never throws: every outcome is a value the form renders. Anything it cannot
 * read — no network, a 5xx, an unknown body — is `error`, which sends the
 * reporter to the abuse address instead.
 */
import { reportErrorSchema, type ReportRequest } from "@kept/shared";

export type ReportSubmitResult =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "not_a_kept_page" }
  | { kind: "rate_limited" }
  | { kind: "turnstile" }
  | { kind: "error" };

export async function submitReport(body: ReportRequest): Promise<ReportSubmitResult> {
  let response: Response;
  try {
    response = await fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 201) return { kind: "ok" };

  const parsed = reportErrorSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { kind: "error" };
  switch (parsed.data.error.code) {
    case "invalid":
      return { kind: "invalid" };
    case "turnstile_failed":
      return { kind: "turnstile" };
    case "not_a_kept_page":
      return { kind: "not_a_kept_page" };
    case "rate_limited":
      return { kind: "rate_limited" };
  }
}
