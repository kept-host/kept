/**
 * `prefers-reduced-motion: reduce`, read at the moment of asking — for the
 * timing decisions CSS cannot make (how a card scrolls into view, whether to
 * wait for a hop that will not play). Browser only: call it from an effect or
 * an event, never during render.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
