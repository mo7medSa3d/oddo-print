import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, PanelLeftClose, PanelLeftOpen, ShieldCheck } from "lucide-react";
import { StatusDot } from "../../components/ui";
import { BrandMarkIcon } from "../../components/brand";
import { NavIconFrame } from "../../components/visual-system";
import type { Page } from "../types";
import { useI18n } from "../../i18n/react";

// A rail can be icon-only on desktop, but a phone-width drawer must never
// inherit that state: it would hide all navigation labels. Subscribe to a
// media query instead of reading window.innerWidth only once (resize/zoom).
const NARROW_NAV_QUERY = "(max-width: 1023px)";

function subscribeNarrowNavigation(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(NARROW_NAV_QUERY);
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  // Support older Windows WebView2 builds using the legacy event API.
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

function isNarrowNavigation(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_NAV_QUERY).matches : false;
}

export interface NavItem {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function StatusLine({ tone, title, detail, pulse }: { tone: "ok" | "bad" | "neutral"; title: string; detail: string; pulse?: boolean; }) {
  return (
    <div className="flex items-center gap-2.5">
      <StatusDot tone={tone} pulse={pulse} />
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-semibold leading-normal text-ink">{title}</div>
        <div className="mt-0.5 truncate text-xs text-ink-3" title={detail}>{detail}</div>
      </div>
    </div>
  );
}

export function Sidebar({
  page, navigate, items, collapsed, setCollapsed, sidebarOpen, setSidebarOpen,
  gatewayConnected, gatewayUrl, isOnline, version, lastStatusCheck,
}: {
  page: Page; navigate: (p: Page) => void; items: NavItem[]; collapsed: boolean; setCollapsed: (v: boolean) => void;
  sidebarOpen: boolean; setSidebarOpen: (v: boolean) => void; gatewayConnected: boolean; gatewayUrl: string;
  isOnline: boolean; version: string; lastStatusCheck: string | null;
}) {
  const { t, formatTime } = useI18n();
  const isNarrow = React.useSyncExternalStore(subscribeNarrowNavigation, isNarrowNavigation, () => false);
  const compact = collapsed && !isNarrow;
  const renderAside = () => (
    <aside id={isNarrow ? "desktop-mobile-nav" : undefined} tabIndex={-1} className={`tg-desktop-rail fixed inset-y-0 start-0 z-40 flex w-[min(320px,90vw)] flex-col border-e border-edge bg-surface shadow-sm transition-[width,transform] duration-200 ease-out lg:inset-y-3 lg:start-3 ${compact ? "lg:w-[var(--sidebar-collapsed)]" : "lg:w-[var(--sidebar-width)]"} ${sidebarOpen ? "translate-x-0" : "max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"} lg:translate-x-0`}>
      {isNarrow && <Dialog.Title className="sr-only">{t("nav.consoleNavigation")}</Dialog.Title>}
      <div className={`flex min-h-16 shrink-0 items-center gap-3 border-b border-edge/80 py-3 ${compact ? "justify-center px-0" : "px-5"}`}>
        <BrandMarkIcon size="md" className="shrink-0" />
        {!compact && (
          <div className="min-w-0 flex-1">
            <div className="break-words text-base font-semibold leading-snug tracking-[-0.02em] text-ink">{t("desktop.sidebar.productName")}</div>
            <div className="mt-1 break-words text-xs font-medium leading-normal text-ink-3">
              {t("desktop.sidebar.tagline", { version: version || "—" })}
            </div>
          </div>
        )}
        <button onClick={() => { setCollapsed(false); setSidebarOpen(false); }} className="ms-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-ink-3 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden" aria-label={t("nav.closeNavigation")}>
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-5" aria-label={t("nav.consoleNavigation")}>
        {!compact && <div className="tg-sidebar-label px-3 pb-2">{t("nav.section.workspace")}</div>}
        <div className="space-y-1">
          {items.map((item) => {
            const active = page === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => { navigate(item.id); setSidebarOpen(false); }}
                aria-current={active ? "page" : undefined}
                data-active={active}
                title={compact ? item.label : undefined}
                className={`sidebar-item tg-nav-item relative flex min-h-12 w-full items-center gap-3 rounded-md text-base leading-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${compact ? "justify-center px-1 py-2.5" : "px-3 py-2.5"} ${active ? "sidebar-item-active font-semibold text-brand" : "font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
              >
                <NavIconFrame active={active}>
                  <Icon className="h-[18px] w-[18px]" />
                </NavIconFrame>
                {!compact && <span className="min-w-0 flex-1 break-words text-start">{item.label}</span>}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="shrink-0 border-t border-edge/80 p-3">
        {compact ? (
          <div className="flex flex-col items-center gap-3 py-2" aria-label={t("desktop.sidebar.systemStatus")}>
            <span title={gatewayConnected ? t("desktop.status.gatewayConnected") : t("desktop.status.gatewayOffline")}><StatusDot tone={gatewayConnected ? "ok" : "bad"} pulse={gatewayConnected} /></span>
            <span title={isOnline ? t("desktop.status.agentRunning") : t("desktop.status.agentStopped")}><StatusDot tone={isOnline ? "ok" : "bad"} pulse={isOnline} /></span>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="space-y-3 rounded-md border border-edge bg-surface-2 p-3.5">
              <StatusLine tone={gatewayConnected ? "ok" : "bad"} title={gatewayConnected ? t("desktop.status.gatewayConnected") : gatewayUrl ? t("desktop.status.gatewayUnavailable") : t("desktop.status.gatewayNotConfigured")} detail={gatewayUrl || t("desktop.status.configureGatewayUrl")} pulse={gatewayConnected} />
              <div className="h-px bg-edge" />
              <StatusLine tone={isOnline ? "ok" : "bad"} title={isOnline ? t("desktop.status.agentRunning") : t("desktop.status.agentStopped")} detail={`v${version || "—"} · ${lastStatusCheck ? formatTime(lastStatusCheck) : "—"}`} pulse={isOnline} />
            </div>
            <div className="flex items-center gap-2 rounded-md border border-ok-edge bg-ok-bg px-3 py-2.5 text-xs font-medium text-ok">
              <ShieldCheck className="h-4 w-4 shrink-0" /> {t("desktop.sidebar.localSecured")}
            </div>
          </div>
        )}
        <button onClick={() => setCollapsed(!compact)} className="mt-3 hidden min-h-11 w-full items-center justify-center rounded-sm px-2 py-2 text-ink-3 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:inline-flex" aria-label={compact ? t("nav.expandNavigation") : t("nav.collapseNavigation")}>
          {compact ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>
    </aside>
  );

  // A portal-based Radix Dialog handles focus trapping, Escape, modality,
  // scroll locking and return focus on narrow Windows WebView layouts.
  // The persistent large-screen rail stays a plain semantic aside.
  if (!isNarrow) return renderAside();
  return (
    <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="pg-fade-in fixed inset-0 z-30 bg-black/40 lg:hidden" />
        <Dialog.Content asChild aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const trigger = document.querySelector<HTMLButtonElement>('[aria-controls="desktop-mobile-nav"]');
            if (trigger) { event.preventDefault(); trigger.focus(); }
          }}>
          {renderAside()}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
