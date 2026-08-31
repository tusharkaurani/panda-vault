import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Search as SearchIcon, Settings as SettingsIcon } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import NotificationBell from "./NotificationBell";
import Tooltip from "./Tooltip";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { MIN_SEARCH_LENGTH } from "../lib/search";
import { api } from "../api";
import { findPath } from "../lib/collections";
import { useIntegrations } from "../integrations/IntegrationsContext";
import type { Collection, SourceType } from "../types";

function isSourceType(value: string): value is SourceType {
  return value === "telegram" || value === "m3u";
}

export default function Layout({ children }: { children: ReactNode }) {
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 350);
  const navigate = useNavigate();
  const location = useLocation();
  const { byId } = useIntegrations();
  const [tree, setTree] = useState<Collection[] | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  // Remembers the page we were on right before the header search box sent us
  // to /search, so clearing the box can return there explicitly — set only
  // while we're the ones navigating, never on a direct/refreshed /search load.
  const originRef = useRef<string | null>(null);

  useEffect(() => {
    api.collections.tree().then(setTree).catch(() => {});
  }, []);

  // The header's height varies (it wraps to two rows below md), so a page's
  // own sticky search bar needs to know it dynamically rather than hardcode
  // a breakpoint-specific offset — exposed as a CSS var so any page can
  // `sticky top-[var(--header-h)]` under it.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Which Library section the current page belongs to, if any. Search is
  // scoped to it rather than spanning every integration, and disabled
  // outright off both `/s/:sourceType` and a bound `/c/:collectionId` (also
  // reached via a `/group/:group` sub-route) — a query can't silently span
  // sources the user never navigated into. `/search` itself carries its
  // scope in its own `type` param rather than the current route, so typing a
  // follow-up query there keeps searching the same section.
  const sectionSourceType = useMemo<SourceType | null>(() => {
    const sMatch = location.pathname.match(/^\/s\/([^/]+)/);
    if (sMatch && isSourceType(sMatch[1])) return sMatch[1];
    const cMatch = location.pathname.match(/^\/c\/([^/]+)/);
    if (cMatch && tree) {
      const path = findPath(tree, cMatch[1]);
      const node = path?.[path.length - 1];
      if (node) return node.sourceType;
    }
    if (location.pathname === "/search") {
      const type = new URLSearchParams(location.search).get("type");
      if (type && isSourceType(type)) return type;
    }
    return null;
  }, [location.pathname, location.search, tree]);

  const sectionName = sectionSourceType ? byId(sectionSourceType)?.name ?? sectionSourceType : null;

  // Leaving a section (e.g. back to Landing or into Settings) with an
  // unsubmitted query in the box would otherwise leave it sitting there,
  // disabled but non-empty — clear it so "disabled" always reads as "empty".
  useEffect(() => {
    if (!sectionSourceType) setQ("");
  }, [sectionSourceType]);

  useEffect(() => {
    const trimmed = debouncedQ.trim();
    // A single character matches most of the library, so searching only
    // starts once the query can actually narrow something down.
    if (trimmed.length >= MIN_SEARCH_LENGTH && sectionSourceType) {
      if (location.pathname !== "/search") {
        originRef.current = location.pathname + location.search;
      }
      navigate(`/search?q=${encodeURIComponent(trimmed)}&type=${sectionSourceType}`, {
        replace: location.pathname === "/search",
      });
    } else if (!trimmed && originRef.current !== null && location.pathname === "/search") {
      navigate(originRef.current, { replace: true });
      originRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed.length < MIN_SEARCH_LENGTH || !sectionSourceType) return;
    if (location.pathname !== "/search") {
      originRef.current = location.pathname + location.search;
    }
    navigate(`/search?q=${encodeURIComponent(trimmed)}&type=${sectionSourceType}`);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header ref={headerRef} className="sticky top-0 z-10 border-b border-panda-border bg-panda-bg/90 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center gap-3">
          <Link to="/" className="order-1 flex items-center gap-2 font-semibold text-lg shrink-0">
            <span className="text-xl leading-none" aria-hidden="true">🐼</span>
            <span>Panda Vault</span>
          </Link>

          <div className="order-2 md:order-3 ml-auto md:ml-0 flex items-center gap-2 shrink-0">
            <ThemeToggle />

            <NotificationBell />

            <Tooltip label="Settings" side="bottom">
              <Link
                to="/settings"
                className="p-2 rounded-lg border border-panda-border hover:border-panda-accent hover:text-panda-accent transition-colors shrink-0"
              >
                <SettingsIcon size={18} />
              </Link>
            </Tooltip>
          </div>

          <form onSubmit={onSearch} className="order-3 md:order-2 w-full md:w-auto md:flex-1 md:max-w-md md:ml-auto relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-panda-muted" size={16} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              disabled={!sectionSourceType}
              title={sectionSourceType ? undefined : "Open Telegram or M3U to search that library"}
              placeholder={sectionSourceType ? `Search ${sectionName} — e.g. WIRED` : "Open a library to search"}
              className="w-full bg-panda-surface border border-panda-border rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-panda-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </form>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-6">{children}</main>

      <footer className="border-t border-panda-border py-4 text-center text-xs text-panda-muted">
        Panda Vault — self-hosted library for Telegram channels and M3U playlists
      </footer>
    </div>
  );
}
