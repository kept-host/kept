# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> The first half of this file covers what kept *is* and how it's built. The second half (**Working in this repo** onward) holds the workflow rules, also mirrored in `.claude/CLAUDE.md`.

## Current state

**E00 → E05b are complete and deployed to dev; E06-creator-studio is built but not merged.** The pnpm + Turbo monorepo builds and ships: `apps/web` (Next.js control plane — the landing on the apex, the publish API, sign-in + claim, the anonymous result/claim screens, and on the E06 branch the studio), `apps/edge` (the Hono Worker serving `*.kept-dev.xyz` from R2 + KV), `packages/shared`. E05-auth-and-claim and the corrective E05a-control-plane-origin-and-session-hardening are deployed to **dev** at tag `dev-v0.3.2`; **E05b-mascot** (PR #20) is deployed to **dev** at **`dev-v0.4.0`** — still the last deployed tag. **E06-creator-studio** — the Pages home, `/site/[id]` (General · Visits · Versions), `/settings`, `limitsFor` (kept cap 3 → 50), names and holds, versions, the visits sync, downloads and export, account deletion; 14 tasks, all closed — is built on **`epic/E06-creator-studio`** (which supersedes the never-merged `epic/E06-dashboard-and-management` and carries its commits) and is **not merged to `develop` and not deployed**: the PR body is drafted in `.agent/Tasks/epics/E06-creator-studio/pr-description.md`, and the PR plus the `dev-v0.5.0` tag are `/wrapup`'s, on Arun's go. Its migration `0005` (and the old branch's `0004`) is applied to the dev Neon branch only. Suites on that branch (local, Node 22, real dev services): `apps/web` unit 428 (`tsx --test "lib/**/*.test.ts"`), `apps/edge` vitest 184, Playwright 211 tests / 37 specs (auth and live specs skip in CI on absent secrets; `visits-sync`'s live AC32/AC33 skip until the dev `CLOUDFLARE_API_TOKEN` has Zone → Analytics → Read). **Next: Arun's hand test and `/wrapup` for E06, then `E07-abuse-and-moderation`.** **Prod has never been deployed:** the `prod` GitHub Environment holds zero secrets, `release.yml` has never run, and `develop` → `main` promotion is unexercised.

Read `.agent/System/00-README-architecture-index.md` first — it is the entry point and the source of truth for build order, repo structure, and the non-negotiable rules. Each `.agent/Tasks/prds/E*.md` is a self-contained epic PRD with its own scope, data model, states, acceptance criteria, and a `UI Source` import block.

Package manager is **pnpm** (`pnpm@10.13.1`).

## What kept is

Free, permanent, dead-simple static hosting for humans *and* AI agents: drop an HTML file — or let an agent publish one — and get a `{slug}.kept.host` link. Publish-before-signup, AGPL-3.0, single-HTML-file in v1. **Pro subscriptions fund the free tier; the books are public.**

> **Model pivot (July 2026) — the docs reflect this; parts of the code do not yet.** Donations/Open Collective are **gone**. Every page is either a **draft** (live instantly, 7-day clock) or **kept** (permanent). Free accounts get unlimited drafts + **50 pages kept forever** (`limitsFor("free").keptPages`, since E06) and 5 chosen names. Agents publish **keyless** and hand the human a claim link; API keys are Pro.

## The architecture rule everything depends on

kept is **two independently-deployed apps** with a one-directional, store-mediated boundary:

```
publish/manage (apps/web) ──writes──▶  R2 (files) + KV (manifest)
                                              │ read
visitor ──▶ {slug}.kept.host (apps/edge) ─────┘──▶ page
```

- **`apps/web`** — CONTROL PLANE. Next.js (App Router, RSC, TS) on its own infra (Railway), authenticated surface at **`app.kept.host` / `app.kept-dev.xyz`**; the apex serves the landing. Both hostnames are the *same* Railway service and build. Landing, dashboard, auth, publish/manage APIs, cron, Neon Postgres. *Writes* pages/settings.
- **`apps/edge`** — DATA PLANE. Hono Worker on Cloudflare serving `*.kept.host` from R2 + KV + Cache. Nothing else. *Reads* only.
- **`packages/shared`** — types, enums (status/plan/region), constants, zod schemas, the KV manifest type. Imported by **both** apps.

**The hard rule: the serve path is 100% Cloudflare and never depends on the control plane.** `apps/edge` may import `packages/shared` but **never** `apps/web`, and serving never calls back to the control plane. A dashboard/database/`apps/web` outage cannot take a hosted page offline. Enforce this in every change.

The **KV manifest contract** is the seam: control plane writes `{ siteId, versionId, status, region, ownerId, updatedAt }` keyed by `<slug>`; the Worker only reads it. R2 layout is `sites/{siteId}/{versionId}/index.html` — keyed by `siteId` not slug, so renaming a slug is a KV-only change (no file move).

**The origin split (E05a) is the second load-bearing boundary.** Pages serve arbitrary user-authored HTML — `<script>` included — at `{slug}.kept.host`, so an authenticated control plane sharing that registrable domain is open to cookie tossing and *same-site* CSRF that `SameSite` cannot block. Hence `app.` for everything authenticated; a session cookie named **`__Host-kept.session_token`** (the prefix makes the browser reject any `Domain` attribute, so a hosted page cannot toss or shadow it); and an `Origin`/`Sec-Fetch-Site` check on the four cookie-authenticated mutating routes, owned by `apps/web/lib/publish/origin.ts`. The **keyless bearer** routes (`POST /api/publish`, the `/api/anon/:token` family) deliberately do **not** check it — that is E08's agent path and it must stay callable from anywhere. PSL submission for `kept.host` is still required before launch (E07 owns it), but it is now defence in depth rather than the only isolation.

## Locked decisions (don't drift)

- **Stack:** Next.js (Railway) + **Neon** Postgres control plane, with **Better Auth** v1.6.26 self-hosted (Drizzle adapter, uuid ids via `advanced.database.generateId`, users in the same Neon database) and **Resend** for magic-link email — both shipped in E05, alongside GitHub **and Google** OAuth (three sign-in doors; account linking is verified-email-only); Cloudflare Worker (Hono) + R2 + KV + Cache serving; Tailwind v4 (`@theme`) + shadcn (`new-york`, heavily re-themed) + Motion (`motion/react`); fonts **Hanken Grotesk** (display, 500/600/700) / **Geist** (body) / **JetBrains Mono** (mono) — what `apps/web/lib/fonts.ts` loads and what `globals.css` binds `--font-display` / `--font-body` to; the OG card vendors `HankenGrotesk-SemiBold.ttf` + `Geist-Regular.ttf` in `lib/og/fonts/`. (Arun's E06 decision, 2026-10-04: adopt the design's faces app-wide; E06 task 010 switched them and dropped Inter. `apps/edge/src/system-pages.ts` still names Geist/Inter — left because E06 kept the edge diff empty; fix it in the next epic that touches the edge.)
- **Tokens are law.** Design tokens are CSS variables in `globals.css`, exposed to Tailwind via `@theme`, with shadcn pointed at them. Never hardcode a hex — use token classes (`bg-bg`, `text-accent`, `font-display`, `rounded-md`). shadcn is the behavior/a11y layer, not the look. See `03-frontend-specs.md` §3–4.
- **v1 is light-only, and that is a decision, not an oversight.** `app/providers.tsx` pins `forcedTheme="light"` and `app/layout.tsx` sets `data-theme="light"` on `<html>`. **There is no theme toggle** — E00 (`6117a26`) deleted the v1 one when the landing was rebuilt to Claude Design v2, which has no toggle in the design. `setTheme` is called nowhere in the repo. **Do not "fix" this by removing `forcedTheme`:** `KeptLanding.tsx` carries ~81 hardcoded colour literals in inline styles that hand-build a light→dark→light band rhythm, so unforcing the theme makes the dark bands unreadable and the light bands opaque. Making dark real means redesigning the landing — an epic, not a patch.
  - The **`[data-theme="dark"]` token block is still real and still maintained**, because the e2e specs set the attribute imperatively and assert against it (`auth-screen`, `anon-keep-flow`, `anon-screens`, `smoke`, `tokens-applied`). New *app* surfaces should keep painting from tokens so dark stays correct when it is eventually switched on. Known gap: `--live`, `--warning` and `--danger` have no dark counterpart and inherit their light values.
  - So: **build in tokens, verify dark where a spec already does, and do not claim parity on the landing.**
- **`packages/shared` is the single source** for types/enums/constants — `MAX_PAGE_BYTES`, `DRAFT_TTL_DAYS=7`, `DRAFT_GRACE_DAYS=30`, and **plan limits only through `limitsFor(plan)`** (`PLAN_LIMITS` in `plans.ts`: free 50 kept pages / 5 chosen names / names ≥ 5 chars / 1 previous version; premium 1000 / 50 / 4 / 20). `KEPT_PAGE_LIMIT` survives as the free alias for the three no-plan surfaces `apps/web/lib/plans/limits.test.ts` allows, and that test fails on any other 50/1000 literal in `apps/web`. Also site `status`, `plan`, `region` (`auto | eu`) enums; zod schemas; the KV manifest type; `RESERVED_NAMES`; the `@kept/shared/names` subpath (`validateName`, kept out of the Worker). The landing must never hardcode a `50` or a `7` where a constant exists.
  - ✅ **The pivot deltas are discharged.** E01 renamed the constants and deleted `SLOT_COST_EUR` / `SUPPORTER_PAGE_LIMIT`; E04's migration `0001` dropped `resting` from `site_status` and added `archived` (`SITE_STATUSES` = `live | under_review | quarantined | expired | removed | archived`); E05's migration `0002` rewrote the plan `pgEnum`, so **`PLANS` is now `free | premium`**. Nothing pivot-related is outstanding — don't re-open it.
- **Page model:** every page is a **draft** (`expires_at` set; live instantly; 7-day clock → `expired` → 30-day grace → delete) or **kept** (`expires_at` null; permanent). `isDraft = expires_at != null`. **Keeping** a draft = sign in + attach + clear the clock, within the kept cap. Publishing past the cap **lands as a draft, never a hard error**; demoting a kept page starts a fresh 7-day clock. Archive, don't delete. The `region` field is wired in v1 but EU data residency is backlog (2027, after billing).
- **Vocabulary:** **draft** and **kept** are product vocabulary — use them consistently in UI copy, code identifiers, and docs.
- **Writes** (publish/rename/replace/delete/claim) go through route handlers / server actions that (a) write Postgres, (b) upload to R2 via S3 client, (c) update the KV manifest via Cloudflare REST, (d) enqueue scans, then (e) purge the edge cache. The browser never touches R2/KV directly. **Reads** (dashboard/settings) query Postgres directly from server components.
  - As built (E04), steps (c) and (e) are **owned solely by `apps/web/lib/storage/manifest.ts`** — `writeManifest` / `removeManifest`, which encode the slug-pointer → KV → purge ordering from `docs/edge-purge-contract.md`. `apps/web/eslint.config.mjs` bans importing `lib/storage/kv` anywhere else, so a direct `kv.put(slug, …)` fails lint. **A purge is two purges**, the second delayed 125 s (`2 × cacheTtl + 5 s`), because `purge_cache` does not reach the Worker's KV read cache — see the "will bite you" list in `.agent/System/06-edge-and-infrastructure.md`.

## Live components (built in code, not static markup)

MVP screens are designed in Claude Design (project `da93d30e-94eb-40d4-b3d1-4632870bf056`); the imported markup is the **skin** — each epic *wires it to live data + states*, it does not redesign it. One thing is NOT a static still and must be built in code, mounted into a placeholder:

- **The stats dot-field** (E17-open-books) — real open-books data (pages kept, infra cost, uptime) + animation. *(Replaces the old Open Collective funding gauge.)*

> **There is no R3F Vessel, and there is no plan for one.** Earlier revisions of
> this file specified a `components/kept/Vessel.tsx` — a React Three Fiber orb
> component, `ssr:false`, with a `VesselState` context bus. It was specified early
> on and never built; that decision is withdrawn and stays withdrawn. `three` /
> `@react-three/fiber` are not dependencies and must not be added for this — see
> the same note above `@keyframes keptLive` in `apps/web/app/globals.css`.
> E01 shipped the landing's drop-box choreography imperatively instead, in
> `apps/web/components/kept/kept-engine.ts` driving `KeptLanding.tsx` — that is the real thing,
> and it is what any epic touching the hero should extend.
>
> Separately, **"vessel" was also the name of two CSS illustrations, and E05b
> retired both.** The orb drawn with `--vessel-lit` / `--vessel-shade` /
> `--vessel-shade-dim` on the Worker's branded system pages is gone from
> `apps/edge/src/system-pages.ts` — only retirement comments name it now — and the
> pure-CSS `.kept-vessel` E05 put on the `/auth` screens is gone from
> `globals.css`, which draws no illustration any more — its only mascot rule is
> the *motion* keyframe `keptMascotHover` (the idle bob), which sits with the
> other keyframes by convention. Do not read that as licence to bring a drawing
> back.
> `git grep -i vessel -- apps/web` returns nothing. Both were replaced by the
> **generated mascot**: one pure function in `packages/shared/src/mascot/` behind
> the `@kept/shared/mascot` subpath, animated on a rAF loop by
> `apps/web/components/kept/mascot.tsx` and frozen into a single inline SVG frame
> by the Worker. Do not re-introduce either illustration; the character and its
> take-and-leave line are `.agent/System/02-design-system.md` §7.

## Build order

Re-planned 2026-10-01 (`.agent/Tasks/prds/` E06–E18; the old E06–E11 PRDs are archived):

```
E00 ✅ → E01 ✅ → E02 ✅ → E03 ✅ → E04 ✅ → E05 ✅ → E05a ✅ → E05b ✅ → E06 (built) → E07 → E08 → E09 → E10 → E11 → E12 → E13 → E14   (launch, Dec 1–4 2026)
                                                                                                                                    └──→ E15, E16, E17, E18   (fast-follow, Dec 7–18)
```

| Epic | Covers |
|---|---|
| `E00-foundation-project-setup` | Scaffold, themed app, empty Worker, Cloudflare + Postgres, shared constants. **Shipped.** |
| `E01-landing-refresh` | Content pivot of the built landing to the draft/kept + agents model. **Shipped.** |
| `E02-cicd-deployment` | GitHub Actions, dev/prod tracks, tag-based releases; Supabase → Neon cutover. **Shipped.** |
| `E03-serving-data-plane` | The Worker that serves `*.kept.host` from R2/KV. **Shipped** (dev only). |
| `E04-anonymous-publish` | API-first publish; drop/paste or agent call → live link + claim link; the 7-day draft. **Shipped** to dev at `dev-v0.1.5`. |
| `E05-auth-and-claim` | GitHub + Google + magic-link sign-in; keep a draft forever; swap when at cap. **Shipped.** |
| `E05a-control-plane-origin-and-session-hardening` | Corrective, inserted after E05: control plane moved to `app.`, `__Host-` session cookie, origin checks on cookie-authenticated mutations. **Shipped** to dev at `dev-v0.3.2`. |
| `E05b-mascot` | Corrective: the CSS vessel and the base64-WebP mascot replaced by one generated mascot in `packages/shared`, animated in `apps/web` and frozen into the Worker's system pages. **Shipped** to dev at `dev-v0.4.0`. |
| `E06-creator-studio` | Pages home, `/site/[id]`, settings; `limitsFor` (cap 3 → 50); names + holds; versions; visits sync; downloads/export; account deletion. **Built** on `epic/E06-creator-studio`; not merged or deployed (`dev-v0.5.0` pending `/wrapup`). |
| `E07-abuse-and-moderation` | PSL, scanning, reports, status lifecycle, draft expiry/purge crons (calling E06's `releaseName()` under `lockOwner`), volume governors. **Next.** |
| `E08-multi-file-sites` | Multi-file sites and SPAs — the file-set publish contract |
| `E09-mcp-and-chat-connector` | Keyless MCP + Skill + copy-paste prompt + chat-app connector; the agents wedge |
| `E10-creator-loop` | Provenance, remix, referrals, handles and profiles |
| `E11-founding-entitlements` | Pro granted to founding creators at launch; entitlements under `limitsFor`; the locked-row CTA |
| `E12-the-wall` | `handle.kept.host`, the bio-link wall and its Pro editor |
| `E13-landing-v3` | Creator-first landing, `/promise`, `/faq` |
| `E14-launch-readiness` | The first prod deploy and everything launch needs |
| `E15-explore`, `E16-share-kit`, `E17-open-books`, `E18-password-pages` | Fast-follow, after launch |

Build **one epic at a time, in order.** Each is shippable and builds on the prior. **E07 precedes E08 and E09**: the abuse pipeline and volume governors must be in place before the keyless agent path widens to MCP and chat apps. **Launch requires E06–E14.**

Several epics carry **open questions** worth resolving before that epic starts (max page size, slug word-list, reputation provider, heuristic ruleset, MoR choice, taxonomy). Don't silently pick — surface them.

## CI/CD model (E02-cicd-deployment)

Protected `develop`/`main`. **Merge = validate, tag = deploy.** Tag patterns: `dev-v*` → dev, `prod-v*` → prod (prod tags must point at `main`). Dev and prod are fully isolated (separate Cloudflare resources and Neon branches — prod is the root branch, dev a persistent branch; dev serves from `*.kept-dev.xyz`, with the control plane at `app.kept-dev.xyz`). Worker deploys via Wrangler; control plane to Railway.

**The launch gate: prod runs closed until launch.** `NEXT_PUBLIC_KEPT_OPEN` (`apps/web/lib/launch.ts`) must be exactly `true` to open publishing and sign-in; unset is the **waitlist** — the landing renders, a dropped/pasted page opens the waitlist dialog (`POST /api/waitlist` → the `waitlist` table, migration `0006`) instead of publishing, and `decideClosedAction` in `lib/routing/host-split.ts` sends every control-plane page to the landing and 404s every API but `/api/health` and `/api/waitlist`, ahead of the split rule. It **fails closed** on purpose. Dev, CI and local set it `true` (the Playwright harness defaults it; `test:e2e:closed` runs `e2e/waitlist.spec.ts` against a closed server). The middleware matcher therefore covers all of `/api/*`. `/api/health` reports `open`, and the release smoke asserts the gate holds instead of publishing when it is `false`. While closed, a route added later (E09's MCP endpoint, say) 404s until it is listed in `CLOSED_API_PATHS` — deny by default.

**Cron is a scheduled GitHub Actions workflow calling an authenticated route** (`.github/workflows/cron-draft-reminder.yml` → `Authorization: Bearer CRON_SECRET`; E06 adds `cron-visits-sync.yml`, whose schedule stays off until the repository variable `VISITS_SYNC_ENABLED` is `true`), not a Worker `[triggers]` block — a Worker cron would make the data plane call the control plane, which the architecture rule forbids. **E07 inherits that substrate** for expiry/purge jobs. Env beyond E02's topology: `BETTER_AUTH_SECRET`/`_URL`, `GITHUB_CLIENT_*`, `GOOGLE_CLIENT_ID`/`_SECRET` (added after E02 reserved its slots), `RESEND_API_KEY`, `EMAIL_FROM`, `CRON_SECRET`. Migrations `0002` (Better Auth tables, `sites.claimed_at`, plan enum rewrite) and `0003` (`reminder_sent_at`, `reminder_keep_token_hash`) are applied to the dev Neon branch only, as are the E06 branch's `0004` (`sites.title`) and `0005` (names, versions, visits tables; partial `sites_slug_key`); **prod remains unmigrated and undeployed.**

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
- **ALWAYS RUN `pnpm typecheck`** before claiming any task complete (zero TypeScript errors). Not `pnpm tsc --noEmit` — there is no root `tsconfig.json`, so that command prints tsc's help and verifies nothing. `pnpm typecheck` runs `turbo run typecheck` across every workspace, which is the real gate.
- **ALWAYS RUN `pnpm lint`** before claiming any task complete (zero ESLint errors; warnings OK). This maps to `turbo run lint`. ⚠️ The `rtk` hook rewrites the command and **summarises** its output, and its summariser invents errors: it reports phantom failures in `KeptLanding.tsx` / `next-env.d.ts` / `lib/auth/return-path.ts` that do not exist. **`rtk proxy pnpm lint` is the truth** (currently 0 errors, 1 pre-existing warning). `git status` is filtered the same way and can show a clean tree while files are untracked — use `/usr/bin/git` when it matters.
- **Node ≥22 is required** (`engines` and `.nvmrc` both say so). Wrangler will not run on Node 20, so `apps/edge` cannot build or test there. Use `nvm use` at the repo root.

## Other conventions

- **Never derive an origin from the request — read it from configuration.** This bug class has shipped twice: `middleware.ts` read `request.nextUrl.host`, and `/auth/callback` built its redirect from `new URL(request.url)`. Next composes both from the server's **listen address**, not the `Host` header, so locally the address *is* the app origin and the bug is invisible; on Railway (`PORT=8080`) it yields `localhost:8080` and kills sign-in. Use `x-forwarded-host` for routing decisions and `authConfig().baseUrl` for anything security-bearing. `apps/web/lib/routing/configured-origins.test.ts` guards the class in CI.
- **Local dev is HTTPS** — `pnpm dev` runs `next dev --experimental-https` at `https://localhost:3000`, because `__Host-` cookies require `Secure`. The first run mints a certificate into `apps/web/certificates/` (gitignored; it holds a private key — never commit it).
- **AST-grep** (`.claude/rules/use-ast-grep.md`): prefer `ast-grep` over regex for structural/language-aware code search and refactoring — *if installed* (`command -v ast-grep`); otherwise fall back to grep/semantic search.
- **Command patterns** (`.claude/rules/standard-patterns.md`): fail fast, trust the system, clear actionable errors, minimal output, smart defaults over interactive prompts.
- **Datetime** (`.claude/rules/datetime.md`): get real timestamps from `date -u +"%Y-%m-%dT%H:%M:%SZ"` for any frontmatter/timestamps — never placeholder or estimate; always UTC ISO 8601.
- **Commit authorship**: all commits MUST be authored by the configured local git account only. Never add a `Co-Authored-By: Claude` trailer, a "Generated with Claude Code" line, or any other Claude/Anthropic attribution to commit messages, and never set Claude as the commit author or co-author. Commit messages describe the change, nothing else.
