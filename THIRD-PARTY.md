# Third-party notices

kept is licensed under the **GNU Affero General Public License v3.0** (see
[`LICENSE`](./LICENSE)). This file carries the notices for third-party work that
is *derived from* rather than merely depended on — code that was read and
adapted by hand, or binaries checked into this repository, so no `node_modules`
entry records it.

Runtime dependencies keep their own licences in `node_modules` and in
`pnpm-lock.yaml`; they are not repeated here.

---

## Geist and Inter (vendored font files)

- **Files:** `apps/web/lib/og/fonts/Geist-SemiBold.ttf`,
  `apps/web/lib/og/fonts/Inter-Regular.ttf`
- **Licence:** SIL Open Font Licence 1.1 — full text alongside each file, as
  `Geist-LICENSE.txt` and `Inter-LICENSE.txt`
- **Copyright:** © 2023 Vercel, in collaboration with basement.studio (Geist);
  © 2016 The Inter Project Authors (Inter)
- **Used by:** `apps/web/lib/og/font.ts` — the OG card renderer only

**Why they are checked in rather than depended on.** `ImageResponse` (satori)
needs raw font bytes, and `next/font/google` exposes none. `geist` ships TTFs in
`node_modules` but declares an `exports` map with no `.` entry, so there is no
supported way to resolve a path to them; Inter arrives from Google Fonts at build
time and never touches disk at all. Fetching either at request time would put a
third-party outage on the path that renders a shared link. So the bytes are
ordinary repository files. `Geist-SemiBold.ttf` is copied verbatim from
`geist@1.7.2`, and a unit test asserts it stays byte-identical to the installed
package; `Inter-Regular.ttf` is the static TTF `fonts.gstatic.com` serves for
`Inter:wght@400` (v20) — the same binary `next/font/google` downloads.

Both faces are unmodified. The OFL asks that redistributed originals travel with
their licence and not be sold on their own; both conditions are met, and the OFL
is compatible with distributing them alongside AGPL-3.0 software.

---

## bloub

- **Upstream:** <https://github.com/jeremy-prt/bloub>
- **Copyright:** © 2026 Jérémy Perret
- **Licence:** MIT (inbound-compatible with AGPL-3.0)
- **Read at:** commit `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749` (2026-08-17)
- **Used by:** `packages/shared/src/mascot/*`

**What was taken.** The generic geometry and animation machinery of bloub's
`src/bot/*`: the fixed-sample radial-profile representation (every profile is
sampled at the same 64 angles, so morphing is a per-index lerp and needs no
path-morph library), `superellipseProfile`, `normalize`, `blend`, `toPoints`,
`closedPath` (Catmull-Rom, tension `1/6`), `radiusAtAngle`, the unit-sphere eye
model (`eyePoses`), `liveliness` and `blinkScale`, plus the `lerp` / `r2`
helpers they depend on. Adapted by hand — bloub is **not** vendored and is not a
dependency of any workspace.

**What was deliberately not taken.** bloub's README describes it as an SVG
recreation of the x.ai bot avatar, *measured off the reference video frame by
frame*. Jérémy can license what he wrote; he cannot license what he measured,
and a mascot is trade dress — the one asset whose entire job is to be recognised
as belonging to a specific company. So **no measured profile and no measured
face constant was copied**: not the `profiles.ts` shape library, not the eye
split, not the eye dimensions, not the rest gaze. kept ships one shape,
generated from an equation, with its own face constants chosen by inspection.
This is asserted by a CI grep, not by a comment — which is also why the
not-taken values and shape names are named nowhere in this repo but inside that
guard's own test.

Every file under `packages/shared/src/mascot/` repeats this notice in its header
and points back at this file.

### MIT licence

```
MIT License

Copyright (c) 2026 Jérémy Perret

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
