"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, Menu, X } from "lucide-react";

type NavEntry = { href: string; label: string };
export function MobileNavigation({
  items, menuLabel, closeLabel, title, actionLabel,
}: {
  items: NavEntry[];
  menuLabel: string;
  closeLabel: string;
  title: string;
  actionLabel: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" aria-label={menuLabel}
          className="yw-mobile-nav-trigger inline-flex h-11 w-11 items-center justify-center rounded-xl border border-edge bg-surface text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand md:hidden">
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="yw-nav-overlay fixed inset-0 z-[90] bg-black/45 backdrop-blur-[3px]" />
        <Dialog.Content aria-describedby={undefined}
          className="yw-nav-panel fixed inset-y-0 end-0 z-[91] flex w-[min(360px,88vw)] flex-col border-s border-edge bg-surface p-5 shadow-2xl outline-none md:hidden">
          <div className="flex items-center justify-between gap-3 border-b border-edge pb-5">
            <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label={closeLabel}
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-edge text-ink-2 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand">
                <X className="h-5 w-5" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <nav aria-label={menuLabel} className="min-h-0 flex-1 overflow-y-auto py-5">
            <ul className="space-y-2">
              {items.map(({ href, label }) => (
                <li key={href}>
                  <Dialog.Close asChild>
                    {href.startsWith("#")
                      ? <a href={href} className="yw-mobile-nav-link">{label}<ArrowUpRight className="h-4 w-4" aria-hidden /></a>
                      : <Link href={href} className="yw-mobile-nav-link">{label}<ArrowUpRight className="h-4 w-4" aria-hidden /></Link>}
                  </Dialog.Close>
                </li>
              ))}
            </ul>
          </nav>
          <Dialog.Close asChild>
            <Link href="/signup" className="yw-mobile-nav-cta">{actionLabel}<ArrowUpRight className="h-4 w-4" aria-hidden /></Link>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
