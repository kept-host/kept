/**
 * ONE OAuth button, used once per provider — E05 task 005.
 *
 * ── THE PROBLEM THIS COMPONENT EXISTS TO PREVENT ───────────────────────────
 * `kept Auth.dc.html` was drawn for **two** sign-in routes: one solid slab for
 * GitHub, a divider, then the email field. E05 ships **three** — Google was
 * added to the scope after the screen was designed. The failure mode is
 * predictable: a second, visually distinct button gets hand-built next to the
 * first, and a two-provider skin quietly becomes a three-provider mess with two
 * spacing scales and two icon treatments.
 *
 * So there is exactly one button here and one array below. Both provider routes
 * are the *same* component with a different `provider`, and a fourth route (E11
 * or later) is a new entry in `AUTH_PROVIDERS`, not a new layout.
 *
 * ── WHY THE INVERTED SLAB WORKS FOR GOOGLE ─────────────────────────────────
 * The export's OAuth treatment is `background: var(--text); color: var(--bg)` —
 * an inverted slab, which is what separates "OAuth" from the outlined
 * magic-link submit below the divider. That treatment happens to track Google's
 * own identity guidance without a special case: in the light theme `--text` is
 * near-black, giving Google's dark button variant; in the dark theme it is
 * near-white, giving the light variant. The four-colour mark is unmodified in
 * both. One component, one rule, two valid Google buttons.
 *
 * Everything except the mark itself is a token class. See `./google-mark.tsx`
 * for why the four brand hexes are an asset rather than a token.
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { GoogleMark } from "./google-mark";

/** The social providers configured in `lib/auth/index.ts` (task 003). */
export type AuthProviderId = "github" | "google";

/**
 * GitHub's mark, drawn in `currentColor` so it inverts with the slab. Unlike
 * Google's, GitHub's guidelines permit a monochrome mark, so this one needs no
 * fixed colours and stays inline here rather than earning its own asset file.
 * Geometry is the export's, unmodified.
 */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2C6.5 2 2 6.6 2 12.3c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.4-3.4-1.4-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4-1.4 6.8-5.2 6.8-9.7C22 6.6 17.5 2 12 2z" />
    </svg>
  );
}

export type AuthProviderRoute = {
  id: AuthProviderId;
  /** The provider's own name, used in the redirect copy. */
  name: string;
  label: string;
  icon: ReactNode;
};

/**
 * The routes, in the order the screen offers them. **Adding a provider is an
 * entry here and a provider in `lib/auth/index.ts` — nothing else.**
 */
export const AUTH_PROVIDERS: readonly AuthProviderRoute[] = [
  {
    id: "github",
    name: "GitHub",
    label: "Continue with GitHub",
    icon: <GithubMark />,
  },
  {
    id: "google",
    name: "Google",
    label: "Continue with Google",
    icon: <GoogleMark />,
  },
];

export function ProviderButton({
  route,
  onSelect,
  disabled,
}: {
  route: AuthProviderRoute;
  onSelect: (route: AuthProviderRoute) => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      // shadcn's Button is the behaviour layer here — focus ring, disabled
      // handling, `asChild` slotting — and the classes below are the kept skin
      // the export drew. `secondary` is the closest base; its border and hover
      // are replaced rather than a new cva variant being added, because this
      // treatment exists on exactly one screen.
      variant="secondary"
      data-provider={route.id}
      disabled={disabled}
      onClick={() => onSelect(route)}
      className={cn(
        "h-auto w-full gap-2.5 border-transparent bg-text px-4 py-3.5",
        "text-[0.9375rem] text-bg",
        // The slab holds its colour on hover; the affordance is the same
        // shadow lift the magic-link submit below the divider uses, so both
        // halves of the card respond in one language.
        "hover:bg-text hover:shadow-[var(--shadow-md)] active:scale-[0.99]",
        // The export's marks are 18px; shadcn's default `[&_svg]:size-4` is 16.
        "[&_svg]:size-[18px]",
      )}
    >
      {route.icon}
      {route.label}
    </Button>
  );
}
