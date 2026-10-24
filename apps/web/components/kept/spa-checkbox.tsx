"use client";

/**
 * "Serve as a single-page app" (E08 D12, PRD §5.7) — under the publish zone, off
 * by default, and under the Versions tab's replace zone with the current
 * version's value. Sent as `spa` with the publish or replace it sits under.
 */
import { SPA_HELPER, SPA_LABEL } from "@/lib/publish/fileset/copy";

export function SpaCheckbox({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5 text-sm text-text has-[:disabled]:opacity-50">
      <input
        type="checkbox"
        data-testid="spa-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-accent"
      />
      <span className="flex flex-col gap-0.5">
        {SPA_LABEL}
        <span className="text-[13px] leading-relaxed text-text-secondary">{SPA_HELPER}</span>
      </span>
    </label>
  );
}
