"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * A consequence, a way out, and one button that does the thing — every
 * confirmation on the page-detail screen (demote, delete, restore, rename).
 * Nothing is written before its confirm button is pressed: a warning printed
 * after the write is a receipt.
 *
 * ⚠️ CLOSING IS REFUSED WHILE THE WRITE IS IN FLIGHT, for `SwapDialog`'s reason:
 * Escape, the overlay and the close button all funnel through one handler, and
 * abandoning a request that may already have committed leaves the screen unable
 * to say what happened.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmVariant = "primary",
  confirmDisabled = false,
  testId,
  pending,
  error,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmVariant?: React.ComponentProps<typeof Button>["variant"];
  /** A gate the dialog's own fields hold shut (delete's type-the-name). */
  confirmDisabled?: boolean;
  testId: string;
  pending: boolean;
  /** The write's refusal, verbatim, shown in the dialog that caused it. */
  error?: string | null;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        data-testid={testId}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-semibold tracking-[-0.02em]">{title}</DialogTitle>
          <DialogDescription className="text-[15px] leading-relaxed text-text-secondary">
            {description}
          </DialogDescription>
        </DialogHeader>

        {children}

        {error ? (
          <p role="alert" data-testid={`${testId}-error`} className="text-sm leading-relaxed text-danger">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="font-body font-medium"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid={`${testId}-confirm`}
            variant={confirmVariant}
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
            className="font-body font-medium"
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
