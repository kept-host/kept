"use client";

/**
 * Sign out — the minimum control the gated surface needs, and no more.
 *
 * E06 owns the dashboard chrome; this is a plain button in the `(app)` layout so
 * that a signed-in session can actually be ended in E05. It calls `signOut` from
 * `lib/auth/client`, the one client-side auth surface, and then sends the user
 * to the landing page.
 *
 * `router.refresh()` after the push is what re-gates: it discards the cached
 * RSC payload for the routes rendered while signed in, so a subsequent
 * `(app)/dashboard` hit re-runs the layout, finds no session, and redirects to
 * sign-in. Without it a back-navigation could paint the gated shell from cache.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await signOut();
        router.replace("/");
        router.refresh();
      }}
    >
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}
