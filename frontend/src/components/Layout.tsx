import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Search as SearchIcon, Settings as SettingsIcon } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import NotificationBell from "./NotificationBell";
import Tooltip from "./Tooltip";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { MIN_SEARCH_LENGTH } from "../lib/search";

export default function Layout({ children }: { children: ReactNode }) {
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 350);
  const navigate = useNavigate();
  const location = useLocation();
  // Remembers the page we were on right before the header search box sent us
  // to /search, so clearing the box can return there explicitly — set only
  // while we're the ones navigating, never on a direct/refreshed /search load.
  const originRef = useRef<string | null>(null);

  useEffect(() => {
    const trimmed = debouncedQ.trim();
    // A single character matches most of the library, so searching only
    // starts once the query can actually narrow something down.
    if (trimmed.length >= MIN_SEARCH_LENGTH) {
      if (location.pathname !== "/search") {
        originRef.current = location.pathname + location.search;
      }
      navigate(`/search?q=${encodeURIComponent(trimmed)}`, { replace: location.pathname === "/search" });
    } else if (!trimmed && originRef.current !== null && location.pathname === "/search") {
      navigate(originRef.current, { replace: true });
      originRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed.length < MIN_SEARCH_LENGTH) return;
    if (location.pathname !== "/search") {
      originRef.current = location.pathname + location.search;
    }
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-10 border-b border-panda-border bg-panda-bg/90 backdrop-blur">
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
              placeholder="Search documents — e.g. TH Ban"
              className="w-full bg-panda-surface border border-panda-border rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-panda-accent transition-colors"
            />
          </form>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-6">{children}</main>

      <footer className="border-t border-panda-border py-4 text-center text-xs text-panda-muted">
        Panda Vault — self-hosted Telegram document library
      </footer>
    </div>
  );
}
