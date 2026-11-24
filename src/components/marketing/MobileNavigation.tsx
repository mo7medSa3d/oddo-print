"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { ThemeToggle } from "../ThemeToggle";

type NavEntry = { href: string; label: string };

export function MobileNavigation({
  items,
  menuLabel,
  closeLabel,
  languageLabel,
}: {
  items: NavEntry[];
  menuLabel: string;
  closeLabel: string;
  languageLabel: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia("(min-width: 1280px)");
    const closeMenu = () => setOpen(false);
    const onMedia = (e: MediaQueryListEvent) => {
      if (e.matches) closeMenu();
    };
    media.addEventListener("change", onMedia);
    window.addEventListener("yaseir:locale-navigation", closeMenu);
    return () => {
      media.removeEventListener("change", onMedia);
      window.removeEventListener("yaseir:locale-navigation", closeMenu);
    };
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={menuLabel}
          className="yw-mobile-nav-trigger inline-flex h-11 w-11 items-center justify-center rounded-full border border-edge bg-surface/80 text-ink backdrop-blur-md transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand xl:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="yw-nav-overlay fixed inset-0 z-[90] bg-ink/20 backdrop-blur-sm xl:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="yw-nav-panel glass-card fixed end-3 top-[calc(56px+env(safe-area-inset-top)+10px)] z-[91] w-[min(300px,calc(100vw-24px))] overflow-y-auto p-4 text-ink shadow-xl outline-none lg:top-[calc(64px+env(safe-area-inset-top)+10px)] xl:hidden"
        >
          <div className="flex items-center justify-between gap-3 border-b border-edge-subtle pb-3">
            <Dialog.Title className="text-sm font-semibold text-ink">{menuLabel}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={closeLabel}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <nav aria-label={menuLabel} className="py-2">
            <ul className="space-y-1">
              {items.map(({ href, label }) => (
                <li key={href}>
                  <Dialog.Close asChild>
                    {href.startsWith("#") ? (
                      <a href={href} className="yw-mobile-nav-link">{label}</a>
                    ) : (
                      <Link href={href} className="yw-mobile-nav-link">{label}</Link>
                    )}
                  </Dialog.Close>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex min-h-11 items-center justify-between border-t border-edge-subtle pt-3">
            <span className="text-xs font-medium text-ink-3">{languageLabel}</span>
            <div className="flex items-center gap-2">
              <LanguageSwitcher compact />
              <ThemeToggle />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
