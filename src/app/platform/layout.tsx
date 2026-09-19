"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Shield, Building2, CreditCard, Activity, LogOut, Cpu, Tags } from "lucide-react";

const NAV_ITEMS = [
  { href: "/platform/dashboard", label: "Dashboard", icon: Activity },
  { href: "/platform/tenants", label: "Tenants", icon: Building2 },
  { href: "/platform/subscriptions", label: "Subscriptions", icon: CreditCard },
  { href: "/platform/plans", label: "Plans", icon: Tags },
  { href: "/platform/audit", label: "System Audit", icon: Shield },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const isLoginPage = pathname === "/platform/login";
  if (isLoginPage) return <>{children}</>;

  async function handleLogout() {
    await fetch("/api/platform/auth/logout", { method: "POST" });
    router.push("/platform/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-6">
            <Link href="/platform/dashboard" className="flex shrink-0 items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-indigo-400/20 bg-indigo-500/10 text-indigo-300">
                <Cpu className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-base font-bold tracking-tight text-white">Yasser</span>
                  <span className="rounded border border-indigo-400/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-indigo-300">
                    Control Plane
                  </span>
                </div>
              </div>
            </Link>

            <nav className="hidden items-center gap-1 md:flex" aria-label="Platform navigation">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition ${
                      active
                        ? "border-indigo-400/20 bg-indigo-500/10 text-indigo-300"
                        : "border-transparent text-slate-400 hover:border-slate-800 hover:bg-slate-900 hover:text-slate-100"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <button
            onClick={handleLogout}
            className="flex shrink-0 items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-red-400/20 hover:bg-red-500/10 hover:text-red-300"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign Out
          </button>
        </div>
      </header>

      <main className="flex-1 bg-slate-950">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
      </main>

      <footer className="border-t border-slate-800 bg-slate-950">
        <div className="mx-auto flex min-h-14 max-w-7xl items-center justify-between gap-4 px-4 py-4 text-xs text-slate-500 sm:px-6 lg:px-8">
          <span>© 2026 Yasser</span>
          <span className="text-slate-600">Platform Control Plane</span>
        </div>
      </footer>
    </div>
  );
}
