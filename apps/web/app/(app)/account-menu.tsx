"use client";

/**
 * The avatar menu — E06 task 011 (PRD §3 item 3).
 *
 * Who is signed in, their plan, and sign out. Nothing else: the design's
 * handle line (`lena.kept.host`) is E10's, so the account's email stands in
 * for it, and every other account control lives on `/settings`.
 *
 * Two triggers over one menu, matching the shell: the sidebar's avatar row on
 * desktop, and a cell in the phone's tab bar — the design's phone screens have
 * no sidebar, and sign out must be reachable from every screen.
 */
import type { Plan } from "@kept/shared";

import { PlanBadge } from "@/components/kept/plan-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { SignOutItem } from "./sign-out-button";

export interface AccountMenuProps {
  /** The account's display name; may be empty for a magic-link account. */
  name: string;
  email: string;
  plan: Plan;
}

function initialOf({ name, email }: Pick<AccountMenuProps, "name" | "email">): string {
  return (name.trim() || email).charAt(0).toUpperCase();
}

function Initial({ account, className }: { account: AccountMenuProps; className?: string }) {
  return (
    <Avatar className={cn("border-0", className)}>
      <AvatarFallback className="bg-accent-soft font-display text-sm font-semibold normal-case tracking-normal text-accent-hover">
        {initialOf(account)}
      </AvatarFallback>
    </Avatar>
  );
}

export function AccountMenu({
  variant,
  ...account
}: AccountMenuProps & { variant: "sidebar" | "tabs" }) {
  const label = account.name.trim() || account.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid={`account-menu-${variant}`}
        aria-label={`Account: ${label}`}
        className={cn(
          "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          variant === "sidebar"
            ? "flex w-full min-w-0 items-center gap-2.5 rounded-[var(--r-sm)] px-2 py-1 text-left text-text hover:bg-sunken"
            : "flex h-[52px] flex-col items-center justify-center gap-1 rounded-[var(--r-sm)] font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-text-secondary hover:text-text",
        )}
      >
        {variant === "sidebar" ? (
          <>
            <Initial account={account} className="size-8" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-medium">{label}</span>
              {account.name.trim() ? (
                <span className="truncate font-mono text-xs text-text-secondary">
                  {account.email}
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <Initial account={account} className="size-5 [&_[data-slot=avatar-fallback]]:text-[11px]" />
            Account
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align={variant === "sidebar" ? "start" : "end"}
        side="top"
        className="w-64"
      >
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <Initial account={account} className="size-8" />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-text">{label}</span>
            <span className="truncate font-mono text-xs text-text-secondary">
              {account.email}
            </span>
          </div>
          <PlanBadge plan={account.plan} />
        </div>
        <DropdownMenuSeparator />
        <SignOutItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
