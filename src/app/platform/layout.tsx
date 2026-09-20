"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Shield, Building2, CreditCard, Activity, LogOut, Cpu, Tags, PanelLeftClose, PanelLeftOpen, Menu, X } from "lucide-react";

const NAV_ITEMS = [
  { href: "/platform/dashboard", label: "Overview", icon: Activity, desc: "Metrics & health" },
  { href: "/platform/tenants", label: "Tenants", icon: Building2, desc: "Workspaces & lifecycle" },
  { href: "/platform/subscriptions", label: "Subscriptions", icon: CreditCard, desc: "Billing states" },
  { href: "/platform/plans", label: "Plans", icon: Tags, desc: "Catalog & entitlements" },
  { href: "/platform/audit", label: "Audit", icon: Shield, desc: "System events" },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const isLoginPage = pathname === "/platform/login";
  if (isLoginPage) return <>{children}</>;

  async function handleLogout() {
    await fetch("/api/platform/auth/logout", { method: "POST" });
    router.push("/platform/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-[#080a12] text-slate-100 flex font-sans selection:bg-indigo-500/20">
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />}

      <aside className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-white/[0.06] bg-[#0c0e1a] transition-all duration-200 ${collapsed ? "w-[72px]" : "w-[280px]"} ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        <div className={`flex h-[64px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 ${collapsed ? "justify-center px-0" : ""}`}>
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white text-slate-900 shadow-sm">
            <Cpu className="h-5 w-5" />
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-bold tracking-tight text-white">Yasser</span>
                <span className="rounded-full border border-indigo-400/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-300">Control Plane</span>
              </div>
              <div className="text-[11px] text-slate-500">Enterprise control plane</div>
            </div>
          )}
          <button onClick={() => setMobileOpen(false)} className="ml-auto rounded-lg p-2 text-slate-500 hover:bg-white/[0.06] lg:hidden"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-5">
          {!collapsed && <div className="mb-3 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Operations</div>}
          <nav className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href;
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)} className={`group relative flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13px] font-medium transition ${collapsed ? "justify-center" : ""} ${active ? "bg-white/[0.08] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"}`}>
                  {active && !collapsed && <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full bg-indigo-400" />}
                  <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-white" : "text-slate-500 group-hover:text-slate-300"}`} />
                  {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                </Link>
              );
            })}
          </nav>

          {!collapsed && (
            <div className="mt-8 rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">System health</div>
              <div className="mt-3 flex items-center gap-2 text-[12px] text-slate-400"><span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> Control plane live</div>
              <div className="mt-2 text-[11px] text-slate-500">Tenant isolation enforced • Audit active</div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-white/[0.06] p-3">
          {!collapsed ? (
            <div className="space-y-2">
              <button onClick={handleLogout} className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] font-medium text-slate-400 hover:bg-white/[0.04] hover:text-slate-200">
                <LogOut className="h-4 w-4" /> Sign out
              </button>
              <button onClick={() => setCollapsed(!collapsed)} className="hidden w-full items-center justify-center rounded-[8px] p-2 text-slate-500 hover:bg-white/[0.04] hover:text-slate-300 lg:flex"><PanelLeftClose className="h-4 w-4" /></button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <button onClick={handleLogout} className="flex h-9 w-9 items-center justify-center rounded-[10px] text-slate-500 hover:bg-white/[0.04] hover:text-slate-200"><LogOut className="h-4 w-4" /></button>
              <button onClick={() => setCollapsed(!collapsed)} className="hidden h-9 w-9 items-center justify-center rounded-[8px] text-slate-500 hover:bg-white/[0.04] hover:text-slate-300 lg:flex"><PanelLeftOpen className="h-4 w-4" /></button>
            </div>
          )}
        </div>
      </aside>

      <div className={`flex min-h-screen flex-1 flex-col transition-[padding] duration-200 ${collapsed ? "lg:pl-[72px]" : "lg:pl-[280px]"}`}>
        <header className="sticky top-0 z-20 flex h-[64px] items-center gap-3 border-b border-white/[0.06] bg-[#080a12]/80 px-4 backdrop-blur-xl sm:px-6">
          <button onClick={() => setMobileOpen(true)} className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-white/[0.06] bg-white/[0.04] text-slate-400 hover:bg-white/[0.06] lg:hidden"><Menu className="h-5 w-5" /></button>
          <div className="hidden items-center gap-2 text-[12px] text-slate-500 sm:flex">
            <span className="h-4 w-px bg-white/[0.06]" />
            <span>Platform Admin • Control Plane • Risk • Billing • Tenants • System Health</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-slate-400 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Operational
            </span>
          </div>
        </header>

        <main className="flex-1 bg-[#080a12]">
          <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
        </main>

        <footer className="border-t border-white/[0.06] bg-[#0c0e1a]/50 px-6 py-4">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between text-[11px] text-slate-500">
            <span>© 2026 Yasser • Platform Control Plane</span>
            <span className="hidden sm:inline">Secure • Isolated • Audited</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
