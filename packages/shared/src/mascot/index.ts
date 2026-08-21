// @kept/shared/mascot — the generated mascot, behind its own subpath export.
//
// ─── Attribution ────────────────────────────────────────────────────────────
// Derived from **bloub** — https://github.com/jeremy-prt/bloub
// Copyright © 2026 Jérémy Perret. Released under the MIT licence.
// Full licence text: `THIRD-PARTY.md` at the repository root.
// The functions taken, and the measured constants deliberately left behind,
// are listed in the header of each file under this directory.
// ────────────────────────────────────────────────────────────────────────────
//
// **This is a subpath entry, not a barrel re-export.** `packages/shared` is
// consumed as raw TypeScript with no build step, and `src/index.ts` re-exports
// everything it names. The mascot does real work at module load (the sample
// tables here, the blink schedule in `face.ts`), so putting it in the barrel
// would make every `import { MAX_PAGE_BYTES } from "@kept/shared"` on the
// Worker's hot path pay for it — `sideEffects: false` is a hint to a bundler,
// not a guarantee. Consumers import from `@kept/shared/mascot`; nothing here is
// ever re-exported from `src/index.ts`.
//
// Nothing under `src/mascot/` may touch the DOM or a Node API. `mascotSvg`
// returns a string, which is what lets `apps/edge` render the character at all.

// The public surface. `frame.ts` is what a consumer actually calls —
// `mascotFrame`, `mascotSvg`, `MASCOT_REST_T` and `MascotOptions`; `face.ts`
// and `geometry.ts` come along because the two consumers legitimately need the
// viewBox, the sample count and the character's own constants to size and
// colour the element they mount it in, and because a consumer that points the
// eyes at something needs `gazeToward`, `HeadGaze` and the `KEPT_TRACK_*`
// envelope it clamps to.
export * from "./geometry";
export * from "./face";
export * from "./frame";
