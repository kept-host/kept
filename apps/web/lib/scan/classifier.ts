/**
 * The scanner's one network call (E07 D1, PRD §6.3): an extraction → the typed
 * answers to three questions, plus what the call cost.
 *
 * `ContentClassifier` is the seam. The default is Jev 1.13 over OpenRouter's
 * Decisions API, PINNED (`typesafe/jev-1.13`, never `~typesafe/jev-latest`), so
 * the thresholds the eval tuned keep meaning what they meant. The fallback
 * named in D1 / Risk 11 — `openai/gpt-oss-safeguard-20b` — would be a second
 * implementation of this interface; it is built only if Jev fails the eval
 * gate (D5), so it does not exist here (NO DEAD CODE).
 *
 * Plain `fetch`, no SDK. The API key comes from `openRouterApiKey()` and is
 * never logged or echoed into an error. Only `apps/web` imports this — the
 * Worker never classifies anything.
 */
import { z } from "zod";

import { openRouterApiKey } from "../storage/env";

import { classifierAnswersSchema, type ClassifierAnswers, type Extraction, type HarmChoice } from "./types";

/** OpenRouter's Decisions API (alpha). */
export const DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
/** Pinned: a model change is an eval re-run, never a silent upgrade. */
export const JEV_MODEL = "typesafe/jev-1.13";
/** PRD §6.3: one call, 10 s, then the scan fails and retries from Postgres (§6.5). */
export const CLASSIFIER_TIMEOUT_MS = 10_000;

export interface ClassifierResult {
  answers: ClassifierAnswers;
  /** `usage.cost`, USD. */
  cost: number;
  /** The model version that answered, as the API reports it (e.g. `typesafe/jev-1.13-20260917`). */
  model: string;
}

export interface ContentClassifier {
  /** The model asked for — recorded with every verdict. */
  readonly model: string;
  classify(state: Extraction): Promise<ClassifierResult>;
}

/**
 * Why a call failed (PRD §6.5). Every kind is retried by `scan-retry`; the kind
 * only names the cause for the scan row and the failure alert.
 * - `timeout` — no answer within `CLASSIFIER_TIMEOUT_MS`
 * - `unavailable` — 5xx, or the network failed
 * - `credit_limit` — 402: the account's credit limit is spent
 * - `rejected` — any other non-2xx (bad request, key, rate limit)
 * - `malformed` — a 2xx whose body is not the three typed answers
 */
export type ClassifierErrorKind = "timeout" | "unavailable" | "credit_limit" | "rejected" | "malformed";

export class ClassifierError extends Error {
  constructor(
    readonly kind: ClassifierErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

/** What each `harm` option means (PRD §6.3, verbatim), declared in `HARM_CHOICES` order — the order they are asked in. */
const HARM_CRITERIA: Record<HarmChoice, string> = {
  none: "An ordinary page: portfolio, tool, game, doc, demo, landing page, a sign-up or contact form for the author's own project, or a UI mockup or clone of a real product that collects nothing and sends nothing anywhere.",
  credential_phishing:
    "Asks visitors to sign in to or confirm an account at a real company, bank, email provider, government service or platform that is not the author's own.",
  payment_harvest:
    "Asks for card or bank details, or a payment to fix a fake problem (parcel fee, suspended account, refund).",
  wallet_drainer: "Asks for a seed phrase, private key or wallet connection to claim, fix or verify something.",
  malware_download: "Pushes a file, app or extension presented as an update, invoice, viewer or fix.",
  scam: "Fake giveaway, investment, job, prize or tech-support scheme asking for money, a call or personal data.",
  sexual_content_minors: "Sexual content involving anyone described as under 18.",
};

/** The three questions of PRD §6.3. Fixed for a given `SCAN_POLICY_VERSION`. */
export const SCAN_QUESTIONS = {
  harm: {
    type: "choice",
    instructions: "Which of these best describes this web page?",
    criteria: HARM_CRITERIA,
  },
  impersonates: {
    type: "noul",
    instructions:
      "Does the page present itself as a real company, bank, government body or platform, rather than the author's own project?",
    criteria: {
      true: "The page presents itself as a real company, bank, government body or platform.",
      false: "The author's own project; or mentions, reviews, tutorials, and clones clearly labelled as such.",
    },
  },
  asks_for_secrets: {
    type: "noul",
    instructions:
      "Does the page ask the visitor to type a password, one-time code, card number, bank login or seed phrase?",
  },
} as const;

/** The Decisions API request for one page: `state` is the extraction only — no owner identity, no emails (D3). */
export function decisionsRequest(model: string, state: Extraction) {
  return { model, state: { facts: state.facts, text: state.text }, questions: SCAN_QUESTIONS };
}

const decisionsResponseSchema = z.object({
  answers: classifierAnswersSchema,
  model: z.string().min(1),
  usage: z.object({ cost: z.number().nonnegative() }),
});

/** A 2xx body → the typed result, or a `malformed` error. Never a guess. */
export function parseDecisionsResponse(body: unknown): ClassifierResult {
  const parsed = decisionsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ClassifierError("malformed", `Decisions API answer did not match the scan questions: ${parsed.error.message}`);
  }
  return { answers: parsed.data.answers, cost: parsed.data.usage.cost, model: parsed.data.model };
}

/** A non-2xx status (+ its body's `error.message`, if any) → a typed error. The message never carries the key. */
export function decisionsHttpError(status: number, body: unknown): ClassifierError {
  const upstream = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
  const detail = upstream.success ? `: ${upstream.data.error.message.slice(0, 200)}` : "";
  const kind: ClassifierErrorKind = status === 402 ? "credit_limit" : status >= 500 ? "unavailable" : "rejected";
  return new ClassifierError(kind, `Decisions API returned ${status}${detail}`);
}

/** Jev over the Decisions API — the default classifier (D1). */
export class JevClassifier implements ContentClassifier {
  readonly model = JEV_MODEL;

  constructor(private readonly apiKey: string) {}

  async classify(state: Extraction): Promise<ClassifierResult> {
    let response: Response;
    try {
      response = await fetch(DECISIONS_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(decisionsRequest(this.model, state)),
        signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new ClassifierError("timeout", `Decisions API gave no answer within ${CLASSIFIER_TIMEOUT_MS} ms`);
      }
      throw new ClassifierError("unavailable", `Decisions API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw decisionsHttpError(response.status, body);
    return parseDecisionsResponse(body);
  }
}

/** D17: the scanner is on exactly when `OPENROUTER_API_KEY` is set. */
export function scannerEnabled(): boolean {
  return openRouterApiKey() !== null;
}

/** The classifier production scans use, or null when the scanner is off (D17). */
export function defaultClassifier(): ContentClassifier | null {
  const apiKey = openRouterApiKey();
  return apiKey ? new JevClassifier(apiKey) : null;
}
