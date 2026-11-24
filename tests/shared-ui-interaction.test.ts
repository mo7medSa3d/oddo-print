// @vitest-environment jsdom
import { act, createElement as h, Fragment, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette, type CommandItem } from "../src/components/CommandPalette";
import { ThemeToggle } from "../src/components/ThemeToggle";
import { LanguageSwitcher } from "../src/components/LanguageSwitcher";
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

  it("switches mobile language inside a dialog without an inaccessible portaled menu", () => {
    const navigation = vi.fn();
    window.addEventListener("yaseir:locale-navigation", navigation);
    try {
      render(h(I18nProvider, {
        initialLocale: "en",
        children: h(Modal, {
          open: true,
          title: "Mobile navigation",
          onClose: vi.fn(),
          children: h(LanguageSwitcher),
        }),
      }));
      const toggle = document.querySelector<HTMLButtonElement>("[data-mobile-language-toggle]");
      expect(toggle).not.toBeNull();
      expect(toggle?.closest('[role="dialog"]')).not.toBeNull();
      expect(toggle?.getAttribute("aria-label")).toContain("العربية");
      expect(toggle?.getAttribute("class")).toContain("lg:hidden");
      act(() => toggle?.click());
      expect(localStorage.getItem("yaseir:locale")).toBe("ar");
      expect(document.cookie).toContain("yaseir_locale=ar");
      expect(document.documentElement.dir).toBe("rtl");
      expect(toggle?.textContent).toContain("EN");
      expect(document.querySelector('[role="menu"]')).toBeNull();

      act(() => toggle?.click());
      expect(localStorage.getItem("yaseir:locale")).toBe("en");
      expect(document.documentElement.dir).toBe("ltr");
      expect(navigation).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("yaseir:locale-navigation", navigation);
    }
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
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
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

  it.each([false, true])("keeps a live focus origin when leaving a menu with Tab (reverse=%s)", (shiftKey) => {
    render(h(Menu, {
      label: "Actions", trigger: "Actions", items: [{ key: "one", label: "One", onSelect: vi.fn() }],
    }));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => trigger.click());
    act(() => vi.advanceTimersByTime(20));
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    act(() => item.focus());
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    act(() => { item.dispatchEvent(event); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    // The browser continues its normal Tab order from the trigger, not from
    // a removed portaled item at the end of document.body.
    expect(document.activeElement).toBe(trigger);
  });

  it("restores the menu opener after an action dialog closes", () => {
    function Actions() {
      const [open, setOpen] = useState(false);
      return h(Fragment, null,
        h(Menu, { label: "Actions", trigger: "Actions", items: [{ key: "edit", label: "Edit", onSelect: () => setOpen(true) }] }),
        h(Modal, { open, title: "Edit device", onClose: () => setOpen(false), children: "Device settings" }),
      );
    }
    render(h(Actions));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => trigger.click());
    act(() => vi.advanceTimersByTime(20));
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    act(() => item.focus());
    act(() => item.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    key(dialog, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps reverse keyboard navigation inside a newly opened dialog", () => {
    render(h(Modal, {
      open: true, title: "Device details", onClose: vi.fn(),
      children: h("button", { id: "last-dialog-action", type: "button" }, "Done"),
    }));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    act(() => { dialog.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("last-dialog-action");
  });

  it("lets the keyboard focus informational dialog content and return to its close action", () => {
    render(h(Modal, {
      open: true, title: "Print operation details", onClose: vi.fn(),
      children: h("p", null, "A long operation history with no interactive controls."),
    }));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const region = dialog.querySelector<HTMLElement>('[role="region"][aria-label="Print operation details"]')!;
    const reverseTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    act(() => { dialog.dispatchEvent(reverseTab); });
    expect(document.activeElement).toBe(region);
    expect(reverseTab.defaultPrevented).toBe(true);
    expect(key(region, "Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog.querySelector("button"));
  });

  it("excludes hidden controls and disabled fieldsets from the dialog focus loop", () => {
    render(h(Modal, {
      open: true, title: "Device details", onClose: vi.fn(),
      children: h("div", null,
        h("button", { id: "last-visible-action", type: "button" }, "Done"),
        h("div", { style: { display: "none" } }, h("button", { id: "hidden-action" }, "Hidden")),
        h("fieldset", { disabled: true }, h("input", { id: "disabled-fieldset-input" })),
      ),
    }));
    const first = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
    act(() => first.focus());
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    act(() => { first.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("last-visible-action");
  });
});
