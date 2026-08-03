// @kept/edge — branded system pages, inlined into the Worker bundle.
//
// This file is the SOLE owner of the `SystemPage` union, the copy, and the HTTP
// status for every non-live serving state. Nothing else in the Worker decides
// what a visitor sees when a page is missing, suspended, or an expired draft.
//
// Source: `kept System Pages.dc.html` in the Claude Design project
// da93d30e-94eb-40d4-b3d1-4632870bf056. The markup below is that file's layout,
// vessel illustration, and type/colour system — stripped of the design-canvas
// scaffolding (`<x-dc>`, `<sc-if>`, `<sc-for>`, the JS theme toggle, the page
// tab switcher) and of the Google Fonts `<link>`.
//
// ZERO EXTERNAL REQUESTS. No `<link>`, no remote font, no remote image, no
// `fetch` at render time. The vessel is CSS; the icons are inline SVG. An
// external asset on the 404 path would be both a per-request cost and a
// dependency, and this epic's premise is that the serve path depends on nothing.
//
// The retired third state — the funding-degradation page that the pre-pivot
// product used — has no template, no union member, and no code path here. The
// design file still carries its panel for reference; the Worker does not bundle
// it. The identically-named `SITE_STATUSES` value is a different symbol, baked
// into drizzle/0000_nasty_moonstone.sql, and its removal is owned by E04/E05.
//
// The design file has no `expired` panel. That retired panel's dimmed-orb vessel
// is the visual the PRD asks for on the expired-draft page ("orb reads dimmed"),
// so the expired template reuses that illustration with draft/kept copy.

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

   Composite values (the vessel gradients) were pre-computed here because the
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
  --accent-rgb:109,74,255;   /* --accent, as channels for the orb bloom */
  --warning:#E0A33A;         /* --warning */
  --warning-rgb:224,163,58;  /* --warning, as channels for the icon wash */
  --on-accent:#FFFFFF;       /* shadcn --color-primary-foreground */
  --shadow-sm:0 1px 2px rgba(40,30,20,0.05);   /* --shadow-sm */
  --shadow-md:0 4px 16px rgba(40,30,20,0.08);  /* --shadow-md */
  --r-sm:8px;                /* --r-sm */
  --r-md:12px;               /* --r-md */
  --r-lg:16px;               /* --r-lg */
  --r-pill:999px;            /* --r-pill */
  /* vessel body, lit face: --surface 92% + #fff  ->  #FFFFFF */
  --vessel-lit:#FFFFFF;
  /* vessel body, shaded face: --bg 55% + --accent-soft 45%  ->  #F4F1F9 */
  --vessel-shade:#F4F1F9;
  /* dimmed vessel shaded face: --bg 70% + --border 30%  ->  #F4F1EC */
  --vessel-shade-dim:#F4F1EC;
  /* dimmed orb: --accent 30% + --surface-sunken 70%  ->  #CABEF0 */
  --orb-dim:#CABEF0;
  /* cast shadow, from the warm rgb the elevation tokens use */
  --vessel-cast:rgba(40,30,20,0.16);
  --vessel-rim:rgba(255,255,255,0.45);
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
    --accent-rgb:139,109,255;  /* dark --accent, as channels */
    /* The dark accent is lifted, which drops white-on-violet to 3.7:1. Flipping
       the button ink to dark --bg restores 5.2:1 — the same ratio light gets. */
    --on-accent:#131210;       /* dark --bg */
    --shadow-sm:0 1px 2px rgba(0,0,0,0.3);   /* dark --shadow-sm */
    --shadow-md:0 4px 16px rgba(0,0,0,0.4);  /* dark --shadow-md */
    /* dark --surface 92% + #fff  ->  #302D2A */
    --vessel-lit:#302D2A;
    /* dark --bg 55% + dark --accent-soft 45%  ->  #1A1623 */
    --vessel-shade:#1A1623;
    /* dark --bg 70% + dark --border 30%  ->  #1A1815 */
    --vessel-shade-dim:#1A1815;
    /* dark --accent 30% + dark --surface-sunken 70%  ->  #342A54 */
    --orb-dim:#342A54;
    --vessel-cast:rgba(0,0,0,0.45);
    --vessel-rim:rgba(255,255,255,0.10);
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
/* The vessel — the brand object, drawn in CSS so it costs no request. */
.stage{position:relative;height:150px;display:flex;align-items:center;justify-content:center;margin-bottom:18px}
.cast{
  position:absolute;bottom:24px;width:130px;height:22px;border-radius:50%;
  background:radial-gradient(ellipse,var(--vessel-cast),transparent 70%);filter:blur(6px);
}
.vessel{
  position:relative;width:92px;height:110px;
  border-radius:42% 42% 46% 46%/46% 46% 50% 50%;
  border:1px solid var(--vessel-rim);
  box-shadow:var(--shadow-md);
  background:
    radial-gradient(58% 52% at 50% 58%,rgba(var(--accent-rgb),0.32),transparent 64%),
    linear-gradient(160deg,var(--vessel-lit),var(--vessel-shade));
  animation:float 6s ease-in-out infinite;
}
.vessel-dim{
  width:84px;height:100px;opacity:.85;
  box-shadow:var(--shadow-sm);
  background:linear-gradient(160deg,var(--vessel-lit),var(--vessel-shade-dim));
  animation:float-calm 7s ease-in-out infinite;
}
.orb{
  position:absolute;left:50%;top:56%;transform:translate(-50%,-50%);
  width:18px;height:18px;border-radius:50%;
  background:var(--surface-sunken);border:1px solid var(--border);
}
.orb-dim{top:58%;width:16px;height:16px;background:var(--orb-dim);border:0}
.lock{
  width:62px;height:62px;border-radius:50%;margin:0 auto 22px;
  background:rgba(var(--warning-rgb),0.16);
  display:flex;align-items:center;justify-content:center;
}
@keyframes float{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-9px) rotate(3deg)}}
@keyframes float-calm{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
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
   Templates
   ─────────────────────────────────────────────────────────────────────────── */

function notFoundBody(apexOrigin: string): string {
  const apex = esc(apexOrigin);
  return `<div class="panel">
  <div class="stage">
    <div class="cast" aria-hidden="true"></div>
    <div class="vessel" aria-hidden="true"><span class="orb"></span></div>
  </div>
  <div class="meta">404 · nothing kept here</div>
  <h1>This vessel is empty.</h1>
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
  <div class="lock" aria-hidden="true">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
  </div>
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
  <div class="stage">
    <div class="vessel vessel-dim" aria-hidden="true"><span class="orb orb-dim"></span></div>
  </div>
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
