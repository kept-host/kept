/**
 * Arun's decision on an appeal, for the e2e drills (E07 task 009, AC19): the
 * real `grantAppeal` / `rejectAppeal` that task 011's moderation screen will
 * call, run in a child process.
 *
 * WHY A CHILD PROCESS: the decisions reach `lib/publish/pipeline.ts`, whose
 * hooks import `next/server`, and Playwright's ESM loader cannot resolve that
 * bare specifier — `tsx` can. So a spec calls `decideAppeal` below, which runs
 * this file under `tsx` against the same dev database and stores.
 *
 *   tsx e2e/appeal-decision.ts <grant|reject> <appealId> <adminUserId> <note>
 *
 * Prints `{"ok":true|false}` as its last line. Not a spec: no `.spec.ts`.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Grant or reject `appealId` as `adminUserId`; whether the decision was taken. */
export function decideAppeal(verb: "grant" | "reject", appealId: string, adminUserId: string, note: string): boolean {
  const out = execFileSync("pnpm", ["exec", "tsx", SELF, verb, appealId, adminUserId, note], {
    cwd: APP_ROOT,
    encoding: "utf8",
  });
  const last = out.trim().split("\n").pop() ?? "";
  return (JSON.parse(last) as { ok: boolean }).ok;
}

async function main(argv: string[]): Promise<void> {
  const [verb, appealId, adminUserId, note] = argv;
  if ((verb !== "grant" && verb !== "reject") || !appealId || !adminUserId || !note) {
    throw new Error("usage: tsx e2e/appeal-decision.ts <grant|reject> <appealId> <adminUserId> <note>");
  }
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  const { grantAppeal, rejectAppeal } = await import("../lib/moderation/appeals");
  const { closeDb } = await import("../lib/db");
  try {
    const decided =
      verb === "grant" ? await grantAppeal(appealId, adminUserId, note) : await rejectAppeal(appealId, adminUserId, note);
    process.stdout.write(`\n${JSON.stringify({ ok: decided.ok })}\n`);
  } finally {
    await closeDb();
  }
}

if (process.argv[1] === SELF) await main(process.argv.slice(2));
