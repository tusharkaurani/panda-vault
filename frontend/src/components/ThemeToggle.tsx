import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { applyTheme, getStoredTheme, ThemePref } from "../lib/theme";

const ORDER: ThemePref[] = ["light", "dark", "system"];
const ICONS: Record<ThemePref, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const LABELS: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };

export default function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getStoredTheme);

  useEffect(() => {
    applyTheme(pref);
  }, [pref]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (pref === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    setPref(next);
  }

  const Icon = ICONS[pref];

  return (
    <button
      onClick={cycle}
      className="p-2 rounded-lg border border-panda-border hover:border-panda-accent hover:text-panda-accent transition-colors shrink-0"
      title={`Theme: ${LABELS[pref]} (click to change)`}
    >
      <Icon size={18} />
    </button>
  );
}
