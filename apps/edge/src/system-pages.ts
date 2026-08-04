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
// vessel holding an orb; it was replaced by the kept mascot (`mascotSvg()`)
// on all three pages. If the design file is ever re-imported, do not restore
// the vessel — it is retired everywhere, including in apps/web.
//
// ZERO EXTERNAL REQUESTS. No `<link>`, no remote font, no remote image, no
// `fetch` at render time. The mascot and the icons are inline SVG. An external
// asset on the 404 path would be both a per-request cost and a dependency, and
// this epic's premise is that the serve path depends on nothing.
//
// The retired third state — the funding-degradation page that the pre-pivot
// product used — has no template, no union member, and no code path here. The
// design file still carries its panel for reference; the Worker does not bundle
// it. The identically-named `SITE_STATUSES` value is a different symbol, baked
// into drizzle/0000_nasty_moonstone.sql, and its removal is owned by E04/E05.
//
// The design file has no `expired` panel. The PRD asks for a dimmed reading on
// the expired-draft page, which the mascot carries as its `asleep` mood: the
// same character, drained of accent, eyes closed, breathing slower. Sleeping
// rather than absent, because the draft is recoverable for another
// DRAFT_GRACE_DAYS and the picture should not say "deleted".

import { DRAFT_GRACE_DAYS, DRAFT_TTL_DAYS } from "@kept/shared";

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

   Composite values (the mascot's faces) were pre-computed here because the
   design file expressed them with `color-mix()`, which we do not want on the
   error path for older browsers. The derivation is noted beside each.
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
  --r-sm:8px;                /* --r-sm */
  --r-md:12px;               /* --r-md */
  --r-lg:16px;               /* --r-lg */
  --r-pill:999px;            /* --r-pill */
  /* Mascot. The lit face is --accent raised toward white, the deep face is the
     offset "side" of the form. Both derive from --accent so the character stays
     on-brand if the accent ever moves. */
  --m-lit:#8B6DFF;           /* --accent + 22% #fff */
  --m-body:#6D4AFF;          /* --accent */
  --m-deep:#5334E6;          /* --accent - 12% (the side/underside face) */
  /* Face sits ON the violet body, so it stays near-black in both themes. */
  --m-face:#1E1633;
  /* Limbs sit on the PAGE, so they track the background, not the body. */
  --m-limb:#1E1633;
  /* Dimmed variant for the expired draft — the same form, drained of accent. */
  --m-lit-dim:#CFC7E8;
  --m-body-dim:#B4A8D8;
  --m-deep-dim:#9C8DC4;
  /* cast shadow, from the warm rgb the elevation tokens use */
  --m-cast:rgba(40,30,20,0.18);
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
    --m-lit:#A791FF;           /* dark --accent + 22% #fff */
    --m-body:#8B6DFF;          /* dark --accent, lifted */
    --m-deep:#6D4AFF;          /* light --accent reads as the shaded face here */
    /* The face still sits on the violet body, so it stays dark for contrast. */
    --m-face:#131210;          /* dark --bg */
    /* The limbs sit on the dark page. Near-black would vanish, taking the
       character's silhouette with it, so they invert to the warm light tone. */
    --m-limb:#A8A096;          /* dark --text-secondary */
    --m-lit-dim:#3A3550;
    --m-body-dim:#2C2840;
    --m-deep-dim:#221F33;
    --m-cast:rgba(0,0,0,0.5);
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
/* The mascot — the brand character, drawn as inline SVG so it costs no request.
   Geometry lives in mascotSvg(); everything here is colour and motion.

   Motion budget is deliberately small (design system: playful-restraint over
   whimsy). Three loops, all decorative, all cancelled by the reduced-motion
   block below: the body breathes, its shadow answers the breath, and one arm
   waves on the 404 only. The blink is the single moment of "aliveness" and is
   rare on purpose — a fast blink reads as a twitch. */
.stage{display:flex;align-items:center;justify-content:center;margin-bottom:18px}
.mascot{width:150px;height:auto;overflow:visible}
.m-body{animation:m-float 4.6s ease-in-out infinite}
.m-cast{
  fill:var(--m-cast);
  transform-box:fill-box;transform-origin:center;
  animation:m-cast 4.6s ease-in-out infinite;
}
/* The eyes scale about their own centres, so the lids appear to close from
   both edges rather than the shape collapsing upward. */
.m-eye{transform-box:fill-box;transform-origin:center;animation:m-blink 7.2s infinite}
.m-arm-wave{transform-box:view-box;transform-origin:108px 68px;animation:m-wave 3.4s ease-in-out infinite}
/* The expired draft holds still — a sleeping character that bobbed would read
   as awake. It keeps only the slowest breath. */
.m-asleep .m-body{animation:m-float-calm 7.5s ease-in-out infinite}
.m-asleep .m-cast{animation:m-cast-calm 7.5s ease-in-out infinite}
.m-asleep .m-eye{animation:none}
@keyframes m-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
@keyframes m-float-calm{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes m-cast{0%,100%{transform:scaleX(1);opacity:.85}50%{transform:scaleX(.88);opacity:.55}}
@keyframes m-cast-calm{0%,100%{transform:scaleX(1);opacity:.7}50%{transform:scaleX(.93);opacity:.55}}
@keyframes m-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.12)}}
@keyframes m-wave{
  0%,55%,100%{transform:rotate(0deg)}
  65%{transform:rotate(-17deg)}
  75%{transform:rotate(7deg)}
  85%{transform:rotate(-11deg)}
}
@keyframes pop{0%{transform:translateY(8px);opacity:0}100%{transform:translateY(0);opacity:1}}
/* Reduced motion is mandatory (design system §6): every animation has a static
   equivalent. These pages' motion is decorative, so the equivalent is "none". */
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
   that use it. Drawn as inline SVG rather than a raster asset because these
   pages are forbidden from making any external request — an <img src> here
   would be both a second round-trip on the error path and a dependency, and
   the whole premise of this epic is that the serve path depends on nothing.

   Construction, back to front: cast shadow, legs, arms, the offset "deep" body
   that gives the form its side, the lit body, then the face. Limbs are drawn
   behind the body so they read as emerging from underneath it.
   ─────────────────────────────────────────────────────────────────────────── */

type MascotMood =
  /** 404 — upright and waving. Nothing is wrong; there is just nothing here. */
  | "wave"
  /** 451 — arms down, amber lock badge. Sober, not alarmed. */
  | "locked"
  /** 410 — dimmed and eyes closed. The draft is resting, not destroyed. */
  | "asleep";

/**
 * Render the mascot.
 *
 * `aria-hidden` throughout: the character carries no information the copy does
 * not already state, so a screen reader should skip it entirely rather than
 * announce a decorative graphic.
 */
function mascotSvg(mood: MascotMood): string {
  const dim = mood === "asleep";
  const lit = dim ? "var(--m-lit-dim)" : "var(--m-lit)";
  const body = dim ? "var(--m-body-dim)" : "var(--m-body)";
  const deep = dim ? "var(--m-deep-dim)" : "var(--m-deep)";
  const gradId = `mg-${mood}`;

  // Eyes: open ellipses that blink, or closed arcs when asleep.
  const eyes = dim
    ? `<path d="M54 63 Q60 69 66 63" fill="none" stroke="var(--m-face)" stroke-width="3" stroke-linecap="round"/>
     <path d="M84 63 Q90 69 96 63" fill="none" stroke="var(--m-face)" stroke-width="3" stroke-linecap="round"/>`
    : `<ellipse class="m-eye" cx="60" cy="64" rx="5.8" ry="7" fill="var(--m-face)"/>
     <ellipse class="m-eye" cx="90" cy="64" rx="5.8" ry="7" fill="var(--m-face)"/>`;

  // The waving arm is its own group so the CSS can rotate it about the shoulder.
  const rightArm =
    mood === "wave"
      ? `<g class="m-arm-wave">
       <path d="M112 70 C126 60 132 46 129 34" fill="none" stroke="var(--m-limb)" stroke-width="5" stroke-linecap="round"/>
       <circle cx="129" cy="32" r="5.4" fill="var(--m-limb)"/>
       <path d="M126 26 v-4 M132 26 v-3.5" stroke="var(--m-limb)" stroke-width="2.6" stroke-linecap="round"/>
     </g>`
      : `<path d="M116 78 C127 89 130 101 127 111" fill="none" stroke="var(--m-limb)" stroke-width="5" stroke-linecap="round"/>
     <circle cx="127" cy="113" r="5" fill="var(--m-limb)"/>`;

  // Amber status badge, only on the reviewed state. Filled with the page
  // background so it reads as a pip sitting in front of the body.
  const badge =
    mood === "locked"
      ? `<g>
       <circle cx="120" cy="100" r="16" fill="var(--bg)" stroke="var(--warning)" stroke-width="2"/>
       <rect x="114" y="99" width="12" height="8.5" rx="2" fill="none" stroke="var(--warning)" stroke-width="2"/>
       <path d="M117 99 V96 a3 3 0 0 1 6 0 V99" fill="none" stroke="var(--warning)" stroke-width="2"/>
     </g>`
      : "";

  return `<svg class="mascot${dim ? " m-asleep" : ""}" viewBox="0 0 150 158" role="img" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="${lit}"/>
      <stop offset="1" stop-color="${body}"/>
    </linearGradient>
  </defs>
  <ellipse class="m-cast" cx="75" cy="149" rx="41" ry="6.5"/>
  <g class="m-body">
    <path d="M66 106 L62 143" fill="none" stroke="var(--m-limb)" stroke-width="5" stroke-linecap="round"/>
    <path d="M86 106 L91 143" fill="none" stroke="var(--m-limb)" stroke-width="5" stroke-linecap="round"/>
    <path d="M34 78 C23 89 20 101 23 111" fill="none" stroke="var(--m-limb)" stroke-width="5" stroke-linecap="round"/>
    <circle cx="23" cy="113" r="5" fill="var(--m-limb)"/>
    ${rightArm}
    <rect x="35" y="30" width="88" height="84" rx="28" fill="${deep}"/>
    <rect x="31" y="26" width="88" height="84" rx="28" fill="url(#${gradId})"/>
    ${eyes}
    <path d="M67 78 Q75 86 83 78" fill="none" stroke="var(--m-face)" stroke-width="3.4" stroke-linecap="round"/>
    ${badge}
  </g>
</svg>`;
}

/* ───────────────────────────────────────────────────────────────────────────
   Templates
   ─────────────────────────────────────────────────────────────────────────── */

function notFoundBody(apexOrigin: string): string {
  const apex = esc(apexOrigin);
  return `<div class="panel">
  <div class="stage">${mascotSvg("wave")}</div>
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
  <div class="stage">${mascotSvg("locked")}</div>
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
  <div class="stage">${mascotSvg("asleep")}</div>
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
