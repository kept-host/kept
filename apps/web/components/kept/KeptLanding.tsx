"use client";

import {
  type CSSProperties,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { DRAFT_TTL_DAYS, KEPT_PAGE_LIMIT } from "@kept/shared";

import { infraCostMonth, keptCount, uptime } from "@/lib/landing-stats";

import {
  KeptEngine,
  type EngineRefs,
  type EngineState,
  type Tab,
} from "./kept-engine";

/**
 * kept Landing v2 (Claude Design) — faithful React port of the single-page
 * "drop box" choreography prototype. The markup below mirrors the design's
 * DOM exactly (nav, hero wall, pinned How/Agents, gauge, why, pricing, footer,
 * the traveling tile with all its layers, auth modal, toast, loader). All
 * per-frame motion is imperative and lives in `KeptEngine`, driven from a
 * single rAF loop inside the mount effect; only discrete UI state (phase,
 * modal, notify forms, accordion tab, gauge reveal) is React state.
 */

// Data figures come from the open-books module — never hardcoded here.
const LIVE_COUNT = keptCount;
// Visual constant: how many dots the field draws, not a number we report.
const GAUGE_TOTAL = 288;

// The shareable artifact: the one line a human pastes into their agent. Single
// source for both the rendered text and the clipboard payload so the two can
// never drift. E08 finalizes the wording — keep it a one-string edit.
const AGENT_PROMPT =
  "Publish this HTML with kept (https://kept.host/agents): call the MCP tool `publish_page`, then give me the live link and the claim link.";

type UIState = EngineState;

const INITIAL: UIState = {
  phase: "idle",
  authOpen: false,
  copied: false,
  agentNotify: "idle",
  proNotify: "idle",
  openTab: "mcp",
  humanPresent: false,
  gaugeRevealed: false,
  mintedCount: 0,
};

function reducer(state: UIState, patch: Partial<UIState>): UIState {
  return { ...state, ...patch };
}

/**
 * A single callback-ref factory that writes any concrete DOM element into one
 * of the engine's structural `{ current }` refs. Because the callback accepts
 * the widest element type, it is assignable to every element's `ref` prop
 * (span, div, img, input, …) without per-site casts.
 */
function bind<T extends HTMLElement>(ref: { current: T | null }) {
  return (el: T | null) => {
    ref.current = el;
  };
}

export default function KeptLanding() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Every DOM ref the engine drives. Kept in a stable object across renders.
  const refs = useRef<EngineRefs>(makeRefs()).current;
  const engineRef = useRef<KeptEngine | null>(null);

  // Mirror the latest state into a ref so the engine reads current values in
  // its rAF loop without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const engine = new KeptEngine(
      refs,
      { liveCount: LIVE_COUNT },
      () => stateRef.current,
      (patch, cb) => {
        // keep the engine's synchronous reads coherent within a frame
        stateRef.current = { ...stateRef.current, ...patch };
        dispatch(patch);
        if (cb) queueMicrotask(cb);
      },
    );
    engineRef.current = engine;
    engine.mount();
    return () => engine.unmount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const e = () => engineRef.current;

  // ---- copy-paste agent prompt (the only interactive bit outside the engine) ----
  const [promptCopied, setPromptCopied] = useState(false);
  const promptCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (promptCopyTimer.current) clearTimeout(promptCopyTimer.current);
    },
    [],
  );
  const copyPrompt = () => {
    // Insecure contexts and denied permissions must not throw — the prompt text
    // stays on screen and selectable either way.
    try {
      void navigator.clipboard?.writeText(AGENT_PROMPT).catch(() => {});
    } catch {
      /* noop */
    }
    setPromptCopied(true);
    if (promptCopyTimer.current) clearTimeout(promptCopyTimer.current);
    promptCopyTimer.current = setTimeout(() => setPromptCopied(false), 1700);
  };

  // ---- derived render values (match the prototype's renderVals) ----
  const humanPresent = state.humanPresent;
  const mcpNum = humanPresent ? "02" : "01";
  const cliNum = humanPresent ? "03" : "02";
  const skillNum = humanPresent ? "04" : "03";
  const chevron = (id: Tab) => (state.openTab === id ? "180deg" : "0deg");

  // The lit count: the honest global baseline plus whatever this visitor just
  // minted in this session. `state.mintedCount` is session-local UI state and is
  // never written back into `landing-stats` — reloading returns to the baseline.
  const keptNow = Math.min(
    Math.max(keptCount + state.mintedCount, 0),
    GAUGE_TOTAL,
  );
  // The "next slot": the first dot NOT yet filled. It is the drop affordance —
  // a pulsing accent ring, deliberately a different kind of thing from a solid
  // kept-page dot, so "every dot is a page kept online right now" stays true.
  const nextSlot = Math.min(keptNow, GAUGE_TOTAL - 1);

  const gaugeDots = useMemo(() => {
    // One meaning: every lit dot is a page kept online right now. The lit count
    // is the kept count itself, capped at the field size — a dot has no second
    // meaning, and there is no target denominator. Drafts are not drawn.
    // At the launch baseline (0 kept) nothing lights, and the field reads as a
    // calm, deliberately empty grid rather than a broken one.
    const onCount = keptNow;
    const revealed = state.gaugeRevealed;
    const dots = [];
    for (let i = 0; i < GAUGE_TOTAL; i++) {
      const col = i % 24,
        row = (i / 24) | 0;
      const dist = Math.hypot(col, row * 1.7);
      const lit = i < onCount;
      // The first kept page anchors the field: brighter, statically glowing,
      // and the origin the ripple wave expands from. With nothing kept there
      // is no anchor — the grid is uniformly unlit.
      const anchor = lit && i === 0;
      dots.push({
        color: anchor
          ? "#FFFFFF"
          : lit
            ? "var(--accent)"
            : "rgba(255,255,255,0.09)",
        glow: anchor
          ? "0 0 14px 4px rgba(139,109,255,.85), 0 0 3px 1px rgba(255,255,255,.9)"
          : "none",
        op: revealed ? 1 : 0,
        tf: revealed ? (anchor ? "scale(1.5)" : "scale(1)") : "scale(.2)",
        delay: revealed ? ((dist * 26) | 0) + "ms" : "0ms",
        // Lit dots ripple once revealed; phase = distance to the anchor, so the
        // glow wave expands outward from the top-left. The anchor keeps its own
        // static glow instead. At zero nothing carries data-on and the ripple
        // simply has nothing to animate.
        on: revealed && lit && !anchor,
        rippleDelay: ((dist * 90) | 0) + "ms",
      });
    }
    return dots;
  }, [state.gaugeRevealed, keptNow]);

  const tiles = useMemo(() => Array.from({ length: 63 }), []);

  return (
    <div
      ref={bind(refs.rootRef)}
      id="kept-root"
      style={{
        fontFamily: "var(--font-body)",
        background: "var(--bg)",
        color: "var(--text)",
        position: "relative",
        height: "100vh",
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      {/* ===================== NAV ===================== */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 60,
          backdropFilter: "saturate(1.2) blur(10px)",
          background: "rgba(250,248,244,.72)",
          borderBottom: "1px solid rgba(229,224,216,.7)",
        }}
      >
        <div
          id="nav-inner"
          style={{
            maxWidth: 1320,
            margin: "0 auto",
            padding: "0 40px",
            height: 68,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <a
            href="#top"
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 24,
              letterSpacing: "-0.03em",
              color: "var(--text)",
              textDecoration: "none",
            }}
          >
            kept
          </a>
          <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
            <nav
              id="nav-links"
              style={{
                display: "flex",
                gap: 22,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                letterSpacing: "0.08em",
              }}
            >
              <a href="#why" style={navLink}>
                ABOUT
              </a>
              <a href="#why" style={navLink}>
                OPEN&nbsp;SOURCE
              </a>
              <a href="#agents" style={navLink}>
                FOR&nbsp;AGENTS
              </a>
              <a href="#pricing" style={navLink}>
                PRICING
              </a>
            </nav>
            <div
              id="nav-divider"
              style={{ width: 1, height: 22, background: "var(--border)" }}
            />
            {/*
              Kept-only counter: pages kept forever, right now. Drafts are live
              but temporary and must never be counted here.
              TODO(E09): back this with a query over kept pages only.
            */}
            <div
              title="pages kept forever, right now"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                letterSpacing: "0.06em",
                color: "var(--text)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--live)",
                  animation: "keptLive 2s ease-in-out infinite",
                }}
              />
              <span ref={bind(refs.navCountRef)}>
                {LIVE_COUNT.toLocaleString()}
              </span>
              &nbsp;
              <span ref={bind(refs.navLabelRef)}>
                {LIVE_COUNT === 1 ? "PAGE" : "PAGES"}
              </span>
              &nbsp;KEPT
            </div>
          </div>
        </div>
      </header>

      <main id="top">
        {/* ===================== HERO — THE WALL ===================== */}
        <section
          ref={bind(refs.heroRef)}
          style={{
            position: "relative",
            minHeight: "calc(100vh - 68px)",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              perspective: "1700px",
            }}
          >
            <div
              ref={bind(refs.wallRef)}
              id="wall"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(9,1fr)",
                gap: 14,
                gridAutoFlow: "dense",
                width: "150vw",
                transform: "rotateX(13deg) rotateZ(-1deg) scale(1.04)",
                transformOrigin: "center 42%",
                maskImage:
                  "radial-gradient(140% 130% at 50% 46%,#000 66%,transparent 100%)",
                WebkitMaskImage:
                  "radial-gradient(140% 130% at 50% 46%,#000 66%,transparent 100%)",
              }}
            >
              <div
                ref={bind(refs.holeRef)}
                id="wall-hole"
                aria-hidden
                style={{ gridColumn: "6 / span 2", gridRow: "4 / span 2" }}
              />
              {tiles.map((_, i) => (
                <div
                  key={i}
                  data-tile
                  style={{
                    position: "relative",
                    aspectRatio: "1",
                    borderRadius: 10,
                    overflow: "hidden",
                    backgroundColor: "#e8e3da",
                    boxShadow:
                      "inset 0 0 0 1px rgba(40,30,20,.06),0 6px 16px rgba(40,30,20,.06)",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    data-thumb
                    alt=""
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      objectPosition: "center top",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "6px 7px",
                      background:
                        "linear-gradient(to top,rgba(20,15,10,.62),transparent)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 8.5,
                      letterSpacing: "0.02em",
                      color: "rgba(255,255,255,.92)",
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: "#3FB950",
                        flex: "none",
                      }}
                    />
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      page.kept.host
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            ref={bind(refs.veilRef)}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 8,
              pointerEvents: "none",
              background: "rgba(250,248,244,.6)",
              opacity: 0,
            }}
          />
          <div
            aria-hidden
            id="hero-scrim"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 10,
              pointerEvents: "none",
              background:
                "linear-gradient(100deg,rgba(250,248,244,1) 0%,rgba(250,248,244,1) 26%,rgba(250,248,244,.94) 39%,rgba(250,248,244,.55) 50%,rgba(250,248,244,0) 64%)",
            }}
          />

          <div
            data-container="1"
            style={{
              position: "relative",
              zIndex: 20,
              maxWidth: 1320,
              margin: "0 auto",
              padding: "0 40px",
              width: "100%",
              pointerEvents: "none",
            }}
          >
            <div style={{ maxWidth: 560, pointerEvents: "auto" }}>
              {/* IDLE / DRAGOVER content */}
              <div ref={bind(refs.ctaIdleRef)}>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                    color: "var(--accent)",
                    background: "var(--accent-soft)",
                    padding: "6px 12px",
                    borderRadius: "var(--r-pill)",
                    marginBottom: 22,
                  }}
                >
                  A WALL OF PAGES, KEPT ONLINE
                </div>
                <h1
                  id="hero-h1"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: "clamp(44px,6vw,88px)",
                    lineHeight: 0.95,
                    letterSpacing: "-0.035em",
                    margin: 0,
                    textShadow: "0 2px 30px rgba(250,248,244,.85)",
                  }}
                >
                  Drop an HTML file.
                  <br />
                  Get a link.
                  <br />
                  Kept&nbsp;&mdash;&nbsp;
                  <span style={{ color: "var(--accent)" }}>forever.</span>
                </h1>
                <p
                  style={{
                    fontSize: 16,
                    lineHeight: 1.55,
                    color: "var(--text-secondary)",
                    margin: "22px 0 26px",
                    maxWidth: "42ch",
                    textShadow: "0 1px 18px rgba(250,248,244,.9)",
                  }}
                >
                  Every square is a real page someone is keeping online right
                  now.{" "}
                  <b style={{ color: "var(--text)" }}>The glowing one is yours</b>{" "}
                  &mdash; drop a file to make it yours.
                </p>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    onClick={() => e()?.browse()}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 10,
                      fontFamily: "var(--font-display)",
                      fontWeight: 600,
                      fontSize: 15,
                      background: "var(--accent)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "var(--r-md)",
                      padding: "14px 22px",
                      cursor: "pointer",
                      boxShadow: "0 10px 30px rgba(109,74,255,.32)",
                    }}
                  >
                    <span style={{ fontSize: 17 }}>&uarr;</span> Drop a file or
                    browse
                  </button>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--text-muted)",
                    }}
                  >
                    NO ACCOUNT · DRAG ANYWHERE
                  </span>
                  <a
                    href="#agents"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      textDecoration: "none",
                      borderBottom: "1px solid var(--border)",
                      paddingBottom: 3,
                    }}
                  >
                    or let your agent do it &rarr;
                  </a>
                </div>
                <div
                  ref={bind(refs.mobileSlotRef)}
                  id="hero-mobile-slot"
                  style={{
                    width: "min(280px,72vw)",
                    height: "min(280px,72vw)",
                    margin: "30px auto 0",
                  }}
                />
              </div>

              {/* LIVE content (after mint) */}
              <div
                ref={bind(refs.ctaLiveRef)}
                id="cta-live"
                style={{
                  position: "absolute",
                  left: 40,
                  top: 0,
                  maxWidth: 560,
                  opacity: 0,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 18,
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: "var(--live)",
                      animation: "keptLive 2s ease-in-out infinite",
                    }}
                  />
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      letterSpacing: "0.08em",
                      color: "var(--live)",
                    }}
                  >
                    LIVE — KEPT ONLINE
                  </span>
                </div>
                <h1
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: "clamp(40px,5.2vw,76px)",
                    lineHeight: 0.96,
                    letterSpacing: "-0.035em",
                    margin: "0 0 8px",
                    textShadow: "0 2px 30px rgba(250,248,244,.85)",
                  }}
                >
                  It&rsquo;s yours now.
                </h1>
                <p
                  style={{
                    fontSize: 16,
                    lineHeight: 1.55,
                    color: "var(--text-secondary)",
                    margin: "14px 0 22px",
                    maxWidth: "40ch",
                    textShadow: "0 1px 18px rgba(250,248,244,.9)",
                  }}
                >
                  {/* No layout claim here. This copy used to say the page
                      "joined the wall on the right", which is only true above
                      820px — below it the wall widens to 340vw and sits behind
                      the text as a full-bleed backdrop, so there is no right. */}
                  Your page is live — anyone with the link can open it. It&rsquo;s
                  a draft for {DRAFT_TTL_DAYS} days. Keep it to make it
                  permanent.
                </p>
                <div
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-lg)",
                    boxShadow: "var(--shadow-lg)",
                    padding: "16px 18px",
                    maxWidth: 460,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 14,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    ref={bind(refs.liveSlugBigRef)}
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "clamp(18px,2.2vw,26px)",
                      letterSpacing: "-0.02em",
                    }}
                  >
                    your-page.kept.host
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => e()?.copy()}
                      aria-label="Copy link"
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: "var(--r-md)",
                        background: "var(--accent-soft)",
                        border: "none",
                        color: "var(--accent)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                    </button>
                    <button
                      onClick={() => e()?.openLive()}
                      aria-label="Open"
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: "var(--r-md)",
                        background: "var(--surface-sunken)",
                        border: "1px solid var(--border)",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M7 17 17 7M9 7h8v8" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    flexWrap: "wrap",
                    marginTop: 18,
                  }}
                >
                  <button
                    onClick={() => e()?.openAuth()}
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 600,
                      fontSize: 15,
                      background: "var(--text)",
                      color: "var(--bg)",
                      border: "none",
                      borderRadius: "var(--r-md)",
                      padding: "13px 22px",
                      cursor: "pointer",
                    }}
                  >
                    Keep it &amp; manage it &rarr;
                  </button>
                  {/* The two text links wrap as ONE unit. Loose in the row they
                      broke individually: from 417px the button and "manage this
                      draft" paired up on line one and orphaned "publish another"
                      alone underneath it. `flexShrink: 0` stops this group being
                      squeezed in beside the button instead of wrapping whole;
                      `maxWidth: "100%"` still lets it stack internally on the
                      narrowest screens, where the pair cannot fit on one line. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      flexWrap: "wrap",
                      flexShrink: 0,
                      maxWidth: "100%",
                    }}
                  >
                    {/* The anonymous manage screen: copy, QR, the draft
                        countdown, replace and delete all live there, keyed by
                        the token the publish response returned. Signed out, that
                        token is the only handle on this page — so this is a real
                        URL, not a panel. */}
                    <button onClick={() => e()?.manage()} style={liveTextAction}>
                      manage this draft &rarr;
                    </button>
                    <button onClick={() => e()?.reset()} style={liveTextAction}>
                      publish another
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            ref={bind(refs.hintRef)}
            id="scroll-hint"
            style={{
              position: "absolute",
              left: "50%",
              bottom: 24,
              transform: "translateX(-50%)",
              zIndex: 20,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 7,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.1em",
              color: "var(--text-muted)",
            }}
          >
            <span>SCROLL — YOUR PAGE FOLLOWS</span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </div>
        </section>

        {/* ===================== HOW IT WORKS ===================== */}
        <section
          id="how"
          ref={bind(refs.howRef)}
          style={{
            position: "relative",
            height: "300vh",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div
            ref={bind(refs.howStickyRef)}
            style={{
              position: "sticky",
              top: 0,
              height: "100vh",
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
            }}
          >
            <div
              data-container="1"
              style={{
                width: "100%",
                maxWidth: 1320,
                margin: "0 auto",
                padding: "0 40px",
              }}
            >
              <div style={{ position: "relative", zIndex: 50 }}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "var(--text-muted)",
                    marginBottom: 14,
                  }}
                >
                  How it works
                </div>
                <h2
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: "clamp(30px,4.2vw,54px)",
                    letterSpacing: "-0.03em",
                    lineHeight: 1.0,
                    margin: "0 0 12px",
                    maxWidth: "18ch",
                  }}
                >
                  Four steps. No build, no Git, no account.
                </h2>
                <p
                  id="how-hint"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    letterSpacing: "0.04em",
                    color: "var(--text-muted)",
                    margin: "0 0 40px",
                  }}
                >
                  Keep scrolling — your page rides each step.
                </p>
              </div>
              <div
                ref={bind(refs.cardsGridRef)}
                id="how-grid"
                style={{
                  position: "relative",
                  display: "grid",
                  gridTemplateColumns: "repeat(4,1fr)",
                  gap: 2,
                  background: "var(--border)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-lg)",
                  overflow: "hidden",
                }}
              >
                <div
                  ref={bind(refs.card0Ref)}
                  data-step="0"
                  style={{
                    position: "relative",
                    background: "var(--bg)",
                    padding: "28px 24px",
                    minHeight: 330,
                  }}
                >
                  <div
                    ref={bind(refs.card0InnerRef)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                    }}
                  >
                    <span style={howNum}>01</span>
                    <div style={{ marginTop: "auto" }}>
                      <svg
                        width="30"
                        height="30"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--text)"
                        strokeWidth="1.6"
                        style={{ marginBottom: 16 }}
                      >
                        <path d="M12 16V4M8 8l4-4 4 4" />
                        <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                      </svg>
                      <h3 style={howTitle}>Drop</h3>
                      <p style={howBody}>
                        Drag a single{" "}
                        <code style={howCode}>.html</code> file onto the page, or
                        paste raw HTML. That&rsquo;s the whole upload.
                      </p>
                    </div>
                  </div>
                </div>
                <div ref={bind(refs.card1Ref)} data-step="1" style={howCardCol}>
                  <span style={howNum}>02</span>
                  <div style={{ marginTop: "auto" }}>
                    <svg
                      width="30"
                      height="30"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--text)"
                      strokeWidth="1.6"
                      style={{ marginBottom: 16 }}
                    >
                      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
                      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
                    </svg>
                    <h3 style={howTitle}>Get a link</h3>
                    <p style={howBody}>
                      A live <code style={howCode}>*.kept.host</code> link mints
                      in seconds &mdash; a draft, live for {DRAFT_TTL_DAYS} days.
                      Copy it, QR it, share it.
                    </p>
                  </div>
                </div>
                <div ref={bind(refs.card2Ref)} data-step="2" style={howCardCol}>
                  <span style={howNum}>03</span>
                  <div style={{ marginTop: "auto" }}>
                    <svg
                      width="30"
                      height="30"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--text)"
                      strokeWidth="1.6"
                      style={{ marginBottom: 16 }}
                    >
                      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
                      <circle cx="9.5" cy="8" r="4" />
                      <path d="m15 11 2 2 4-4" />
                    </svg>
                    <h3 style={howTitle}>Keep</h3>
                    <p style={howBody}>
                      Sign in once and keep it &mdash; free, up to{" "}
                      {KEPT_PAGE_LIMIT} pages, forever.
                    </p>
                  </div>
                </div>
                <div ref={bind(refs.card3Ref)} data-step="3" style={howCardCol}>
                  <span style={howNum}>04</span>
                  <div style={{ marginTop: "auto" }}>
                    <svg
                      width="30"
                      height="30"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--text)"
                      strokeWidth="1.6"
                      style={{ marginBottom: 16 }}
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                    <h3 style={howTitle}>Kept forever</h3>
                    <p style={howBody}>
                      Once kept, there&rsquo;s no expiry and no rot. Nothing to
                      renew, no login needed to keep it up, and we never delete
                      it quietly.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===================== FOR AGENTS (MCP) ===================== */}
        <section
          id="agents"
          ref={bind(refs.agentsRef)}
          style={{
            position: "relative",
            height: "300vh",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div
            ref={bind(refs.agentsStickyRef)}
            style={{
              position: "sticky",
              top: 0,
              height: "100vh",
              display: "flex",
              alignItems: "center",
              overflow: "hidden",
            }}
          >
            <div
              data-container="1"
              style={{
                width: "100%",
                maxWidth: 1320,
                margin: "0 auto",
                padding: "0 40px",
              }}
            >
              <div
                id="agents-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1.02fr",
                  gap: 64,
                  alignItems: "center",
                }}
              >
                <div>
                  <div
                    data-reveal
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 18,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: "var(--text-muted)",
                      }}
                    >
                      Built for the AI era
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        letterSpacing: "0.08em",
                        color: "var(--accent)",
                        background: "var(--accent-soft)",
                        padding: "4px 10px",
                        borderRadius: "var(--r-pill)",
                      }}
                    >
                      COMING SOON
                    </span>
                  </div>
                  <h2
                    data-reveal
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "clamp(34px,4.8vw,64px)",
                      letterSpacing: "-0.03em",
                      lineHeight: 0.98,
                      margin: "0 0 20px",
                    }}
                  >
                    Let your agents publish.
                  </h2>
                  <p
                    data-reveal
                    style={{
                      fontSize: 17,
                      lineHeight: 1.6,
                      color: "var(--text-secondary)",
                      margin: "0 0 28px",
                      maxWidth: "46ch",
                    }}
                  >
                    AI agents generate HTML all day. Give it a home. Your agent
                    publishes with zero setup &mdash; no key, no account &mdash;
                    and gets back a live link plus a claim link for you. One
                    click makes it yours, forever.
                  </p>
                  <div data-reveal style={{ maxWidth: 560, marginBottom: 28 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        marginBottom: 9,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "var(--text-muted)",
                        }}
                      >
                        Paste this to your agent
                      </span>
                      <span
                        role="status"
                        aria-live="polite"
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          letterSpacing: "0.06em",
                          color: "var(--live)",
                        }}
                      >
                        {promptCopied ? "Copied to clipboard" : ""}
                      </span>
                      <button
                        type="button"
                        onClick={copyPrompt}
                        aria-label="Copy the agent prompt to your clipboard"
                        style={{
                          marginLeft: "auto",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 7,
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          letterSpacing: "0.06em",
                          background: "var(--surface)",
                          color: "var(--text)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--r-pill)",
                          padding: "5px 12px",
                          cursor: "pointer",
                        }}
                      >
                        {promptCopied ? "COPIED" : "COPY"}
                      </button>
                    </div>
                    <p
                      style={{
                        ...codeBlock,
                        fontSize: 12,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {AGENT_PROMPT}
                    </p>
                  </div>
                  <div
                    data-reveal
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 10,
                      marginBottom: 28,
                    }}
                  >
                    <div style={agentChip}>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--accent)",
                        }}
                      />
                      <span style={agentChipLabel}>MCP SERVER</span>
                      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                        the headline capability
                      </span>
                    </div>
                    <div style={agentChip}>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--text-muted)",
                        }}
                      />
                      <span style={agentChipLabel}>CLI</span>
                      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                        publish from scripts &amp; CI
                      </span>
                    </div>
                    <div style={agentChip}>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--text-muted)",
                        }}
                      />
                      <span style={agentChipLabel}>SKILL</span>
                      <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                        drop-in SKILL.md
                      </span>
                    </div>
                  </div>
                  <p
                    data-reveal
                    style={{
                      fontSize: 13,
                      lineHeight: 1.6,
                      color: "var(--text-muted)",
                      margin: "0 0 24px",
                      maxWidth: "52ch",
                    }}
                  >
                    Power path: API keys publish straight into your account
                    &mdash; part of Pro.
                  </p>
                  <div data-reveal style={{ maxWidth: 460 }}>
                    {state.agentNotify !== "success" ? (
                      <>
                        <div
                          style={{
                            display: "flex",
                            gap: 10,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
                          <input
                            ref={bind(refs.agentEmailRef)}
                            type="email"
                            placeholder="you@example.com"
                            style={{
                              flex: 1,
                              minWidth: 200,
                              fontFamily: "var(--font-body)",
                              fontSize: 15,
                              background: "var(--surface)",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--r-md)",
                              padding: "13px 15px",
                              color: "var(--text)",
                              outline: "none",
                            }}
                          />
                          <button
                            onClick={() => e()?.notifyAgent()}
                            style={{
                              fontFamily: "var(--font-display)",
                              fontWeight: 600,
                              fontSize: 15,
                              background: "var(--accent)",
                              color: "#fff",
                              border: "none",
                              borderRadius: "var(--r-md)",
                              padding: "13px 22px",
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                          >
                            Get notified
                          </button>
                        </div>
                        {state.agentNotify === "error" && (
                          <p style={notifyError}>
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="9" />
                              <path d="M12 8v4M12 16h.01" />
                            </svg>
                            Enter a valid email and we&rsquo;ll try again.
                          </p>
                        )}
                      </>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 11,
                          background:
                            "color-mix(in srgb,var(--live) 12%,var(--surface))",
                          border:
                            "1px solid color-mix(in srgb,var(--live) 30%,var(--border))",
                          borderRadius: "var(--r-md)",
                          padding: "14px 16px",
                        }}
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--live)"
                          strokeWidth="2.4"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                        <span style={{ fontSize: 15, color: "var(--text)" }}>
                          You&rsquo;re on the list — we&rsquo;ll email you when MCP
                          lands.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div
                  data-reveal
                  data-delay="120"
                  ref={bind(refs.accordionRef)}
                  style={{ position: "relative" }}
                >
                  <div
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--r-lg)",
                      boxShadow: "var(--shadow-lg)",
                      overflow: "hidden",
                    }}
                  >
                    {/* HUMAN — appears only when the drop box snaps in */}
                    {humanPresent && (
                      <div
                        ref={bind(refs.humanItemRef)}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          transition: "background .3s ease",
                        }}
                      >
                        <button
                          onClick={() => e()?.toggleHuman()}
                          style={accBtn}
                        >
                          <span style={accNum}>01</span>
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: "var(--accent)",
                              flexShrink: 0,
                            }}
                          />
                          <span style={accLabel}>HUMAN</span>
                          <span data-hide-mobile="1" style={accDesc}>
                            manual — drop a file yourself
                          </span>
                          <span
                            style={{
                              marginLeft: "auto",
                              fontFamily: "var(--font-mono)",
                              fontSize: 9.5,
                              letterSpacing: "0.07em",
                              color: "var(--live)",
                              background:
                                "color-mix(in srgb,var(--live) 13%,transparent)",
                              padding: "3px 8px",
                              borderRadius: "var(--r-pill)",
                            }}
                          >
                            LIVE NOW
                          </span>
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="var(--text-muted)"
                            strokeWidth="2"
                            style={{
                              flexShrink: 0,
                              transition: "transform .25s ease",
                              transform: `rotate(${chevron("human")})`,
                            }}
                          >
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </button>
                        <div ref={bind(refs.humanBodyRef)} style={accBody}>
                          <div style={{ padding: "0 20px 22px" }}>
                            <div
                              ref={bind(refs.humanSlotRef)}
                              style={{
                                position: "relative",
                                width: "100%",
                                minHeight: 236,
                                borderRadius: "var(--r-md)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <div
                                ref={bind(refs.humanPlaceholderRef)}
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  alignItems: "center",
                                  gap: 10,
                                  color: "var(--text-muted)",
                                }}
                              >
                                <svg
                                  width="34"
                                  height="34"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="var(--accent)"
                                  strokeWidth="1.6"
                                >
                                  <path d="M12 16V4M8 8l4-4 4 4" />
                                  <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                                </svg>
                                <span
                                  style={{
                                    fontFamily: "var(--font-display)",
                                    fontWeight: 600,
                                    fontSize: 16,
                                    color: "var(--text)",
                                  }}
                                >
                                  Drop your HTML
                                </span>
                                <span
                                  style={{
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 12,
                                    color: "var(--text-muted)",
                                  }}
                                >
                                  drag a{" "}
                                  <code style={{ color: "var(--accent)" }}>
                                    .html
                                  </code>{" "}
                                  file, or paste raw HTML
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* MCP SERVER */}
                    <div
                      ref={bind(refs.mcpItemRef)}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        transition: "background .3s ease",
                      }}
                    >
                      <button onClick={() => e()?.toggleMcp()} style={accBtn}>
                        <span style={accNum}>{mcpNum}</span>
                        <span style={accDot} />
                        <span style={accLabel}>MCP SERVER</span>
                        <span data-hide-mobile="1" style={accDesc}>
                          let an agent publish
                        </span>
                        <span style={accSoon}>SOON</span>
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--text-muted)"
                          strokeWidth="2"
                          style={{
                            flexShrink: 0,
                            transition: "transform .25s ease",
                            transform: `rotate(${chevron("mcp")})`,
                          }}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <div ref={bind(refs.mcpBodyRef)} style={accBody}>
                        <div style={{ padding: "0 20px 20px" }}>
                          <p
                            style={{
                              fontSize: 13,
                              lineHeight: 1.55,
                              color: "var(--text-secondary)",
                              margin: "0 0 12px",
                            }}
                          >
                            Add kept to any MCP host — Claude, Cursor, ChatGPT.
                            No token, no account. Drop this into your MCP
                            config:
                          </p>
                          <pre style={codeBlock}>
                            <span style={{ color: "#7C7468" }}>{"{"}</span>
                            {"\n  "}
                            <span style={{ color: "#9B8CFF" }}>&quot;kept&quot;</span>
                            {": {"}
                            {"\n    "}
                            <span style={{ color: "#9B8CFF" }}>
                              &quot;command&quot;
                            </span>
                            {": "}
                            <span style={{ color: "#8FBF8F" }}>&quot;npx&quot;</span>
                            {",\n    "}
                            <span style={{ color: "#9B8CFF" }}>&quot;args&quot;</span>
                            {": ["}
                            <span style={{ color: "#8FBF8F" }}>&quot;-y&quot;</span>
                            {", "}
                            <span style={{ color: "#8FBF8F" }}>
                              &quot;@kept/mcp&quot;
                            </span>
                            {"]\n  }\n"}
                            <span style={{ color: "#7C7468" }}>{"}"}</span>
                          </pre>
                          <p
                            style={{
                              fontSize: 12.5,
                              lineHeight: 1.55,
                              color: "var(--text-muted)",
                              margin: "12px 0 0",
                            }}
                          >
                            Your agent calls{" "}
                            <code
                              style={{
                                fontFamily: "var(--font-mono)",
                                color: "var(--accent)",
                              }}
                            >
                              kept.publish_page(html)
                            </code>{" "}
                            and gets back{" "}
                            <code
                              style={{
                                fontFamily: "var(--font-mono)",
                                color: "var(--accent)",
                              }}
                            >
                              {`{ live_url, claim_url, expires_in: "${DRAFT_TTL_DAYS}d" }`}
                            </code>
                            . The page is live at once as a draft; open the
                            claim link to keep it forever.
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* CLI */}
                    <div
                      ref={bind(refs.cliItemRef)}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        transition: "background .3s ease",
                      }}
                    >
                      <button onClick={() => e()?.toggleCli()} style={accBtn}>
                        <span style={accNum}>{cliNum}</span>
                        <span style={accDot} />
                        <span style={accLabel}>CLI</span>
                        <span data-hide-mobile="1" style={accDesc}>
                          publish from scripts &amp; CI
                        </span>
                        <span style={accSoon}>SOON</span>
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--text-muted)"
                          strokeWidth="2"
                          style={{
                            flexShrink: 0,
                            transition: "transform .25s ease",
                            transform: `rotate(${chevron("cli")})`,
                          }}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <div ref={bind(refs.cliBodyRef)} style={accBody}>
                        <div style={{ padding: "0 20px 20px" }}>
                          <pre style={{ ...codeBlock, fontSize: 12.5, lineHeight: 1.9 }}>
                            <span style={{ color: "#7C7468" }}># install</span>
                            {"\n"}
                            <span style={{ color: "#8FBF8F" }}>npm</span>
                            {" i -g @kept/cli\n\n"}
                            <span style={{ color: "#7C7468" }}>
                              # publish a file
                            </span>
                            {"\n"}
                            <span style={{ color: "#8FBF8F" }}>kept</span>
                            {" push ./index.html\n\n"}
                            <span style={{ color: "#7C7468" }}>↳ https://</span>
                            <span style={{ color: "#9B8CFF" }}>
                              your-page.kept.host
                            </span>
                          </pre>
                        </div>
                      </div>
                    </div>

                    {/* SKILL */}
                    <div
                      ref={bind(refs.skillItemRef)}
                      style={{ transition: "background .3s ease" }}
                    >
                      <button onClick={() => e()?.toggleSkill()} style={accBtn}>
                        <span style={accNum}>{skillNum}</span>
                        <span style={accDot} />
                        <span style={accLabel}>SKILL</span>
                        <span data-hide-mobile="1" style={accDesc}>
                          drop-in SKILL.md
                        </span>
                        <span style={accSoon}>SOON</span>
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--text-muted)"
                          strokeWidth="2"
                          style={{
                            flexShrink: 0,
                            transition: "transform .25s ease",
                            transform: `rotate(${chevron("skill")})`,
                          }}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <div ref={bind(refs.skillBodyRef)} style={accBody}>
                        <div style={{ padding: "0 20px 20px" }}>
                          <div
                            style={{
                              background: "var(--surface-sunken)",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--r-md)",
                              padding: "15px 16px",
                              fontFamily: "var(--font-mono)",
                              fontSize: 12,
                              lineHeight: 1.7,
                              color: "var(--text-secondary)",
                              position: "relative",
                              maxHeight: 150,
                              overflow: "hidden",
                            }}
                          >
                            <div style={{ color: "var(--text)" }}>---</div>
                            <div>
                              <span style={{ color: "var(--text-muted)" }}>
                                name:
                              </span>{" "}
                              publish-to-kept
                            </div>
                            <div>
                              <span style={{ color: "var(--text-muted)" }}>
                                description:
                              </span>{" "}
                              Publish an HTML file to kept and
                            </div>
                            <div style={{ paddingLeft: 14 }}>
                              return the live link and the claim link.
                            </div>
                            <div style={{ color: "var(--text)" }}>---</div>
                            <div style={{ marginTop: 6 }}>
                              When the user asks to publish or share an
                            </div>
                            <div>
                              HTML page, POST the file to{" "}
                              <span style={{ color: "var(--accent)" }}>
                                api.kept.host
                              </span>
                              …
                            </div>
                            <div
                              style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                bottom: 0,
                                height: 64,
                                background:
                                  "linear-gradient(transparent,var(--surface-sunken))",
                              }}
                            />
                          </div>
                          <button
                            onClick={() => e()?.downloadSkill()}
                            style={{
                              marginTop: 14,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 9,
                              fontFamily: "var(--font-display)",
                              fontWeight: 600,
                              fontSize: 14,
                              background: "var(--text)",
                              color: "var(--surface)",
                              border: "none",
                              borderRadius: "var(--r-md)",
                              padding: "11px 18px",
                              cursor: "pointer",
                            }}
                          >
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M12 3v12M7 10l5 5 5-5" />
                              <path d="M5 21h14" />
                            </svg>
                            Download SKILL.md
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===================== GAUGE TEASER ===================== */}
        <section
          id="gauge"
          ref={bind(refs.gaugeRef)}
          style={{
            maxWidth: 1320,
            margin: "0 auto",
            padding: "0 40px 150px",
          }}
        >
          <div
            data-reveal
            id="gauge-card"
            style={{
              background: "#141210",
              borderRadius: "var(--r-xl)",
              padding: 56,
              color: "#F5F1EA",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              id="gauge-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1.1fr",
                gap: 48,
                alignItems: "center",
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    color: "#8B6DFF",
                    marginBottom: 18,
                  }}
                >
                  Open books
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: "clamp(40px,5vw,68px)",
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                  }}
                >
                  <span ref={bind(refs.gaugeNumRef)}>0</span>
                </div>
                <p
                  style={{
                    fontSize: 16,
                    lineHeight: 1.6,
                    color: "#A8A096",
                    margin: "18px 0 20px",
                    maxWidth: "38ch",
                  }}
                >
                  Every dot is a page kept online right now. Pro pages fund the
                  free ones — and the books are public.
                </p>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "8px 24px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "#A8A096",
                    margin: "0 0 28px",
                  }}
                >
                  <span>
                    infra cost this month · &euro;{infraCostMonth.toFixed(2)}
                  </span>
                  <span>
                    uptime · {uptime === null ? "not yet measured" : `${uptime}%`}
                  </span>
                </div>
                <a
                  href="/stats"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    fontFamily: "var(--font-display)",
                    fontWeight: 600,
                    fontSize: 15,
                    background: "var(--accent)",
                    color: "#fff",
                    textDecoration: "none",
                    borderRadius: "var(--r-md)",
                    padding: "13px 22px",
                  }}
                >
                  See the math <span>&rarr;</span>
                </a>
              </div>
              <div ref={bind(refs.gaugeWrapRef)} style={{ position: "relative" }}>
                <div
                  ref={bind(refs.gaugeGridRef)}
                  id="gauge-dots"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(24,1fr)",
                    gap: 7,
                    alignContent: "center",
                    willChange: "transform",
                  }}
                >
                  {gaugeDots.map((d, i) =>
                    i === nextSlot ? (
                      // The next free slot. A real focusable control, not a
                      // decorative dot: hover *or* keyboard focus opens the drop
                      // panel, Enter/Space browses for a file. It never reads as
                      // a kept page — hollow accent ring, breathing glow.
                      <button
                        key={i}
                        id="gauge-next-slot"
                        type="button"
                        ref={bind(refs.gaugeSlotRef)}
                        onClick={() => e()?.browse()}
                        aria-label={
                          keptNow === 0
                            ? "Drop an HTML file to keep your first page"
                            : "Drop an HTML file to keep another page"
                        }
                        style={{
                          width: "100%",
                          aspectRatio: "1",
                          padding: 0,
                          borderRadius: "50%",
                          border: "1.5px solid var(--accent)",
                          background:
                            "color-mix(in srgb,var(--accent) 30%,transparent)",
                          cursor: "pointer",
                          opacity: d.op,
                          transform: d.tf,
                          transition:
                            "opacity .55s ease, transform .6s cubic-bezier(.34,1.45,.5,1)",
                          transitionDelay: d.delay,
                        }}
                      />
                    ) : (
                      <div
                        key={i}
                        data-on={d.on ? "1" : undefined}
                        style={
                          {
                            aspectRatio: "1",
                            borderRadius: "50%",
                            background: d.color,
                            boxShadow: d.glow,
                            opacity: d.op,
                            transform: d.tf,
                            transition:
                              "opacity .55s ease, transform .6s cubic-bezier(.34,1.45,.5,1)",
                            transitionDelay: d.delay,
                            "--ripple-delay": d.rippleDelay,
                          } as CSSProperties
                        }
                      />
                    ),
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===================== WHY KEPT ===================== */}
        <section
          id="why"
          ref={bind(refs.whyRef)}
          style={{ maxWidth: 1320, margin: "0 auto", padding: "0 40px 150px" }}
        >
          <h2
            data-reveal
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: "clamp(40px,6.5vw,96px)",
              letterSpacing: "-0.03em",
              lineHeight: 0.98,
              margin: "0 0 12px",
            }}
          >
            This link
            <br />
            won&rsquo;t{" "}
            <span ref={bind(refs.rotWordRef)} style={{ display: "inline-block" }}>
              rot.
            </span>
          </h2>
          <p
            data-reveal
            style={{
              fontSize: 18,
              lineHeight: 1.6,
              color: "var(--text-secondary)",
              maxWidth: "48ch",
              margin: "0 0 68px",
            }}
          >
            Most &ldquo;free&rdquo; hosts quietly delete you. kept is built to do
            the opposite — and to prove it in the open.
          </p>
          <div
            id="why-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3,1fr)",
              gap: 40,
              maxWidth: 1040,
            }}
          >
            <div data-reveal data-delay="0">
              <div style={whyKicker}>PERMANENT BY DEFAULT</div>
              <h3 style={whyTitle}>No expiry, ever</h3>
              <p style={whyBody}>
                Kept pages don&rsquo;t time out, don&rsquo;t need a login to stay
                up, and never silently vanish. Drafts are honest too: {DRAFT_TTL_DAYS}{" "}
                days, clearly labeled.
              </p>
            </div>
            <div data-reveal data-delay="90">
              <div style={whyKicker}>OPEN SOURCE · AGPL</div>
              <h3 style={whyTitle}>Nothing to lock you in</h3>
              <p style={whyBody}>
                The whole platform is open. Self-host it, fork it, audit it. Your
                pages aren&rsquo;t hostage to one company staying in business.
              </p>
            </div>
            <div data-reveal data-delay="180">
              <div style={whyKicker}>COSTS IN PUBLIC</div>
              <h3 style={whyTitle}>Math you can check</h3>
              <p style={whyBody}>
                Infra costs and uptime are public. Pro subscriptions fund the
                free tier. When we say &ldquo;free forever,&rdquo; you can check
                the math.
              </p>
            </div>
          </div>
        </section>

        {/* ===================== FREE + PRO ===================== */}
        <section
          id="pricing"
          ref={bind(refs.pricingRef)}
          style={{ maxWidth: 1320, margin: "0 auto", padding: "0 40px 150px" }}
        >
          <div
            id="pricing-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1.3fr 1fr",
              gap: 24,
              alignItems: "stretch",
            }}
          >
            <div
              data-reveal
              style={{
                background: "var(--surface)",
                border: "1.5px solid var(--accent)",
                borderRadius: "var(--r-xl)",
                padding: 48,
                boxShadow: "var(--shadow-md)",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 24,
                  right: 24,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  padding: "6px 12px",
                  borderRadius: "var(--r-pill)",
                }}
              >
                FREE FOREVER
              </div>
              <h3
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: "clamp(32px,4vw,52px)",
                  letterSpacing: "-0.03em",
                  margin: "0 0 8px",
                }}
              >
                Free
              </h3>
              <p
                style={{
                  fontSize: 16,
                  color: "var(--text-secondary)",
                  margin: "0 0 28px",
                }}
              >
                Everything you need to publish and keep a page online.
              </p>
              <div style={{ display: "grid", gap: 14 }}>
                {[
                  `Unlimited drafts — live instantly, ${DRAFT_TTL_DAYS} days`,
                  `${KEPT_PAGE_LIMIT} pages kept forever`,
                  "Instant link, QR, live status",
                  "Keep, rename slug, replace versions",
                  "Dashboard for pages & drafts",
                ].map((f) => (
                  <div key={f} style={freeFeature}>
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="2"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {f}
                  </div>
                ))}
              </div>
              <div
                ref={bind(refs.priceSlotRef)}
                style={{
                  position: "relative",
                  marginTop: 34,
                  width: "100%",
                  minHeight: 216,
                  borderRadius: "var(--r-md)",
                }}
              >
                <div
                  ref={bind(refs.pricePlaceholderRef)}
                  onClick={() => e()?.browse()}
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    border:
                      "1.5px dashed color-mix(in srgb,var(--accent) 45%,transparent)",
                    borderRadius: "var(--r-md)",
                    background:
                      "color-mix(in srgb,var(--accent-soft) 40%,transparent)",
                    cursor: "pointer",
                  }}
                >
                  <svg
                    width="30"
                    height="30"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="1.7"
                  >
                    <path d="M12 16V4M8 8l4-4 4 4" />
                    <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                  </svg>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 600,
                      fontSize: 15,
                      color: "var(--text)",
                    }}
                  >
                    Drop your HTML
                  </div>
                  <div style={slugChip}>yourpage.kept.host</div>
                </div>
              </div>
            </div>
            <div
              data-reveal
              data-delay="100"
              style={{
                background: "var(--surface-sunken)",
                border: "1px dashed var(--border)",
                borderRadius: "var(--r-xl)",
                padding: 48,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <h3
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 600,
                    fontSize: 26,
                    letterSpacing: "-0.02em",
                    margin: 0,
                    color: "var(--text-secondary)",
                  }}
                >
                  Pro
                </h3>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    letterSpacing: "0.06em",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                    padding: "4px 10px",
                    borderRadius: "var(--r-pill)",
                  }}
                >
                  COMING
                </span>
              </div>
              <p
                style={{
                  fontSize: 15,
                  color: "var(--text-muted)",
                  margin: "0 0 24px",
                  lineHeight: 1.55,
                }}
              >
                For when a page needs a little more. Free stays free — these are
                extras, never a lock on the open-source core.
              </p>
              <div style={{ display: "grid", gap: 13 }}>
                {PRO_FEATURES.map((f) => (
                  <div key={f.title} style={proFeature}>
                    {f.icon}
                    <span>
                      <b style={{ color: "var(--text)" }}>{f.title}</b> — {f.body}
                    </span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  marginTop: 28,
                  paddingTop: 24,
                  borderTop: "1px solid var(--border)",
                }}
              >
                {state.proNotify !== "success" ? (
                  <>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <input
                        ref={bind(refs.proEmailRef)}
                        type="email"
                        placeholder="you@example.com"
                        style={{
                          flex: 1,
                          minWidth: 160,
                          fontFamily: "var(--font-body)",
                          fontSize: 14,
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--r-md)",
                          padding: "11px 13px",
                          color: "var(--text)",
                          outline: "none",
                        }}
                      />
                      <button
                        onClick={() => e()?.notifyPro()}
                        style={{
                          fontFamily: "var(--font-display)",
                          fontWeight: 600,
                          fontSize: 14,
                          background: "var(--surface)",
                          color: "var(--text)",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--r-md)",
                          padding: "11px 18px",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Notify me about Pro
                      </button>
                    </div>
                    {state.proNotify === "error" && (
                      <p style={{ ...notifyError, fontSize: 12 }}>
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 8v4M12 16h.01" />
                        </svg>
                        Enter a valid email and we&rsquo;ll try again.
                      </p>
                    )}
                  </>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontSize: 14,
                      color: "var(--text)",
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--live)"
                      strokeWidth="2.4"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    We&rsquo;ll let you know when Pro is ready.
                  </div>
                )}
                <p
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    letterSpacing: "0.03em",
                    color: "var(--text-muted)",
                    margin: "16px 0 0",
                  }}
                >
                  Pro is what keeps the free tier free.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ===================== FOOTER ===================== */}
      <footer ref={bind(refs.footerRef)} style={{ background: "#0E0D0B", color: "#F5F1EA" }}>
        <div
          id="footer-inner"
          style={{ maxWidth: 1320, margin: "0 auto", padding: "110px 40px 48px" }}
        >
          <div
            data-reveal
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: 40,
              flexWrap: "wrap",
              paddingBottom: 60,
              borderBottom: "1px solid #2A2620",
            }}
          >
            <div>
              <h2
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: "clamp(36px,5vw,64px)",
                  letterSpacing: "-0.03em",
                  margin: "0 0 16px",
                  maxWidth: "16ch",
                }}
              >
                Start keeping something today.
              </h2>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  color: "#3FB950",
                }}
              >
                ● Kept online, permanently.
              </p>
            </div>
            <div
              ref={bind(refs.footSlotRef)}
              style={{
                position: "relative",
                width: "min(380px,100%)",
                minHeight: 190,
                borderRadius: "var(--r-lg)",
                flex: "none",
              }}
            >
              <div
                ref={bind(refs.footPlaceholderRef)}
                onClick={() => e()?.browse()}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  border: "1.5px dashed rgba(139,109,255,.55)",
                  borderRadius: "var(--r-lg)",
                  background: "rgba(255,255,255,.04)",
                  cursor: "pointer",
                }}
              >
                <svg
                  width="30"
                  height="30"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#8B6DFF"
                  strokeWidth="1.7"
                >
                  <path d="M12 16V4M8 8l4-4 4 4" />
                  <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 600,
                    fontSize: 15,
                    color: "#F5F1EA",
                  }}
                >
                  Drop your HTML
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "#B9A7FF",
                    background: "rgba(139,109,255,.16)",
                    padding: "5px 10px",
                    borderRadius: 999,
                  }}
                >
                  yourpage.kept.host
                </div>
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 48,
              flexWrap: "wrap",
              paddingTop: 40,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: 40,
                letterSpacing: "-0.03em",
              }}
            >
              kept
            </div>
            <div style={{ display: "flex", gap: 56, flexWrap: "wrap" }}>
              <FooterCol
                heading="PROJECT"
                links={[
                  { label: "GitHub repo" },
                  { label: "Stats", href: "/stats" },
                  { label: "License · AGPL-3.0" },
                ]}
              />
              <FooterCol
                heading="DEVELOPERS"
                links={[
                  { label: "MCP server · soon" },
                  { label: "CLI · soon" },
                  { label: "Docs" },
                ]}
              />
              <FooterCol
                heading="SAFETY"
                links={[
                  { label: "The forever promise", href: "/promise" },
                  { label: "Report a page" },
                  { label: "Acceptable use" },
                  { label: "Privacy" },
                ]}
              />
            </div>
          </div>
        </div>
      </footer>

      {/* ===================== THE TRAVELING SLOT =====================
          Its four faces carry `data-face` (idle | minting | live | error) —
          one per `Phase` the engine drives. The engine crossfades them by
          opacity, which Playwright still counts as "visible", so the e2e suite
          asserts on `data-face`'s opacity rather than on visible text. */}
      <div
        ref={bind(refs.tileRef)}
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: 300,
          height: 300,
          zIndex: 40,
          borderRadius: 14,
          willChange: "transform",
          pointerEvents: "auto",
        }}
      >
        <div
          ref={bind(refs.tileInnerRef)}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 14,
            overflow: "hidden",
            background: "#FAF8F4",
          }}
        >
          <div
            ref={bind(refs.slotIdleRef)}
            data-face="idle"
            onClick={() => e()?.browse()}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              border: "1.5px dashed var(--accent)",
              borderRadius: 14,
              background: "radial-gradient(120% 120% at 50% 40%,#fff,#F3EFFF)",
              cursor: "pointer",
            }}
          >
            <svg
              width="34"
              height="34"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.7"
            >
              <path d="M12 16V4M8 8l4-4 4 4" />
              <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <div
              ref={bind(refs.slotTextRef)}
              style={{ fontWeight: 600, fontSize: 15, color: "var(--text)" }}
            >
              Drop your HTML
            </div>
            <div style={slugChip}>yourpage.kept.host</div>
          </div>
          <div
            ref={bind(refs.mintingRef)}
            data-face="minting"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              background: "radial-gradient(120% 120% at 50% 40%,#fff,#F3EFFF)",
              opacity: 0,
              pointerEvents: "none",
              overflow: "hidden",
            }}
          >
            <div
              ref={bind(refs.scanRef)}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                height: 40,
                background:
                  "linear-gradient(to bottom,rgba(109,74,255,.45),transparent)",
              }}
            />
            <span
              ref={bind(refs.spinnerRef)}
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                border: "2.5px solid var(--accent-soft)",
                borderTopColor: "var(--accent)",
              }}
            />
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text)" }}>
              Keeping it…
            </div>
            <div
              ref={bind(refs.mintSlugRef)}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-secondary)",
              }}
            >
              minting link…
            </div>
          </div>
          <div
            ref={bind(refs.liveRef)}
            data-face="live"
            style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={bind(refs.liveImgRef)}
              alt="your kept page"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                objectPosition: "center top",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 10,
                top: 10,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "rgba(20,15,10,.55)",
                backdropFilter: "blur(4px)",
                borderRadius: 999,
                padding: "5px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.08em",
                color: "#fff",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#3FB950",
                  animation: "keptLive 2s ease-in-out infinite",
                }}
              />
              LIVE
            </div>
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "10px 11px",
                background: "linear-gradient(to top,rgba(20,15,10,.72),transparent)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "#fff",
              }}
            >
              <span
                ref={bind(refs.liveSlugRef)}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                your-page.kept.host
              </span>
            </div>
          </div>
          {/* The `error` face. Nothing was published when this shows, so the
              only thing lost is the attempt — the message is the API's own and
              the button puts the drop box back. */}
          <div
            ref={bind(refs.errorRef)}
            data-face="error"
            role="alert"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: "18px 20px",
              textAlign: "center",
              border: "1.5px solid var(--danger)",
              borderRadius: 14,
              background:
                "radial-gradient(120% 120% at 50% 40%,var(--surface),color-mix(in srgb,var(--danger) 10%,var(--surface)))",
              opacity: 0,
              pointerEvents: "none",
              overflow: "hidden",
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--danger)"
              strokeWidth="1.7"
              aria-hidden
            >
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--text)" }}>
              Couldn&rsquo;t keep it
            </div>
            <div
              ref={bind(refs.errorTextRef)}
              style={{
                fontSize: 12.5,
                lineHeight: 1.45,
                color: "var(--text-secondary)",
                overflow: "hidden",
              }}
            >
              Nothing was published.
            </div>
            <button
              onClick={() => e()?.dismissError()}
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                fontSize: 13,
                background: "var(--text)",
                color: "var(--bg)",
                border: "none",
                borderRadius: "var(--r-md)",
                padding: "9px 16px",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
          <div
            ref={bind(refs.lockCardRef)}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              padding: "24px 22px",
              background: "radial-gradient(120% 120% at 50% 26%,#fff,#F1ECFF)",
              border: "1.6px dashed var(--accent)",
              borderRadius: 14,
              opacity: 0,
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                color: "var(--accent)",
              }}
            >
              01
            </span>
            <div
              style={{
                flex: 1,
                margin: "14px 0 12px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 9,
                border:
                  "1.4px dashed color-mix(in srgb,var(--accent) 42%,transparent)",
                borderRadius: 11,
                background: "rgba(255,255,255,.5)",
              }}
            >
              <svg
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.7"
              >
                <path d="M12 16V4M8 8l4-4 4 4" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 600,
                  fontSize: 15,
                  color: "var(--text)",
                }}
              >
                Drop your HTML
              </div>
              <div style={{ ...slugChip, fontSize: 10.5 }}>yourpage.kept.host</div>
            </div>
            <h3
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                fontSize: 20,
                letterSpacing: "-0.02em",
                margin: "0 0 6px",
              }}
            >
              Drop
            </h3>
            <p
              style={{
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--text-secondary)",
                margin: 0,
              }}
            >
              Drag a single{" "}
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--accent)",
                }}
              >
                .html
              </code>{" "}
              file onto the page, or paste raw HTML.
            </p>
          </div>
          <div
            ref={bind(refs.whyLinkRef)}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--accent-soft)",
              borderRadius: "50%",
              opacity: 0,
              pointerEvents: "none",
              transition: "opacity .15s ease",
            }}
          >
            <svg
              style={{ width: "52%", height: "52%" }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2.1"
            >
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
              <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
            </svg>
            <span
              ref={bind(refs.whyLiveDotRef)}
              style={{
                position: "absolute",
                right: "8%",
                top: "8%",
                width: "22%",
                height: "22%",
                borderRadius: "50%",
                background: "#3FB950",
                border: "2px solid #fff",
                opacity: 0,
                transition: "opacity .15s ease",
              }}
            />
          </div>
          <div
            ref={bind(refs.gaugeDockRef)}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--accent)",
              // A rounded box, not a disc: it sits BESIDE the pulsing slot dot
              // rather than on top of it, so it must not read as another dot.
              borderRadius: 12,
              opacity: 0,
              pointerEvents: "none",
              transition: "opacity .15s ease",
            }}
          >
            <svg
              style={{ width: "46%", height: "46%" }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
            >
              <path d="M12 16V4M8 8l4-4 4 4" />
              <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
          </div>
          <div
            ref={bind(refs.whyCardRef)}
            onClick={() => e()?.browse()}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              padding: 18,
              background: "radial-gradient(120% 120% at 50% 20%,#fff,#F1ECFF)",
              border: "1.6px solid var(--accent)",
              borderRadius: 16,
              opacity: 0,
              pointerEvents: "none",
              cursor: "pointer",
              transition: "opacity .22s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2.2"
              >
                <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
                <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
              </svg>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  letterSpacing: ".1em",
                  color: "var(--accent)",
                }}
              >
                A LINK THAT LASTS
              </span>
            </div>
            <div
              style={{
                flex: 1,
                margin: "12px 0",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                border:
                  "1.5px dashed color-mix(in srgb,var(--accent) 45%,transparent)",
                borderRadius: 12,
                background: "rgba(255,255,255,.55)",
              }}
            >
              <svg
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.7"
              >
                <path d="M12 16V4M8 8l4-4 4 4" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 600,
                  fontSize: 15,
                  color: "var(--text)",
                }}
              >
                Drop your HTML
              </div>
              <div style={{ ...slugChip, fontSize: 10 }}>yourpage.kept.host</div>
            </div>
            <p
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--text-secondary)",
                margin: 0,
              }}
            >
              Every kept link is permanent — drop a page and this exact URL still
              works years from now.
            </p>
          </div>
          <div
            ref={bind(refs.darkIdleRef)}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              border: "1.5px dashed rgba(139,109,255,.6)",
              borderRadius: 14,
              background: "radial-gradient(120% 120% at 50% 40%,#221E33,#141210)",
              opacity: 0,
              pointerEvents: "none",
            }}
          >
            <svg
              width="34"
              height="34"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#8B6DFF"
              strokeWidth="1.7"
            >
              <path d="M12 16V4M8 8l4-4 4 4" />
              <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <div style={{ fontWeight: 600, fontSize: 15, color: "#F5F1EA" }}>
              Drop your HTML
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "#B9A7FF",
                background: "rgba(139,109,255,.16)",
                padding: "5px 10px",
                borderRadius: 999,
              }}
            >
              yourpage.kept.host
            </div>
          </div>
        </div>
      </div>

      <div
        ref={bind(refs.glowRef)}
        aria-hidden
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: 200,
          height: 200,
          zIndex: -1,
          borderRadius: 22,
          background: "rgba(109,74,255,0.5)",
          filter: "blur(46px)",
          opacity: 0,
          pointerEvents: "none",
          willChange: "transform,opacity",
        }}
      />

      <div
        ref={bind(refs.highlightRef)}
        aria-hidden
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          width: 200,
          height: 200,
          zIndex: 41,
          borderRadius: 16,
          border: "2.5px solid var(--accent)",
          boxShadow:
            "0 0 0 4px color-mix(in srgb,var(--accent) 13%,transparent),0 12px 44px rgba(109,74,255,.30)",
          willChange: "transform,width,height",
          opacity: 0,
          pointerEvents: "none",
        }}
      />

      <input
        ref={bind(refs.fileRef)}
        type="file"
        accept=".html,text/html"
        onChange={() => e()?.onFile()}
        style={{ display: "none" }}
      />

      {/* ===================== AUTH MODAL ===================== */}
      {state.authOpen && (
        <div
          onClick={() => e()?.closeAuth()}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "rgba(26,23,20,0.55)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div
            onClick={(ev) => ev.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 420,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-xl)",
              boxShadow: "var(--shadow-lg)",
              padding: 32,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 8,
              }}
            >
              <h3
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: 26,
                  letterSpacing: "-0.02em",
                  margin: 0,
                }}
              >
                Keep this page
              </h3>
              <button
                onClick={() => e()?.closeAuth()}
                aria-label="Close"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: 20,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <p
              style={{
                fontSize: 14,
                color: "var(--text-secondary)",
                lineHeight: 1.55,
                margin: "0 0 26px",
              }}
            >
              We&rsquo;ll attach{" "}
              <b ref={bind(refs.authSlugRef)} style={{ color: "var(--text)" }}>
                your-page.kept.host
              </b>{" "}
              to your account. It stays exactly where it is — keeping it stops
              the {DRAFT_TTL_DAYS}-day draft clock and puts it in your dashboard.
            </p>
            <button style={authGithub}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.5 2 2 6.6 2 12.3c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.4-3.4-1.4-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4-1.4 6.8-5.2 6.8-9.7C22 6.6 17.5 2 12 2z" />
              </svg>
              Continue with GitHub
            </button>
            <button style={authEmail}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="m3 7 9 6 9-6" />
              </svg>
              Email me a magic link
            </button>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-muted)",
                textAlign: "center",
                margin: 0,
              }}
            >
              NO PASSWORD · YOUR PAGE STAYS LIVE EITHER WAY
            </p>
          </div>
        </div>
      )}

      {/* ===================== TOAST ===================== */}
      {state.copied && (
        <div
          style={{
            position: "fixed",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 90,
            background: "var(--text)",
            color: "var(--bg)",
            borderRadius: "var(--r-md)",
            padding: "12px 18px",
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--live)"
            strokeWidth="2.5"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          Copied to clipboard
        </div>
      )}

      {/* ===================== LOADER ===================== */}
      <div
        ref={bind(refs.loaderRef)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 100,
          background: "#FAF8F4",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 22,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: "-0.03em",
          }}
        >
          kept
        </div>
        <div
          style={{
            width: 220,
            height: 3,
            borderRadius: 999,
            background: "#E9E3DA",
            overflow: "hidden",
          }}
        >
          <div
            ref={bind(refs.barRef)}
            style={{ height: "100%", width: "0%", background: "var(--accent)" }}
          />
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.1em",
            color: "var(--text-muted)",
          }}
        >
          PREFETCHING&nbsp;<span ref={bind(refs.loadCountRef)}>0</span>&nbsp;KEPT&nbsp;PAGES
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * refs factory + shared style objects + small sub-components
 * ------------------------------------------------------------------------- */

function makeRefs(): EngineRefs {
  const r = <T extends HTMLElement = HTMLElement>() => ({
    current: null as T | null,
  });
  return {
    rootRef: r(),
    heroRef: r(),
    wallRef: r(),
    holeRef: r(),
    veilRef: r(),
    tileRef: r(),
    tileInnerRef: r(),
    slotIdleRef: r(),
    slotTextRef: r(),
    mintingRef: r(),
    spinnerRef: r(),
    scanRef: r(),
    liveRef: r(),
    liveImgRef: r<HTMLImageElement>(),
    liveSlugRef: r(),
    mintSlugRef: r(),
    errorRef: r(),
    errorTextRef: r(),
    fileRef: r<HTMLInputElement>(),
    loaderRef: r(),
    barRef: r(),
    loadCountRef: r(),
    navCountRef: r(),
    navLabelRef: r(),
    hintRef: r(),
    ctaIdleRef: r(),
    ctaLiveRef: r(),
    liveSlugBigRef: r(),
    authSlugRef: r(),
    howRef: r(),
    howStickyRef: r(),
    cardsGridRef: r(),
    card0Ref: r(),
    card1Ref: r(),
    card2Ref: r(),
    card3Ref: r(),
    card0InnerRef: r(),
    lockCardRef: r(),
    highlightRef: r(),
    glowRef: r(),
    agentsRef: r(),
    agentsStickyRef: r(),
    accordionRef: r(),
    humanItemRef: r(),
    humanBodyRef: r(),
    humanSlotRef: r(),
    humanPlaceholderRef: r(),
    mcpItemRef: r(),
    mcpBodyRef: r(),
    cliItemRef: r(),
    cliBodyRef: r(),
    skillItemRef: r(),
    skillBodyRef: r(),
    gaugeRef: r(),
    gaugeWrapRef: r(),
    gaugeGridRef: r(),
    gaugeNumRef: r(),
    gaugeSlotRef: r(),
    gaugeDockRef: r(),
    whyRef: r(),
    rotWordRef: r(),
    whyLinkRef: r(),
    whyLiveDotRef: r(),
    whyCardRef: r(),
    pricingRef: r(),
    priceSlotRef: r(),
    pricePlaceholderRef: r(),
    footerRef: r(),
    footSlotRef: r(),
    footPlaceholderRef: r(),
    darkIdleRef: r(),
    agentEmailRef: r<HTMLInputElement>(),
    proEmailRef: r<HTMLInputElement>(),
    mobileSlotRef: r(),
  };
}

/** The quiet text actions under the live link — manage, publish another. */
const liveTextAction: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--text-secondary)",
  background: "none",
  border: "none",
  cursor: "pointer",
  borderBottom: "1px solid var(--border)",
  paddingBottom: 3,
};
const navLink: React.CSSProperties = {
  color: "var(--text-secondary)",
  textDecoration: "none",
};
const howNum: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--accent)",
};
const howTitle: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 600,
  fontSize: 22,
  letterSpacing: "-0.02em",
  margin: "0 0 10px",
};
const howBody: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: "var(--text-secondary)",
  margin: 0,
};
const howCode: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--accent)",
};
const howCardCol: React.CSSProperties = {
  position: "relative",
  background: "var(--bg)",
  padding: "28px 24px",
  minHeight: 330,
  display: "flex",
  flexDirection: "column",
};
const agentChip: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  padding: "10px 14px",
};
const agentChipLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  letterSpacing: "0.04em",
  color: "var(--text)",
};
const accBtn: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 13,
  padding: "17px 20px",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "var(--font-body)",
};
const accNum: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};
const accLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  letterSpacing: "0.05em",
  color: "var(--text)",
};
const accDesc: React.CSSProperties = { fontSize: 13, color: "var(--text-muted)" };
const accDot: React.CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "var(--text-muted)",
  flexShrink: 0,
};
const accSoon: React.CSSProperties = {
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  letterSpacing: "0.07em",
  color: "var(--accent)",
  background: "var(--accent-soft)",
  padding: "3px 8px",
  borderRadius: "var(--r-pill)",
};
const accBody: React.CSSProperties = {
  overflow: "hidden",
  maxHeight: 0,
  transition: "max-height .42s cubic-bezier(.4,0,.2,1)",
};
const codeBlock: React.CSSProperties = {
  margin: 0,
  background: "#141210",
  color: "#E8E2D6",
  borderRadius: "var(--r-md)",
  padding: 16,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.7,
  overflow: "auto",
};
const whyKicker: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  letterSpacing: "0.08em",
  color: "var(--accent)",
  paddingBottom: 18,
  borderBottom: "1px solid var(--border)",
  marginBottom: 18,
};
const whyTitle: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 600,
  fontSize: 22,
  letterSpacing: "-0.02em",
  margin: "0 0 10px",
};
const whyBody: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.6,
  color: "var(--text-secondary)",
  margin: 0,
};
const freeFeature: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  fontSize: 15,
};
const proFeature: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  fontSize: 15,
  color: "var(--text-secondary)",
};
const slugChip: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--accent)",
  background: "var(--accent-soft)",
  padding: "5px 10px",
  borderRadius: 999,
};
const notifyError: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 13,
  color: "var(--danger)",
  margin: "12px 0 0",
};
const authGithub: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  fontFamily: "var(--font-display)",
  fontWeight: 600,
  fontSize: 15,
  background: "var(--text)",
  color: "var(--bg)",
  border: "none",
  borderRadius: "var(--r-md)",
  padding: 14,
  cursor: "pointer",
  marginBottom: 12,
};
const authEmail: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  fontFamily: "var(--font-display)",
  fontWeight: 600,
  fontSize: 15,
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-md)",
  padding: 14,
  cursor: "pointer",
  marginBottom: 18,
};

const proIcon = (children: React.ReactNode) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--text-muted)"
    strokeWidth="2"
    style={{ marginTop: 2, flex: "none" }}
  >
    {children}
  </svg>
);

const PRO_FEATURES = [
  {
    title: "More pages kept forever",
    body: `keep well beyond the free ${KEPT_PAGE_LIMIT}.`,
    icon: proIcon(
      <>
        <rect x="7" y="3" width="14" height="15" rx="2" />
        <path d="M3 7v12a2 2 0 0 0 2 2h11" />
      </>,
    ),
  },
  {
    title: "API keys",
    body: "agents publish straight to your account.",
    icon: proIcon(
      <>
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="M10.7 12.3 21 2M17 6l3 3" />
      </>,
    ),
  },
  {
    title: "Higher agent/MCP volume",
    body: "room for agents that publish often.",
    icon: proIcon(
      <>
        <path d="M3 20h18" />
        <path d="M6 20v-6M11 20V8M16 20v-9M21 20V4" />
      </>,
    ),
  },
  {
    title: "Password-protected pages",
    body: "gate a page behind a password.",
    icon: proIcon(
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>,
    ),
  },
  {
    title: "Custom domains",
    body: "serve a page on your own domain.",
    icon: proIcon(
      <>
        <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        <circle cx="12" cy="12" r="10" />
      </>,
    ),
  },
  {
    title: "Private analytics",
    body: "views & referrers, privacy-respecting.",
    icon: proIcon(
      <>
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 3 3 5-6" />
      </>,
    ),
  },
  {
    title: "Remove the kept badge",
    body: "unbranded pages.",
    icon: proIcon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12l3 3 5-6" />
      </>,
    ),
  },
  {
    title: "Version history & rollback",
    body: "restore a previous version.",
    icon: proIcon(<path d="M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4" />),
  },
  {
    title: "EU data residency",
    body: "pages stored and served from the EU.",
    icon: proIcon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a14 14 0 0 0 0 18M3.5 9h17M3.5 15h17" />
      </>,
    ),
  },
] as const;

function FooterCol({
  heading,
  links,
}: {
  heading: string;
  links: readonly { label: string; href?: string }[];
}) {
  // Labels without a live destination render as plain text, never a dead link.
  const linkStyle: React.CSSProperties = {
    color: "#A8A096",
    textDecoration: "none",
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        letterSpacing: "0.06em",
        color: "#A8A096",
      }}
    >
      <span style={{ color: "#6E6760" }}>{heading}</span>
      {links.map((l) =>
        l.href ? (
          <a key={l.label} href={l.href} style={linkStyle}>
            {l.label}
          </a>
        ) : (
          <span key={l.label} style={linkStyle}>
            {l.label}
          </span>
        ),
      )}
    </div>
  );
}
