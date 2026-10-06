"use client";

/**
 * The studio's navigation — E06 task 011 (PRD §3 item 3, AC10).
 *
 * EXACTLY TWO ITEMS: Pages and Settings. The design's Wall (E12), Explore (E15)
 * and Referrals (E10) are not rendered — no "Soon" pill, no disabled
 * placeholder, no dead link. The epic that builds each one adds it here.
 *
 * Two presentations of the same list, from `kept Studio Screen.dc.html`: the
 * desktop sidebar's rows and the phone's bottom tab bar. `aria-current` comes
 * from the path, so the page-detail screen (`/site/…`) lights Pages — it is a
 * page of Pages.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Settings2, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Path prefixes this item is current for. */
  owns: readonly string[];
}

const NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Pages", icon: LayoutGrid, owns: ["/dashboard", "/site"] },
  { href: "/settings", label: "Settings", icon: Settings2, owns: ["/settings"] },
];

function isCurrent(pathname: string, item: NavItem): boolean {
  return item.owns.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function StudioNav({ variant }: { variant: "sidebar" | "tabs" }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Studio"
      data-testid={`studio-nav-${variant}`}
      className={variant === "sidebar" ? "flex flex-col gap-0.5" : "contents"}
    >
      {NAV.map((item) => {
        const current = isCurrent(pathname, item);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "font-mono font-medium uppercase outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
              variant === "sidebar"
                ? "flex h-10 items-center gap-3 rounded-[var(--r-sm)] px-3 text-xs tracking-[0.08em]"
                : "flex h-[52px] flex-col items-center justify-center gap-1 rounded-[var(--r-sm)] text-[11px] tracking-[0.04em]",
              current
                ? cn("text-text", variant === "sidebar" && "bg-sunken")
                : cn(
                    "text-text-secondary hover:text-text",
                    variant === "sidebar" && "hover:bg-sunken",
                  ),
            )}
          >
            <Icon
              aria-hidden="true"
              strokeWidth={1.5}
              className={variant === "sidebar" ? "size-[18px]" : "size-5"}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
