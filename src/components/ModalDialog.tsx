import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

interface ModalDialogProps {
  children: ReactNode;
  describedBy: string;
  labelledBy: string;
  onDismiss: () => void;
}

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function ModalDialog({
  children,
  describedBy,
  labelledBy,
  onDismiss,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const firstControl =
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
    firstControl?.focus();

    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }

    if (event.key !== "Tab" || !dialogRef.current) {
      return;
    }

    const controls = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
    );
    if (controls.length === 0) {
      return;
    }

    const first = controls.at(0);
    const last = controls.at(-1);
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        aria-describedby={describedBy}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="dialog-card"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        {children}
      </div>
    </div>
  );
}
