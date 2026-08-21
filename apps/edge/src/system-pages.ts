// @kept/edge — branded system pages, inlined into the Worker bundle.
//
// This file is the SOLE owner of the `SystemPage` union, the copy, and the HTTP
// status for every non-live serving state. Nothing else in the Worker decides
// what a visitor sees when a page is missing, suspended, or an expired draft.
//
// Source: `kept System Pages.dc.html` in the Claude Design project
// da93d30e-94eb-40d4-b3d1-4632870bf056. The layout and type/colour system below
// are that file's, stripped of the design-canvas scaffolding (`<x-dc>`,
// `<sc-if>`, `<sc-for>`, the JS theme toggle, the page tab switcher) and of the
// Google Fonts `<link>`.
//
// The illustration is NOT the design file's. That file drew a frosted-glass
// vessel holding an orb; it was replaced by the kept mascot (`mascot()`) on all
// three pages. The mascot is GENERATED, not authored: `@kept/shared/mascot` is
// the one implementation, shared with apps/web, and this file renders a single
// frozen instant of it at `MASCOT_REST_T` — the same instant apps/web freezes on
// under `prefers-reduced-motion`, which is what stops the two drifting apart. If
// the design file is ever re-imported, do not restore the vessel — it is retired
// everywhere, including in apps/web.
//
// ZERO EXTERNAL REQUESTS. No `<link>`, no remote font, no remote image, no
// `fetch` at render time. Every graphic here — the note icon, the lock pip and
// the mascot — is inline SVG, so there is not even a data: URI left to fetch or
// decode. An external asset on the 404 path would be both a per-request cost and
// a dependency, and this epic's premise is that the serve path depends on nothing.
//
// The retired third state — the funding-degradation page that the pre-pivot
// product used — has no template, no union member, and no code path here. The
// design file still carries its panel for reference; the Worker does not bundle
// it. The identically-named `SITE_STATUSES` value is a different symbol, baked
// into drizzle/0000_nasty_moonstone.sql, and its removal is owned by E04/E05.
//
// The design file has no `expired` panel. The PRD asks for a dimmed reading on
// the expired-draft page, which is the mascot's `dim` mood: the same artwork
// drained by a CSS filter rather than a second asset. Drained rather than
// absent, because the draft is recoverable for another DRAFT_GRACE_DAYS and the
// picture should not say "deleted".

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS } from "@kept/shared";
// The SUBPATH, never the barrel: `@kept/shared`'s index re-exports everything it
// names, and the mascot builds tables at module load. Importing it from the
// barrel would put that work on the hot path of every served page, not just the
// three that draw a character.
import { MASCOT_REST_T, mascotSvg } from "@kept/shared/mascot";

export type SystemPage = "notFound" | "suspended" | "expired";

/**
 * Extra render input. Kept as an explicit argument because the Worker's system
 * pages must never read `Env` themselves — the caller owns the bindings and
 * passes the value down. `index.ts` supplies `c.env.KEPT_APEX_ORIGIN`.
 *
 * `apexOrigin` is optional so a caller that has no env in hand (and the E00
 * skeleton call site) still type-checks; it falls back to the production apex.
 * Every real serving branch should pass the env value so dev renders dev links.
 */
export interface SystemPageOptions {
  /** Control-plane origin, no trailing slash. e.g. `https://kept.host`. */
  apexOrigin?: string;
}

/** Production control plane. Used only when the caller passes no origin. */
const DEFAULT_APEX_ORIGIN = "https://kept.host";

interface SystemPageSpec {
  /**
   * HTTP status for this state.
   *
   * STATUS CODES ARE SETTLED — reviewed and confirmed on 2026-08-03. E00 shipped
   * them as an unreviewed guess; the review kept them. Do not re-litigate:
   *   - 404 `notFound`  — nothing is published at this address.
   *   - 451 `suspended` — "Unavailable For Legal Reasons" is the honest code for
   *     a page withheld after moderation, and it is machine-distinguishable from
   *     403, which implies the requester lacks permission (they do not — nobody
   *     can see it).
   *   - 410 `expired`   — "Gone" tells crawlers to drop the URL, which is exactly
   *     right for a draft that will not come back unless someone keeps it.
   */
  status: number;
  /** `<title>` text, without the " · kept" suffix the shell appends. */
  title: string;
  /** Renders the centred `<main>` content for this state. */
  body: (apexOrigin: string) => string;
}

/* ───────────────────────────────────────────────────────────────────────────
   Tokens.

   The Worker cannot import `globals.css`, so the design tokens are inlined as
   literal values. Each one names the token it came from and matches the
   definition in apps/web/app/globals.css / .agent/System/02-design-system.md §3.
   Light is the default; the dark block is the same token set remapped, so the
   pages have full contrast parity either way a visitor's OS is set.
   ─────────────────────────────────────────────────────────────────────────── */
const TOKENS_CSS = `
:root{
  --bg:#FAF8F4;              /* --bg */
  --surface:#FFFFFF;         /* --surface */
  --surface-sunken:#F2EFE9;  /* --surface-sunken */
  --text:#1A1714;            /* --text */
  --text-secondary:#6B645C;  /* --text-secondary */
  --border:#E5E0D8;          /* --border */
  --accent:#6D4AFF;          /* --accent */
  --warning:#E0A33A;         /* --warning */
  --on-accent:#FFFFFF;       /* shadcn --color-primary-foreground */
  --shadow-sm:0 1px 2px rgba(40,30,20,0.05);   /* --shadow-sm */
  --shadow-md:0 4px 16px rgba(40,30,20,0.08);  /* --shadow-md */
  --shadow-lg:0 12px 40px rgba(40,30,20,0.12); /* --shadow-lg */
  --shadow-mascot:0 6px 14px rgba(40,30,20,0.18); /* --shadow-mascot: the blob's own, tighter and stronger than the card ramp */
  --r-sm:8px;                /* --r-sm */
  --r-md:12px;               /* --r-md */
  --r-lg:16px;               /* --r-lg */
  --r-pill:999px;            /* --r-pill */
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#131210;              /* dark --bg */
    --surface:#1E1B17;         /* dark --surface */
    --surface-sunken:#0E0D0B;  /* dark --surface-sunken */
    --text:#F5F1EA;            /* dark --text */
    --text-secondary:#A8A096;  /* dark --text-secondary */
    --border:#2A2620;          /* dark --border */
    --accent:#8B6DFF;          /* dark --accent, lifted for legibility */
    /* The dark accent is lifted, which drops white-on-violet to 3.7:1. Flipping
       the button ink to dark --bg restores 5.2:1 — the same ratio light gets. */
    --on-accent:#131210;       /* dark --bg */
    --shadow-sm:0 1px 2px rgba(0,0,0,0.3);   /* dark --shadow-sm */
    --shadow-md:0 4px 16px rgba(0,0,0,0.4);  /* dark --shadow-md */
    --shadow-lg:0 12px 40px rgba(0,0,0,0.5); /* dark --shadow-lg */
    --shadow-mascot:0 6px 14px rgba(0,0,0,0.75); /* dark --shadow-mascot */
  }
}
`;

/* Type roles per apps/web/app/globals.css `@theme`: Geist display, Inter body,
   JetBrains Mono meta. No webfont is loaded, so each falls back to the system
   stack — the pages must render with zero network access. */
const BASE_CSS = `
*{box-sizing:border-box}
html{color-scheme:light dark}
body{
  margin:0;
  min-height:100vh;
  display:flex;
  flex-direction:column;
  background:var(--bg);
  color:var(--text);
  font-family:"Inter",system-ui,sans-serif;          /* --font-body */
  -webkit-font-smoothing:antialiased;
}
::selection{background:var(--accent);color:var(--on-accent)}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hd{border-bottom:1px solid var(--border)}
.hd-in{
  max-width:1100px;margin:0 auto;height:64px;
  padding:0 clamp(20px,5vw,32px);
  display:flex;align-items:center;
}
.mark{
  font-family:"Geist",system-ui,sans-serif;          /* --font-display */
  font-weight:700;font-size:22px;letter-spacing:-0.03em;
  color:var(--text);text-decoration:none;
}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:48px 24px}
.panel{width:100%;max-width:540px;text-align:center;animation:pop .4s var(--ease-out,cubic-bezier(0.2,0,0,1))}
/* The design file sets these mono labels in --text-muted (2.8:1) and the review
   label in --warning (2.1:1) — both fail the accessibility floor (§11) at 11–12px.
   --text-secondary carries them at 5.5:1 light / 7.3:1 dark. The amber still
   signals the review state through the (decorative) lock icon. */
.meta{
  font-family:"JetBrains Mono",ui-monospace,monospace; /* --font-mono */
  font-size:12px;letter-spacing:0.1em;text-transform:uppercase;
  color:var(--text-secondary);margin-bottom:12px;
}
h1{
  font-family:"Geist",system-ui,sans-serif;          /* --font-display */
  font-weight:700;font-size:clamp(30px,5.4vw,48px);
  letter-spacing:-0.03em;line-height:1.04;margin:0 0 14px;
}
.lede{
  font-size:16px;line-height:1.55;color:var(--text-secondary);
  margin:0 auto 28px;max-width:46ch;
}
.lede b{color:var(--text);font-weight:600}
.acts{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.btn{
  display:inline-flex;align-items:center;gap:8px;
  font-weight:600;font-size:15px;line-height:1;
  text-decoration:none;border-radius:var(--r-md);padding:14px 22px;
}
.btn-primary{background:var(--accent);color:var(--on-accent)}
.btn-ink{background:var(--text);color:var(--bg)}
.btn-quiet{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.note{
  display:flex;align-items:center;gap:14px;text-align:left;
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r-lg);padding:18px;margin:0 0 22px;
}
.note-ico{
  flex:none;width:40px;height:40px;border-radius:var(--r-sm);
  background:var(--surface-sunken);color:var(--accent);
  display:flex;align-items:center;justify-content:center;
}
.note-t{font-weight:600;font-size:14px}
.note-d{font-size:13px;color:var(--text-secondary);margin-top:2px;line-height:1.45}
.foot{
  font-family:"JetBrains Mono",ui-monospace,monospace; /* --font-mono */
  font-size:11px;letter-spacing:0.05em;color:var(--text-secondary);margin:22px 0 0;
}
.stage{display:flex;align-items:center;justify-content:center;margin-bottom:18px}
/* The mascot. Inline SVG generated by @kept/shared/mascot, not a background
   image, which is what makes it theme-aware for the first time: the body paints
   currentColor (set here to --accent, the violet the retired raster was drawn
   in) and the eyes paint var(--bg), so they punch through to whichever page
   background the visitor's OS asked for.

   No ratio guard in CSS any more — the proportions come from the generator's
   square viewBox, so a re-crop cannot silently squash the character.

   The POSE stays frozen at MASCOT_REST_T: the breathing outline and the blink
   need per-frame values, and these pages get no script (the kept-own CSP grants
   no script-src). What CSS alone can carry, it carries, so the character reads
   the same in both places — apps/web's hover and its silhouette shadow.
   The hover is a transform on this box, never on the path data or the eye
   centres: the viewBox is tight to the silhouette, so moving the geometry
   inside it would clip the character. Moving the element cannot. The pip and
   the dim filter ride along, being on/inside this same box. */
.mascot{
  width:170px;color:var(--accent);
  animation:hover 3s ease-in-out infinite alternate;
}
/* Depth via drop-shadow, which traces the rendered alpha: box-shadow paints the
   border box, and this box is a transparent square, so it drew a square tile
   behind a round character. On the inner svg, not on .mascot, because filter
   does not accumulate — .m-dim is the SAME element at the same specificity, so
   one declaration would have silently replaced the other and 410 would have
   lost either its shadow or its drain. One filter each; dim then drains the
   shadow too, which is what a lapsed draft should look like. */
.mascot>svg:first-child{display:block;width:100%;height:auto;filter:drop-shadow(var(--shadow-mascot))}
/* The expired draft is drained rather than redrawn — one asset, two readings.
   A plain filter, not a transition: the page looks the same at first paint as
   it does forever after. */
.m-dim{filter:grayscale(0.5) opacity(0.5)}
/* The reviewed state keeps an amber pip, because "under review" is the one
   thing here the artwork cannot say by itself. */
.m-pip{position:relative;display:flex;align-items:center;justify-content:center}
/* A child selector, not a bare descendant one: the mascot is inline SVG now, so
   a descendant rule would absolutely position the character along with the pip.
   The pip is always emitted last, after the mascot. */
.m-pip>svg:last-child{position:absolute;right:2px;bottom:26px}
@keyframes pop{0%{transform:translateY(8px);opacity:0}100%{transform:translateY(0);opacity:1}}
/* ±3% over 3s, alternating — apps/web's keptMascotHover exactly. A PERCENTAGE,
   not px: a transform percentage resolves against the element's own border box,
   so the bob is proportional at apps/web's 96px and at the 170px here. */
@keyframes hover{from{transform:translateY(-3%)}to{transform:translateY(3%)}}
/* Reduced motion is mandatory (design system §6): every animation has a static
   equivalent. These pages' motion is decorative, so the equivalent is "none" —
   the wildcard covers pop and hover alike, parking the mascot at translateY(0),
   which is the frozen frame the markup already carries. The mascot's
   drop-shadow is a filter, not an animation, so this block does not touch it:
   the character keeps its depth and only stops moving. */
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
@media (max-width:480px){
  main{padding:32px 20px}
  .btn{width:100%;justify-content:center}
}
`;

/** Escape text destined for HTML text nodes or double-quoted attributes. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Display host for the apex link ("kept.host"), without parsing/throwing. */
function apexHost(apexOrigin: string): string {
  return apexOrigin.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/* ───────────────────────────────────────────────────────────────────────────
   The mascot.

   One function, three moods, so the character cannot drift between the pages
   that use it. The artwork is inline SVG generated by `@kept/shared/mascot` —
   one implementation, shared with apps/web — because these pages are forbidden
   from making any external request: a fetched <img src> here would be both a
   second round-trip on the error path and a dependency, and the whole premise of
   this epic is that the serve path depends on nothing. Inline markup beats the
   base64 raster it replaced on that axis too: 15,079 characters off every one of
   the three pages, measured — about 54% of the rendered document. (It was 17,027
   for the bare swap; the hover keyframe, the mascot's shadow and the comments
   explaining both have cost 1,948 characters back since — 1,107 of that for the
   hover and the first, wrong, box-shadow. Re-measured each time, not derived.)

   The generator is called once, at module load, with a fixed `t`: the output is
   pure, so every request would otherwise recompute identical bytes.
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * The id of the `<mask>` the eyes clip against.
 *
 * A literal, not a generated id, because a system page renders exactly one
 * mascot into a document nothing else contributes to — there is no second
 * instance for it to collide with. `apps/web` fills the same slot with
 * `useId()`, where a React tree genuinely can mount two.
 */
const MASCOT_MASK_ID = "kept-mascot";

/**
 * Points on the body outline. **Measured, not chosen.**
 *
 * The generator defaults to 64. Both counts were emitted and their outlines
 * overlaid at 600 px — 3.5x the 170 px these pages draw at — and the 32-point
 * curve is coincident with the 64-point one at that magnification; 16 is not
 * (it separates visibly at the corners). 32 is therefore the smallest count
 * that is indistinguishable from the full-fat curve here, and it costs 3,185
 * bytes of `<svg>` against 5,557.
 *
 * apps/web keeps the 64-point default: it animates, at up to 600 px, where the
 * difference is on screen. The two counts are both pinned in the test suite.
 */
const MASCOT_SAMPLES_EDGE = 32;

/** The frozen frame. Built once per isolate; `mascotSvg` is pure. */
const MASCOT_ART = mascotSvg(MASCOT_REST_T, {
  maskId: MASCOT_MASK_ID,
  samples: MASCOT_SAMPLES_EDGE,
});

type MascotMood =
  /** 404 — the character as drawn. Nothing is wrong; there is just nothing here. */
  | "plain"
  /** 451 — same artwork, amber lock pip. Sober, not alarmed. */
  | "locked"
  /** 410 — same artwork, drained. The draft has lapsed, not been destroyed. */
  | "dim";

/**
 * Render the mascot.
 *
 * One frame, three readings — the markup is identical in all of them and only
 * the treatment differs, so the character cannot drift between pages.
 *
 * `aria-hidden`: it carries no information the copy does not already state, so
 * a screen reader should skip it rather than announce a decorative graphic.
 * There is deliberately no `role="img"` — the two together are contradictory,
 * since a role names a graphic that `aria-hidden` has already removed from the
 * accessibility tree.
 */
function mascot(mood: MascotMood): string {
  const cls = ["mascot", mood === "dim" ? "m-dim" : "", mood === "locked" ? "m-pip" : ""]
    .filter(Boolean)
    .join(" ");
  const pip =
    mood === "locked"
      ? `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true" focusable="false">
       <circle cx="17" cy="17" r="16" fill="var(--bg)" stroke="var(--warning)" stroke-width="2"/>
       <rect x="11" y="16" width="12" height="8.5" rx="2" fill="none" stroke="var(--warning)" stroke-width="2"/>
       <path d="M14 16 V13 a3 3 0 0 1 6 0 V16" fill="none" stroke="var(--warning)" stroke-width="2"/>
     </svg>`
      : "";
  return `<div class="${cls}" aria-hidden="true">${MASCOT_ART}${pip}</div>`;
}

/* ───────────────────────────────────────────────────────────────────────────
   Templates
   ─────────────────────────────────────────────────────────────────────────── */

function notFoundBody(apexOrigin: string): string {
  const apex = esc(apexOrigin);
  return `<div class="panel">
  <div class="stage">${mascot("plain")}</div>
  <div class="meta">404 · nothing kept here</div>
  <h1>There&rsquo;s nothing at this link.</h1>
  <p class="lede">No page lives at this address — it may never have been published, or the link is mistyped. The good news: making one takes seconds.</p>
  <div class="acts">
    <a class="btn btn-primary" href="${apex}/">Publish your own page in seconds →</a>
    <a class="btn btn-quiet" href="${apex}/">Go to ${esc(apexHost(apexOrigin))}</a>
  </div>
</div>`;
}

function suspendedBody(apexOrigin: string): string {
  const apex = esc(apexOrigin);
  return `<div class="panel">
  <div class="stage">${mascot("locked")}</div>
  <div class="meta">Under review</div>
  <h1>This page is paused while we review it.</h1>
  <p class="lede">It is temporarily not serving its content while a person takes a look. <b>Nothing has been deleted.</b> If this is your page, you can appeal — a person will read it and reply.</p>
  <div class="acts">
    <a class="btn btn-ink" href="${apex}/appeal">Appeal this decision</a>
    <a class="btn btn-quiet" href="${apex}/contact">Contact a human</a>
  </div>
  <p class="foot">Every appeal is reviewed by a person, not a filter.</p>
</div>`;
}

function expiredBody(apexOrigin: string): string {
  const apex = esc(apexOrigin);
  return `<div class="panel">
  <div class="stage">${mascot("dim")}</div>
  <div class="meta">Draft · not kept</div>
  <h1>This draft wasn&rsquo;t kept.</h1>
  <p class="lede">Every page starts as a draft that stays online for ${DRAFT_TTL_DAYS} days. That window passed without anyone keeping this one, so it stopped serving. <b>It is not gone.</b></p>
  <div class="note">
    <div class="note-ico" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div>
      <div class="note-t">Recoverable for ${DRAFT_GRACE_DAYS} days</div>
      <div class="note-d">Keep it and it comes back online, permanently. After ${DRAFT_GRACE_DAYS} days it is deleted for good.</div>
    </div>
  </div>
  <div class="acts">
    <a class="btn btn-primary" href="${apex}/keep">Keep this page →</a>
    <a class="btn btn-quiet" href="${apex}/">Publish a new page →</a>
  </div>
</div>`;
}

const SYSTEM_PAGE_SPECS: Record<SystemPage, SystemPageSpec> = {
  notFound: { status: 404, title: "Nothing kept here", body: notFoundBody },
  // 451/410: reviewed and confirmed 2026-08-03 — see `SystemPageSpec.status`.
  suspended: {
    status: 451,
    title: "This page is under review",
    body: suspendedBody,
  },
  expired: { status: 410, title: "This draft wasn't kept", body: expiredBody },
};

/**
 * Render a branded system page.
 *
 * Returns `{ body, status }`. The caller owns headers — `Cache-Control` in
 * particular is task 005's, and suspended/expired must not be edge-cached.
 */
export function renderSystemPage(
  page: SystemPage,
  options: SystemPageOptions = {}
): { body: string; status: number } {
  const spec = SYSTEM_PAGE_SPECS[page];
  const apexOrigin = options.apexOrigin ?? DEFAULT_APEX_ORIGIN;
  const apex = esc(apexOrigin);

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${esc(spec.title)} · kept</title>
<style>${TOKENS_CSS}${BASE_CSS}</style>
</head>
<body>
<header class="hd"><div class="hd-in"><a class="mark" href="${apex}/">kept</a></div></header>
<main>${spec.body(apexOrigin)}</main>
</body>
</html>
`;

  return { body, status: spec.status };
}
