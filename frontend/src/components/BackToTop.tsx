import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import Tooltip from "./Tooltip";

/** Distance scrolled before the button appears. Deliberately small — the page
 *  only scrolls at all once the listing overflows the viewport, so this shows
 *  up about as soon as a scrollbar does rather than making people scroll a
 *  screenful to earn it. */
const SHOW_AFTER = 160;

/** Floating "back to top" control for the long collection listings. The page
 *  scrolls the window (`Layout` puts content in normal flow), so it watches
 *  `scrollY` rather than a container. Resize is watched too: shrinking the
 *  viewport or filtering the list down can leave us above the threshold with
 *  no scroll event of our own. */
export default function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setVisible(window.scrollY > SHOW_AFTER);
    };
    const onChange = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onChange, { passive: true });
    window.addEventListener("resize", onChange);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);

  function toTop() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }

  return (
    <div
      className={`fixed bottom-6 right-6 z-20 transition-opacity duration-200 ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <Tooltip label="Back to top">
        <button
          type="button"
          onClick={toTop}
          aria-label="Back to top"
          tabIndex={visible ? 0 : -1}
          className="rounded-full bg-panda-accent p-3 text-panda-bg shadow-lg shadow-black/25 transition-opacity hover:opacity-90"
        >
          <ArrowUp size={18} />
        </button>
      </Tooltip>
    </div>
  );
}
