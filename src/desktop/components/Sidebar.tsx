import React from "react";
import { X, PanelLeftClose, PanelLeftOpen, ShieldCheck } from "lucide-react";
import { StatusDot } from "../../components/ui";
import { BrandMarkIcon } from "../../components/brand";
import { NavIconFrame } from "../../components/visual-system";
import type { Page } from "../types";
import { useI18n } from "../../i18n/react";

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
        <div className="truncate text-xs font-semibold text-ink">{title}</div>
        <div className="truncate text-xs text-ink-3">{detail}</div>
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
  const asideRef = React.useRef<HTMLElement | null>(null);
  // Mobile drawer keyboard behavior: while open on small screens the drawer
  // acts as a dialog - Escape closes, Tab cycles inside (C048). Desktop
  // widths keep the persistent sidebar.
  React.useEffect(() => {
    if (!sidebarOpen) return;
    if (typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches) return;
    const aside = asideRef.current;
    if (!aside) return;
    aside.setAttribute("role", "dialog");
    aside.setAttribute("aria-modal", "true");
    const previous = document.activeElement as HTMLElement | null;
    aside.querySelector<HTMLElement>("button:not([disabled]), a[href]")?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }
      if (event.key !== "Tab" || !asideRef.current) return;
      const root = asideRef.current;
      const items = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")].filter(
        (el) => el.offsetParent !== null
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!root.contains(document.activeElement)) {
        event.preventDefault();
        firstItem.focus();
      } else if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      aside.removeAttribute("role");
      aside.removeAttribute("aria-modal");
      previous?.focus?.();
    };
  }, [sidebarOpen, setSidebarOpen]);
  return (
    <aside ref={asideRef} className={`tg-desktop-rail fixed inset-y-0 start-0 z-40 lg:inset-y-3 lg:start-3 flex flex-col border-e border-edge bg-surface shadow-sm transition-[width,transform] duration-200 ease-out ${collapsed ? "w-[80px]" : "w-[264px]"} ${sidebarOpen ? "translate-x-0" : "max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"} lg:translate-x-0`}>
      <div className={`flex h-[76px] shrink-0 items-center gap-3 border-b border-edge/80 ${collapsed ? "justify-center px-0" : "px-5"}`}>
        <BrandMarkIcon size="md" className="shrink-0" />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold tracking-[-0.02em] text-ink">{t("desktop.sidebar.productName")}</div>
            <div className="mt-0.5 truncate text-xs font-medium text-ink-3">
              {t("desktop.sidebar.tagline", { version: version || "—" })}
            </div>
          </div>
        )}
        <button onClick={() => { setCollapsed(false); setSidebarOpen(false); }} className="ms-auto inline-flex h-10 w-10 items-center justify-center rounded-sm text-ink-3 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:hidden" aria-label={t("nav.closeNavigation")}>
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-5" aria-label={t("nav.consoleNavigation")}>
        {!collapsed && <div className="tg-sidebar-label px-3 pb-2">{t("nav.section.workspace")}</div>}
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
                title={collapsed ? item.label : undefined}
                className={`sidebar-item tg-nav-item relative flex w-full items-center gap-2 rounded-md text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${collapsed ? "justify-center px-1 py-2.5" : "px-2.5 py-2"} ${active ? "sidebar-item-active font-semibold text-brand" : "font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
              >
                <NavIconFrame active={active}>
                  <Icon className="h-[18px] w-[18px]" />
                </NavIconFrame>
                {!collapsed && <span className="flex-1 truncate text-start">{item.label}</span>}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="shrink-0 border-t border-edge/80 p-3">
        {collapsed ? (
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
              <ShieldCheck className="h-3.5 w-3.5" /> {t("desktop.sidebar.localSecured")}
            </div>
          </div>
        )}
        <button onClick={() => setCollapsed(!collapsed)} className="mt-3 hidden min-h-10 w-full items-center justify-center rounded-sm px-2 py-2 text-ink-3 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 lg:inline-flex" aria-label={collapsed ? t("nav.expandNavigation") : t("nav.collapseNavigation")}>
          {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>
    </aside>
  );
}
