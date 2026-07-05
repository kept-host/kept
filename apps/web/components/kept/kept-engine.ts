/**
 * kept Landing v2 — the "drop box" scroll-choreography engine.
 *
 * A faithful, imperative port of the `Component` class from the Claude Design
 * prototype (`kept Landing v2.dc.html`). It runs entirely inside a single
 * `useEffect` on the client, driving a `requestAnimationFrame` loop that
 * repositions one fixed "tile" (the drop box) every frame. Per-section
 * routines (computeHow / computeAgents / computeGauge / computeWhy /
 * computePricing / computeFooter) chain to decide the tile's pose as the user
 * scrolls the `#kept-root` container, docking it into each section.
 *
 * Discrete React state (phase, authOpen, copied, agentNotify, proNotify,
 * openTab, humanPresent, gaugeRevealed) is owned by the React component and
 * mirrored here via `getState` / `setState`; everything per-frame is written
 * straight to the DOM through refs (never React state) to stay at 60fps.
 */

type Ref<T extends HTMLElement = HTMLElement> = { current: T | null };

export type Phase = "idle" | "dragover" | "minting" | "live";
export type Tab = "human" | "mcp" | "cli" | "skill" | null;
export type NotifyState = "idle" | "success" | "error";

export interface EngineState {
  phase: Phase;
  authOpen: boolean;
  copied: boolean;
  agentNotify: NotifyState;
  proNotify: NotifyState;
  openTab: Tab;
  humanPresent: boolean;
  gaugeRevealed: boolean;
}

export interface EngineRefs {
  rootRef: Ref;
  heroRef: Ref;
  wallRef: Ref;
  holeRef: Ref;
  veilRef: Ref;
  tileRef: Ref;
  tileInnerRef: Ref;
  slotIdleRef: Ref;
  slotTextRef: Ref;
  mintingRef: Ref;
  spinnerRef: Ref;
  scanRef: Ref;
  liveRef: Ref;
  liveImgRef: Ref<HTMLImageElement>;
  liveSlugRef: Ref;
  mintSlugRef: Ref;
  fileRef: Ref<HTMLInputElement>;
  loaderRef: Ref;
  barRef: Ref;
  loadCountRef: Ref;
  navCountRef: Ref;
  hintRef: Ref;
  ctaIdleRef: Ref;
  ctaLiveRef: Ref;
  liveSlugBigRef: Ref;
  authSlugRef: Ref;
  howRef: Ref;
  howStickyRef: Ref;
  cardsGridRef: Ref;
  card0Ref: Ref;
  card1Ref: Ref;
  card2Ref: Ref;
  card3Ref: Ref;
  card0InnerRef: Ref;
  lockCardRef: Ref;
  highlightRef: Ref;
  glowRef: Ref;
  agentsRef: Ref;
  agentsStickyRef: Ref;
  accordionRef: Ref;
  humanItemRef: Ref;
  humanBodyRef: Ref;
  humanSlotRef: Ref;
  humanPlaceholderRef: Ref;
  mcpItemRef: Ref;
  mcpBodyRef: Ref;
  cliItemRef: Ref;
  cliBodyRef: Ref;
  skillItemRef: Ref;
  skillBodyRef: Ref;
  gaugeRef: Ref;
  gaugeWrapRef: Ref;
  gaugeGridRef: Ref;
  gaugeNumRef: Ref;
  whyRef: Ref;
  rotWordRef: Ref;
  whyLinkRef: Ref;
  whyLiveDotRef: Ref;
  whyCardRef: Ref;
  pricingRef: Ref;
  priceSlotRef: Ref;
  pricePlaceholderRef: Ref;
  footerRef: Ref;
  footSlotRef: Ref;
  footPlaceholderRef: Ref;
  darkIdleRef: Ref;
  agentEmailRef: Ref<HTMLInputElement>;
  proEmailRef: Ref<HTMLInputElement>;
  mobileSlotRef: Ref;
}

interface Pose {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rot: number;
}

interface AgentResult {
  pose: Pose;
  lock: number;
  active: boolean;
  boxOp: number;
  want: Tab | undefined;
  present: boolean;
  hi: Tab;
  boxIn?: boolean;
}

interface WhyResult {
  pose: Pose;
  active: boolean;
  iconAmt: number;
  expanded: boolean;
}

interface SectionResult {
  pose: Pose;
  active: boolean;
  lock?: number;
}

export interface EngineProps {
  liveCount: number;
  gaugeFunded: number;
}

export class KeptEngine {
  refs: EngineRefs;
  props: EngineProps;
  getState: () => EngineState;
  setState: (patch: Partial<EngineState>, cb?: () => void) => void;

  reduced: boolean;
  isMobile: boolean;

  pose: Pose = { cx: 0, cy: 0, w: 300, h: 300, rot: 0 };
  cur: Pose = { cx: 0, cy: 0, w: 300, h: 300, rot: 0 };
  mouse = { x: 0, y: 0 };
  mouseRaw?: { x: number; y: number };
  gridPar = { x: 0, y: 0 };
  hover = false;
  curScale = 1;
  tileOpacity = 1;
  lockAmt = 0;
  highlightT = -1;
  highlightOn = 0;
  count: number;
  liveSlug = "your-page.kept.host";
  tiles: { img: string; slug: string }[] = [];

  cardRefs: Ref[] = [];
  W = 0;
  H = 0;

  // scroll-choreography section snapshots
  agState: AgentResult | null = null;
  gaugeState: SectionResult | null = null;
  whyState: WhyResult | null = null;
  prState: SectionResult | null = null;
  ftState: SectionResult | null = null;

  whyIconOn = false;
  anyExpanded = false;
  prLock = 0;
  ftLock = 0;
  agentLock = 0;
  agBoxIn = false;
  tileVisTarget: number | null = 1;

  // accordion manual-override tracking
  agManual = false;
  manualTab: Tab = null;
  private _lastST?: number;

  private _gaugeRevealed = false;
  private reveals: { el: HTMLElement; delay: number; started: number }[] = [];

  // timers / listeners
  raf = 0;
  mintTimer?: ReturnType<typeof setTimeout>;
  loadTimer?: ReturnType<typeof setInterval>;
  countTimer?: ReturnType<typeof setInterval>;
  copyTimer?: ReturnType<typeof setTimeout>;
  private _mm?: (e: MouseEvent) => void;
  private _over?: (e: DragEvent) => void;
  private _leave?: (e: DragEvent) => void;
  private _drop?: (e: DragEvent) => void;
  private _dragDepth = 0;
  private _enter?: () => void;
  private _leaveT?: () => void;
  private _rs?: () => void;
  private _mq?: MediaQueryList;
  private _mqh?: (e: MediaQueryListEvent) => void;

  constructor(
    refs: EngineRefs,
    props: EngineProps,
    getState: () => EngineState,
    setState: (patch: Partial<EngineState>, cb?: () => void) => void,
  ) {
    this.refs = refs;
    this.props = props;
    this.getState = getState;
    this.setState = setState;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.isMobile = window.matchMedia("(max-width: 820px)").matches;
    this.count = props.liveCount || 1284;
    this.tiles = this.buildTiles();
  }

  // ---------- procedural thumbnails ----------
  rng(a: number) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  drawThumb(layout: number, palIdx: number, seed: number): string {
    const PALS = [
      { bg: "#ffffff", ink: "#16181d", acc: "#ff5b39", sub: "#e9e6e0" },
      { bg: "#0f1115", ink: "#eef1f6", acc: "#5b8cff", sub: "#23262e" },
      { bg: "#faf7f0", ink: "#1a1714", acc: "#6d4aff", sub: "#ece6dc" },
      { bg: "#0d1f17", ink: "#eafff4", acc: "#36d399", sub: "#163328" },
      { bg: "#fff7fb", ink: "#23121c", acc: "#ff4d9d", sub: "#f3e2ea" },
      { bg: "#f4f5f7", ink: "#101418", acc: "#111317", sub: "#e3e5e9" },
      { bg: "#1a1430", ink: "#f0eaff", acc: "#b388ff", sub: "#2c2350" },
      { bg: "#fffdf5", ink: "#211c10", acc: "#e0a33a", sub: "#efe7d2" },
      { bg: "#eef4ff", ink: "#0b1f3a", acc: "#2a6fdb", sub: "#d6e2f7" },
      { bg: "#160f0c", ink: "#ffece0", acc: "#ff8a4c", sub: "#2f211a" },
    ];
    const p = PALS[palIdx % PALS.length]!;
    const r = this.rng(seed);
    const W = 300,
      H = 300,
      c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d");
    if (!x) return "";
    x.fillStyle = p.bg;
    x.fillRect(0, 0, W, H);
    const rr = (
      X: number,
      Y: number,
      w: number,
      h: number,
      col: string,
      rad?: number,
    ) => {
      x.fillStyle = col;
      rad = rad || 0;
      x.beginPath();
      x.moveTo(X + rad, Y);
      x.arcTo(X + w, Y, X + w, Y + h, rad);
      x.arcTo(X + w, Y + h, X, Y + h, rad);
      x.arcTo(X, Y + h, X, Y, rad);
      x.arcTo(X, Y, X + w, Y, rad);
      x.fill();
    };
    const lines = (
      X: number,
      Y: number,
      w: number,
      n: number,
      gap: number,
      col: string,
      hh?: number,
    ) => {
      for (let i = 0; i < n; i++) {
        const ww = w * (0.5 + r() * 0.5);
        rr(X, Y + i * gap, ww, hh || 5, col, 2);
      }
    };
    const M = 24;
    rr(0, 0, W, 14, p.sub, 0);
    rr(10, 5, 5, 4, p.acc, 2);
    rr(20, 5, 5, 4, p.ink + "55", 2);
    if (layout === 0) {
      rr(M, 40, W - 2 * M, 96, p.sub, 10);
      rr(M, 40, W - 2 * M, 96, p.acc + "22", 10);
      rr(M + 14, 150, 150, 16, p.ink, 4);
      lines(M + 14, 176, 150, 2, 12, p.ink + "55", 5);
      rr(M + 14, 212, 76, 22, p.acc, 11);
    } else if (layout === 1) {
      const g = 3,
        s = (W - 2 * M - 2 * 10) / g;
      for (let i = 0; i < g; i++)
        for (let j = 0; j < g; j++) {
          rr(
            M + i * (s + 10),
            40 + j * (s + 10),
            s,
            s,
            (i + j) % 2 ? p.sub : p.acc + "33",
            6,
          );
        }
    } else if (layout === 2) {
      x.fillStyle = p.acc;
      x.beginPath();
      x.arc(W / 2, 90, 34, 0, 7);
      x.fill();
      rr(W / 2 - 50, 138, 100, 12, p.ink, 4);
      lines(M, 170, W - 2 * M, 3, 16, p.ink + "44", 6);
      rr(W / 2 - 40, 240, 80, 20, p.acc, 10);
    } else if (layout === 3) {
      rr(M, 44, W - 2 * M, 18, p.ink, 4);
      lines(M, 84, W - 2 * M, 7, 20, p.ink + "40", 6);
    } else if (layout === 4) {
      rr(M + 10, 52, W - 2 * M - 20, H - 104, p.sub, 14);
      rr(W / 2 - 44, 84, 88, 88, p.acc, 12);
      rr(W / 2 - 58, 190, 116, 12, p.ink, 4);
      lines(W / 2 - 58, 212, 116, 2, 12, p.ink + "44", 5);
    } else if (layout === 5) {
      rr(0, 14, 70, H - 14, p.sub, 0);
      lines(14, 34, 40, 5, 16, p.ink + "55", 6);
      for (let i = 0; i < 5; i++) {
        const bh = 30 + r() * 120;
        rr(92 + i * 36, H - 30 - bh, 24, bh, p.acc, 4);
      }
      rr(92, 44, 150, 14, p.ink, 4);
    } else if (layout === 6) {
      for (let i = 0; i < 5; i++) {
        rr(M, 44 + i * 44, W - 2 * M, 34, p.sub, 8);
        rr(M + 10, 54 + i * 44, 16, 16, p.acc, 4);
        rr(M + 34, 57 + i * 44, 120, 8, p.ink + "77", 3);
      }
    } else if (layout === 7) {
      rr(M, 40, (W - 2 * M) * 0.58, H - 80, p.acc + "44", 10);
      rr(M + (W - 2 * M) * 0.6, 40, (W - 2 * M) * 0.4, (H - 90) / 2, p.sub, 8);
      rr(
        M + (W - 2 * M) * 0.6,
        40 + (H - 80) / 2 + 8,
        (W - 2 * M) * 0.4,
        (H - 90) / 2,
        p.ink + "22",
        8,
      );
    } else if (layout === 8) {
      x.textAlign = "center";
      x.fillStyle = p.acc;
      x.font = "italic 600 30px Geist, serif";
      x.fillText("Save", W / 2, 110);
      x.fillText("the date", W / 2, 146);
      rr(W / 2 - 30, 176, 60, 2, p.ink, 1);
      rr(W / 2 - 44, 196, 88, 12, p.ink + "88", 3);
    } else {
      rr(M, 44, W - 2 * M, 14, p.ink, 4);
      x.strokeStyle = p.acc;
      x.lineWidth = 3;
      x.beginPath();
      for (let i = 0; i < 9; i++) {
        const px = M + i * ((W - 2 * M) / 8),
          py = 200 - Math.abs(Math.sin(i * 0.9 + seed)) * 120;
        if (i === 0) x.moveTo(px, py);
        else x.lineTo(px, py);
      }
      x.stroke();
      lines(M, 236, W - 2 * M, 2, 16, p.ink + "33", 6);
    }
    return c.toDataURL("image/webp", 0.7);
  }
  buildTiles() {
    const NAMES = [
      "sunset-notes", "tiny-portfolio", "wedding-rsvp", "launch-day",
      "recipe-card", "resume-2026", "field-guide", "press-kit", "trip-log",
      "demo-reel", "reading-list", "garden-plan", "mixtape", "postcard",
      "changelog", "manifesto", "price-list", "lookbook", "open-invite",
      "case-study", "moodboard", "set-list", "syllabus", "patch-notes",
      "zine-04", "dinner-menu", "itinerary", "thesis", "playbook", "almanac",
      "launch-faq", "studio-001", "wishlist", "timeline", "cv-jan", "art-drop",
      "park-map", "quiz", "poster", "beta-notes",
    ];
    const base: string[] = [];
    for (let i = 0; i < 24; i++)
      base.push(this.drawThumb(i % 10, (i * 3 + 1) % 10, i * 1337 + 7));
    const order = [...Array(24).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1);
      const t = order[i]!;
      order[i] = order[j]!;
      order[j] = t;
    }
    const tiles: { img: string; slug: string }[] = [];
    for (let i = 0; i < 63; i++) {
      const img = base[order[(i * 5 + order[i % 24]!) % 24]!]!;
      tiles.push({
        img,
        slug: NAMES[(i * 3 + 1) % NAMES.length]! + ".kept.host",
      });
    }
    return tiles;
  }

  // ---------- lifecycle ----------
  mount() {
    const r = this.refs;
    if (r.navCountRef.current)
      r.navCountRef.current.textContent = this.count.toLocaleString();
    this._mm = (e: MouseEvent) => {
      this.mouse.x = e.clientX / window.innerWidth - 0.5;
      this.mouse.y = e.clientY / window.innerHeight - 0.5;
      this.mouseRaw = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", this._mm, { passive: true });
    this._dragDepth = 0;
    this._over = (e: DragEvent) => {
      e.preventDefault();
      if (this.getState().phase === "idle") {
        this._dragDepth = 2;
        this.applyPhase("dragover");
      }
    };
    this._leave = (e: DragEvent) => {
      e.preventDefault();
      this._dragDepth--;
      if (this._dragDepth <= 0 && this.getState().phase === "dragover")
        this.applyPhase("idle");
    };
    this._drop = (e: DragEvent) => {
      e.preventDefault();
      this._dragDepth = 0;
      this.startMint();
    };
    const root = r.rootRef.current;
    if (root) {
      root.addEventListener("dragenter", this._over as EventListener);
      root.addEventListener("dragover", this._over as EventListener);
      root.addEventListener("dragleave", this._leave as EventListener);
      root.addEventListener("drop", this._drop as EventListener);
    }
    const tl = r.tileRef.current;
    if (tl) {
      this._enter = () => {
        this.hover = true;
      };
      this._leaveT = () => {
        this.hover = false;
      };
      tl.addEventListener("mouseenter", this._enter);
      tl.addEventListener("mouseleave", this._leaveT);
    }
    this.cardRefs = [r.card0Ref, r.card1Ref, r.card2Ref, r.card3Ref];
    if (this.reduced || this.isMobile) {
      const pad = this.isMobile ? "70px 0" : "130px 0";
      const hs = r.howStickyRef.current,
        hw = r.howRef.current;
      if (hw) hw.style.height = "auto";
      if (hs) {
        hs.style.position = "static";
        hs.style.height = "auto";
        hs.style.padding = pad;
      }
      const as = r.agentsStickyRef.current,
        aw = r.agentsRef.current;
      if (aw) aw.style.height = "auto";
      if (as) {
        as.style.position = "static";
        as.style.height = "auto";
        as.style.padding = pad;
      }
      setTimeout(() => this.applyAccordion(this.getState().openTab, null), 0);
      if (this.reduced && r.gaugeNumRef.current)
        r.gaugeNumRef.current.textContent = (
          this.props.gaugeFunded ?? 1284
        ).toLocaleString();
    }
    this.paintThumbs();
    this.revealTiles();
    this.setupReveal();
    if (this.isMobile) {
      const t = r.tileRef.current;
      if (t) t.style.position = "absolute";
      this.dockMobile();
      if (document.fonts && document.fonts.ready)
        document.fonts.ready.then(() => this.dockMobile());
      this._rs = () => this.dockMobile();
      window.addEventListener("resize", this._rs);
    } else {
      this.computeTarget();
      this.cur = { ...this.pose };
      this.applyTile();
    }
    this._mq = window.matchMedia("(max-width: 820px)");
    this._mqh = (e: MediaQueryListEvent) => {
      if (e.matches !== this.isMobile) window.location.reload();
    };
    try {
      this._mq.addEventListener("change", this._mqh);
    } catch {
      /* noop */
    }
    this.runLoader();
    if (!this.reduced) {
      this.tick();
      this.countTimer = setInterval(() => {
        this.count += Math.random() < 0.6 ? 1 : 0;
        if (r.navCountRef.current)
          r.navCountRef.current.textContent = this.count.toLocaleString();
      }, 9000);
    }
  }
  unmount() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.mintTimer);
    clearInterval(this.loadTimer);
    clearInterval(this.countTimer);
    clearTimeout(this.copyTimer);
    if (this._mm) window.removeEventListener("mousemove", this._mm);
    if (this._rs) window.removeEventListener("resize", this._rs);
    if (this._mq && this._mqh) {
      try {
        this._mq.removeEventListener("change", this._mqh);
      } catch {
        /* noop */
      }
    }
    const root = this.refs.rootRef.current;
    if (root) {
      if (this._over) {
        root.removeEventListener("dragenter", this._over as EventListener);
        root.removeEventListener("dragover", this._over as EventListener);
      }
      if (this._leave)
        root.removeEventListener("dragleave", this._leave as EventListener);
      if (this._drop) root.removeEventListener("drop", this._drop as EventListener);
    }
    const tl = this.refs.tileRef.current;
    if (tl) {
      if (this._enter) tl.removeEventListener("mouseenter", this._enter);
      if (this._leaveT) tl.removeEventListener("mouseleave", this._leaveT);
    }
  }

  // ---------- React-bound handlers (invoked from the component) ----------
  browse = () => {
    const p = this.getState().phase;
    if (p === "idle" || p === "dragover") this.refs.fileRef.current?.click();
  };
  onFile = () => this.startMint();
  openAuth = () => {
    this.setState({ authOpen: true });
    setTimeout(() => {
      if (this.refs.authSlugRef.current)
        this.refs.authSlugRef.current.textContent = this.liveSlug;
    }, 0);
  };
  closeAuth = () => this.setState({ authOpen: false });
  reset = () => {
    this.liveSlug = "your-page.kept.host";
    this.applyPhase("idle");
  };
  copy = () => {
    try {
      if (navigator.clipboard)
        navigator.clipboard.writeText("https://" + this.liveSlug);
    } catch {
      /* noop */
    }
    this.setState({ copied: true });
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.setState({ copied: false }), 1700);
  };
  notifyAgent = () => this.doNotify("agent");
  notifyPro = () => this.doNotify("pro");
  toggleHuman = () => this.setTab("human");
  toggleMcp = () => this.setTab("mcp");
  toggleCli = () => this.setTab("cli");
  toggleSkill = () => this.setTab("skill");
  downloadSkill = () => this.doDownloadSkill();

  revealGauge() {
    if (this._gaugeRevealed) return;
    this._gaugeRevealed = true;
    this.setState({ gaugeRevealed: true });
    this.countUp(
      this.refs.gaugeNumRef.current,
      this.props.gaugeFunded ?? 1284,
      1400,
    );
  }
  countUp(el: HTMLElement | null, target: number, dur: number) {
    if (!el) return;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  setTab(id: Tab) {
    this.agManual = true;
    this.manualTab = this.getState().openTab === id ? null : id;
    this.setState({ openTab: this.manualTab }, () =>
      this.applyAccordion(this.manualTab, null),
    );
  }
  doDownloadSkill() {
    const md =
      "---\nname: publish-to-kept\ndescription: Publish an HTML file to kept and return the permanent live link.\n---\n\nWhen the user asks to publish or share an HTML page, POST the file to api.kept.host and return the live *.kept.host URL. Pages are kept forever.\n";
    try {
      const blob = new Blob([md], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "SKILL.md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch {
      /* noop */
    }
  }
  doNotify(kind: "agent" | "pro") {
    const ref = kind === "agent" ? this.refs.agentEmailRef : this.refs.proEmailRef;
    const val = ref.current ? ref.current.value.trim() : "";
    const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val);
    this.setState({
      [kind === "agent" ? "agentNotify" : "proNotify"]: ok ? "success" : "error",
    } as Partial<EngineState>);
  }

  // ---------- loader ----------
  runLoader() {
    const start = performance.now(),
      dur = this.reduced ? 200 : 1500,
      target = this.count;
    const r = this.refs;
    this.loadTimer = setInterval(() => {
      const p = Math.min(1, (performance.now() - start) / dur),
        e = 1 - Math.pow(1 - p, 3);
      if (r.barRef.current) r.barRef.current.style.width = e * 100 + "%";
      if (r.loadCountRef.current)
        r.loadCountRef.current.textContent = Math.floor(
          e * target,
        ).toLocaleString();
      if (p >= 1) {
        clearInterval(this.loadTimer);
        if (r.loadCountRef.current)
          r.loadCountRef.current.textContent = target.toLocaleString();
        const l = r.loaderRef.current;
        if (l) {
          l.style.transition = "opacity .6s ease";
          l.style.opacity = "0";
          l.style.pointerEvents = "none";
          setTimeout(() => {
            if (l) l.style.display = "none";
          }, 650);
        }
      }
    }, 40);
  }

  // ---------- thumbnails + reveals ----------
  paintThumbs() {
    const wall = this.refs.wallRef.current;
    if (!wall) return;
    const imgs = [
      ...wall.querySelectorAll<HTMLImageElement>("img[data-thumb]"),
    ];
    imgs.forEach((im, i) => {
      const t = this.tiles[i];
      if (t) im.src = t.img;
    });
  }
  revealTiles() {
    const wall = this.refs.wallRef.current;
    if (!wall) return;
    const kids = [...wall.querySelectorAll<HTMLElement>("[data-tile]")];
    kids.forEach((t) => {
      t.style.transition = "none";
    });
    if (this.reduced) {
      kids.forEach((t) => {
        t.style.opacity = "1";
        t.style.transform = "none";
      });
      return;
    }
    const cols = 9,
      dur = 560,
      start = performance.now();
    const delays = kids.map(
      (t, i) => 200 + (i % cols) * 36 + Math.floor(i / cols) * 68,
    );
    const step = () => {
      const now = performance.now();
      let done = true;
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i]!;
        const p = Math.max(0, Math.min(1, (now - start - delays[i]!) / dur));
        if (p < 1) done = false;
        const e = 1 - Math.pow(1 - p, 3);
        kid.style.opacity = e.toFixed(3);
        kid.style.transform =
          "translateY(" +
          ((1 - e) * 10).toFixed(1) +
          "px) scale(" +
          (0.94 + 0.06 * e).toFixed(3) +
          ")";
      }
      if (!done) requestAnimationFrame(step);
      else
        kids.forEach((t) => {
          t.style.transform = "none";
          t.style.opacity = "1";
        });
    };
    requestAnimationFrame(step);
  }
  setupReveal() {
    const scope = this.refs.rootRef.current || document;
    const els = [...scope.querySelectorAll<HTMLElement>("[data-reveal]")];
    this.reveals = els.map((el) => ({
      el,
      delay: parseInt(el.getAttribute("data-delay") || "0", 10),
      started: 0,
    }));
    if (this.reduced) {
      els.forEach((el) => {
        el.style.opacity = "1";
        el.style.transform = "none";
      });
      this.reveals = [];
      return;
    }
    els.forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translateY(26px)";
    });
  }
  updateReveals(now: number) {
    if (!this.reveals || !this.reveals.length) return;
    const H = window.innerHeight;
    this.reveals = this.reveals.filter((rv) => {
      if (!rv.started) {
        if (rv.el.getBoundingClientRect().top < H * 0.88)
          rv.started = now + rv.delay;
        else return true;
      }
      const p = Math.max(0, Math.min(1, (now - rv.started) / 600));
      const e = 1 - Math.pow(1 - p, 3);
      rv.el.style.opacity = e.toFixed(3);
      rv.el.style.transform = "translateY(" + ((1 - e) * 26).toFixed(1) + "px)";
      if (p >= 1) {
        rv.el.style.transform = "none";
        return false;
      }
      return true;
    });
  }

  // ---------- phase / mint ----------
  applyPhase(phase: Phase) {
    this.setState({ phase });
    const r = this.refs;
    const idle = r.slotIdleRef.current,
      mint = r.mintingRef.current,
      live = r.liveRef.current;
    if (idle) {
      idle.style.opacity =
        phase === "idle" || phase === "dragover" ? "1" : "0";
      idle.style.pointerEvents = phase === "idle" ? "auto" : "none";
      idle.style.background =
        phase === "dragover"
          ? "radial-gradient(120% 120% at 50% 40%,#fff,#E7DEFF)"
          : "radial-gradient(120% 120% at 50% 40%,#fff,#F3EFFF)";
    }
    if (mint) mint.style.opacity = phase === "minting" ? "1" : "0";
    if (live) {
      live.style.opacity = phase === "live" ? "1" : "0";
      live.style.pointerEvents = phase === "live" ? "auto" : "none";
    }
    const veil = r.veilRef.current;
    if (veil) veil.style.opacity = phase === "dragover" ? "1" : "0";
    const st = r.slotTextRef.current;
    if (st)
      st.textContent =
        phase === "dragover" ? "Release to keep it" : "Drop your HTML";
    const ci = r.ctaIdleRef.current,
      cl = r.ctaLiveRef.current;
    if (ci) {
      ci.style.opacity = phase === "live" ? "0" : "1";
      ci.style.pointerEvents = phase === "live" ? "none" : "auto";
    }
    if (cl) {
      cl.style.opacity = phase === "live" ? "1" : "0";
      cl.style.pointerEvents = phase === "live" ? "auto" : "none";
    }
    const hint = r.hintRef.current;
    if (hint) hint.style.opacity = phase === "idle" ? "1" : "0";
    if (this.isMobile) {
      const ms = r.mobileSlotRef && r.mobileSlotRef.current,
        tl = r.tileRef.current;
      const hide = phase === "live";
      if (ms) {
        if (hide) ms.style.setProperty("display", "none", "important");
        else ms.style.removeProperty("display");
      }
      if (tl) {
        tl.style.opacity = hide ? "0" : "1";
        tl.style.pointerEvents = hide ? "none" : "auto";
      }
    }
    this.applyGlow();
  }
  applyGlow() {
    const tile = this.refs.tileRef.current;
    if (!tile) return;
    const p = this.getState().phase;
    if (p === "live")
      tile.style.boxShadow =
        "0 0 0 2px var(--accent),0 0 50px 8px rgba(109,74,255,.45),0 26px 70px rgba(40,30,20,.28)";
    else if (p === "dragover")
      tile.style.boxShadow =
        "0 0 0 2px var(--accent),0 0 80px 18px rgba(109,74,255,.62),0 26px 70px rgba(40,30,20,.22)";
    else if (p === "minting")
      tile.style.boxShadow =
        "0 0 0 1.5px var(--accent),0 0 56px 12px rgba(109,74,255,.55),0 22px 60px rgba(40,30,20,.2)";
  }
  startMint() {
    const p = this.getState().phase;
    if (p === "minting" || p === "live") return;
    const names = [
      "sunset-notes", "my-portfolio", "launch-notes", "our-wedding",
      "field-notes", "recipe-box",
    ];
    this.liveSlug = names[Math.floor(Math.random() * names.length)] + ".kept.host";
    this.applyPhase("minting");
    const r = this.refs;
    if (r.mintSlugRef.current)
      r.mintSlugRef.current.textContent = "https://" + this.liveSlug;
    const wait = this.reduced ? 500 : 1700;
    clearTimeout(this.mintTimer);
    this.mintTimer = setTimeout(() => {
      const img = this.drawThumb(0, 2, Date.now() % 99999);
      if (r.liveImgRef.current) r.liveImgRef.current.src = img;
      if (r.liveSlugRef.current) r.liveSlugRef.current.textContent = this.liveSlug;
      if (r.liveSlugBigRef.current)
        r.liveSlugBigRef.current.textContent = this.liveSlug;
      this.count += 1;
      if (r.navCountRef.current)
        r.navCountRef.current.textContent = this.count.toLocaleString();
      this.applyPhase("live");
    }, wait);
  }

  // ---------- scroll choreography ----------
  lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
  }
  ease(t: number) {
    t = Math.max(0, Math.min(1, t));
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
  blend(a: Pose, b: Pose, t: number): Pose {
    return {
      cx: this.lerp(a.cx, b.cx, t),
      cy: this.lerp(a.cy, b.cy, t),
      w: this.lerp(a.w, b.w, t),
      h: this.lerp(a.h, b.h, t),
      rot: this.lerp(a.rot, b.rot, t),
    };
  }
  transit(ref: Ref, W: number, _H: number, cy: number): Pose {
    let cx = W * 0.55;
    const el = ref && ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
    }
    cx = Math.max(130, Math.min(W - 130, cx));
    return { cx, cy, w: 128, h: 128, rot: 2 };
  }
  computeTarget() {
    const W = window.innerWidth,
      H = window.innerHeight;
    this.W = W;
    this.H = H;
    const r = this.refs;
    let hero: Pose;
    const hole = r.holeRef.current;
    if (hole) {
      const rr = hole.getBoundingClientRect();
      hero = {
        cx: rr.left + rr.width / 2,
        cy: rr.top + rr.height / 2,
        w: rr.width,
        h: rr.height,
        rot: -1,
      };
    } else {
      const s = Math.min(330, W * 0.28);
      hero = { cx: W * 0.66, cy: H * 0.5, w: s, h: s, rot: -1 };
    }
    const howRes = this.computeHow(hero, W, H);
    let pose = howRes.pose;
    this.lockAmt = howRes.lockAmt;
    this.highlightT = howRes.hi;
    this.highlightOn = howRes.hiOn;
    const agRes = this.computeAgents(pose, W, H);
    pose = agRes.pose;
    this.agState = agRes;
    const gRes = this.computeGauge(pose, W, H);
    pose = gRes.pose;
    this.gaugeState = gRes;
    const wRes = this.computeWhy(pose, W, H);
    pose = wRes.pose;
    this.whyState = wRes;
    const prRes = this.computePricing(pose, W, H);
    pose = prRes.pose;
    this.prState = prRes;
    const fRes = this.computeFooter(pose, W, H);
    pose = fRes.pose;
    this.ftState = fRes;
    this.whyIconOn = wRes.active && wRes.iconAmt > 0.5 && !wRes.expanded;
    this.anyExpanded = !!wRes.expanded;
    this.prLock = prRes.lock || 0;
    this.ftLock = fRes.lock || 0;
    this.agentLock = agRes.lock;
    this.agBoxIn = agRes.active ? !!agRes.boxIn : false;
    this.pose = pose;
    const heroEl = r.heroRef.current;
    const heroIn = heroEl
      ? heroEl.getBoundingClientRect().bottom > H * 0.4
      : true;
    let vis =
      W < 1024 &&
      !heroIn &&
      (this.lockAmt || 0) < 0.01 &&
      agRes.lock < 0.01 &&
      this.prLock < 0.01 &&
      this.ftLock < 0.01 &&
      !gRes.active &&
      !wRes.active
        ? 0
        : 1;
    if (agRes.active && !gRes.active) vis = Math.min(vis, agRes.boxOp);
    this.tileVisTarget = vis;
  }
  computeAgents(entry: Pose, W: number, H: number): AgentResult {
    const r = this.refs;
    const sec = r.agentsRef.current,
      acc = r.accordionRef.current;
    if (!sec || !acc || this.reduced)
      return {
        pose: entry,
        lock: 0,
        active: false,
        boxOp: 1,
        want: "mcp",
        present: false,
        hi: null,
      };
    const rect = sec.getBoundingClientRect();
    const pinTotal = Math.max(1, rect.height - H);
    const p = -rect.top / pinTotal;
    const ar = acc.getBoundingClientRect();
    const fillPose = (): Pose => {
      const el = r.humanSlotRef.current;
      if (el) {
        const rc = el.getBoundingClientRect();
        if (rc.height > 40)
          return {
            cx: rc.left + rc.width / 2,
            cy: rc.top + rc.height / 2,
            w: rc.width,
            h: rc.height,
            rot: 0,
          };
      }
      const btn = r.humanItemRef.current
        ? r.humanItemRef.current.querySelector("button")
        : null;
      const hdr = btn ? (btn as HTMLElement).offsetHeight || 56 : 56;
      return {
        cx: ar.left + ar.width / 2,
        cy: ar.top + hdr + 118,
        w: ar.width - 40,
        h: 236,
        rot: 0,
      };
    };
    const SNAP = 0.2,
      TOUR_END = 0.84;
    if (p <= 0) {
      const lead = this.ease(Math.max(0, Math.min(1, (H - rect.top) / H)));
      return {
        pose: this.blend(entry, fillPose(), lead),
        lock: lead,
        boxIn: lead > 0.45,
        active: true,
        boxOp: 1,
        want: "human",
        present: lead > 0.3,
        hi: null,
      };
    }
    if (p < SNAP) {
      return {
        pose: fillPose(),
        lock: 1,
        boxIn: true,
        active: true,
        boxOp: 1,
        want: "human",
        present: true,
        hi: null,
      };
    }
    if (p < TOUR_END) {
      const fade = Math.max(0, Math.min(1, (p - SNAP) / 0.03));
      const tt = (p - SNAP) / (TOUR_END - SNAP);
      const tab = (["mcp", "cli", "skill"] as Tab[])[
        Math.min(2, Math.floor(tt * 3))
      ]!;
      return {
        pose: fillPose(),
        lock: 1,
        boxIn: true,
        active: true,
        boxOp: 1 - fade,
        want: tab,
        present: true,
        hi: tab,
      };
    }
    const t = this.ease(Math.max(0, Math.min(1, (p - TOUR_END) / (1 - TOUR_END))));
    const start = { cx: ar.right - 110, cy: ar.top + 95, w: 140, h: 140, rot: 0 };
    const exit = this.transit(r.gaugeNumRef, W, H, H * 0.6);
    return {
      pose: this.blend(start, exit, t),
      lock: 0,
      boxIn: false,
      active: true,
      boxOp: 1,
      want: t > 0.12 ? null : "skill",
      present: t < 0.9,
      hi: null,
    };
  }
  computeGauge(entry: Pose, W: number, H: number): SectionResult {
    const r = this.refs;
    const wrap = r.gaugeWrapRef.current,
      num = r.gaugeNumRef.current;
    if (!wrap || !num || this.reduced) return { pose: entry, active: false };
    const gr = wrap.getBoundingClientRect();
    if (!this._gaugeRevealed && gr.top < H * 0.85) this.revealGauge();
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    if (gr.top > H * 0.92) return { pose: entry, active: false };
    const numRow = num.parentElement || num;
    const nr = numRow.getBoundingClientRect();
    const s = Math.max(72, Math.min(104, nr.height * 1.25));
    const park = {
      cx: nr.right + 26 + s / 2,
      cy: nr.top + nr.height / 2,
      w: s,
      h: s,
      rot: 0,
    };
    const a = clamp((H * 0.6 - gr.top) / (0.28 * H));
    const out = clamp((H * 0.12 - gr.top) / (0.22 * H));
    let pose: Pose;
    if (a < 1) pose = this.blend(entry, park, this.ease(a));
    else if (out <= 0) pose = park;
    else
      pose = this.blend(
        park,
        this.transit(r.rotWordRef, W, H, H * 0.52),
        this.ease(out),
      );
    return { pose, active: true };
  }
  computeWhy(entry: Pose, W: number, H: number): WhyResult {
    const r = this.refs;
    const sec = r.whyRef.current,
      word = r.rotWordRef.current;
    if (!sec || !word || this.reduced)
      return { pose: entry, active: false, iconAmt: 0, expanded: false };
    const sr = sec.getBoundingClientRect();
    if (sr.top > H * 0.92 || sr.bottom < -H * 0.1)
      return { pose: entry, active: false, iconAmt: 0, expanded: false };
    const wr = word.getBoundingClientRect();
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const s = Math.max(36, wr.height * 0.42);
    const ix = wr.right + s / 2 + 16,
      iy = wr.top + wr.height * 0.54;
    const icon = { cx: ix, cy: iy, w: s, h: s, rot: 0 };
    const a = clamp((H * 0.62 - wr.top) / (0.3 * H));
    const out = clamp((H * 0.16 - wr.top) / (0.2 * H));
    const near = this.mouseRaw
      ? Math.hypot(this.mouseRaw.x - ix, this.mouseRaw.y - iy) < 48
      : false;
    const hovered = this.hover || near;
    let pose: Pose,
      expanded = false,
      iconAmt = 0;
    if (a < 1) {
      pose = this.blend(entry, icon, this.ease(a));
      iconAmt = a;
    } else if (out <= 0) {
      pose = icon;
      iconAmt = 1;
    } else {
      pose = this.blend(
        icon,
        this.transit(r.priceSlotRef, W, H, H * 0.52),
        this.ease(out),
      );
      iconAmt = 1 - out;
    }
    if (hovered && iconAmt > 0.55) {
      const cw = 300,
        ch = 290;
      const cx = Math.min(W - cw / 2 - 20, ix + cw / 2 - s / 2),
        cy = Math.min(H - ch / 2 - 20, iy + ch / 2 + 14);
      pose = { cx, cy, w: cw, h: ch, rot: 0 };
      expanded = true;
      iconAmt = 1;
    }
    return { pose, active: true, iconAmt, expanded };
  }
  computePricing(entry: Pose, W: number, H: number): SectionResult {
    const r = this.refs;
    const slot = r.priceSlotRef.current;
    if (!slot || this.reduced) return { pose: entry, active: false, lock: 0 };
    const rect = slot.getBoundingClientRect();
    if (rect.top > H * 0.95) return { pose: entry, active: false, lock: 0 };
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const fill = {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      w: rect.width,
      h: rect.height,
      rot: 0,
    };
    const a = clamp((H * 0.72 - rect.top) / (0.3 * H));
    const out = clamp((H * 0.26 - rect.top) / (0.2 * H));
    const lock = Math.min(this.ease(a), 1 - this.ease(out));
    let pose: Pose;
    if (out <= 0) pose = this.blend(entry, fill, this.ease(a));
    else
      pose = this.blend(
        fill,
        this.transit(r.footSlotRef, W, H, H * 0.55),
        this.ease(out),
      );
    return { pose, active: true, lock };
  }
  computeFooter(entry: Pose, _W: number, H: number): SectionResult {
    const slot = this.refs.footSlotRef.current;
    if (!slot || this.reduced) return { pose: entry, active: false, lock: 0 };
    const rect = slot.getBoundingClientRect();
    if (rect.top > H * 0.98) return { pose: entry, active: false, lock: 0 };
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const fill = {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      w: rect.width,
      h: rect.height,
      rot: 0,
    };
    const a = this.ease(clamp((H * 0.85 - rect.top) / (0.32 * H)));
    return { pose: this.blend(entry, fill, a), active: true, lock: a };
  }
  computeHow(hero: Pose, W: number, H: number) {
    const r = this.refs;
    const how = r.howRef.current,
      c0 = r.card0Ref.current;
    if (!how || !c0 || this.reduced)
      return { pose: hero, lockAmt: 0, hi: -1 as number, hiOn: 0 };
    const rect = how.getBoundingClientRect();
    const pinTotal = Math.max(1, rect.height - H);
    const p = -rect.top / pinTotal;
    const c0r = c0.getBoundingClientRect();
    const locked = {
      cx: c0r.left + c0r.width / 2,
      cy: c0r.top + c0r.height / 2,
      w: c0r.width,
      h: c0r.height,
      rot: 0,
    };
    const approach = {
      cx: locked.cx,
      cy: c0r.top - H * 0.3,
      w: locked.w * 0.58,
      h: locked.w * 0.58,
      rot: -2,
    };
    const LOCK = 0.14,
      TRAV = 0.84;
    if (p <= 0) {
      const leadT = this.ease(Math.max(0, Math.min(1, (H - rect.top) / H)));
      return {
        pose: this.blend(hero, approach, leadT),
        lockAmt: 0,
        hi: -1 as number,
        hiOn: 0,
      };
    }
    if (p < LOCK) {
      const t = this.ease(Math.max(0, Math.min(1, p / LOCK)));
      return { pose: this.blend(approach, locked, t), lockAmt: t, hi: 0, hiOn: t };
    }
    if (p < TRAV) {
      const t = (p - LOCK) / (TRAV - LOCK);
      return {
        pose: locked,
        lockAmt: 1,
        hi: Math.min(3, Math.floor(t * 4)),
        hiOn: 1,
      };
    }
    const t = this.ease(Math.max(0, Math.min(1, (p - TRAV) / (1 - TRAV))));
    const exit = this.transit(r.accordionRef, W, H, H * 0.55);
    return { pose: this.blend(locked, exit, t), lockAmt: 1 - t, hi: 3, hiOn: 1 - t };
  }
  dockMobile() {
    const r = this.refs;
    const slot = r.mobileSlotRef && r.mobileSlotRef.current,
      tile = r.tileRef.current,
      root = r.rootRef.current;
    if (!slot || !tile || !root) return;
    const sr = slot.getBoundingClientRect();
    if (sr.width < 10) return;
    const rr = root.getBoundingClientRect();
    const x = sr.left - rr.left,
      y = sr.top - rr.top + root.scrollTop;
    tile.style.width = sr.width.toFixed(1) + "px";
    tile.style.height = sr.height.toFixed(1) + "px";
    tile.style.transform =
      "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px)";
    if (this.getState().phase !== "live") {
      tile.style.opacity = "1";
      tile.style.pointerEvents = "auto";
    }
  }
  applyTile() {
    const tile = this.refs.tileRef.current;
    if (!tile) return;
    const c = this.cur,
      p = this.getState().phase;
    const tScale =
      (this.hover && (p === "idle" || p === "live") ? 1.05 : 1) *
      (p === "dragover" ? 1.14 : 1);
    this.curScale = this.lerp(this.curScale, tScale, 0.18);
    const x = c.cx - c.w / 2,
      top = c.cy - c.h / 2;
    tile.style.width = c.w + "px";
    tile.style.height = c.h + "px";
    tile.style.transform =
      "translate(" +
      x.toFixed(1) +
      "px," +
      top.toFixed(1) +
      "px) rotate(" +
      c.rot.toFixed(2) +
      "deg) scale(" +
      this.curScale.toFixed(3) +
      ")";
    this.tileOpacity = this.lerp(
      this.tileOpacity,
      this.tileVisTarget == null ? 1 : this.tileVisTarget,
      0.12,
    );
    tile.style.opacity = this.tileOpacity.toFixed(3);
    tile.style.pointerEvents = this.tileOpacity < 0.5 ? "none" : "auto";
  }
  updateGridParallax() {
    const H = this.H || window.innerHeight;
    const heroEl = this.refs.heroRef.current;
    const heroIn = !!heroEl && heroEl.getBoundingClientRect().bottom > H * 0.4;
    const tgx = heroIn ? this.mouse.x * -26 : 0;
    const tgy = heroIn ? this.mouse.y * -16 : 0;
    this.gridPar.x += (tgx - this.gridPar.x) * 0.06;
    this.gridPar.y += (tgy - this.gridPar.y) * 0.06;
    const wall = this.refs.wallRef.current;
    if (wall)
      wall.style.transform =
        "translate3d(" +
        this.gridPar.x.toFixed(1) +
        "px," +
        this.gridPar.y.toFixed(1) +
        "px,0) rotateX(13deg) rotateZ(-1deg) scale(1.04)";
  }
  slotFx(time: number) {
    const r = this.refs;
    const tile = r.tileRef.current,
      p = this.getState().phase;
    if (tile && p === "idle") {
      const la = this.lockAmt || 0;
      if (this.anyExpanded) {
        tile.style.boxShadow =
          "0 0 0 1.5px var(--accent),0 22px 64px rgba(40,30,20,.26)";
      } else if (this.whyIconOn) {
        tile.style.boxShadow =
          "0 0 0 1.4px var(--accent),0 0 16px 3px rgba(109,74,255,.35)";
      } else if ((this.ftLock || 0) > 0.5) {
        tile.style.boxShadow =
          "0 0 0 1.5px #8B6DFF,0 0 44px 8px rgba(139,109,255,.28)";
      } else if ((this.prLock || 0) > 0.5) {
        tile.style.boxShadow =
          "0 0 0 1.6px var(--accent),0 16px 40px rgba(40,30,20,.13)";
      } else if (this.agBoxIn) {
        tile.style.boxShadow =
          "0 0 0 1.6px var(--accent),0 16px 40px rgba(40,30,20,.13)";
      } else if (la > 0.01) {
        tile.style.boxShadow = "0 18px 48px rgba(40,30,20,.15)";
      } else {
        const base = 0.34 + 0.22 * (0.5 + 0.5 * Math.sin(time * 2.1));
        const g = this.hover ? Math.min(0.85, base + 0.3) : base;
        tile.style.boxShadow =
          "0 0 0 1.5px var(--accent),0 0 " +
          (30 + g * 56).toFixed(0) +
          "px " +
          (4 + g * 12).toFixed(0) +
          "px rgba(109,74,255," +
          g.toFixed(3) +
          "),0 22px 60px rgba(40,30,20,.2)";
      }
    }
    if (p === "minting") {
      if (r.spinnerRef.current)
        r.spinnerRef.current.style.transform =
          "rotate(" + ((time * 420) % 360).toFixed(0) + "deg)";
      if (r.scanRef.current) {
        const y = (time * 0.95) % 1;
        r.scanRef.current.style.transform =
          "translateY(" + (y * 760 - 60).toFixed(0) + "%)";
      }
    }
  }
  tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const now = performance.now();
    const r = this.refs;
    if (this.isMobile) {
      this.dockMobile();
      this.slotFx(now / 1000);
      this.updateReveals(now);
      if (!this._gaugeRevealed) {
        const w = r.gaugeWrapRef.current;
        if (w && w.getBoundingClientRect().top < window.innerHeight * 0.85)
          this.revealGauge();
      }
      return;
    }
    const st =
      (r.rootRef.current ? r.rootRef.current.scrollTop : 0) +
      (window.scrollY || 0);
    if (this._lastST !== undefined && Math.abs(st - this._lastST) > 1.2)
      this.agManual = false;
    this._lastST = st;
    this.updateGridParallax();
    this.computeTarget();
    const k = 0.14;
    this.cur.cx = this.lerp(this.cur.cx, this.pose.cx, k);
    this.cur.cy = this.lerp(this.cur.cy, this.pose.cy, k);
    this.cur.w = this.lerp(this.cur.w, this.pose.w, k);
    this.cur.h = this.lerp(this.cur.h, this.pose.h, k);
    this.cur.rot = this.lerp(this.cur.rot, this.pose.rot, k);
    this.applyTile();
    this.slotFx(now / 1000);
    this.applyHowVisuals();
    this.applyAgentVisuals();
    this.applyGaugeVisuals();
    this.updateReveals(now);
  };
  applyAgentVisuals() {
    const r = this.refs;
    const ag = this.agState || ({ active: false } as AgentResult);
    const state = this.getState();
    if (ag.active) {
      if (ag.present && !state.humanPresent)
        this.setState({ humanPresent: true });
      else if (!ag.present && state.humanPresent)
        this.setState({ humanPresent: false });
    }
    let openTab: Tab;
    if (this.agManual) openTab = this.manualTab;
    else if (ag.active && ag.want !== undefined) openTab = ag.want;
    else openTab = state.openTab;
    if (openTab !== state.openTab) this.setState({ openTab });
    this.applyAccordion(openTab, this.agManual ? null : ag.hi);
    const ph = r.humanPlaceholderRef.current;
    if (ph)
      ph.style.opacity = (openTab === "human"
        ? Math.max(0, 1 - (ag.boxOp != null ? ag.boxOp : 1))
        : 1
      ).toFixed(3);
  }
  applyAccordion(eff: Tab, hi: Tab) {
    const r = this.refs;
    const drive = (ref: Ref, id: Tab) => {
      const el = ref.current;
      if (!el) return;
      const open = eff === id;
      el.style.maxHeight = open ? el.scrollHeight + 48 + "px" : "0px";
      el.style.opacity = open ? "1" : "0";
    };
    drive(r.humanBodyRef, "human");
    drive(r.mcpBodyRef, "mcp");
    drive(r.cliBodyRef, "cli");
    drive(r.skillBodyRef, "skill");
    const lit = (ref: Ref, id: Tab) => {
      const el = ref.current;
      if (!el) return;
      el.style.background =
        hi === id ? "color-mix(in srgb,var(--accent) 7%,transparent)" : "transparent";
    };
    lit(r.mcpItemRef, "mcp");
    lit(r.cliItemRef, "cli");
    lit(r.skillItemRef, "skill");
  }
  applyGaugeVisuals() {
    const r = this.refs;
    const w = this.whyState || ({} as WhyResult);
    const phase = this.getState().phase;
    const iconOn = !!w.active && w.iconAmt > 0.5 && !w.expanded;
    const link = r.whyLinkRef.current;
    if (link) link.style.opacity = iconOn ? "1" : "0";
    const ld = r.whyLiveDotRef.current;
    if (ld) ld.style.opacity = iconOn && phase === "live" ? "1" : "0";
    const wcOn = !!w.expanded && phase === "idle";
    const wcard = r.whyCardRef.current;
    if (wcard) {
      wcard.style.opacity = wcOn ? "1" : "0";
      wcard.style.pointerEvents = wcOn ? "auto" : "none";
    }
    const pr = this.prState || ({} as SectionResult),
      ft = this.ftState || ({} as SectionResult);
    const pp = r.pricePlaceholderRef.current;
    if (pp) {
      pp.style.opacity = (1 - (pr.lock || 0)).toFixed(3);
      pp.style.pointerEvents = (pr.lock || 0) > 0.5 ? "none" : "auto";
    }
    const fp = r.footPlaceholderRef.current;
    if (fp) {
      fp.style.opacity = (1 - (ft.lock || 0)).toFixed(3);
      fp.style.pointerEvents = (ft.lock || 0) > 0.5 ? "none" : "auto";
    }
    const dk = r.darkIdleRef.current;
    if (dk) dk.style.opacity = phase === "idle" ? (ft.lock || 0).toFixed(3) : "0";
    const inner = r.tileInnerRef.current;
    if (inner) inner.style.borderRadius = iconOn ? "50%" : "14px";
    if (iconOn) {
      const idle = r.slotIdleRef.current;
      if (idle) idle.style.opacity = "0";
    }
  }
  applyHowVisuals() {
    const r = this.refs;
    const phaseIdle = this.getState().phase === "idle";
    const lockA = this.lockAmt || 0;
    const idleOp = Math.max(0, 1 - lockA * 2),
      lockOp = Math.max(0, lockA * 2 - 1);
    const lc = r.lockCardRef.current;
    if (lc) lc.style.opacity = (phaseIdle ? lockOp : 0).toFixed(3);
    const idle = r.slotIdleRef.current;
    if (idle && phaseIdle) idle.style.opacity = idleOp.toFixed(3);
    const c0 = r.card0InnerRef.current;
    if (c0) c0.style.opacity = (1 - lockA).toFixed(3);
    const gl = r.glowRef.current;
    if (gl) {
      const card0 = this.cardRefs[0]?.current;
      if (lockA > 0.01 && card0) {
        const rc = card0.getBoundingClientRect();
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 650);
        gl.style.width = rc.width.toFixed(1) + "px";
        gl.style.height = rc.height.toFixed(1) + "px";
        gl.style.transform =
          "translate(" + rc.left.toFixed(1) + "px," + rc.top.toFixed(1) + "px)";
        gl.style.opacity = (lockA * (0.52 + 0.22 * pulse)).toFixed(3);
      } else gl.style.opacity = "0";
    }
    const hl = r.highlightRef.current;
    if (hl) {
      if (this.highlightOn > 0.01 && this.highlightT >= 0 && this.cardRefs) {
        const idx = Math.max(0, Math.min(3, Math.round(this.highlightT)));
        const c = this.cardRefs[idx]?.current;
        if (c) {
          const rc = c.getBoundingClientRect();
          hl.style.width = rc.width.toFixed(1) + "px";
          hl.style.height = rc.height.toFixed(1) + "px";
          hl.style.transform =
            "translate(" + rc.left.toFixed(1) + "px," + rc.top.toFixed(1) + "px)";
          hl.style.opacity = Math.max(0, Math.min(1, this.highlightOn)).toFixed(3);
        }
      } else hl.style.opacity = "0";
    }
  }
}
