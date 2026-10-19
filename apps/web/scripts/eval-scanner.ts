/**
 * The scanner eval (E07 D5, PRD §6.6, AC13) — manual, calls the real classifier.
 *
 *   pnpm --filter @kept/web eval:scanner                      classify every page once, save the judgments
 *   pnpm --filter @kept/web eval:scanner --replay [file]      replay saved judgments (latest by default), no calls
 *   … --thresholds harm=0.75,impersonates=0.6,minors=0.5      replay under candidate thresholds
 *
 * Sets: the clean set is public (`apps/web/eval/scanner/clean/`, ≥ 60); the
 * harmful set lives only in `.agent/eval/scanner/harmful/` (gitignored, ≥ 8 —
 * Arun 2026-10-16, D-70: a few inert pages, not the PRD's 40)
 * and must be inert — the run refuses while any harmful page names a host that
 * is not `.invalid`. Judgments go to `.agent/eval/scanner/judgments-<date>.json`
 * and the table to `.agent/eval/scanner/results-<date>.md` for Arun's sign-off.
 * The thresholds the gate passes with are committed to `SCAN_THRESHOLDS` by hand.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SCAN_THRESHOLDS, type ScanThresholds } from "@kept/shared";
import { config } from "dotenv";

import { ClassifierError, defaultClassifier, type ContentClassifier } from "../lib/scan/classifier";
import {
  liveHosts,
  replay,
  resultsTable,
  staleJudgments,
  summarize,
  sweep,
  type EvalPage,
  type EvalSet,
  type JudgmentsFile,
} from "../lib/scan/eval";
import { extract } from "../lib/scan/extract";

config({ path: ".env.local", quiet: true });

const CLEAN_DIR = fileURLToPath(new URL("../eval/scanner/clean/", import.meta.url));
const AGENT_DIR = fileURLToPath(new URL("../../../.agent/eval/scanner/", import.meta.url));
const HARMFUL_DIR = `${AGENT_DIR}harmful/`;
const MIN_PAGES: Record<EvalSet, number> = { clean: 60, harmful: 8 };

interface Args {
  replay: string | true | null;
  thresholds: ScanThresholds;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { replay: null, thresholds: SCAN_THRESHOLDS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--replay") {
      const next = argv[i + 1];
      args.replay = next && !next.startsWith("--") ? (i++, next) : true;
    } else if (arg === "--thresholds") {
      const overrides: Record<string, number> = {};
      for (const pair of (argv[++i] ?? "").split(",")) {
        const [key = "", value] = pair.split("=");
        overrides[key] = Number(value);
      }
      for (const [key, value] of Object.entries(overrides)) {
        if (!(key in SCAN_THRESHOLDS) || !(value >= 0 && value <= 1)) {
          throw new Error(`--thresholds: "${key}=${value}" — expected harm|minors|impersonates=<0..1>`);
        }
      }
      args.thresholds = { ...SCAN_THRESHOLDS, ...overrides };
    } else if (arg !== "--") {
      throw new Error(`unknown argument "${arg}" — see the header of scripts/eval-scanner.ts`);
    }
  }
  return args;
}

function loadSet(set: EvalSet, dir: string): { page: EvalPage; html: string }[] {
  const files = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".html")).sort() : [];
  if (files.length < MIN_PAGES[set]) {
    throw new Error(`the ${set} set needs ≥ ${MIN_PAGES[set]} pages in ${dir}; found ${files.length}`);
  }
  return files.map((file) => {
    const html = readFileSync(`${dir}${file}`, "utf8");
    const sha256 = createHash("sha256").update(html).digest("hex");
    // A generated-name-shaped address on the real suffix, as a live scan would see it.
    const facts = extract(html, `${sha256.slice(0, 8)}.kept.host`).facts;
    return { page: { id: `${set}/${file}`, set, sha256, facts }, html };
  });
}

function latestJudgments(): string {
  const files = existsSync(AGENT_DIR) ? readdirSync(AGENT_DIR).filter((f) => /^judgments-.*\.json$/.test(f)).sort() : [];
  const latest = files.at(-1);
  if (!latest) throw new Error(`--replay: no judgments-*.json in ${AGENT_DIR} — run once without --replay first`);
  return `${AGENT_DIR}${latest}`;
}

async function classifyAll(classifier: ContentClassifier, loaded: { page: EvalPage; html: string }[]): Promise<JudgmentsFile> {
  const file: JudgmentsFile = { model: classifier.model, savedAt: new Date().toISOString(), judgments: {} };
  for (const [index, { page, html }] of loaded.entries()) {
    const address = page.facts.address;
    try {
      const result = await classifier.classify(extract(html, address));
      file.judgments[page.id] = { sha256: page.sha256, result };
      console.error(`[${index + 1}/${loaded.length}] ${page.id} → ${result.answers.harm.choice}`);
    } catch (err) {
      if (!(err instanceof ClassifierError)) throw err;
      // Out of credit or refused: every later call fails the same way — stop instead of burning the run.
      if (err.kind === "credit_limit" || err.kind === "rejected") throw err;
      file.judgments[page.id] = { sha256: page.sha256, error: err.kind };
      console.error(`[${index + 1}/${loaded.length}] ${page.id} → ${err.kind}: ${err.message}`);
    }
  }
  return file;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const classifier = args.replay ? null : defaultClassifier();
  if (!args.replay && !classifier) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — the eval calls the real classifier. Set it in apps/web/.env.local, " +
        "or pass --replay to re-run saved judgments.",
    );
  }

  const loaded = [...loadSet("clean", CLEAN_DIR), ...loadSet("harmful", HARMFUL_DIR)];
  const live = loaded.filter(({ page }) => page.set === "harmful").map(({ page, html }) => [page.id, liveHosts(html)] as const);
  const unsafe = live.filter(([, hosts]) => hosts.length > 0);
  if (unsafe.length > 0) {
    throw new Error(
      `the harmful set must be inert — these pages name hosts that are not .invalid:\n` +
        unsafe.map(([id, hosts]) => `  ${id}: ${hosts.join(", ")}`).join("\n"),
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  let judgments: JudgmentsFile;
  if (classifier) {
    judgments = await classifyAll(classifier, loaded);
    mkdirSync(AGENT_DIR, { recursive: true });
    const path = `${AGENT_DIR}judgments-${date}.json`;
    writeFileSync(path, `${JSON.stringify(judgments, null, 2)}\n`);
    console.error(`judgments saved: ${path}`);
  } else {
    const path = args.replay === true ? latestJudgments() : String(args.replay);
    judgments = JSON.parse(readFileSync(path, "utf8")) as JudgmentsFile;
    const pages = loaded.map(({ page }) => page);
    const stale = staleJudgments(pages, judgments);
    if (stale.length > 0) {
      throw new Error(`--replay: these pages changed or were never judged — run without --replay:\n  ${stale.join("\n  ")}`);
    }
    console.error(`replaying ${path}`);
  }

  const pages = loaded.map(({ page }) => page);
  const rows = replay(pages, judgments, args.thresholds);
  const summary = summarize(rows);
  const table = resultsTable(rows, summary);
  const best = sweep(pages, judgments, args.thresholds);
  const tuning = best
    ? `Best gate-passing thresholds on this set: harm ${best.thresholds.harm}, impersonates ${best.thresholds.impersonates} ` +
      `(harmful flagged ${best.summary.harmful.flagged} / ${best.summary.harmful.total}).`
    : "No harm × impersonates pair on the 0.5–1.0 grid passes the gate — hand to Arun (fallback model, Risk 11).";

  console.log(table);
  console.log(`\n${tuning}`);

  const results = [
    `# Scanner eval — ${date}`,
    "",
    `- Model: \`${judgments.model}\` (judgments saved ${judgments.savedAt})`,
    `- Thresholds: harm ${args.thresholds.harm}, minors ${args.thresholds.minors}, impersonates ${args.thresholds.impersonates}`,
    `- Pages: ${summary.clean.total} clean, ${summary.harmful.total} harmful`,
    "",
    table,
    "",
    tuning,
    "",
    "Sign-off (D5): ☐ Arun — 0 clean flagged, ≥ 80% harmful flagged, thresholds above go into `SCAN_THRESHOLDS`.",
    "",
  ].join("\n");
  mkdirSync(AGENT_DIR, { recursive: true });
  const resultsPath = `${AGENT_DIR}results-${date}.md`;
  writeFileSync(resultsPath, results);
  console.error(`results written: ${resultsPath}`);
  if (!summary.gate) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
