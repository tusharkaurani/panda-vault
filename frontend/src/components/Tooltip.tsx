import { ReactNode } from "react";

/** Hover/focus label for icon-only controls, whose purpose isn't otherwise
 *  visible. Replaces the native `title` attribute, which waits about a
 *  second and renders in the OS style rather than the app's.
 *
 *  Uses a named group so nesting inside another `group` (collection rows,
 *  tree nodes) can't trigger it by accident. Not shown on touch devices,
 *  which have no hover — so it must never be the only way to learn what a
 *  button does.
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
  const position = side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5";

  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${position} left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md border border-panda-border bg-panda-surface2 px-2 py-1 text-[11px] font-medium text-panda-text opacity-0 shadow-lg shadow-black/20 transition-opacity delay-150 duration-100 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100`}
      >
        {label}
      </span>
    </span>
  );
}
