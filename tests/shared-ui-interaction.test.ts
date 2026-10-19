// @vitest-environment jsdom
import { act, createElement as h, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type CommandItem } from "../src/components/CommandPalette";
import { ThemeToggle } from "../src/components/ThemeToggle";
import { Menu, Modal } from "../src/components/ui";
import { I18nProvider, useI18n, type I18nValue } from "../src/i18n/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

let roots: Root[] = [];
let restoreLocale: I18nValue["setLocale"] | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  localStorage.clear();
  document.cookie = "yaseir_locale=en; path=/";
  document.documentElement.dataset.theme = "light";
});

afterEach(() => {
  // Restore persistence before clearing the provider's private-mode fallback.
  vi.restoreAllMocks();
  if (restoreLocale) act(() => restoreLocale?.("en"));
  restoreLocale = null;
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  localStorage.clear();
  document.cookie = "yaseir_locale=en; path=/";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return root;
}

function key(target: Element, value: string) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
}

function LocaleProbe() {
  const { locale, setLocale } = useI18n();
  useEffect(() => {
    restoreLocale = setLocale;
    return () => { restoreLocale = null; };
  }, [setLocale]);
  return h("button", { id: "locale-choice", onClick: () => setLocale("en") }, locale);
}

describe("shared shell interactions", () => {
  it("executes the highlighted command when groups are interleaved", () => {
    const first = vi.fn();
    const otherGroup = vi.fn();
    const second = vi.fn();
    const items: CommandItem[] = [
      { id: "a1", label: "First A", group: "A", onSelect: first },
      { id: "b1", label: "First B", group: "B", onSelect: otherGroup },
      { id: "a2", label: "Second A", group: "A", onSelect: second },
    ];
    render(h(CommandPalette, { open: true, onClose: vi.fn(), items }));
    const input = document.querySelector('[role="combobox"]')!;
    key(input, "ArrowDown");
    const selected = document.querySelector('[role="option"][aria-selected="true"]')!;
    expect(selected.textContent).toContain("Second A");
    key(input, "Enter");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(otherGroup).not.toHaveBeenCalled();
  });

  it("keeps selection valid when permissions shrink the open command list", () => {
    const first = vi.fn();
    const items: CommandItem[] = [
      { id: "a", label: "First", group: "__proto__", onSelect: first },
      { id: "b", label: "Second", group: "Other" },
      { id: "c", label: "Third", group: "Other" },
    ];
    const root = render(h(CommandPalette, { open: true, onClose: vi.fn(), items }));
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    act(() => root.render(h(CommandPalette, { open: true, onClose: vi.fn(), items: items.slice(0, 1) })));
    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
    expect(active?.textContent).toContain("First");
    expect(document.querySelector<HTMLButtonElement>('[role="option"]')?.tabIndex).toBe(-1);
    act(() => input.focus());
    expect(key(input, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    key(input, "Enter");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps the chosen locale when storage writes fail (reads blocked=%s)", (blockReads) => {
    localStorage.setItem("yaseir:locale", "ar");
    document.cookie = "yaseir_locale=ar; path=/";
    if (blockReads) vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    render(h(I18nProvider, { initialLocale: "ar", children: h(LocaleProbe) }));
    const choice = document.getElementById("locale-choice") as HTMLButtonElement;
    expect(choice.textContent).toBe("ar");
    act(() => choice.click());
    expect(choice.textContent).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.cookie).toContain("yaseir_locale=en");
  });

  it("applies theme changes and clearing from another tab to the DOM and accessible label", () => {
    render(h(ThemeToggle));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "theme", newValue: "dark" })));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.querySelector("button")?.getAttribute("aria-label")).toBe("Switch to light mode");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "light" })));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("dismisses a focused menu on Escape while retaining its parent dialog", () => {
    const onClose = vi.fn();
    render(h(Modal, {
      open: true, title: "Parent", onClose,
      children: h(Menu, {
        label: "Actions", trigger: "Actions", items: [{ key: "one", label: "One", onSelect: vi.fn() }],
      }),
    }));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Actions"]')!;
    act(() => trigger.click());
    act(() => vi.advanceTimersByTime(20));
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    act(() => item.focus());
    key(item, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
