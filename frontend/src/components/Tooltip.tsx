import { ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Hover/focus label for icon-only controls, whose purpose isn't otherwise
 *  visible. Replaces the native `title` attribute, which waits about a
 *  second and renders in the OS style rather than the app's.
 *
 *  Portals to `document.body` and positions itself from the trigger's
 *  `getBoundingClientRect`, rather than an absolutely-positioned child of the
 *  trigger. Document lists (`doc-row`) use `content-visibility: auto` for
 *  scroll performance, and that implies paint containment on every row —
 *  which clips anything an in-row tooltip tries to render outside the row's
 *  own box, so it showed up cut off instead of floating over neighbours.
 *
 *  Not shown on touch devices, which have no hover — so it must never be the
 *  only way to learn what a button does.
 */
export default function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({
        top: side === "top" ? rect.top - 6 : rect.bottom + 6,
        left: rect.left + rect.width / 2,
      });
    };
    update();
    // Capture phase: scroll doesn't bubble, but this still sees scrolling in
    // any ancestor scroll container, not just the window.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, side]);

  return (
    <span
      ref={triggerRef}
      className="inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {createPortal(
        <span
          role="tooltip"
          style={{
            top: pos.top,
            left: pos.left,
            transform: side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
          }}
          className={`pointer-events-none fixed z-30 whitespace-nowrap rounded-md border border-panda-border bg-panda-surface2 px-2 py-1 text-[11px] font-medium text-panda-text shadow-lg shadow-black/20 transition-opacity delay-150 duration-100 ${
            open ? "opacity-100" : "opacity-0"
          }`}
        >
          {label}
        </span>,
        document.body,
      )}
    </span>
  );
}
