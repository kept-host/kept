/**
 * The static extractor (E07 D3, PRD §6.2): one page's HTML → `{ facts, text }`
 * for the classifier and the policy.
 *
 * ⚠️ IT NEVER EXECUTES ANYTHING. The markup goes through `htmlparser2` (a
 * tokenizer: no DOM, no resource loading, no script engine) and every inline
 * script through `@babel/parser` (an AST, never evaluated). Strings and JSX are
 * READ out of scripts — pages built in script would otherwise read as empty —
 * and a string that holds markup (`innerHTML = '<form …>'`) is parsed as
 * markup, never run.
 *
 * ⚠️ IT NEVER THROWS. Unparseable HTML or script degrades to what can be read
 * (edge case 6): a script that fails to parse, or that falls outside the
 * 2 s / 1 MB parse budget, is counted in `unparsedScriptBytes` and read by
 * pattern instead.
 *
 * ⚠️ FACTS COVER THE WHOLE PAGE; ONLY THE TEXT IS SAMPLED. `text` fills what the
 * facts leave of `SCAN_TEXT_BUDGET_CHARS`, in the order title + headings → form
 * context → buttons → body text → script strings. No CSS, no raw script code,
 * no email addresses.
 *
 * PURE: no network, no database, no storage. Per document — E08 runs it once
 * per set, over the one document `synthesize.ts` builds from it (D15).
 */
import { parse as parseScript, type ParserOptions } from "@babel/parser";
import type { Node } from "@babel/types";
import { SCAN_TEXT_BUDGET_CHARS } from "@kept/shared";
import { Parser } from "htmlparser2";

import type { Extraction, FormFacts, FormField, PageFacts } from "./types";

/** Babel parsing stops after this long; the rest is read by pattern (PRD §6.2). */
const PARSE_BUDGET_MS = 2000;
/** At most this much inline script (UTF-8 bytes) is parsed into an AST per page. */
const SCRIPT_PARSE_BYTES = 1024 * 1024;
/** At most this much markup found in script strings and template blocks is parsed. */
const FRAGMENT_PARSE_CHARS = 1024 * 1024;
/** Host lists keep the most frequent this many. */
const TOP_HOSTS = 20;
/** Fact caps — they keep `JSON.stringify(facts)` far inside the budget whatever the page. */
const MAX_LIST_ITEMS = 15;
const MAX_FORMS = 5;
const MAX_FIELDS = 8;
const MAX_STRING = 80;
const MAX_LABEL = 60;
const MAX_NAME = 40;
const MAX_TYPE = 20;
const MAX_HOST = 64;
/** How much text one form contributes to the form-context section. */
const FORM_TEXT_CHARS = 1000;
/** One script string's share of the text — a longer one is a blob, not a sentence. */
const MAX_SCRIPT_STRING = 500;
/** Headings and buttons gathered for the text (the facts keep `MAX_LIST_ITEMS`). */
const MAX_TEXT_ITEMS = 100;

const BABEL_OPTIONS: ParserOptions = {
  sourceType: "unambiguous",
  plugins: ["jsx"],
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
  allowUndeclaredExports: true,
  allowSuperOutsideMethod: true,
  allowNewTargetOutsideFunction: true,
  attachComment: false,
};

/** `<script type>` values that hold JavaScript (incl. in-browser Babel and modules). */
const JS_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/babel",
  "text/jsx",
]);

/** Executables and archives a phishing page pushes (`downloads[]`). */
const DOWNLOAD_EXTS =
  "exe|msi|msix|appx|dmg|pkg|apk|xapk|ipa|zip|rar|7z|tar|gz|tgz|iso|scr|bat|cmd|ps1|vbs|vbe|jse|wsf|hta|jar|lnk|deb|rpm|appimage|crx|xpi|reg";
const DOWNLOAD_EXT_RE = new RegExp(`\\.(?:${DOWNLOAD_EXTS})$`, "i");
/** A cheap pre-check before a string is parsed as a URL. */
const DOWNLOAD_HINT_RE = new RegExp(`\\.(?:${DOWNLOAD_EXTS})(?:[?#]|$)`, "i");

/**
 * Words that name a secret, matched against a field's normalised type, name,
 * id, label, placeholder, autocomplete and aria-label (camelCase and `-_.[]`
 * split into words, lowercased). Long words match inside compounds
 * (`passwordinput`); short ones only as whole words.
 */
const SECRET_RE =
  /pass ?word|passwd|passcode|card ?(number|num|no)\b|\bcc ?(num|number|csc|exp)|\bcv[cv]2?\b|\bcsc\b|security ?code|expir(y|ation)|\bexp ?(date|month|year)|\bmm ?\/ ?yy|\biban\b|routing ?number|sort ?code|seed ?(phrase|words?)|recovery ?(phrase|words?|key)|secret ?phrase|mnemonic|\b(12|24) ?words?\b|private ?key|one ?time ?(code|password|pin|passcode)|\botp\b|verification ?code|\b2fa\b|two ?factor|auth(entication)? ?code|sms ?code|\bpin\b/;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
/** Absolute URLs inside a string or a raw script. */
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>()\\]+/gi;
/** A string that carries markup worth parsing. */
const MARKUP_RE = /<[a-z][\w-]*[\s/>]/i;

/**
 * An encoded literal ≥ 2,000 chars that is not a `data:` URI (the base64 run's
 * lookbehind rejects one that follows `base64,`): base64, `\x`/`\u` escapes,
 * `%XX` runs, a long char-code array. Each lookbehind pins the match to the
 * start of a run, so a scan stays linear on a 5 MB page.
 */
const ENCODED_RES = [
  /(?<![A-Za-z0-9+/]|base64,)[A-Za-z0-9+/]{2000,}/,
  /(?<!\\x[0-9a-fA-F]{2})(?:\\x[0-9a-fA-F]{2}){500,}/,
  /(?<!\\u[0-9a-fA-F]{4})(?:\\u[0-9a-fA-F]{4}){334,}/,
  /(?<!%[0-9a-fA-F]{2})(?:%[0-9a-fA-F]{2}){667,}/,
  /(?<![\d,\s])(?:\d{2,3}\s*,\s*){500,}/,
];
/** Packer signatures: Dean Edwards' packer, JSFuck. (javascript-obfuscator: see `OBFUSCATOR_IDENT_RE`.) */
const PACKER_RES = [
  /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)/,
  /[[\]()!+]{2000,}/,
];
const OBFUSCATOR_IDENT_RE = /\b_0x[0-9a-f]{4,6}\b/g;
const OBFUSCATOR_IDENT_MIN = 20;

/** Pattern reads for script that was not parsed into an AST. */
const RAW_EVALUATOR_RE =
  /\beval\s*\(|\batob\s*\(|\bunescape\s*\(|\bFunction\s*\(|fromCharCode|document\s*\.\s*write/;
const RAW_NETWORK_RE =
  /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bWebSocket\s*\(|\bEventSource\s*\(|\.submit\s*\(|new\s+Image\b|\$\s*\.\s*(?:ajax|post|get|getJSON)\s*\(|\baxios\b/;
const RAW_SINK_RE =
  /\.\s*(?:innerHTML|outerHTML|srcdoc)\s*=[^=]|insertAdjacentHTML|document\s*\.\s*write|\.\s*html\s*\(|dangerouslySetInnerHTML/;
const RAW_REDIRECT_RE =
  /(?<![\w$])location(?:\s*\.\s*href)?\s*=\s*["'`]([^"'`\s]+)|(?<![\w$])location\s*\.\s*(?:replace|assign)\s*\(\s*["'`]([^"'`\s]+)/g;
const RAW_PASSWORD_RE = /\btype["']?\s*[:=]\s*["']password["']/i;

/** Calls (by the callee's last name) that send something over the network. */
const NETWORK_CALLS = new Set(["fetch", "sendBeacon", "ajax", "getJSON", "submit", "requestSubmit", "axios"]);
/** Constructors that open a connection (an `Image` is the classic beacon). */
const NETWORK_NEWS = new Set(["XMLHttpRequest", "WebSocket", "EventSource", "Image"]);
/** Decoders and evaluators (`document.write` is matched by path). */
const EVALUATOR_CALLS = new Set(["eval", "atob", "unescape", "Function", "fromCharCode"]);
const HTML_SINK_CALLS = new Set(["insertAdjacentHTML", "createContextualFragment", "setHTMLUnsafe"]);
const HTML_SINK_PROPS = new Set(["innerHTML", "outerHTML", "srcdoc"]);
/** `createElement`-style factories, compiled JSX included. */
const ELEMENT_FACTORIES = new Set(["createElement", "h", "jsx", "jsxs", "_jsx", "_jsxs", "jsxDEV"]);
/** Element properties whose string value is checked for a secret (`input.type = "password"`). */
const FIELD_PROPS = new Set(["type", "name", "id", "placeholder", "autocomplete", "aria-label", "ariaLabel"]);
const FIELD_SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset"]);
const BUTTON_INPUT_TYPES = new Set(["submit", "button", "image", "reset"]);
/**
 * JSX attributes whose string is not read as script text: links and resources
 * (the element itself records them — they are not places data goes) and styling.
 */
const JSX_SKIP_STRING_ATTRS = new Set(["href", "src", "srcSet", "poster", "cite", "className", "class", "style"]);
const AST_SKIP_KEYS = new Set(["loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments", "errors", "comments", "tokens"]);

/** One element, from markup or from script (JSX, `createElement`, markup in a string). */
interface El {
  tag: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

type Origin = "markup" | "script";

interface FieldRef {
  el: El;
  form: FormRef | null;
  label: El | null;
}

interface FormRef {
  el: El | null;
  actionHost: string;
  method: string;
  fields: { field: FormField; secret: boolean }[];
}

interface Collector {
  address: string;
  base: string;
  title: string | null;
  description: string | null;
  headings: string[];
  buttons: string[];
  forms: FormRef[];
  fields: FieldRef[];
  labels: El[];
  bodyText: string[];
  bodyChars: number;
  scriptText: string[];
  scriptTextSeen: Set<string>;
  scriptChars: number;
  scripts: string[];
  fragmentChars: number;
  secretAssigned: boolean;
  formHosts: Map<string, number>;
  stringHosts: Map<string, number>;
  linkHosts: Map<string, number>;
  iframes: Map<string, number>;
  externalScripts: Map<string, number>;
  downloads: Set<string>;
  redirectTo: string | null;
  network: boolean;
  evaluator: boolean;
  encoded: boolean;
  packer: boolean;
  htmlSink: boolean;
  remoteHtmx: boolean;
  textChars: number;
  scriptBytes: number;
  unparsedScriptBytes: number;
}

function newCollector(address: string): Collector {
  const host = address.trim().toLowerCase();
  return {
    address: host,
    base: `https://${host}/`,
    title: null,
    description: null,
    headings: [],
    buttons: [],
    forms: [],
    fields: [],
    labels: [],
    bodyText: [],
    bodyChars: 0,
    scriptText: [],
    scriptTextSeen: new Set(),
    scriptChars: 0,
    scripts: [],
    fragmentChars: 0,
    secretAssigned: false,
    formHosts: new Map(),
    stringHosts: new Map(),
    linkHosts: new Map(),
    iframes: new Map(),
    externalScripts: new Map(),
    downloads: new Set(),
    redirectTo: null,
    network: false,
    evaluator: false,
    encoded: false,
    packer: false,
    htmlSink: false,
    remoteHtmx: false,
    textChars: 0,
    scriptBytes: 0,
    unparsedScriptBytes: 0,
  };
}

export function extract(html: string, address: string): Extraction {
  const started = performance.now();
  const c = newCollector(address);
  try {
    analyseTree(parseHtml(html), c, "markup");
    parseScripts(c, started);
  } catch {
    // Degrade (edge case 6): whatever was collected before the failure stands.
  }
  try {
    return finish(c);
  } catch {
    return finish(newCollector(address));
  }
}

// ── strings ──────────────────────────────────────────────────────────────────

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Whitespace-collapsed, emails redacted, capped. */
function clean(s: string, max: number): string {
  return collapse(s).replace(EMAIL_RE, "[email]").slice(0, max);
}

function cleanOrNull(s: string | undefined, max: number): string | null {
  if (s === undefined) return null;
  return clean(s, max) || null;
}

/** `cardNumber` / `card_number` / `cc-number` → `card number` / `cc number`. */
function normaliseWords(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .toLowerCase();
}

function namesSecret(values: (string | undefined)[]): boolean {
  return values.some((v) => v !== undefined && SECRET_RE.test(normaliseWords(v)));
}

// ── URLs and hosts ───────────────────────────────────────────────────────────

/** The host of an absolute or protocol-relative http(s)/ws(s) URL; `null` for relative and other schemes. */
function hostOf(url: string, c: Collector): string | null {
  const value = url.trim();
  if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value, c.base);
    if (!/^(?:https?|wss?):$/.test(parsed.protocol)) return null;
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** A host other than the page's own address, else `null`. */
function otherHost(url: string, c: Collector): string | null {
  const host = hostOf(url, c);
  return host && host !== c.address ? host : null;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_HOSTS)
    .map(([host]) => host.slice(0, MAX_HOST));
}

/** Records `url` (or a bare file name) when it names an executable or archive. */
function noteDownload(url: string, c: Collector): void {
  const value = url.trim();
  if (!value || value.length > 2048 || /\s/.test(value) || !DOWNLOAD_HINT_RE.test(value)) return;
  let name = value;
  try {
    name = new URL(value, c.base).pathname.split("/").pop() ?? "";
  } catch {
    name = value.split(/[?#]/)[0]?.split("/").pop() ?? "";
  }
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the encoded name
  }
  if (DOWNLOAD_EXT_RE.test(name)) c.downloads.add(clean(name, MAX_STRING));
}

function noteRedirect(url: string, c: Collector): void {
  const host = otherHost(url, c);
  if (host && !c.redirectTo) c.redirectTo = host;
  noteDownload(url, c);
}

// ── markup ───────────────────────────────────────────────────────────────────

function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const current = () => stack[stack.length - 1] ?? root;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const el: El = { tag: name, attrs: attribs, children: [] };
        current().children.push(el);
        stack.push(el);
      },
      ontext(data) {
        current().children.push(data);
      },
      onclosetag() {
        if (stack.length > 1) stack.pop();
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return root;
}

/** Markup found in a script string or a template block — parsed, never run, within its own budget. */
function analyseFragment(markup: string, c: Collector): void {
  if (c.fragmentChars + markup.length > FRAGMENT_PARSE_CHARS) return;
  c.fragmentChars += markup.length;
  analyseTree(parseHtml(markup), c, "script");
}

function isFieldTag(tag: string): boolean {
  return tag !== "fieldset" && /input|field|textarea|select/.test(tag);
}

function isHeading(el: El): boolean {
  return /^h[1-6]$/.test(el.tag) || el.attrs.role === "heading";
}

function isButton(el: El): boolean {
  return el.tag === "button" || el.attrs.role === "button";
}

/** The visible text of an element's subtree (plus field placeholders), up to `limit` chars. */
function textOf(el: El, limit: number): string {
  let out = "";
  const stack: (El | string)[] = [el];
  while (stack.length > 0 && out.length < limit) {
    const node = stack.pop();
    if (node === undefined) break;
    if (typeof node === "string") {
      out += ` ${node}`;
      continue;
    }
    if (node !== el && (node.tag === "script" || node.tag === "style" || node.tag === "title")) continue;
    if (isFieldTag(node.tag)) {
      const hint = node.attrs.placeholder ?? node.attrs["aria-label"];
      if (hint) out += ` ${hint}`;
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return clean(out, limit);
}

interface WalkContext {
  form: FormRef | null;
  label: El | null;
  /** Text here belongs to the body (not a heading, button, form or title). */
  body: boolean;
}

/** One pass over a tree: every fact markup can carry, and the text sections. */
function analyseTree(root: El, c: Collector, origin: Origin): void {
  const stack: [El | string, WalkContext][] = [[root, { form: null, label: null, body: true }]];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const [node, ctx] = item;

    if (typeof node === "string") {
      if (origin === "markup") {
        const text = collapse(node);
        c.textChars += text.length;
        if (ctx.body && text && c.bodyChars < SCAN_TEXT_BUDGET_CHARS) {
          const cleaned = clean(text, SCAN_TEXT_BUDGET_CHARS);
          c.bodyText.push(cleaned);
          c.bodyChars += cleaned.length + 1;
        }
      } else if (ctx.body) {
        addScriptText(node, c);
      }
      continue;
    }

    const next = visitElement(node, ctx, c, origin);
    if (next === null) continue;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child !== undefined) stack.push([child, next]);
    }
  }
}

/** Records one element's facts; returns the context for its children, or `null` to skip them. */
function visitElement(el: El, ctx: WalkContext, c: Collector, origin: Origin): WalkContext | null {
  const { tag, attrs } = el;
  if (origin === "markup") visitAttributes(el, c);

  switch (tag) {
    case "script":
      if (attrs.src) {
        const host = otherHost(attrs.src, c);
        if (host) bump(c.externalScripts, host);
      }
      if (origin === "markup") visitScriptElement(el, c);
      return null;
    case "style":
      return null;
    case "title":
      if (!c.title) c.title = textOf(el, MAX_STRING) || null;
      return null;
    case "meta":
      visitMeta(attrs, c);
      return null;
    case "a":
    case "area":
      if (attrs.href !== undefined) {
        const host = otherHost(attrs.href, c);
        if (host) bump(c.linkHosts, host);
        noteDownload(attrs.href, c);
      }
      if (attrs.download !== undefined) noteDownload(attrs.download || attrs.href || "", c);
      break;
    case "iframe":
    case "frame":
    case "embed":
    case "object": {
      const src = attrs.src ?? attrs.data;
      const host = src ? otherHost(src, c) : null;
      if (host) bump(c.iframes, host);
      break;
    }
    case "form": {
      const action = attrs.action ?? "";
      const form: FormRef = {
        el,
        actionHost: otherHost(action, c) ?? "none",
        method: clean(attrs.method ?? "get", MAX_TYPE).toLowerCase() || "get",
        fields: [],
      };
      c.forms.push(form);
      return { form, label: ctx.label, body: false };
    }
    case "label":
      c.labels.push(el);
      return { form: ctx.form, label: el, body: ctx.body };
  }

  const type = (attrs.type ?? "").toLowerCase();
  if (tag === "input" && BUTTON_INPUT_TYPES.has(type)) {
    const text = cleanOrNull(attrs.value ?? attrs.alt ?? attrs["aria-label"], MAX_STRING);
    if (text && c.buttons.length < MAX_TEXT_ITEMS) c.buttons.push(text);
    return null;
  }
  if (isFieldTag(tag)) {
    c.fields.push({ el, form: ctx.form, label: ctx.label });
    return { ...ctx, body: false };
  }
  if (isHeading(el)) {
    const text = textOf(el, MAX_STRING);
    if (text && c.headings.length < MAX_TEXT_ITEMS) c.headings.push(text);
    return { ...ctx, body: false };
  }
  if (isButton(el)) {
    const text = textOf(el, MAX_STRING) || cleanOrNull(attrs["aria-label"], MAX_STRING);
    if (text && c.buttons.length < MAX_TEXT_ITEMS) c.buttons.push(text);
    return { ...ctx, body: false };
  }
  return ctx;
}

/** Attributes that act, on markup elements: handlers, `javascript:` URLs, `formaction`, htmx. */
function visitAttributes(el: El, c: Collector): void {
  for (const [name, value] of Object.entries(el.attrs)) {
    if (!value) continue;
    if (name.startsWith("on")) {
      c.scripts.push(value);
    } else if ((name === "href" || name === "action") && /^\s*javascript:/i.test(value)) {
      c.scripts.push(value.replace(/^\s*javascript:/i, ""));
    } else if (name === "formaction" || name === "hx-post" || name === "hx-put" || name === "hx-patch") {
      const host = otherHost(value, c);
      if (host) bump(c.formHosts, host);
    } else if (name === "hx-get") {
      if (otherHost(value, c)) c.remoteHtmx = true;
    }
  }
}

function visitMeta(attrs: Record<string, string>, c: Collector): void {
  const name = (attrs.name ?? attrs.property ?? "").toLowerCase();
  if (!c.description && (name === "description" || name === "og:description")) {
    c.description = cleanOrNull(attrs.content, MAX_STRING * 2);
  }
  if ((attrs["http-equiv"] ?? "").toLowerCase() === "refresh") {
    const match = /url\s*=\s*['"]?([^'"\s;]+)/i.exec(attrs.content ?? "");
    if (match?.[1]) noteRedirect(match[1], c);
  }
}

function visitScriptElement(el: El, c: Collector): void {
  const source = el.children.filter((child): child is string => typeof child === "string").join("");
  if (!source.trim()) return;
  const type = (el.attrs.type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (JS_TYPES.has(type)) {
    c.scripts.push(source);
  } else if (type.includes("template") || type === "text/html") {
    analyseFragment(source, c);
  } else {
    // A data block (JSON, text/plain…) — a payload a decoder elsewhere could read.
    scanEncoding(source, c);
  }
}

// ── scripts ──────────────────────────────────────────────────────────────────

function parseScripts(c: Collector, started: number): void {
  let parsedBytes = 0;
  for (const source of c.scripts) {
    const bytes = Buffer.byteLength(source, "utf8");
    c.scriptBytes += bytes;
    scanEncoding(source, c);
    const inBudget = performance.now() - started <= PARSE_BUDGET_MS && parsedBytes + bytes <= SCRIPT_PARSE_BYTES;
    if (inBudget) parsedBytes += bytes;
    if (!inBudget || !analyseScript(source, c)) {
      c.unparsedScriptBytes += bytes;
      scanRaw(source, c);
    }
  }
}

/** Encoded literals and packer signatures, by pattern over the source — parsed or not. */
function scanEncoding(source: string, c: Collector): void {
  if (!c.encoded && ENCODED_RES.some((re) => re.test(source))) c.encoded = true;
  if (!c.packer) {
    const idents = new Set(source.match(OBFUSCATOR_IDENT_RE));
    if (idents.size >= OBFUSCATOR_IDENT_MIN || PACKER_RES.some((re) => re.test(source))) c.packer = true;
  }
}

/** The pattern read of a script that was not parsed (edge case 6). */
function scanRaw(source: string, c: Collector): void {
  if (RAW_EVALUATOR_RE.test(source)) c.evaluator = true;
  if (RAW_NETWORK_RE.test(source)) c.network = true;
  if (RAW_SINK_RE.test(source)) c.htmlSink = true;
  if (RAW_PASSWORD_RE.test(source)) c.secretAssigned = true;
  for (const url of source.match(URL_RE) ?? []) {
    const host = otherHost(url, c);
    if (host) bump(c.stringHosts, host);
    noteDownload(url, c);
  }
  for (const match of source.matchAll(RAW_REDIRECT_RE)) {
    const url = match[1] ?? match[2];
    if (url) noteRedirect(url, c);
  }
}

/** Parses one script into an AST and reads it. `false` when Babel gives up. */
function analyseScript(source: string, c: Collector): boolean {
  let program: Node;
  try {
    program = parseScript(source, BABEL_OPTIONS).program;
  } catch {
    return false;
  }
  const converted = new WeakSet<Node>();
  const skipStrings = new WeakSet<Node>();
  const stack: Node[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    visitNode(node, c, converted, skipStrings);
    for (const key in node) {
      if (AST_SKIP_KEYS.has(key)) continue;
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) if (isNode(value[i])) stack.push(value[i]);
      } else if (isNode(value)) {
        stack.push(value);
      }
    }
  }
  return true;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function visitNode(node: Node, c: Collector, converted: WeakSet<Node>, skipStrings: WeakSet<Node>): void {
  switch (node.type) {
    case "StringLiteral":
      if (!skipStrings.has(node)) visitString(node.value, c);
      return;
    case "TemplateLiteral":
      visitString(node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(""), c);
      return;
    case "JSXElement":
      if (!converted.has(node)) {
        const el = jsxToEl(node, converted, 0);
        if (el) analyseTree(el, c, "script");
      }
      return;
    case "JSXAttribute":
      if (node.name.type === "JSXIdentifier") {
        if (node.name.name === "dangerouslySetInnerHTML") c.htmlSink = true;
        if (JSX_SKIP_STRING_ATTRS.has(node.name.name) && node.value) {
          skipStrings.add(node.value);
          if (node.value.type === "JSXExpressionContainer") skipStrings.add(node.value.expression);
        }
      }
      return;
    case "NewExpression": {
      const name = lastName(pathOf(node.callee));
      if (name === "Function") c.evaluator = true;
      if (name && NETWORK_NEWS.has(name)) c.network = true;
      return;
    }
    case "CallExpression":
    case "OptionalCallExpression":
      visitCall(node.callee, node.arguments, c);
      return;
    case "AssignmentExpression":
      visitAssignment(node.left, node.right, c);
      return;
    case "ObjectProperty": {
      // Props handed to any element helper, however a bundler renamed it: `{ type: "password" }`.
      const key = node.key.type === "Identifier" ? node.key.name : node.key.type === "StringLiteral" ? node.key.value : "";
      if (key === "type" || key === "autocomplete") visitPropertyWrite(key, staticString(node.value), c);
      return;
    }
  }
}

function visitString(value: string, c: Collector): void {
  if (!value) return;
  for (const url of value.match(URL_RE) ?? []) {
    const host = otherHost(url, c);
    if (host) bump(c.stringHosts, host);
  }
  if (value.startsWith("//")) {
    const host = otherHost(value, c);
    if (host) bump(c.stringHosts, host);
  }
  if (value.length < 2048 && !/\s/.test(value)) noteDownload(value, c);
  if (MARKUP_RE.test(value) && value.includes(">")) {
    analyseFragment(value, c);
    return;
  }
  addScriptText(value, c);
}

/** A human-looking string from script into the last text section — never code, CSS or a token. */
function addScriptText(value: string, c: Collector): void {
  if (c.scriptChars >= SCAN_TEXT_BUDGET_CHARS) return;
  const text = clean(value, MAX_SCRIPT_STRING);
  if (text.length < 3 || !/\p{L}/u.test(text) || /[{}]/.test(text)) return;
  if (!/\s/.test(text) && (text.length > 40 || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text))) return;
  if (c.scriptTextSeen.has(text)) return;
  c.scriptTextSeen.add(text);
  c.scriptText.push(text);
  c.scriptChars += text.length + 1;
}

/** `a.b.c` for an identifier/member chain; an unknown root is `*` (`*.innerHTML`). */
function pathOf(node: Node): string | null {
  const parts: string[] = [];
  let current: Node = node;
  for (let depth = 0; depth < 12; depth++) {
    if (current.type === "Identifier") return [current.name, ...parts].join(".");
    if (current.type === "ThisExpression") return ["this", ...parts].join(".");
    if (current.type === "MemberExpression" || current.type === "OptionalMemberExpression") {
      const prop = propName(current);
      if (prop === null) return parts.length > 0 ? ["*", ...parts].join(".") : null;
      parts.unshift(prop);
      current = current.object;
      continue;
    }
    break;
  }
  return parts.length > 0 ? ["*", ...parts].join(".") : null;
}

function propName(node: Node): string | null {
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "StringLiteral") return node.property.value;
  return null;
}

function lastName(path: string | null): string | null {
  return path === null ? null : (path.split(".").pop() ?? null);
}

function isLocationPath(path: string): boolean {
  return /(?:^|\.)location(?:\.href)?$/.test(path);
}

function isDocumentWrite(path: string): boolean {
  return /(?:^|\.)document\.writeln?$/.test(path);
}

/** Markup written from a literal is the page's own, not fetched — only a computed value counts as a sink. */
function isLiteral(node: Node): boolean {
  return node.type === "StringLiteral" || (node.type === "TemplateLiteral" && node.expressions.length === 0);
}

/** A string an expression certainly starts with: literal, template prefix, `"…" + x`. */
function staticString(node: Node | undefined, depth = 0): string | null {
  if (!node || depth > 8) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral") return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("");
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = node.left.type === "PrivateName" ? null : staticString(node.left, depth + 1);
    const right = staticString(node.right, depth + 1);
    return left === null && right === null ? null : `${left ?? ""}${right ?? ""}`;
  }
  return null;
}

function visitCall(callee: Node, args: Node[], c: Collector): void {
  const path = pathOf(callee) ?? "";
  const name = lastName(path) ?? "";
  const first = staticString(args[0]);

  if (NETWORK_CALLS.has(name) || /^(?:\$|jQuery|axios)\.(?:post|get|put|request)$/.test(path)) c.network = true;
  if (EVALUATOR_CALLS.has(name) || isDocumentWrite(path)) c.evaluator = true;
  const written = name === "insertAdjacentHTML" ? args[1] : args[0];
  if ((HTML_SINK_CALLS.has(name) || isDocumentWrite(path) || name === "html") && written && !isLiteral(written)) {
    c.htmlSink = true;
  }
  if (name === "load" && first !== null && hostOf(first, c)) {
    c.network = true;
    c.htmlSink = true;
  }
  if (/(?:^|\.)location\.(?:replace|assign)$/.test(path) && first !== null) noteRedirect(first, c);
  if (name === "setAttribute") visitPropertyWrite(first ?? "", staticString(args[1]), c);

  const isFactory = name === "createElement" || (callee.type === "Identifier" && ELEMENT_FACTORIES.has(name));
  const [tagArg, props] = args;
  if (isFactory && tagArg?.type === "StringLiteral" && props?.type === "ObjectExpression") {
    analyseTree(factoryToEl(tagArg.value, props, args.slice(2)), c, "script");
  }
}

function visitAssignment(left: Node, right: Node, c: Collector): void {
  const path = pathOf(left);
  if (path === null) return;
  const name = lastName(path) ?? "";
  const value = staticString(right);
  if (HTML_SINK_PROPS.has(name) && !isLiteral(right)) c.htmlSink = true;
  if (value === null) return;
  if (isLocationPath(path)) noteRedirect(value, c);
  else if (path === "document.title" && !c.title) c.title = cleanOrNull(value, MAX_STRING);
  else visitPropertyWrite(name, value, c);
}

/** `el.type = "password"`, `el.setAttribute("placeholder", "Card number")`, `form.action = "https://…"`. */
function visitPropertyWrite(name: string, value: string | null, c: Collector): void {
  if (value === null) return;
  if (name === "action" || name === "formAction" || name === "formaction") {
    const host = otherHost(value, c);
    if (host) bump(c.formHosts, host);
  } else if (FIELD_PROPS.has(name)) {
    if ((name === "type" && value.toLowerCase() === "password") || (name !== "type" && namesSecret([value]))) {
      c.secretAssigned = true;
    }
  }
}

// ── JSX and element factories → El ───────────────────────────────────────────

const JSX_MAX_DEPTH = 100;

function jsxName(node: Node): string | null {
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression") return node.property.name;
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  return null;
}

/** JSX attribute names to their HTML spelling, so one analyser reads both. */
function htmlAttrName(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  if (/^(?:aria|data)[A-Z]/.test(name)) return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
  return name.toLowerCase();
}

function jsxToEl(node: Node, converted: WeakSet<Node>, depth: number): El | null {
  if (node.type !== "JSXElement") return null;
  converted.add(node);
  const name = jsxName(node.openingElement.name);
  if (name === null) return null;
  const attrs: Record<string, string> = {};
  for (const attr of node.openingElement.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    const attrName = attr.name.type === "JSXIdentifier" ? attr.name.name : attr.name.name.name;
    const value = attr.value;
    let text = "";
    if (value?.type === "StringLiteral") text = value.value;
    else if (value?.type === "JSXExpressionContainer" && value.expression.type !== "JSXEmptyExpression") {
      text = staticString(value.expression) ?? "";
    }
    attrs[htmlAttrName(attrName)] = text;
  }
  const el: El = { tag: name.toLowerCase(), attrs, children: [] };
  if (depth < JSX_MAX_DEPTH) jsxChildren(node.children, el, converted, depth);
  return el;
}

function jsxChildren(children: Node[], el: El, converted: WeakSet<Node>, depth: number): void {
  for (const child of children) {
    if (child.type === "JSXText") el.children.push(child.value);
    else if (child.type === "JSXElement") {
      const nested = jsxToEl(child, converted, depth + 1);
      if (nested) el.children.push(nested);
    } else if (child.type === "JSXFragment") jsxChildren(child.children, el, converted, depth + 1);
    else if (child.type === "JSXExpressionContainer" && child.expression.type !== "JSXEmptyExpression") {
      const text = staticString(child.expression);
      if (text !== null) el.children.push(text);
    }
  }
}

/** `createElement("input", { type: "password" }, "child")` → El. Nested factory calls are read on their own. */
function factoryToEl(tag: string, props: Node, rest: Node[]): El {
  const el: El = { tag: tag.toLowerCase(), attrs: {}, children: [] };
  if (props.type === "ObjectExpression") {
    for (const prop of props.properties) {
      if (prop.type !== "ObjectProperty") continue;
      const key =
        prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : null;
      if (key === null) continue;
      const value = staticString(prop.value);
      if (key === "children") {
        if (value !== null) el.children.push(value);
      } else {
        el.attrs[htmlAttrName(key)] = value ?? "";
      }
    }
  }
  for (const child of rest) {
    const text = staticString(child);
    if (text !== null) el.children.push(text);
  }
  return el;
}

// ── assembly ─────────────────────────────────────────────────────────────────

function resolveFields(c: Collector): { orphans: FormRef; secretField: boolean } {
  const labelFor = new Map<string, El>();
  for (const label of c.labels) {
    const target = label.attrs.for;
    if (target && !labelFor.has(target)) labelFor.set(target, label);
  }
  const orphans: FormRef = { el: null, actionHost: "none", method: "none", fields: [] };
  let secretField = c.secretAssigned;
  for (const ref of c.fields) {
    const { attrs, tag } = ref.el;
    const type = (attrs.type ?? "").toLowerCase() || (tag === "textarea" || tag === "select" ? tag : "text");
    if (FIELD_SKIP_TYPES.has(type)) continue;
    const labelEl = (attrs.id ? labelFor.get(attrs.id) : undefined) ?? ref.label;
    const labelText = labelEl ? textOf(labelEl, MAX_LABEL) : "";
    const secret =
      type === "password" ||
      namesSecret([
        tag,
        attrs.name,
        attrs.id,
        attrs.placeholder,
        attrs.autocomplete,
        attrs["aria-label"],
        attrs.title,
        labelText,
      ]);
    if (secret) secretField = true;
    const field: FormField = {
      type: clean(type, MAX_TYPE),
      name: cleanOrNull(attrs.name ?? attrs.id, MAX_NAME),
      label: labelText || cleanOrNull(attrs["aria-label"] ?? attrs.placeholder, MAX_LABEL),
    };
    (ref.form ?? orphans).fields.push({ field, secret });
  }
  return { orphans, secretField };
}

function rankForms(forms: FormRef[]): FormRef[] {
  const score = (f: FormRef) => (f.fields.some((x) => x.secret) ? 2 : f.fields.length > 0 ? 1 : 0);
  return forms
    .map((form, index) => ({ form, index }))
    .sort((a, b) => score(b.form) - score(a.form) || a.index - b.index)
    .map(({ form }) => form);
}

function toFormFacts(form: FormRef): FormFacts {
  const secretFirst = [...form.fields.filter((f) => f.secret), ...form.fields.filter((f) => !f.secret)];
  return {
    actionHost: form.actionHost.slice(0, MAX_HOST),
    method: form.method,
    fields: secretFirst.slice(0, MAX_FIELDS).map((f) => f.field),
  };
}

function finish(c: Collector): Extraction {
  const { orphans, secretField } = resolveFields(c);
  const forms = rankForms(orphans.fields.length > 0 ? [...c.forms, orphans] : c.forms);

  const destinations = new Map(c.formHosts);
  for (const form of c.forms) if (form.actionHost !== "none") bump(destinations, form.actionHost);
  if (c.network) for (const [host, count] of c.stringHosts) destinations.set(host, (destinations.get(host) ?? 0) + count);
  const dataDestinations = top(destinations);

  const facts: PageFacts = {
    address: c.address,
    title: c.title,
    description: c.description,
    headings: c.headings.slice(0, MAX_LIST_ITEMS),
    buttons: c.buttons.slice(0, MAX_LIST_ITEMS),
    forms: forms.slice(0, MAX_FORMS).map(toFormFacts),
    secretField,
    dataDestinations,
    secretsLeavePage: secretField && dataDestinations.length > 0,
    obfuscated: c.packer || (c.evaluator && c.encoded),
    insertsRemoteHtml: c.remoteHtmx || (c.network && c.htmlSink && c.stringHosts.size > 0),
    downloads: [...c.downloads].slice(0, TOP_HOSTS),
    redirectTo: c.redirectTo?.slice(0, MAX_HOST) ?? null,
    iframes: top(c.iframes),
    externalScripts: top(c.externalScripts),
    linkHosts: top(c.linkHosts),
    textChars: c.textChars,
    scriptBytes: c.scriptBytes,
    unparsedScriptBytes: c.unparsedScriptBytes,
  };
  const room = SCAN_TEXT_BUDGET_CHARS - JSON.stringify(facts).length;
  return { facts, text: assembleText(c, forms, room) };
}

/** Fills `room` characters in the PRD's order; whatever does not fit is dropped. */
function assembleText(c: Collector, forms: FormRef[], room: number): string {
  let out = "";
  const add = (line: string): boolean => {
    if (!line) return out.length < room;
    const piece = out ? `\n${line}` : line;
    out += piece.slice(0, Math.max(0, room - out.length));
    return out.length < room;
  };
  const sections: (() => Iterable<string>)[] = [
    () => [c.title ?? "", c.description ?? "", ...c.headings],
    () =>
      forms.map((form) =>
        form.el ? textOf(form.el, FORM_TEXT_CHARS) : form.fields.map((f) => f.field.label ?? "").join(" · "),
      ),
    () => c.buttons,
    () => [c.bodyText.join(" ")],
    () => c.scriptText,
  ];
  if (room <= 0) return "";
  for (const section of sections) {
    for (const line of section()) if (!add(line)) return out;
  }
  return out;
}
