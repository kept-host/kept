import { Check, Lock, Shield } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropControl } from "@/components/kept/DropControl";
import { LinkPill } from "@/components/kept/LinkPill";
import { Reveal, RevealGroup, RevealItem } from "@/components/kept/Reveal";
import { UtilityBar } from "@/components/kept/UtilityBar";
import { VesselScrollStage } from "@/components/kept/VesselScrollStage";
import { VesselStateProvider } from "@/components/kept/vessel-state";

/**
 * kept landing (frontend-specs §12 — `kept Landing.dc.html` adopted).
 *
 * Static skin wired to real tokens, fonts, and re-skinned shadcn components.
 * The Vessel is a MOUNT POINT (VesselMount → dynamic ssr:false placeholder),
 * not a baked image. NO publish/auth/live-data wiring — those are E1/E2. The
 * "ink" panels (gauge teaser, footer) use `data-theme="dark"` so the kept dark
 * token block paints them; no hex is hardcoded anywhere.
 */

const HOW_STEPS = [
  {
    n: "01",
    title: "Drop",
    body: (
      <>
        Drag a single{" "}
        <code className="font-mono text-[13px] text-accent">.html</code> file
        onto the page, or paste raw HTML. That&rsquo;s the whole upload.
      </>
    ),
    icon: (
      <svg
        width="34"
        height="34"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M12 16V4M8 8l4-4 4 4" />
        <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
    ),
  },
  {
    n: "02",
    title: "Get a link",
    body: (
      <>
        A live{" "}
        <code className="font-mono text-[13px] text-accent">*.kept.host</code>{" "}
        link mints in seconds. Copy it, QR it, share it &mdash; it works
        immediately.
      </>
    ),
    icon: (
      <svg
        width="34"
        height="34"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
      </svg>
    ),
  },
  {
    n: "03",
    title: "Kept forever",
    body: (
      <>
        It stays up &mdash; no expiry, no rot. Claim it any time to rename,
        replace, or manage from a dashboard.
      </>
    ),
    icon: (
      <svg
        width="34"
        height="34"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    ),
  },
] as const;

const ROADMAP_CHIPS = [
  { label: "MCP Server", note: "the headline capability", active: true },
  { label: "CLI", note: "publish from scripts & CI", active: false },
  { label: "Skill", note: "drop-in SKILL.md", active: false },
] as const;

const WHY_CARDS = [
  {
    kicker: "Permanent by default",
    title: "No expiry, ever",
    body: "Anonymous pages are real pages. They don't time out, don't require a login to stay up, and never silently vanish.",
  },
  {
    kicker: "Open source · AGPL",
    title: "Nothing to lock you in",
    body: "The whole platform is open. Self-host it, fork it, audit it. Your pages aren't hostage to one company's runway.",
  },
  {
    kicker: "Open books",
    title: "Funding you can see",
    body: 'Infra cost, donations, and runway are public. When we say "free forever," you can check our math.',
  },
] as const;

const FREE_FEATURES = [
  "Unlimited public pages, kept forever",
  "Instant link, QR, and live status",
  "Claim, rename slug, replace versions",
  "Dashboard for all your pages",
] as const;

const PRO_FEATURES = [
  {
    title: "Password-protected pages",
    body: "gate a page behind a password.",
  },
  { title: "Custom domains", body: "serve a page on your own domain." },
  {
    title: "Private analytics",
    body: "views & referrers, privacy-respecting.",
  },
  { title: "Remove the kept badge", body: "unbranded pages." },
  {
    title: "More pages & higher limits",
    body: "well beyond the free 3, plus higher MCP/agent volume.",
  },
  {
    title: "EU data residency",
    body: "pin a page's stored files to the EU.",
  },
  {
    title: "Version history & rollback",
    body: "restore a previous version of a page.",
  },
] as const;

const FOOTER_COLUMNS = [
  {
    heading: "Project",
    links: ["GitHub repo", "Open Collective", "License · AGPL-3.0"],
  },
  {
    heading: "Community",
    links: ["Support · Keep it free", "Mastodon", "Status"],
  },
  {
    heading: "Developers",
    links: ["MCP server · soon", "CLI · soon", "Skill · soon", "Docs"],
  },
] as const;

/** Deterministic placeholder gauge dots: 1,284 of 2,000 ≈ 64% filled. */
const GAUGE_DOTS = Array.from({ length: 72 }, (_, i) => i < 46);

function LiveDot() {
  return (
    <span className="motion-safe:animate-[keptLive_2s_ease-in-out_infinite] inline-block size-[9px] rounded-full bg-live" />
  );
}

export default function MarketingHome() {
  return (
    <div className="min-h-dvh overflow-x-hidden bg-bg text-text">
      <UtilityBar />

      <main id="top">
        {/* ───────── PINNED VESSEL SCROLL STAGE (hero + how + agents) ───────── */}
        <VesselStateProvider>
          <VesselScrollStage>
            {/* ───────────────── HERO ───────────────── */}
            <section className="relative mx-auto grid max-w-[1280px] items-center gap-6 px-6 md:min-h-[calc(100vh-72px)] md:grid-cols-[1.12fr_0.88fr] md:px-12">
              {/* faint vertical column grid (inset by the gutter) */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-6 right-6 md:left-12 md:right-12"
                style={{
                  background:
                    "repeating-linear-gradient(90deg, transparent 0, transparent calc(8.333% - 1px), color-mix(in srgb, var(--text) 6%, transparent) calc(8.333% - 1px), color-mix(in srgb, var(--text) 6%, transparent) 8.333%)",
                }}
              />

              <div className="relative z-[2] py-10">
                <h1 className="m-0 font-display text-[clamp(48px,7.4vw,104px)] font-bold leading-[0.95] tracking-[-0.03em]">
                  Drop an HTML file.
                  <br />
                  Get a link.
                  <br />
                  Kept&nbsp;&mdash;&nbsp;
                  <span className="text-accent">forever.</span>
                </h1>
                <div className="mt-10 flex flex-wrap items-center gap-3.5">
                  <DropControl />
                  <LinkPill slug="yourpage.kept.host" />
                </div>
                <p className="mono-label mt-6 text-xs text-text-muted">
                  No account needed · drag a file anywhere on this page
                </p>
              </div>

              {/* Spacer reserving the hero's right column — the Vessel canvas is
                  rendered once in VesselScrollStage's pinned layer and shows
                  through here, so it stays mounted as the page scrolls. */}
              <div aria-hidden className="h-[560px]" />
            </section>

            {/* ───────────────── HOW IT WORKS ───────────────── */}
            <section
              id="how"
              className="mx-auto max-w-[1280px] border-t border-border px-6 py-[120px] md:px-12"
            >
              <Reveal>
                <p className="mono-label mb-3.5 text-xs text-text-muted">
                  How it works
                </p>
                <h2 className="m-0 mb-16 max-w-[14ch] font-display text-[clamp(32px,4.4vw,56px)] font-bold leading-none tracking-[-0.03em]">
                  Three steps. No build, no Git, no account.
                </h2>
              </Reveal>
              <RevealGroup className="grid gap-px overflow-hidden rounded-[var(--r-lg)] border border-border bg-border md:grid-cols-3">
                {HOW_STEPS.map((step) => (
                  <RevealItem
                    key={step.n}
                    className="flex min-h-[260px] flex-col bg-bg p-9"
                  >
                    <span className="font-mono text-[13px] text-accent">
                      {step.n}
                    </span>
                    <div className="mt-auto">
                      <div className="mb-4.5 text-text">{step.icon}</div>
                      <h3 className="m-0 mb-2.5 font-display text-2xl font-semibold tracking-[-0.02em]">
                        {step.title}
                      </h3>
                      <p className="m-0 text-[15px] leading-[1.55] text-text-secondary">
                        {step.body}
                      </p>
                    </div>
                  </RevealItem>
                ))}
              </RevealGroup>
            </section>

            {/* ───────────────── FOR AGENTS (MCP) ───────────────── */}
            <section
              id="agents"
              className="mx-auto max-w-[1280px] border-t border-border px-6 py-[120px] md:px-12"
            >
              <div className="grid items-center gap-16 md:grid-cols-[1fr_1.02fr]">
                {/* copy */}
                <Reveal>
              <div className="mb-4.5 flex items-center gap-3">
                <span className="mono-label text-xs text-text-muted">
                  Built for the AI era
                </span>
                <Badge>Coming soon</Badge>
              </div>
              <h2 className="m-0 mb-5 font-display text-[clamp(34px,4.8vw,64px)] font-bold leading-[0.98] tracking-[-0.03em]">
                Let your agents publish.
              </h2>
              <p className="m-0 mb-7 max-w-[46ch] text-[17px] leading-[1.6] text-text-secondary">
                AI agents generate HTML all day. Give it a home. Connect
                kept&rsquo;s <b className="text-text">MCP server</b> to Claude,
                ChatGPT, Cursor &mdash; any MCP host &mdash; and your agent
                publishes a page to your account and gets back a live link. Free,
                with your account.
              </p>
              <div className="mb-7 flex flex-wrap gap-2.5">
                {ROADMAP_CHIPS.map((chip) => (
                  <div
                    key={chip.label}
                    className="flex items-center gap-2.5 rounded-[var(--r-md)] border border-border bg-surface px-3.5 py-2.5"
                  >
                    <span
                      className="size-[7px] rounded-full"
                      style={{
                        background: chip.active
                          ? "var(--accent)"
                          : "var(--text-muted)",
                      }}
                    />
                    <span className="mono-label text-xs text-text">
                      {chip.label}
                    </span>
                    <span className="text-[13px] text-text-muted">
                      {chip.note}
                    </span>
                  </div>
                ))}
              </div>
              <p className="m-0 mb-6 flex items-center gap-2.5 text-sm text-text-secondary">
                <Shield className="size-4 text-accent" />
                Account-gated and scanned, same as every page. Higher volume with
                Pro.
              </p>
              {/* notify capture (static; no wiring) */}
              <div className="flex max-w-[460px] flex-wrap items-center gap-2.5">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  aria-label="Email for MCP launch notification"
                  className="min-w-[200px] flex-1"
                />
                <Button>Get notified</Button>
                <Button variant="link" size="default">
                  Read the docs &rarr;
                </Button>
              </div>
            </Reveal>

            {/* tool-call snippet card */}
            <Reveal
              delay={0.1}
              className="overflow-hidden rounded-[var(--r-lg)] border border-border bg-surface shadow-[var(--shadow-lg)]"
            >
              <div className="flex items-center gap-2.5 border-b border-border bg-sunken px-4.5 py-3.5">
                <div className="flex gap-1.5">
                  <span className="size-2.5 rounded-full bg-border" />
                  <span className="size-2.5 rounded-full bg-border" />
                  <span className="size-2.5 rounded-full bg-border" />
                </div>
                <span className="ml-1.5 font-mono text-[11px] tracking-[0.06em] text-text-muted">
                  AGENT · MCP SESSION
                </span>
                <Badge className="ml-auto">Preview</Badge>
              </div>
              <div className="p-5.5 font-mono text-[13px] leading-[1.7]">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-accent">▸</span>
                  <span className="text-text-secondary">call</span>
                  <span className="font-medium text-text">
                    kept.publish_page
                  </span>
                </div>
                <div className="mt-2 pl-[22px] text-text-secondary">{"{"}</div>
                <div className="pl-[38px] text-text-secondary">
                  <span className="text-text-muted">&quot;slug&quot;</span>:{" "}
                  <span className="text-text">&quot;launch-notes&quot;</span>,
                </div>
                <div className="pl-[38px] text-text-secondary">
                  <span className="text-text-muted">&quot;html&quot;</span>:{" "}
                  <span className="text-text">
                    &quot;&lt;!doctype html&gt;&hellip;&quot;
                  </span>
                </div>
                <div className="pl-[22px] text-text-secondary">{"}"}</div>
                <div className="my-4 h-px bg-border" />
                <div className="flex items-baseline gap-2.5">
                  <span className="text-live">&larr;</span>
                  <span className="text-live">200</span>
                  <span className="text-text-secondary">kept</span>
                </div>
                <div className="mt-2 pl-[22px] text-text-secondary">{"{"}</div>
                <div className="pl-[38px]">
                  <span className="text-text-muted">&quot;url&quot;</span>:{" "}
                  <span className="font-semibold text-accent">
                    &quot;https://launch-notes.kept.host&quot;
                  </span>
                  ,
                </div>
                <div className="pl-[38px]">
                  <span className="text-text-muted">&quot;status&quot;</span>:{" "}
                  <span className="text-text">&quot;live&quot;</span>,
                </div>
                <div className="pl-[38px]">
                  <span className="text-text-muted">&quot;kept&quot;</span>:{" "}
                  <span className="text-text">&quot;forever&quot;</span>
                </div>
                <div className="pl-[22px] text-text-secondary">{"}"}</div>
              </div>
              <div className="flex items-center gap-2.5 border-t border-border bg-sunken px-5.5 py-3.5">
                <LiveDot />
                <span className="font-mono text-xs text-text-secondary">
                  link returned to the agent · kept online, permanently
                </span>
              </div>
            </Reveal>
              </div>
            </section>
          </VesselScrollStage>
        </VesselStateProvider>

        {/* ───────────────── GAUGE TEASER (ink panel) ───────────────── */}
        <section
          id="gauge"
          className="mx-auto max-w-[1280px] px-6 pb-[120px] md:px-12"
        >
          <Reveal
            data-theme="dark"
            className="relative overflow-hidden rounded-[var(--r-xl)] bg-bg p-8 text-text md:p-14"
          >
            <div className="grid items-center gap-12 md:grid-cols-[1fr_1.1fr]">
              <div>
                <p className="mono-label mb-4.5 text-xs text-accent">
                  Kept alive by the community
                </p>
                <div className="font-display text-[clamp(40px,5vw,68px)] font-bold leading-none tracking-[-0.03em]">
                  1,284
                  <span className="text-[0.5em] font-semibold text-text-muted">
                    {" "}
                    / 2,000
                  </span>
                </div>
                <p className="my-5 mb-7 max-w-[38ch] text-base leading-[1.6] text-text-secondary">
                  Free hosting is funded by donations. Every dot is a page the
                  community is keeping online right now.
                </p>
                <Button asChild>
                  <a href="#support">
                    Help keep more pages free <span>&rarr;</span>
                  </a>
                </Button>
              </div>
              <div className="grid grid-cols-[repeat(24,1fr)] content-center gap-[7px]">
                {GAUGE_DOTS.map((filled, i) => (
                  <div
                    key={i}
                    className="aspect-square rounded-full"
                    style={{
                      background: filled ? "var(--accent)" : "var(--border)",
                    }}
                  />
                ))}
              </div>
            </div>
          </Reveal>
        </section>

        {/* ───────────────── WHY KEPT ───────────────── */}
        <section
          id="why"
          className="mx-auto max-w-[1280px] px-6 pb-[120px] md:px-12"
        >
          <Reveal>
            <h2 className="m-0 mb-3 font-display text-[clamp(40px,6.5vw,96px)] font-bold leading-[0.98] tracking-[-0.03em]">
              This link
              <br />
              won&rsquo;t rot.
            </h2>
            <p className="m-0 mb-[72px] max-w-[48ch] text-lg leading-[1.6] text-text-secondary">
              Most &ldquo;free&rdquo; hosts quietly delete you. kept is built to
              do the opposite &mdash; and to prove it in the open.
            </p>
          </Reveal>
          <RevealGroup className="grid gap-10 md:grid-cols-3">
            {WHY_CARDS.map((card) => (
              <RevealItem key={card.title}>
                <p className="mono-label mb-4.5 border-b border-border pb-4.5 text-xs text-accent">
                  {card.kicker}
                </p>
                <h3 className="m-0 mb-2.5 font-display text-[22px] font-semibold tracking-[-0.02em]">
                  {card.title}
                </h3>
                <p className="m-0 text-[15px] leading-[1.6] text-text-secondary">
                  {card.body}
                </p>
              </RevealItem>
            ))}
          </RevealGroup>
        </section>

        {/* ───────────────── FREE + PRO ───────────────── */}
        <section
          id="pricing"
          className="mx-auto max-w-[1280px] px-6 pb-[120px] md:px-12"
        >
          <div className="grid items-stretch gap-6 md:grid-cols-[1.3fr_1fr]">
            {/* Free */}
            <Reveal className="relative overflow-hidden rounded-[var(--r-xl)] border-[1.5px] border-accent bg-surface p-8 shadow-[var(--shadow-md)] md:p-12">
              <Badge className="absolute right-6 top-6">Free forever</Badge>
              <h3 className="m-0 mb-2 font-display text-[clamp(32px,4vw,52px)] font-bold tracking-[-0.03em]">
                Free
              </h3>
              <p className="m-0 mb-7 text-base text-text-secondary">
                Everything you need to publish and keep a page online.
              </p>
              <div className="grid gap-3.5">
                {FREE_FEATURES.map((feature) => (
                  <div
                    key={feature}
                    className="flex items-center gap-3 text-[15px]"
                  >
                    <Check className="size-[18px] shrink-0 text-accent" />
                    {feature}
                  </div>
                ))}
              </div>
              <Button className="mt-9">Drop a file to start</Button>
            </Reveal>

            {/* Pro */}
            <Reveal
              delay={0.1}
              className="flex flex-col rounded-[var(--r-xl)] border border-dashed border-border bg-sunken p-8 md:p-12"
            >
              <div className="mb-2 flex items-center gap-2.5">
                <h3 className="m-0 font-display text-[26px] font-semibold tracking-[-0.02em] text-text-secondary">
                  Pro
                </h3>
                <Badge variant="outline">Coming</Badge>
              </div>
              <p className="m-0 mb-6 text-[15px] leading-[1.55] text-text-muted">
                For when a page needs a little more. Free stays free &mdash;
                these are extras, never a lock on the open-source core.
              </p>
              <div className="grid gap-3.5">
                {PRO_FEATURES.map((feature) => (
                  <div
                    key={feature.title}
                    className="flex items-start gap-3 text-[15px] text-text-secondary"
                  >
                    <Lock className="mt-0.5 size-4 shrink-0 text-text-muted" />
                    <span>
                      <b className="text-text">{feature.title}</b> &mdash;{" "}
                      {feature.body}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-7 border-t border-border pt-6">
                <div className="flex flex-wrap gap-2">
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    aria-label="Email for Pro launch notification"
                    className="min-w-[160px] flex-1"
                  />
                  <Button variant="secondary">Notify me about Pro</Button>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ───────────────── FOOTER (ink panel) ───────────────── */}
      <footer data-theme="dark" id="support" className="bg-bg text-text">
        <div className="mx-auto max-w-[1280px] px-6 pb-12 pt-24 md:px-12">
          <div className="flex flex-wrap items-end justify-between gap-10 border-b border-border pb-16">
            <div>
              <h2 className="m-0 mb-4 max-w-[16ch] font-display text-[clamp(36px,5vw,64px)] font-bold tracking-[-0.03em]">
                Start keeping something today.
              </h2>
              <p className="m-0 flex items-center gap-2 font-mono text-[13px] text-live">
                <LiveDot /> Kept online, permanently.
              </p>
            </div>
            <Button size="lg">
              <span>&uarr;</span> Drop a file
            </Button>
          </div>
          <div className="flex flex-wrap justify-between gap-12 pt-10">
            <div className="font-display text-4xl font-bold tracking-[-0.03em]">
              kept
            </div>
            <div className="flex flex-wrap gap-14">
              {FOOTER_COLUMNS.map((col) => (
                <div
                  key={col.heading}
                  className="flex flex-col gap-3 font-mono text-xs tracking-[0.06em]"
                >
                  <span className="text-text-muted">
                    {col.heading.toUpperCase()}
                  </span>
                  {col.links.map((link) => (
                    <a
                      key={link}
                      href="#top"
                      className="text-text-secondary transition-colors hover:text-text"
                    >
                      {link}
                    </a>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
