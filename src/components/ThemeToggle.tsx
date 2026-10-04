"use client";

import { useSyncExternalStore } from "react";
import { useI18n } from "../i18n/react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

const THEME_EVENT = "yaseir:theme-change";

function emitThemeChange() {
  window.dispatchEvent(new Event(THEME_EVENT));
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener(THEME_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);

  // Follow the OS until the user makes an explicit choice. Some test DOMs
  // (including jsdom) do not implement matchMedia, so theme syncing must
  // degrade to the explicit DOM/localStorage state without throwing.
  if (typeof window.matchMedia !== "function") {
    return () => {
      window.removeEventListener(THEME_EVENT, onStoreChange);
      window.removeEventListener("storage", onStoreChange);
    };
  }

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => {
    try {
      if (localStorage.getItem("theme")) return;
    } catch {
      return;
    }
    document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    syncColorScheme();
    emitThemeChange();
  };
  // Older Windows WebView2 builds expose addListener/removeListener only.
  const mqLegacy = mq as MediaQueryList & {
    addListener?: (fn: () => void) => void;
    removeListener?: (fn: () => void) => void;
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onSchemeChange);
  } else if (typeof mqLegacy.addListener === "function") {
    mqLegacy.addListener(onSchemeChange);
  }
  return () => {
    window.removeEventListener(THEME_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
    if (typeof mq.removeEventListener === "function") {
      mq.removeEventListener("change", onSchemeChange);
    } else if (typeof mqLegacy.removeListener === "function") {
      mqLegacy.removeListener(onSchemeChange);
    }
  };
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

function syncColorScheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

/** Applies a theme everywhere it is observable (DOM, color-scheme, storage). */
export function setTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  syncColorScheme();
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* private mode: the attribute still applies for this visit */
  }
  emitThemeChange();
}

/** Flips the current theme — used by the toggle and the command menu. */
export function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

/**
 * Light/dark switch. The actual theme is applied by a pre-paint script in the
 * root layout (data-theme on <html>); this component flips that attribute,
 * remembers the explicit choice in localStorage, and re-renders from the DOM
 * via useSyncExternalStore (no setState-in-effect, no hydration mismatch).
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const { t } = useI18n();
  const label = t(theme === "dark" ? "theme.switchToLight" : "theme.switchToDark");

  return (
    <button
      type="button"
      onClick={() => toggleTheme()}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 ${className}`}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
    </button>
  );
}
