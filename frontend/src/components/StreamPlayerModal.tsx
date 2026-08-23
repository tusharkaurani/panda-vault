import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Plays a stream in-app via hls.js, as an alternative to the entry's default
 *  click, which just hands the raw URL to the browser — fine for a direct
 *  media file, but a `.m3u8` manifest has no player behind it on any browser
 *  without native HLS support (i.e. everything but Safari), so it renders as
 *  text instead of video. Safari gets native `<video src>` since it already
 *  understands HLS and loading hls.js on top would just double the work. */
export default function StreamPlayerModal({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const fail = (message: string) => setError((prev) => prev ?? message);
    // A provider that never actually responds usable data — a CORS-opaque
    // response, a token endpoint that 200s with garbage — doesn't always
    // reach hls.js's own fatal-error path, so the spinner would otherwise
    // hang forever. This is the backstop: if nothing has played by the
    // deadline, treat it as failed regardless of what fired (or didn't).
    const stallTimer = window.setTimeout(
      () => fail("This stream couldn't be played. It may be geo-restricted or offline."),
      12000,
    );
    const clearStall = () => window.clearTimeout(stallTimer);
    video.addEventListener("playing", clearStall, { once: true });

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      return () => {
        clearStall();
        video.removeEventListener("playing", clearStall);
      };
    }

    // hls.js is only pulled in for browsers that actually need it — Safari
    // (above) and the majority-Telegram vault never load it at all.
    let hls: import("hls.js").default | undefined;
    let cancelled = false;
    import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        fail("This browser can't play HLS streams.");
        return;
      }
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // A provider that's actually reachable can still fail here — an
        // expired token or a geo-block responds to the manifest fetch but not
        // with anything playable. `fatal` distinguishes that from the
        // transient/network errors hls.js already retries internally.
        if (data.fatal) {
          fail("This stream couldn't be played. It may be geo-restricted or offline.");
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    });

    return () => {
      cancelled = true;
      clearStall();
      video.removeEventListener("playing", clearStall);
      hls?.destroy();
    };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl border border-panda-border bg-panda-surface p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="truncate text-sm font-medium">{name}</span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-panda-muted hover:text-panda-accent"
            aria-label="Close player"
          >
            <X size={18} />
          </button>
        </div>
        {error ? (
          <div className="flex aspect-video items-center justify-center rounded-lg bg-black text-sm text-panda-muted">
            {error}
          </div>
        ) : (
          <video ref={videoRef} controls autoPlay className="aspect-video w-full rounded-lg bg-black" />
        )}
      </div>
    </div>,
    document.body,
  );
}
