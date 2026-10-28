/**
 * E10 Risk 3: the edge serves a page's HTML with the badge streamed in — the
 * published bytes plus ONE `<kept-badge>` element (before `</body>`, or at the
 * end when there is none). Test and smoke help only: nothing in the app imports
 * it, and its name keeps it outside the unit-test glob.
 *
 * A spec that compared the served body to the published bytes compares
 * `unbadged(body)` instead — nothing else about it changes.
 */
const BADGE = /<kept-badge>[\s\S]*?<\/kept-badge>/g;

/** `body` without its badge, or `null` unless it carries exactly one. */
export function unbadged(body: string): string | null {
  const badges = body.match(BADGE) ?? [];
  return badges.length === 1 ? body.replace(BADGE, "") : null;
}
