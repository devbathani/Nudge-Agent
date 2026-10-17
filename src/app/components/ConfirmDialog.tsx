import { useEffect, useRef } from "react";
import { Button } from "@cloudflare/kumo";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  // Runs only when the dialog opens/closes, so re-renders while it is open
  // (e.g. a state sync) don't steal focus back to the Cancel button.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onCancel}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
        className="relative w-full max-w-sm rounded-2xl border border-kumo-line bg-kumo-base p-5 shadow-xl"
      >
        <h2
          id="confirm-title"
          className="text-base font-semibold text-kumo-default"
        >
          {title}
        </h2>
        <p
          id="confirm-desc"
          className="mt-2 text-sm leading-relaxed text-kumo-subtle"
        >
          {description}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            ref={cancelRef}
            variant="secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Keep my data
          </Button>
          <Button variant="destructive" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
