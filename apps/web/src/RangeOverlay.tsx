import { useEffect, useRef, type ReactNode } from "react";

export function RangeOverlay({
  title,
  onClose,
  onResume,
  children,
}: {
  title: string;
  onClose: () => void;
  onResume: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="range-overlay"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
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
