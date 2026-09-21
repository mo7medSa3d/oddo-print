import React from "react";
import { LayoutDashboard, Printer, ClipboardList, Cpu, Settings, X, PanelLeftClose, PanelLeftOpen, ShieldCheck } from "lucide-react";
import { StatusDot } from "../../components/ui";
import type { Page } from "../types";

export interface NavItem {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
}

function StatusLine({ tone, title, detail, pulse }: { tone: "ok" | "bad" | "neutral"; title: string; detail: string; pulse?: boolean; }) {
  return (
    <div className="flex items-center gap-2.5">
      <StatusDot tone={tone} pulse={pulse} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold text-ink">{title}</div>
        <div className="truncate text-[11px] text-ink-3">{detail}</div>
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
  return (
    <aside className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-edge bg-surface shadow-sm transition-all duration-180 ease-out ${collapsed ? "w-[72px]" : "w-[276px]"} ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
      <div className={`flex h-[68px] shrink-0 items-center gap-3 border-b border-edge/80 ${collapsed ? "justify-center px-0" : "px-5"}`}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-brand text-white shadow-sm" aria-hidden="true">
          <Printer className="h-5 w-5" />
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold tracking-[-0.02em] text-ink">Yasser Manager</div>
            <div className="mt-0.5 truncate text-[10.5px] font-medium text-ink-3">Local print operations · v{version || "—"}</div>
          </div>
        )}
        <button onClick={() => { setCollapsed(false); setSidebarOpen(false); }} className="ml-auto rounded-[9px] p-2 text-ink-3 transition hover:bg-surface-2 hover:text-ink lg:hidden" aria-label="Close navigation">
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5" aria-label="Primary">
        {!collapsed && <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-4">Workspace</div>}
        <div className="space-y-1">
          {items.map((item) => {
            const active = page === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => { navigate(item.id); setSidebarOpen(false); }}
                aria-current={active ? "page" : undefined}
                title={collapsed ? item.label : undefined}
                className={`relative flex w-full items-center gap-3 rounded-[10px] text-[13px] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 ${collapsed ? "justify-center px-2 py-3" : "px-3 py-2.5"} ${active ? "bg-brand-subtle font-semibold text-brand shadow-xs before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-full before:bg-brand" : "font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                {!collapsed && <span className="flex-1 text-left">{item.label}</span>}
                {!collapsed && <span className={`text-[10px] font-medium ${active ? "text-brand/65" : "text-ink-4"}`}>{item.desc}</span>}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="shrink-0 border-t border-edge/80 p-3">
        {collapsed ? (
          <div className="flex flex-col items-center gap-3 py-2" aria-label="System status">
            <span title={gatewayConnected ? "Gateway connected" : "Gateway offline"}><StatusDot tone={gatewayConnected ? "ok" : "bad"} pulse={gatewayConnected} /></span>
            <span title={isOnline ? "Agent running" : "Agent stopped"}><StatusDot tone={isOnline ? "ok" : "bad"} pulse={isOnline} /></span>
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="rounded-[12px] border border-edge bg-surface-2 p-3.5 space-y-3">
              <StatusLine tone={gatewayConnected ? "ok" : "bad"} title={gatewayConnected ? "Gateway connected" : gatewayUrl ? "Gateway unavailable" : "Gateway not configured"} detail={gatewayUrl || "Configure a Gateway URL"} pulse={gatewayConnected} />
              <div className="h-px bg-edge" />
              <StatusLine tone={isOnline ? "ok" : "bad"} title={isOnline ? "Agent running" : "Agent stopped"} detail={`v${version || "—"} · ${lastStatusCheck ? new Date(lastStatusCheck).toLocaleTimeString() : "—"}`} pulse={isOnline} />
            </div>
            <div className="flex items-center gap-2 rounded-[10px] border border-ok-edge bg-ok-bg px-3 py-2.5 text-[11px] font-medium text-ok">
              <ShieldCheck className="h-3.5 w-3.5" /> Local execution secured
            </div>
          </div>
        )}
        <button onClick={() => setCollapsed(!collapsed)} className="mt-3 hidden w-full items-center justify-center rounded-[9px] px-2 py-2 text-ink-3 transition hover:bg-surface-2 hover:text-ink lg:inline-flex" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>
    </aside>
  );
}
