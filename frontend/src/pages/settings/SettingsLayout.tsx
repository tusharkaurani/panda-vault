import { NavLink, Outlet, useLocation } from "react-router-dom";
import Breadcrumbs from "../../components/Breadcrumbs";

// Two tabs, fixed — the strip must not grow with every new source type. They
// are real routes rather than `?tab=` params so each is its own history entry
// and each can be a distinct breadcrumb crumb; a source type's own settings
// then hang off `/settings/integrations/:sourceType` outside this layout.
const TABS: { path: string; label: string }[] = [
  { path: "integrations", label: "Integrations" },
  { path: "collections", label: "Collections" },
];

/** The chrome both Settings tabs share. */
export default function SettingsLayout() {
  const { pathname } = useLocation();
  const active = TABS.find((t) => pathname.startsWith(`/settings/${t.path}`)) ?? TABS[0];

  return (
    <div className="flex flex-col gap-6">
      {/* "Settings" carries no `to`: it redirects to whichever tab is default,
          so linking it would just duplicate the crumb after it. */}
      <Breadcrumbs items={[{ label: "Settings" }, { label: active.label }]} />

      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-panda-muted text-sm mt-1">
          Connect an integration, manage the sources it provides, and organize them into collections.
        </p>
      </div>

      <div className="flex gap-1 border-b border-panda-border">
        {TABS.map(({ path, label }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                isActive
                  ? "border-panda-accent text-panda-text"
                  : "border-transparent text-panda-muted hover:text-panda-text"
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </div>

      <Outlet />
    </div>
  );
}
