import { useEffect, useRef, type ReactNode } from "react";

export function RangeOverlay({
  title,
  onClose,
  onResume,
  onOutside = onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  onResume: () => void;
  /** A click on the dimmed surround, outside the panel. Defaults to `onClose`. */
  onOutside?: () => void;
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
        onClose();
      }}
      onPointerDown={(event) => { pressedOutside.current = outside(event); }}
      onClick={(event) => {
        if (!pressedOutside.current || !outside(event)) return;
        ref.current?.close();
        onOutside();
      }}
    >
      <header>
        <button
          autoFocus
          onClick={() => {
            ref.current?.close();
            onResume();
          }}
        >
          ← BACK TO RANGE
        </button>
        <span>{title} · Your position is saved</span>
        <button onClick={onClose} aria-label="Close panel">
          ESC / CLOSE ×
        </button>
      </header>
      <div className="range-overlay-content">{children}</div>
    </dialog>
  );
}
