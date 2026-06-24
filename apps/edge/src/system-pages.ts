// @kept/edge — branded system-page template slots.
//
// EMPTY PLACEHOLDERS for task 004. Epic E0 imports the real on-brand markup from
// the Claude Design `kept System Pages.dc.html` file (404 / suspended / resting /
// expired) and wires each to the matching `KvManifest.status` branch. Until then
// these return minimal, dependency-free HTML so the skeleton is self-contained.
//
// Keep the keys aligned with the serving status branch documented in E0:
//   - notFound : missing slug / missing object / removed / archived
//   - suspended: quarantined / under_review
//   - resting  : funding degradation (E4)
//   - expired  : unclaimed anonymous page, 7-day window elapsed (E1/E5)

export type SystemPage = "notFound" | "suspended" | "resting" | "expired";

interface SystemPageSpec {
  /** Default HTTP status for this state (E0 may refine, e.g. 451 vs 403). */
  status: number;
  /** Placeholder heading; real copy lands in E0. */
  title: string;
}

const SYSTEM_PAGE_SPECS: Record<SystemPage, SystemPageSpec> = {
  notFound: { status: 404, title: "Not found" },
  suspended: { status: 451, title: "Page suspended" },
  resting: { status: 200, title: "Temporarily resting" },
  expired: { status: 410, title: "Page wasn't claimed" },
};

/** Render a placeholder system page. Real branded templates land in E0. */
export function renderSystemPage(page: SystemPage): {
  body: string;
  status: number;
} {
  const spec = SYSTEM_PAGE_SPECS[page];
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>kept — ${spec.title}</title>
  </head>
  <body>
    <!-- E0: replace with branded "${page}" template from kept System Pages.dc.html -->
    <main>
      <h1>${spec.title}</h1>
      <p>kept system page placeholder (${page}).</p>
    </main>
  </body>
</html>
`;
  return { body, status: spec.status };
}
