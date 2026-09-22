"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

const THEME_EVENT = "yasser:theme-change";

function emitThemeChange() {
  window.dispatchEvent(new Event(THEME_EVENT));
}

function subscribe(onStoreChange: () => void) {
  window.addEventListener(THEME_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  // Follow the OS until the user makes an explicit choice.
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => {
    if (localStorage.getItem("theme")) return;
    document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    emitThemeChange();
  };
  mq.addEventListener("change", onSchemeChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
    mq.removeEventListener("change", onSchemeChange);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

/**
 * Light/dark switch. The actual theme is applied by a pre-paint script in the
 * root layout (data-theme on <html>); this component flips that attribute,
 * remembers the explicit choice in localStorage, and re-renders from the DOM
 * via useSyncExternalStore (no setState-in-effect, no hydration mismatch).
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* private mode: the attribute still applies for this visit */
    }
    emitThemeChange();
  }

  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-edge/70 bg-surface/70 text-ink-2 shadow-xs transition-all duration-200 hover:border-edge-strong hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 ${className}`}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
    </button>
  );
}
