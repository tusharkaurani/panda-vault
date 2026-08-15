export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "panda-theme";

export function getStoredTheme(): ThemePref {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function resolveIsDark(pref: ThemePref): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(pref: ThemePref) {
  document.documentElement.classList.toggle("dark", resolveIsDark(pref));
  if (pref === "system") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, pref);
  }
}
