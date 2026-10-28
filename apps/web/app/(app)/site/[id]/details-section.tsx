"use client";

/**
 * General → Details: the page's title, "List on Explore when it opens" (PRD
 * §5.2 item 2, D11 / D12, AC36 / AC37; E06 task 012) and how it was made —
 * model, tool, prompt + "Show the prompt", "Show 'Made with' on the page",
 * "Allow remix", source link and the README (E10 §4.1, D6, D8; task 006).
 *
 * The design's Explore card and provenance rows (`kept Page Screen.dc.html`,
 * `s-explore` and the "How it was made" block) where they cover a field; the
 * source link and the README editor have no design (Q10) and are built from
 * tokens, flagged for review. One explicit save bar for everything: "Unsaved
 * changes · Discard · Save" → "Saved." — or, when the save changed what
 * visitors of a kept page see, "Saved. Showing on your page in about 2
 * minutes." (the second purge's window).
 *
 * ── STATES ───────────────────────────────────────────────────────────────────
 * clean · dirty (the bar) · saving · saved · field errors (checked against the
 * route's own schema before sending, so a URL or length error sits under its
 * field) · the route's sentence for anything else · "Couldn't save. Try again."
 * for anything that is not the studio envelope · README preview.
 *
 * Only what changed is sent. Clearing the title hands it back to the page's
 * own `<title>`, so the fields repaint from the RESPONSE, not from what was
 * typed. A server render that brings new values (a replace re-titled the
 * page, an agent sent a new model) is adopted while the form is clean, never
 * over an edit in progress.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  PAGE_TITLE_MAX_LENGTH,
  PROVENANCE_LIMITS,
  remixAllowed,
  siteUpdateRequestSchema,
  type SiteUpdateRequest,
  type StudioSite,
} from "@kept/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { updatePage } from "@/lib/sites/owner-client";
import { cn } from "@/lib/utils";

import { Section } from "./section";

/** How long "Saved." stays before the bar folds away (the design's 1.8 s). */
const SAVED_MS = 1800;

/** PRD §5.2 / AC37, verbatim — until E15 opens Explore. */
const EXPLORE_LABEL = "List on Explore when it opens";

/** PRD §8 — a kept page's visitors see the change after the second purge. */
const SAVED_VISIBLE = "Saved. Showing on your page in about 2 minutes.";

/** The page's provenance as the Details panel edits it (E10 §4.1). */
export type DetailsProvenance = Pick<
  StudioSite,
  "model" | "tool" | "prompt" | "readme" | "sourceUrl" | "showPrompt" | "showMadeWith" | "allowRemix"
>;

interface DetailsValues {
  title: string;
  listedPublic: boolean;
  model: string;
  tool: string;
  prompt: string;
  readme: string;
  sourceUrl: string;
  showPrompt: boolean;
  showMadeWith: boolean;
  /** `null` = the default rule (D8). */
  allowRemix: boolean | null;
}

type Field = keyof DetailsValues;

const FIELDS = Object.keys({
  title: 0,
  listedPublic: 0,
  model: 0,
  tool: 0,
  prompt: 0,
  readme: 0,
  sourceUrl: 0,
  showPrompt: 0,
  showMadeWith: 0,
  allowRemix: 0,
} satisfies Record<Field, 0>) as Field[];

/** Fields that change a kept page's badge or README page (Q5) — everything but the Explore flag. */
const VISIBLE_FIELDS: readonly Field[] = FIELDS.filter((field) => field !== "listedPublic");

/** A field's own sentence for a schema refusal; the title's comes from the schema itself. */
const FIELD_ERRORS: Partial<Record<Field, string>> = {
  sourceUrl: "Enter a link that starts with https:// or http://.",
  model: `Up to ${PROVENANCE_LIMITS.model} characters.`,
  tool: `Up to ${PROVENANCE_LIMITS.tool} characters.`,
  prompt: `Up to ${PROVENANCE_LIMITS.prompt.toLocaleString("en")} characters.`,
  readme: `Up to ${PROVENANCE_LIMITS.readme.toLocaleString("en")} characters.`,
};

type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

function valuesOf(site: { title: string | null; listedPublic: boolean } & DetailsProvenance): DetailsValues {
  return {
    title: site.title ?? "",
    listedPublic: site.listedPublic,
    model: site.model ?? "",
    tool: site.tool ?? "",
    prompt: site.prompt ?? "",
    readme: site.readme ?? "",
    sourceUrl: site.sourceUrl ?? "",
    showPrompt: site.showPrompt,
    showMadeWith: site.showMadeWith,
    allowRemix: site.allowRemix,
  };
}

/** A switch row: label, a note under it, the switch at the right (the design's rows). */
function ToggleRow({
  label,
  note,
  checked,
  disabled,
  onChange,
  testId,
  divided = true,
  children,
}: {
  label: string;
  note: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
  /** The hairline above — every row but a first one. */
  divided?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const noteId = useId();
  return (
    <div className={cn("flex items-center gap-3", divided && "border-t border-border pt-3")}>
      <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
        <label htmlFor={id} className="text-[15px] text-text">
          {label}
        </label>
        <span id={noteId} className="text-[13px] text-pretty text-text-secondary">
          {note}
          {children}
        </span>
      </span>
      <Switch
        id={id}
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        aria-describedby={noteId}
        onCheckedChange={onChange}
        className="data-[state=unchecked]:bg-text-muted"
      />
    </div>
  );
}

/** A labelled text field with its note or its error underneath. */
function TextField({
  label,
  note,
  error,
  children,
}: {
  label: string;
  note?: ReactNode;
  error?: string;
  children: (ids: { id: string; describedBy: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const noteId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children({ id, describedBy: noteId, invalid: error !== undefined })}
      {error !== undefined || note ? (
        <p
          id={noteId}
          role={error !== undefined ? "alert" : undefined}
          className={cn("text-[13px]", error !== undefined ? "text-danger" : "text-text-secondary")}
        >
          {error ?? note}
        </p>
      ) : null}
    </div>
  );
}

const FIELD_CLASS = "h-11 rounded-[var(--r-sm)] text-[15px] shadow-none";

export function DetailsSection({
  siteId,
  title,
  fallbackName,
  listedPublic,
  provenance,
  isKept,
  canEditTitle,
  canList,
  listingNote,
}: {
  siteId: string;
  /** The stored title (the page's own or the owner's); `null` → none. */
  title: string | null;
  /** What the page is called without a title — its name — as the placeholder. */
  fallbackName: string;
  listedPublic: boolean;
  provenance: DetailsProvenance;
  /** Kept pages show the badge's credit and the README page; a draft's badge is fixed (D4). */
  isKept: boolean;
  /** PRD §5.2: live (kept or draft) and under review. Otherwise title and provenance are absent. */
  canEditTitle: boolean;
  /** Kept and live. Otherwise the toggle is DISABLED with `listingNote` — the one exception to "absent". */
  canList: boolean;
  listingNote: string;
}) {
  const router = useRouter();
  const fromProps = valuesOf({ title, listedPublic, ...provenance });
  const [baseline, setBaseline] = useState(fromProps);
  const [values, setValues] = useState(fromProps);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [readmeTab, setReadmeTab] = useState<"write" | "preview">("write");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);

  const changed = FIELDS.filter((field) => values[field] !== baseline[field]);
  const dirty = changed.length > 0;
  const busy = phase.kind === "saving";

  // Adopt a new server render while clean — React's "adjust state on a prop
  // change" pattern, so no effect paints the stale value first.
  const propsKey = JSON.stringify(fromProps);
  const [seenKey, setSeenKey] = useState(propsKey);
  if (propsKey !== seenKey) {
    setSeenKey(propsKey);
    if (!dirty && !busy) {
      setBaseline(fromProps);
      setValues(fromProps);
    }
  }

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
      abort.current?.abort();
    };
  }, []);

  // The preview renders with the very renderer the README page is written
  // with, loaded only when someone opens the tab.
  useEffect(() => {
    if (readmeTab !== "preview") return;
    let live = true;
    void import("@/lib/readme/render").then(({ renderReadme }) => {
      if (live) setPreviewHtml(renderReadme(values.readme));
    });
    return () => {
      live = false;
    };
  }, [readmeTab, values.readme]);

  function edit(next: Partial<DetailsValues>) {
    setValues((current) => ({ ...current, ...next }));
    setFieldErrors((current) => {
      const rest = { ...current };
      for (const field of Object.keys(next) as Field[]) delete rest[field];
      return rest;
    });
    if (!busy) setPhase({ kind: "idle" });
  }

  function discard() {
    setValues(baseline);
    setFieldErrors({});
    setPhase({ kind: "idle" });
  }

  async function save() {
    if (!dirty || busy) return;
    const body = Object.fromEntries(changed.map((field) => [field, values[field]])) as SiteUpdateRequest;

    // The route's own schema, so a field's error sits under the field.
    const checked = siteUpdateRequestSchema.safeParse(body);
    if (!checked.success) {
      const errors: Partial<Record<Field, string>> = {};
      for (const issue of checked.error.issues) {
        const field = issue.path[0] as Field | undefined;
        if (field && !errors[field]) errors[field] = FIELD_ERRORS[field] ?? issue.message;
      }
      setFieldErrors(errors);
      setPhase({ kind: "error", message: "Check the highlighted fields." });
      return;
    }

    if (savedTimer.current) clearTimeout(savedTimer.current);
    setPhase({ kind: "saving" });
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const outcome = await updatePage(siteId, body, controller.signal);
    if (controller.signal.aborted) return;

    if (!outcome.ok) {
      setPhase({ kind: "error", message: outcome.error.message });
      return;
    }
    const saved = valuesOf(outcome.site);
    setBaseline(saved);
    setValues(saved);
    setFieldErrors({});
    const visible = isKept && changed.some((field) => VISIBLE_FIELDS.includes(field));
    setPhase({ kind: "saved", message: visible ? SAVED_VISIBLE : "Saved." });
    savedTimer.current = setTimeout(() => setPhase({ kind: "idle" }), SAVED_MS);
    router.refresh();
  }

  const showBar = dirty || phase.kind !== "idle";
  const remixOn =
    values.allowRemix ?? remixAllowed({ allowRemix: null, kept: true, model: values.model.trim() || null });
  const remixNote = !isKept
    ? "Only kept pages can be remixed."
    : values.allowRemix === null
      ? `Visitors can open the idea in Claude or ChatGPT. Default: ${remixOn ? "on, because a model is set" : "off until a model is set"}.`
      : "Visitors can open the idea in Claude or ChatGPT.";

  return (
    <Section title="Details" testId="details-section">
      {canEditTitle ? (
        <TextField label="Title" note="Leave it empty to use the page’s own title." error={fieldErrors.title}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              data-testid="title-input"
              value={values.title}
              maxLength={PAGE_TITLE_MAX_LENGTH}
              placeholder={fallbackName}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid || phase.kind === "error" ? true : undefined}
              disabled={busy}
              onChange={(event) => edit({ title: event.target.value })}
              className={FIELD_CLASS}
            />
          )}
        </TextField>
      ) : null}

      <ToggleRow
        label={EXPLORE_LABEL}
        note={listingNote}
        checked={values.listedPublic}
        disabled={!canList || busy}
        onChange={(listed) => edit({ listedPublic: listed })}
        testId="explore-toggle"
        divided={canEditTitle}
      />

      {canEditTitle ? (
        <div data-testid="provenance-fields" className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="flex flex-col gap-0.5">
            <h3 className="font-display text-[17px] font-semibold text-text">How it was made</h3>
            <p className="text-[13px] text-text-secondary">
              Optional. An agent that replaces this page can overwrite these fields.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Model" error={fieldErrors.model}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  data-testid="model-input"
                  value={values.model}
                  maxLength={PROVENANCE_LIMITS.model}
                  placeholder="e.g. claude-opus-4-7"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  disabled={busy}
                  onChange={(event) => edit({ model: event.target.value })}
                  className={FIELD_CLASS}
                />
              )}
            </TextField>
            <TextField label="Tool" error={fieldErrors.tool}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  data-testid="tool-input"
                  value={values.tool}
                  maxLength={PROVENANCE_LIMITS.tool}
                  placeholder="e.g. Claude Code, Cursor"
                  autoComplete="off"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  disabled={busy}
                  onChange={(event) => edit({ tool: event.target.value })}
                  className={FIELD_CLASS}
                />
              )}
            </TextField>
          </div>

          <TextField label="Prompt" error={fieldErrors.prompt}>
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                data-testid="prompt-input"
                rows={4}
                value={values.prompt}
                maxLength={PROVENANCE_LIMITS.prompt}
                placeholder="What did you ask the model for?"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                disabled={busy}
                onChange={(event) => edit({ prompt: event.target.value })}
                className="rounded-[var(--r-sm)] text-[15px] leading-normal shadow-none"
              />
            )}
          </TextField>

          <div className="flex flex-col gap-3">
            <ToggleRow
              label="Show the prompt"
              note="Shown on your page and in Remix links."
              checked={values.showPrompt}
              disabled={busy}
              onChange={(showPrompt) => edit({ showPrompt })}
              testId="show-prompt-toggle"
            />
            <ToggleRow
              label="Show “Made with” on the page"
              note="Credits the model in the corner badge."
              checked={values.showMadeWith}
              disabled={busy}
              onChange={(showMadeWith) => edit({ showMadeWith })}
              testId="show-made-with-toggle"
            />
            <ToggleRow
              label="Allow remix"
              note={remixNote}
              checked={isKept && remixOn}
              disabled={!isKept || busy}
              onChange={(allowRemix) => edit({ allowRemix })}
              testId="allow-remix-toggle"
            >
              {isKept && values.allowRemix !== null ? (
                <>
                  {" "}
                  <button
                    type="button"
                    data-testid="remix-default"
                    disabled={busy}
                    onClick={() => edit({ allowRemix: null })}
                    className="text-accent underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Use the default
                  </button>
                </>
              ) : null}
            </ToggleRow>
          </div>

          <TextField label="Source link" note="Where the source lives — an http(s) link." error={fieldErrors.sourceUrl}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                data-testid="source-url-input"
                type="url"
                inputMode="url"
                value={values.sourceUrl}
                maxLength={PROVENANCE_LIMITS.source_url}
                placeholder="https://github.com/you/your-page"
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                disabled={busy}
                onChange={(event) => edit({ sourceUrl: event.target.value })}
                className={FIELD_CLASS}
              />
            )}
          </TextField>

          <TextField
            label="README"
            note={
              isKept
                ? "Markdown. Shown at /_kept/readme and linked from the badge as “How it was made”. No images or HTML."
                : "Markdown. Shown on your page once it is kept. No images or HTML."
            }
            error={fieldErrors.readme}
          >
            {({ id, describedBy, invalid }) => (
              <div className="flex flex-col gap-2">
                <div role="group" aria-label="README view" className="flex items-center gap-1">
                  {(["write", "preview"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      aria-pressed={readmeTab === tab}
                      data-testid={`readme-${tab}-tab`}
                      onClick={() => setReadmeTab(tab)}
                      className={cn(
                        "h-8 rounded-[var(--r-sm)] px-3 text-sm",
                        readmeTab === tab ? "bg-sunken font-medium text-text" : "text-text-secondary hover:text-text",
                      )}
                    >
                      {tab === "write" ? "Write" : "Preview"}
                    </button>
                  ))}
                  <span data-testid="readme-count" className="ml-auto font-mono text-xs text-text-muted">
                    {values.readme.length.toLocaleString("en")} / {PROVENANCE_LIMITS.readme.toLocaleString("en")}
                  </span>
                </div>
                {readmeTab === "write" ? (
                  <Textarea
                    id={id}
                    data-testid="readme-input"
                    rows={10}
                    value={values.readme}
                    maxLength={PROVENANCE_LIMITS.readme}
                    placeholder={"## How I made this\n\nWhat you asked for, what you changed, what you learned."}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    disabled={busy}
                    onChange={(event) => edit({ readme: event.target.value })}
                    className="rounded-[var(--r-sm)] font-mono text-[13px] leading-normal shadow-none"
                  />
                ) : (
                  <div
                    data-testid="readme-preview"
                    className={cn(
                      "min-h-40 overflow-x-auto rounded-[var(--r-sm)] border border-border px-3.5 py-2.5 text-[15px] text-text",
                      "[&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3",
                      "[&_code]:font-mono [&_code]:text-[13px] [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold",
                      "[&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&>div>*+*]:mt-2",
                      "[&_pre]:overflow-x-auto [&_pre]:rounded-[var(--r-sm)] [&_pre]:bg-sunken [&_pre]:p-3",
                    )}
                  >
                    {values.readme.trim() ? (
                      // `renderReadme` emits no raw HTML, image or script (html: false).
                      <div dangerouslySetInnerHTML={{ __html: previewHtml ?? "" }} />
                    ) : (
                      <p className="text-text-muted">Nothing to preview yet.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </TextField>
        </div>
      ) : null}

      {showBar ? (
        <div
          data-testid="save-bar"
          data-phase={phase.kind === "idle" ? (dirty ? "dirty" : "clean") : phase.kind}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3"
        >
          <span
            role={phase.kind === "error" ? "alert" : "status"}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 text-sm",
              phase.kind === "error" ? "text-danger" : "text-text",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                phase.kind === "saved" ? "bg-live" : phase.kind === "error" ? "bg-danger" : "bg-text-muted",
              )}
            />
            {phase.kind === "saving"
              ? "Saving…"
              : phase.kind === "saved" || phase.kind === "error"
                ? phase.message
                : "Unsaved changes"}
          </span>
          {dirty ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={discard}
                className="font-body font-medium"
              >
                Discard
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="details-save"
                disabled={busy}
                onClick={save}
                className="font-body font-medium"
              >
                Save
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
