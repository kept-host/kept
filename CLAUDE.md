# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The first half of this file covers what kept *is* and how it's built. The second half (**Working in this repo** onward) holds the workflow rules, also mirrored in `.claude/CLAUDE.md`.

## Current state

**E00-Foundation is shipped.** The pnpm + Turbo monorepo exists and builds: `apps/web` (Next.js control plane, themed, landing v2 adopted), `apps/edge` (empty deployable Hono Worker), `packages/shared`. Playwright e2e suite is green. **Next epic: `E01-landing-refresh`** — a content pivot of the built landing, not a redesign.

Read `.agent/System/00-README-architecture-index.md` first — it is the entry point and the source of truth for build order, repo structure, and the non-negotiable rules. Each `.agent/Tasks/prds/E*.md` is a self-contained epic PRD with its own scope, data model, states, acceptance criteria, and a `UI Source` import block.

Package manager is **pnpm** (`pnpm@10.13.1`).

## What kept is

Free, permanent, dead-simple static hosting for humans *and* AI agents: drop an HTML file — or let an agent publish one — and get a `{slug}.kept.host` link. Publish-before-signup, AGPL-3.0, single-HTML-file in v1. **Pro subscriptions fund the free tier; the books are public.**

> **Model pivot (July 2026) — the docs reflect this; parts of the code do not yet.** Donations/Open Collective are **gone**. Every page is either a **draft** (live instantly, 7-day clock) or **kept** (permanent). Free accounts get unlimited drafts + **3 pages kept forever**. Agents publish **keyless** and hand the human a claim link; API keys are Pro.

## The architecture rule everything depends on

kept is **two independently-deployed apps** with a one-directional, store-mediated boundary:

```
publish/manage (apps/web) ──writes──▶  R2 (files) + KV (manifest)
                                              │ read
visitor ──▶ {slug}.kept.host (apps/edge) ─────┘──▶ page
```

- **`apps/web`** — CONTROL PLANE. Next.js (App Router, RSC, TS) on its own infra (Railway). Landing, dashboard, auth, publish/manage APIs, cron, Supabase. *Writes* pages/settings.
- **`apps/edge`** — DATA PLANE. Hono Worker on Cloudflare serving `*.kept.host` from R2 + KV + Cache. Nothing else. *Reads* only.
- **`packages/shared`** — types, enums (status/plan/region), constants, zod schemas, the KV manifest type. Imported by **both** apps.

**The hard rule: the serve path is 100% Cloudflare and never depends on the control plane.** `apps/edge` may import `packages/shared` but **never** `apps/web`, and serving never calls back to the control plane. A dashboard/Supabase/`apps/web` outage cannot take a hosted page offline. Enforce this in every change.

The **KV manifest contract** is the seam: control plane writes `{ siteId, versionId, status, region, ownerId, updatedAt }` keyed by `<slug>`; the Worker only reads it. R2 layout is `sites/{siteId}/{versionId}/index.html` — keyed by `siteId` not slug, so renaming a slug is a KV-only change (no file move).

## Locked decisions (don't drift)

- **Stack:** Next.js + Supabase (Postgres/Auth/Realtime) control plane; Cloudflare Worker (Hono) + R2 + KV + Cache serving; Tailwind v4 (`@theme`) + shadcn (`new-york`, heavily re-themed) + Motion (`motion/react`) + React Three Fiber; fonts Hanken Grotesk (display) / Geist (body) / JetBrains Mono (mono).
- **Tokens are law.** Design tokens are CSS variables in `globals.css`, exposed to Tailwind via `@theme`, with shadcn pointed at them. Never hardcode a hex — use token classes (`bg-bg`, `text-accent`, `font-display`, `rounded-md`). Theme toggle swaps the variable block; light/dark parity on every screen. shadcn is the behavior/a11y layer, not the look. See `03-frontend-specs.md` §3–4.
- **`packages/shared` is the single source** for types/enums/constants — `MAX_PAGE_BYTES`, `KEPT_PAGE_LIMIT=3`, `DRAFT_TTL_DAYS=7`, `DRAFT_GRACE_DAYS=30`; site `status`, `plan`, `region` (`auto | eu`) enums; zod schemas; the KV manifest type. The landing must never hardcode a `3` or a `7` where a constant exists.
  - ⚠️ **One pivot delta still pending.** E01 renamed the constants to draft/kept vocabulary and deleted `SLOT_COST_EUR` / `SUPPORTER_PAGE_LIMIT`. Still outstanding: `PLANS` carries `supporter` and `SITE_STATUSES` carries `resting`. Both drive `pgEnum` in `apps/web/lib/db/schema.ts` and are baked into the committed migration `apps/web/drizzle/0000_nasty_moonstone.sql`, so dropping a value is a **Postgres enum migration, not a rename** — owned by E04/E05. Target: plans `free | premium`, no `resting`.
- **Page model:** every page is a **draft** (`expires_at` set; live instantly; 7-day clock → `expired` → 30-day grace → delete) or **kept** (`expires_at` null; permanent). `isDraft = expires_at != null`. **Keeping** a draft = sign in + attach + clear the clock, within the kept cap. Publishing past the cap **lands as a draft, never a hard error**; demoting a kept page starts a fresh 7-day clock. Archive, don't delete. The `region` field is wired in v1 but EU data residency only activates in **E11**.
- **Vocabulary:** **draft** and **kept** are product vocabulary — use them consistently in UI copy, code identifiers, and docs.
- **Writes** (publish/rename/replace/delete/claim) go through route handlers / server actions that (a) write Postgres, (b) upload to R2 via S3 client, (c) update the KV manifest via Cloudflare REST, (d) enqueue scans, then (e) purge the edge cache. The browser never touches R2/KV directly. **Reads** (dashboard/settings) query Postgres directly from server components.

## Live components (built in code, not static markup)

MVP screens are designed in Claude Design (project `da93d30e-94eb-40d4-b3d1-4632870bf056`); the imported markup is the **skin** — each epic *wires it to live data + states*, it does not redesign it. Two things are NOT static stills and must be built in code, mounted into placeholders:

- **The Vessel** (`components/kept/Vessel.tsx`) — R3F, dynamically imported `ssr:false`, behind `<Suspense>` with a static still fallback (also the no-WebGL fallback). Reacts to a `VesselState` context bus (`idle | dragover | minting | scrolling`). Reduced-motion / no-WebGL → static. Loads only on routes that show it (landing, support, 404 cameo).
- **The stats dot-field** (E09-open-books) — real open-books data (pages kept, infra cost, uptime) + animation. *(Replaces the old Open Collective funding gauge.)*

## Build order

```
E00-Foundation ✅ → E01-Landing-Refresh → E02 → E03 → E04 → E05 → E06 → E07 → E08 → E09-open-books   (v1 / launch)
                                                                        └──→ E10, E11   (v1.5)
```

| Epic | Covers |
|---|---|
| `E00-foundation-project-setup` | Scaffold, themed app, empty Worker, Cloudflare/Supabase, shared constants. **Shipped.** |
| `E01-landing-refresh` | Content pivot of the built landing to the draft/kept + agents model. **Next.** |
| `E02-cicd-deployment` | GitHub Actions, dev/prod tracks, tag-based releases |
| `E03-serving-data-plane` | The Worker that serves `*.kept.host` from R2/KV |
| `E04-anonymous-publish` | API-first publish; drop/paste or agent call → live link + claim link; the 7-day draft |
| `E05-auth-and-claim` | GitHub + magic-link sign-in; keep a draft forever; swap when at cap |
| `E06-dashboard-and-management` | Kept pages + drafts; rename/replace/delete; keep/demote; quota |
| `E07-abuse-and-moderation` | PSL, scanning, reports, status lifecycle, draft expiry/purge, volume governors |
| `E08-mcp-server` | **Now v1.** Keyless MCP + Skill + copy-paste prompt; the agents wedge |
| `E09-open-books` | Public `/stats`, the forever promise, landing panel data |
| `E10-public-gallery`, `E11-premium-tier` | v1.5 |

Build **one epic at a time, in order.** Each is shippable and builds on the prior. **E07 precedes E08**: the abuse pipeline and volume governors must be in place before the keyless agent path opens. **Launch requires E08** — the public story is agents-first.

Several epics carry **open questions** worth resolving before that epic starts (max page size, slug word-list, reputation provider, heuristic ruleset, MoR choice, taxonomy). Don't silently pick — surface them.

## CI/CD model (E02-cicd-deployment)

Protected `develop`/`main`. **Merge = validate, tag = deploy.** Tag patterns: `dev-v*` → dev, `prod-v*` → prod (prod tags must point at `main`). Dev and prod are fully isolated (separate Cloudflare/Supabase resources). Worker deploys via Wrangler; control plane to its own infra.

---

# Working in this repo

> Think carefully and implement the most concise solution that changes as little code as possible.

## Use sub-agents for context optimization

- **`file-analyzer`** — always use when asked to read files, especially logs/verbose output. Returns concise summaries that preserve essentials while cutting context.
- **`code-analyzer`** — always use when searching code, analyzing code, researching bugs, or tracing logic flow. Expert in logic tracing and vulnerability detection.
- **`test-runner`** — always use to run tests and analyze results. Captures full output for debugging, keeps the main conversation clean, surfaces all issues, no approval dialogs.
- **`troubleshooter`** — complex bug investigation: deep analysis, 3–5 solution approaches with pros/cons, web search for external knowledge, implements with tests.
- **`playwright-tester`** — frontend testing via Playwright MCP (not the npm package): starts the app, runs the flow, returns a concise pass/fail report. Use to verify UI changes and bug fixes.

## Project context documentation (`.agent/` folder)

At the start of a new session, run `/context:load` to load essential project context from the `.agent/` folder. It contains focused, non-bloated docs (<200 lines each, actionable, no bloat):

- **`.agent/README.md`** — index and navigation; **read this first.**
- **`.agent/Tasks/`** — PRDs in `Tasks/prds/`, decomposed epics in `Tasks/epics/<name>/`. All product requirements and implementation planning live here, kept out of `.claude/`.
- **`.agent/System/`** — architecture, tech stack, dependencies, database, infrastructure.
- **`.agent/Style/`** — brand guidelines, UI patterns, design system (frontend projects).
- **`.agent/SOP/`** — standard operating procedures ("how to add a schema migration", "how to add a page route").

> Note: `.agent/` exists with `README.md`, `System/`, and `Tasks/`. `Style/` and `SOP/` are not populated yet — brand/UI patterns live in `System/02-design-system.md`. Run `/context:update` after significant changes (new deps, architecture changes).

**Context commands:** `/context:init` (create), `/context:update` (refresh after changes), `/context:load` (load at session start).

## Project management workflow

Local-first, branch-based (each epic on `epic/{name}`, no worktrees), task-driven, parallel where marked `parallel: true`. Six commands:

- **PRDs:** `/pm:prd-new <name>`, `/pm:prd-edit <name>`, `/pm:prd-parse <name>` (PRD → technical epic).
- **Epics:** `/pm:epic-decompose <name>` (epic → tasks), `/pm:epic-start <name>` (branch + launch agents), `/pm:epic-edit <name>`.

## Debugging commands

- `/bug:debug <issue>` — add strategic debug logging (entry/exit, state changes, conditionals) with filterable prefixes like `[BUGNAME]`.
- `/bug:cleanup-debug [files]` — remove temporary debug logs after a fix; validates with type check + lint; preserves production error handling.

## Philosophy

**Error handling:** fail fast for critical config (e.g. missing text model); log-and-continue for optional features; graceful degradation when external services are down; user-friendly messages.

**Testing:** always use the `test-runner` agent. **Never mock anything, ever** — use real services. Finish the current test before moving to the next. If a test fails, first check the test is structured correctly before refactoring the codebase. Keep tests verbose for debugging.

## Tone and behavior

Criticism is welcome — say when I'm wrong or might be wrong. Flag better approaches and relevant standards/conventions I seem unaware of. Be skeptical and concise. Short summaries are fine; no extended breakdowns unless we're working through a plan. Don't flatter or compliment unless I ask for judgement. Ask questions when my intent is unclear rather than guessing.

## Absolute rules

- **NO PARTIAL IMPLEMENTATION** — finish what you start.
- **NO SIMPLIFICATION** — no "simplified for now, full version would…" stubs.
- **NO CODE DUPLICATION** — read the existing codebase and reuse functions/constants before writing new ones.
- **NO DEAD CODE** — use it or delete it completely.
- **NO INCONSISTENT NAMING** — follow existing naming patterns.
- **NO OVER-ENGINEERING** — no needless abstractions/factories/middleware where a simple function works. Build "working," not "enterprise."
- **NO MIXED CONCERNS** — keep validation out of API handlers, DB queries out of UI components, etc.
- **NO RESOURCE LEAKS** — close connections, clear timeouts, remove listeners, clean up file handles.
- **ALWAYS RUN `pnpm tsc --noEmit`** before claiming any task complete (zero TypeScript errors).
- **ALWAYS RUN `pnpm lint`** before claiming any task complete (zero ESLint errors; warnings OK).

## Other conventions

- **AST-grep** (`.claude/rules/use-ast-grep.md`): prefer `ast-grep` over regex for structural/language-aware code search and refactoring — *if installed* (`command -v ast-grep`); otherwise fall back to grep/semantic search.
- **Command patterns** (`.claude/rules/standard-patterns.md`): fail fast, trust the system, clear actionable errors, minimal output, smart defaults over interactive prompts.
- **Datetime** (`.claude/rules/datetime.md`): get real timestamps from `date -u +"%Y-%m-%dT%H:%M:%SZ"` for any frontmatter/timestamps — never placeholder or estimate; always UTC ISO 8601.
- **Commit authorship**: all commits MUST be authored by the configured local git account only. Never add a `Co-Authored-By: Claude` trailer, a "Generated with Claude Code" line, or any other Claude/Anthropic attribution to commit messages, and never set Claude as the commit author or co-author. Commit messages describe the change, nothing else.
