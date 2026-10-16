/**
 * The scanner eval's pure half (E07 D5, PRD §6.6, AC13): the inert-set guard,
 * the replay of saved judgments through `decide`, the tally, the threshold
 * sweep and the results table. `scripts/eval-scanner.ts` does the I/O (pages,
 * classifier calls, judgment files) around it.
 *
 * Judgments are saved once and replayed: a threshold change never costs a new
 * classifier call (D5).
 */
import { SCAN_EVAL_HARMFUL_FLAG_RATE, type ScanThresholds } from "@kept/shared";

import type { ClassifierResult } from "./classifier";
import { decide } from "./policy";
import type { PageFacts, PolicyDecision } from "./types";

export type EvalSet = "clean" | "harmful";

/** One page as the eval reads it. `id` is `<set>/<file>`. */
export interface EvalPage {
  id: string;
  set: EvalSet;
  sha256: string;
  facts: PageFacts;
}

/** One saved classifier call: the typed result, or the error kind it failed with. */
export type Judgment = { sha256: string } & ({ result: ClassifierResult } | { error: string });

/** `judgments-<date>.json`. */
export interface JudgmentsFile {
  model: string;
  savedAt: string;
  judgments: Record<string, Judgment>;
}

export interface EvalRow {
  page: EvalPage;
  judgment: Judgment;
  decision: PolicyDecision;
}

export interface EvalSummary {
  clean: { total: number; flagged: number };
  harmful: { total: number; flagged: number };
  /** Pages whose classifier call failed — replayed with `answers = null`, as production would. */
  errors: number;
  /** Flags per rule, across both sets. */
  byRule: Record<string, number>;
  cost: number;
  /** D5: 0 clean flagged, ≥ 80% harmful flagged, and every page actually judged. */
  gate: boolean;
}

/** Every host a `//host` URL names anywhere in the page (markup, script, text) — not just the hosts the extractor surfaces. */
const URL_HOST = /(?:[a-z][a-z0-9+.-]*:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/**
 * The inert-set guard (AC13): the hosts a harmful page names that do not end in
 * `.invalid`. The eval refuses to run while any harmful page has one.
 */
export function liveHosts(html: string): string[] {
  const hosts = new Set<string>();
  for (const match of html.matchAll(URL_HOST)) {
    const host = (match[1] ?? "").toLowerCase();
    if (!host.endsWith(".invalid")) hosts.add(host);
  }
  return [...hosts];
}

/** Pages whose saved judgment is missing or was taken from different bytes — replay refuses them. */
export function staleJudgments(pages: EvalPage[], file: JudgmentsFile): string[] {
  return pages.filter((page) => file.judgments[page.id]?.sha256 !== page.sha256).map((page) => page.id);
}

/** Replays every saved judgment through `decide` under `thresholds`. Pure. */
export function replay(pages: EvalPage[], file: JudgmentsFile, thresholds: ScanThresholds): EvalRow[] {
  return pages.map((page) => {
    const judgment = file.judgments[page.id];
    if (!judgment) throw new Error(`no saved judgment for ${page.id}`);
    const answers = "result" in judgment ? judgment.result.answers : null;
    return { page, judgment, decision: decide(page.facts, answers, thresholds) };
  });
}

export function summarize(rows: EvalRow[]): EvalSummary {
  const summary: EvalSummary = {
    clean: { total: 0, flagged: 0 },
    harmful: { total: 0, flagged: 0 },
    errors: 0,
    byRule: {},
    cost: 0,
    gate: false,
  };
  for (const { page, judgment, decision } of rows) {
    const set = summary[page.set];
    set.total += 1;
    if (decision.verdict === "flag") {
      set.flagged += 1;
      summary.byRule[decision.rule] = (summary.byRule[decision.rule] ?? 0) + 1;
    }
    if ("result" in judgment) summary.cost += judgment.result.cost;
    else summary.errors += 1;
  }
  summary.gate =
    summary.errors === 0 &&
    summary.clean.flagged === 0 &&
    summary.harmful.total > 0 &&
    summary.harmful.flagged / summary.harmful.total >= SCAN_EVAL_HARMFUL_FLAG_RATE;
  return summary;
}

/** A misfire: a clean page flagged, or a harmful page left clean. */
export function isMisfire(row: EvalRow): boolean {
  return (row.decision.verdict === "flag") !== (row.page.set === "harmful");
}

const SWEEP_STEPS = Array.from({ length: 11 }, (_, i) => Math.round((0.5 + i * 0.05) * 100) / 100);

/**
 * Threshold tuning by replay: every `harm` × `impersonates` pair on a 0.05 grid
 * from 0.5 to 1.0 (`minors` held at `base.minors` — the eval has no such pages),
 * keeping the gate-passing pair that flags the most harmful pages, ties to the
 * higher (more conservative) thresholds. Null when no pair passes.
 */
export function sweep(
  pages: EvalPage[],
  file: JudgmentsFile,
  base: ScanThresholds,
): { thresholds: ScanThresholds; summary: EvalSummary } | null {
  let best: { thresholds: ScanThresholds; summary: EvalSummary } | null = null;
  for (const harm of SWEEP_STEPS) {
    for (const impersonates of SWEEP_STEPS) {
      const thresholds = { ...base, harm, impersonates };
      const summary = summarize(replay(pages, file, thresholds));
      if (!summary.gate) continue;
      const better =
        !best ||
        summary.harmful.flagged > best.summary.harmful.flagged ||
        (summary.harmful.flagged === best.summary.harmful.flagged &&
          harm + impersonates > best.thresholds.harm + best.thresholds.impersonates);
      if (better) best = { thresholds, summary };
    }
  }
  return best;
}

function topProbability(judgment: Judgment): string {
  if (!("result" in judgment)) return `error: ${judgment.error}`;
  const { harm, impersonates } = judgment.result.answers;
  return `${harm.choice} ${(harm.probabilities[harm.choice] ?? 0).toFixed(2)} · imp ${impersonates.noul.toFixed(2)}`;
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "–";
}

/** The results table (markdown): one row per page, then the totals. */
export function resultsTable(rows: EvalRow[], summary: EvalSummary): string {
  const lines = [
    "| Set | Page | Expected | Verdict | Rule | Reason | Top probability | Misfire |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    const { page, judgment, decision } = row;
    const flagged = decision.verdict === "flag";
    lines.push(
      `| ${page.set} | ${page.id.slice(page.set.length + 1)} | ${page.set === "harmful" ? "flag" : "clean"} | ${decision.verdict} | ${flagged ? decision.rule : ""} | ${flagged ? decision.reason : ""} | ${topProbability(judgment)} | ${isMisfire(row) ? "**yes**" : ""} |`,
    );
  }
  const rules = Object.entries(summary.byRule)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rule, count]) => `${rule} ${count}`)
    .join(", ");
  lines.push(
    "",
    `- Clean flagged: **${summary.clean.flagged} / ${summary.clean.total}** (gate: 0)`,
    `- Harmful flagged: **${summary.harmful.flagged} / ${summary.harmful.total} (${pct(summary.harmful.flagged, summary.harmful.total)})** (gate: ≥ ${SCAN_EVAL_HARMFUL_FLAG_RATE * 100}%)`,
    `- Flags by rule: ${rules || "none"}`,
    `- Classifier errors: ${summary.errors}`,
    `- Total cost: $${summary.cost.toFixed(6)}`,
    `- Gate (D5): **${summary.gate ? "PASS" : "FAIL"}**`,
  );
  return lines.join("\n");
}
