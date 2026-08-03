import type { Metadata } from "next";
import Link from "next/link";

import { infraCostMonth, keptCount, uptime } from "@/lib/landing-stats";

// TODO(E09): E09-open-books replaces this placeholder with the real stats page
// (live snapshot data, monthly cost breakdown, uptime record).

export const metadata: Metadata = {
  title: "Stats",
  description: "What kept costs to run, and how many pages it keeps.",
};

const FIGURES = [
  { label: "Pages kept", value: keptCount.toLocaleString("en-US") },
  { label: "Infra cost this month", value: `€${infraCostMonth.toFixed(2)}` },
  { label: "Uptime", value: uptime === null ? "Not yet measured" : `${uptime}%` },
];

export default function StatsPlaceholder() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <p className="mono-label text-text-muted">Open books</p>
        <h1 className="font-display text-3xl font-semibold text-text">Stats</h1>
        <p className="text-text-secondary">
          Everything kept spends and everything it keeps, in public. The full
          stats page ships with launch.
        </p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        {FIGURES.map((figure) => (
          <div
            key={figure.label}
            className="flex flex-col gap-1 rounded-md border border-border bg-surface p-4"
          >
            <dt className="mono-label text-xs text-text-muted">
              {figure.label}
            </dt>
            <dd className="font-display text-2xl font-semibold text-text">
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>
      <Link href="/" className="mono-label text-xs text-accent hover:underline">
        ← Back to kept
      </Link>
    </main>
  );
}
