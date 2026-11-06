import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "./ui";

/**
 * A modal built on the native <dialog>, which brings focus trapping, Escape to close and an
 * inert background without a library.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only closes on a backdrop click; <dialog> already closes on Escape
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
      aria-labelledby="dialog-title"
      className={cx(
        "m-auto w-[min(560px,calc(100vw-32px))] rounded-lg border border-line bg-surface p-0 text-ink shadow-[0_24px_64px_-24px_rgb(0_0_0/0.45)]",
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-48px)] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id="dialog-title" className="text-base font-semibold">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-m-1 rounded-md p-1 text-ink-muted hover:bg-raised hover:text-ink"
              aria-label="Close"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
          <div className="min-h-0 overflow-y-auto">{children}</div>
        </div>
      )}
    </dialog>
  );
}
