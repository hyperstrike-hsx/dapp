import { useEffect, useRef, type ReactNode } from "react";

/**
 * A panel laid over the range. Every way out of it leads back to the range: the app decides in
 * each handler whether that means play or, before the player has deployed, the briefing.
 */
export function RangeOverlay({
  title,
  onClose,
  onEscape = onClose,
  onResume = onClose,
  children,
}: {
  title: string;
  /** Closed by a click: the close button, or the dimmed surround outside the panel. */
  onClose: () => void;
  /** Closed with Escape, which a browser does not always count as a gesture. Defaults to `onClose`. */
  onEscape?: () => void;
  /** BACK TO RANGE. Defaults to `onClose`. */
  onResume?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Only a press that began on the surround dismisses: a drag out of the panel must not.
  const pressedOutside = useRef(false);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  // The dialog comes down before the handler runs: while it is up as a modal the range behind it
  // is inert, and the handler is what asks for the pointer back, inside the same click or key press.
  const leave = (then: () => void) => {
    ref.current?.close();
    then();
  };
  // The surround of a modal dialog is its ::backdrop, whose clicks arrive on the dialog itself.
  const outside = (event: { target: EventTarget; currentTarget: HTMLDialogElement; clientX: number; clientY: number }) => {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  return (
    <dialog
      ref={ref}
      className="range-overlay"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        leave(onEscape);
      }}
      onPointerDown={(event) => { pressedOutside.current = outside(event); }}
      onClick={(event) => {
        if (pressedOutside.current && outside(event)) leave(onClose);
      }}
    >
      <header>
        <button autoFocus onClick={() => leave(onResume)}>
          ← BACK TO RANGE
        </button>
        <span>{title} · Your position is saved</span>
        <button onClick={() => leave(onClose)} aria-label="Close panel">
          ESC / CLOSE ×
        </button>
      </header>
      <div className="range-overlay-content">{children}</div>
    </dialog>
  );
}
