"use client";

/**
 * Sign out — the avatar menu's one item (E06 task 011; E05 put it in the header
 * as a plain button) and the Account section's button on `/settings` (task 013,
 * PRD §5.8). One action behind both, so they cannot land in different places.
 *
 * It calls `signOut` from `lib/auth/client`, the one client-side auth surface,
 * and then sends the user to the **apex** landing (§5.8: "Sign out → apex").
 * `farewellHref` is the apex from configuration — the same helper account
 * deletion leaves through. `"/"` would not do: on the `app.` host the split rule
 * 307s it to `/dashboard`, and the gate bounces that to `/auth`, so a signed-out
 * user would land on a sign-in screen. Locally there is one origin and the
 * helper returns `"/"`, which is the landing there.
 *
 * A full-document navigation, not `router.replace`: the apex is another origin
 * once the deploy has two hostnames, and a hard load is also what discards every
 * RSC payload rendered while signed in, so a back-navigation cannot paint the
 * gated shell from cache.
 *
 * `preventDefault` on select keeps the menu open while the request is in flight,
 * so "Signing out…" is what the user sees rather than a menu that vanished and a
 * screen that has not moved yet.
 */
import { LogOut } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth/client";
import { farewellHref } from "@/lib/routing/host-split";

function useSignOut() {
  const [pending, setPending] = useState(false);

  async function signOutToApex() {
    setPending(true);
    await signOut();
    window.location.replace(farewellHref(process.env.NEXT_PUBLIC_APP_URL));
  }

  return { pending, signOutToApex };
}

export function SignOutItem() {
  const { pending, signOutToApex } = useSignOut();

  return (
    <DropdownMenuItem
      disabled={pending}
      onSelect={(event) => {
        event.preventDefault();
        void signOutToApex();
      }}
    >
      <LogOut aria-hidden="true" strokeWidth={1.5} />
      {pending ? "Signing out…" : "Sign out"}
    </DropdownMenuItem>
  );
}

export function SignOutButton() {
  const { pending, signOutToApex } = useSignOut();

  return (
    <Button
      type="button"
      variant="secondary"
      disabled={pending}
      onClick={() => void signOutToApex()}
      className="h-10 self-start rounded-[var(--r-md)] px-4 font-body font-medium"
    >
      <LogOut aria-hidden="true" strokeWidth={1.5} />
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
