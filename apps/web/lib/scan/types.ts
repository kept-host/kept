/**
 * The scanner's shapes (E07 D3, PRD §6.2–6.4): what the extractor reads out of
 * a page, what the classifier answers, and what the policy decides. Shared by
 * `extract.ts`, `policy.ts`, the classifier client and eval (task 006) and the
 * scan runtime (task 007), which stores `PageFacts` and `ClassifierAnswers` on
 * the `scans` row (`facts`, `answers` jsonb).
 */
import type { ModerationReason } from "@kept/shared";
import { z } from "zod";

/** One form control, as markup or JSX declares it. `label` is the label text, else `aria-label`, else the placeholder. */
export interface FormField {
  type: string;
  name: string | null;
  label: string | null;
}

/**
 * A form. `actionHost` is `"none"` when the action stays on the page's own
 * address (no action, relative, `#`, `javascript:`); otherwise the host it
 * posts to. Controls outside any `<form>` are gathered into one entry with
 * `method: "none"` — script-driven pages rarely use a `<form>` at all.
 */
export interface FormFacts {
  actionHost: string;
  method: string;
  fields: FormField[];
}

/** The structured half of an extraction (PRD §6.2), computed over the whole page. */
export interface PageFacts {
  /** `{slug}.{base}` — the page's own host. */
  address: string;
  title: string | null;
  description: string | null;
  headings: string[];
  buttons: string[];
  forms: FormFacts[];
  /** A password, card, CVV/CVC, expiry, IBAN, seed-phrase, private-key, one-time-code or PIN field — in markup, JSX or script. */
  secretField: boolean;
  /** Hosts that receive data: form actions, plus URL-literal hosts in script when the page makes a network call. */
  dataDestinations: string[];
  /** `secretField` and at least one data destination. */
  secretsLeavePage: boolean;
  /** A decoder or evaluator and an encoded literal ≥ 2,000 chars that is not a `data:` URI, or a packer signature. */
  obfuscated: boolean;
  /** Fetches from another host and writes HTML into the DOM. */
  insertsRemoteHtml: boolean;
  /** File names of linked or `download`-attributed executables and archives. */
  downloads: string[];
  /** The other host a meta refresh or a script `location` change sends visitors to. */
  redirectTo: string | null;
  iframes: string[];
  externalScripts: string[];
  linkHosts: string[];
  /** Visible text outside scripts and styles, in characters. */
  textChars: number;
  /** Inline script (elements and event-handler attributes), in UTF-8 bytes. */
  scriptBytes: number;
  /** The part of `scriptBytes` not parsed into an AST (over budget or unparseable); read by pattern only. */
  unparsedScriptBytes: number;
}

/**
 * What the classifier reads (D3): the facts plus sampled text. Together —
 * `JSON.stringify(facts).length + text.length` — they never exceed
 * `SCAN_TEXT_BUDGET_CHARS`.
 */
export interface Extraction {
  facts: PageFacts;
  text: string;
}

/** The `harm` question's options (PRD §6.3), in the order the classifier is asked them. */
export const HARM_CHOICES = [
  "none",
  "credential_phishing",
  "payment_harvest",
  "wallet_drainer",
  "malware_download",
  "scam",
  "sexual_content_minors",
] as const;
export type HarmChoice = (typeof HARM_CHOICES)[number];

const probability = z.number().min(0).max(1);

/** A Decisions API `noul` answer: `noul` is the probability of yes, 0–1. */
const noulAnswerSchema = z.object({ type: z.literal("noul"), noul: probability });

/**
 * The Decisions API's typed answers to the three scan questions — `harm`
 * (`choice`: the pick and the full distribution), `impersonates` and
 * `asks_for_secrets` (`noul`). Task 006 parses every response through this, so
 * a malformed answer is an error, never a guess.
 */
export const classifierAnswersSchema = z.object({
  harm: z.object({
    type: z.literal("choice"),
    choice: z.enum(HARM_CHOICES),
    probabilities: z.record(z.enum(HARM_CHOICES), probability),
  }),
  impersonates: noulAnswerSchema,
  asks_for_secrets: noulAnswerSchema,
});
export type ClassifierAnswers = z.infer<typeof classifierAnswersSchema>;

/** The policy rules of PRD §6.4, recorded as `scans.rule`. */
export type PolicyRule = "P1" | "P2" | "P3" | "P4";

/** `decide`'s verdict. `priority` is set for P2 only: it raises the priority admin alert. */
export type PolicyDecision =
  | { verdict: "clean" }
  | { verdict: "flag"; reason: ModerationReason; rule: PolicyRule; priority: boolean };
