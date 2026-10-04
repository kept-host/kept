"use client";

/**
 * Sign out — the avatar menu's one item (E06 task 011; E05 put it in the header
 * as a plain button).
 *
 * It calls `signOut` from `lib/auth/client`, the one client-side auth surface,
 * and then sends the user to the landing page.
 *
 * `router.refresh()` after the replace is what re-gates: it discards the cached
 * RSC payload for the routes rendered while signed in, so a subsequent
 * `(app)/dashboard` hit re-runs the layout, finds no session, and redirects to
 * sign-in. Without it a back-navigation could paint the gated shell from cache.
 *
 * `preventDefault` on select keeps the menu open while the request is in flight,
 * so "Signing out…" is what the user sees rather than a menu that vanished and a
 * screen that has not moved yet.
 */
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth/client";

export function SignOutItem() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <DropdownMenuItem
      disabled={pending}
      onSelect={async (event) => {
        event.preventDefault();
        setPending(true);
        await signOut();
        router.replace("/");
        router.refresh();
      }}
    >
      <LogOut aria-hidden="true" strokeWidth={1.5} />
      {pending ? "Signing out…" : "Sign out"}
    </DropdownMenuItem>
  );
}
