/**
 * AC34 (E07 D18), at source level: no post-commit manifest writer hard-codes
 * `status: "live"` any more.
 *
 * Reads the source of every `apps/web` module that calls `writeManifest` (or
 * `storeManifest`, its in-module twin) and fails on a `status: "live"` property
 * anywhere in it — except the ONE literal D18 keeps: `storeNewPage`, the
 * brand-new publish's store half (a replace is `storeReplacement`'s, which
 * calls `syncManifest`). A
 * replace, restore, rename or late keep that writes `live` again would undo a
 * flag committed while it was in flight; everything after a page's first
 * publish goes through `syncManifest`, which writes the row's own status.
 *
 * Pure source analysis over the TypeScript AST (comments are not nodes, so a
 * comment quoting the literal cannot trip it): no network, no database.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import ts from "typescript";

const WEB_ROOT = path.resolve(import.meta.dirname, "../..");
const SCANNED_DIRS = ["app", "lib", "components", "scripts"];
const WRITERS = new Set(["writeManifest", "storeManifest"]);
const ALLOWED = { file: "lib/publish/pipeline.ts", fn: "storeNewPage" };

/** Every non-test TypeScript module under the scanned directories. */
function sourceFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(path.join(WEB_ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
      .map((file) => path.join(dir, file)),
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
  }
  return null;
}

interface LiveLiteral {
  file: string;
  line: number;
  fn: string | null;
}

function scan(file: string): { callsWriter: boolean; live: LiveLiteral[] } {
  const text = readFileSync(path.join(WEB_ROOT, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let callsWriter = false;
  const live: LiveLiteral[] = [];

  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && WRITERS.has(node.expression.text)) {
      callsWriter = true;
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "status" &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === "live"
    ) {
      live.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        fn: enclosingFunctionName(node),
      });
    }
  });
  return { callsWriter, live };
}

test('AC34: no manifest writer hard-codes status "live" outside the brand-new publish branch', () => {
  const writers = sourceFiles()
    .map((file) => ({ file, ...scan(file) }))
    .filter((result) => result.callsWriter);

  // Not vacuous: the two modules that must write manifests are found.
  const names = writers.map((w) => w.file);
  assert.ok(names.includes("lib/storage/manifest.ts"), `manifest.ts not scanned: ${names.join(", ")}`);
  assert.ok(names.includes(ALLOWED.file), `${ALLOWED.file} not scanned: ${names.join(", ")}`);

  const violations: string[] = [];
  let allowedSeen = 0;
  for (const writer of writers) {
    for (const literal of writer.live) {
      const isAllowed = literal.file === ALLOWED.file && literal.fn === ALLOWED.fn;
      if (isAllowed) allowedSeen += 1;
      else violations.push(`${literal.file}:${literal.line} (in ${literal.fn ?? "module scope"})`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `status: "live" hard-coded in a manifest writer — use syncManifest (D18): ${violations.join("; ")}`,
  );
  assert.equal(allowedSeen, 1, "storeNewPage keeps exactly one literal, for a brand-new publish");
});
