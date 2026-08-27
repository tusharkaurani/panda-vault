import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { isHlsStream } from "../lib/streams";

/** Plays a stream in-app, as an alternative to the entry's default click,
 *  which just hands the raw URL to the browser. For a `.m3u8` manifest that's
 *  no help on any browser without native HLS support (i.e. everything but
 *  Safari) — it renders as text instead of video, so this pulls in hls.js.
 *  Safari gets native `<video src>` since it already understands HLS and
 *  loading hls.js on top would just double the work. Anything else (a direct
 *  .mp4/.ts/.mkv/... file) has no manifest for hls.js to parse, so it's
 *  handed to an iframe instead — the browser's own native player renders it
 *  the same way it would if the URL were opened in a new tab, just inline. */
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
  const isHls = isHlsStream(url);

  useEffect(() => {
    if (!isHls) return;
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
  }, [url, isHls]);

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
        ) : isHls ? (
          <video ref={videoRef} controls autoPlay className="aspect-video w-full rounded-lg bg-black" />
        ) : (
          // No manifest for hls.js to parse, so this leans on the browser's
          // own handling of the URL — the same thing a direct navigation
          // would do, just inline. A provider that blocks framing (X-Frame-
          // Options/CSP) renders blank; "Open the stream" is the fallback.
          <iframe
            src={url}
            title={name}
            allow="autoplay; fullscreen"
            allowFullScreen
            className="aspect-video w-full rounded-lg border-0 bg-black"
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
