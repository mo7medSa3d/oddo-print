import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Printer, ShieldCheck, Activity, Globe, Cpu } from "lucide-react";

export const dynamic = "force-static";

export default function Home() {
  return (
    <div className="flex flex-col items-center">
      <section className="w-full border-b border-edge bg-surface">
        <div className="mx-auto max-w-[1440px] px-4 py-16 text-center sm:px-6 md:py-24">
          <div className="mx-auto inline-flex rounded-full border border-edge-accent bg-brand-subtle px-3 py-1 text-xs font-semibold text-brand-subtle-text">
            Odoo 19 · Cloud print operations
          </div>
          <h1 className="mx-auto mt-5 max-w-3xl text-3xl font-extrabold leading-tight tracking-tight text-ink sm:text-4xl md:text-5xl">
            Reliable printing from Odoo to your physical printers.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-ink-2 sm:text-lg">
            A managed print gateway for branches, agents, printers, queues and Odoo integrations. Keep business truth in Odoo while the Gateway manages runtime delivery.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/signup" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-95">
              Start a trial <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/pricing" className="inline-flex items-center justify-center rounded-lg border border-edge bg-surface px-5 py-3 text-sm font-semibold text-ink hover:bg-surface-2">
              View pricing
            </Link>
            <Link href="/login" className="inline-flex items-center justify-center rounded-lg border border-edge bg-surface px-5 py-3 text-sm font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink">
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <section className="w-full bg-app">
        <div className="mx-auto max-w-[1440px] px-4 py-16 sm:px-6 md:py-20">
          <div className="mb-10 text-center">
            <h2 className="text-2xl font-bold tracking-tight text-ink">Production print architecture</h2>
            <p className="mt-2 text-sm text-ink-3">Odoo → Gateway → PostgreSQL → Windows Agent → Printer</p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            <FeatureCard icon={<ShieldCheck className="h-5 w-5" />} title="Secure customer access" description="Email/password accounts, server-side sessions, tenant membership and role-based permissions." />
            <FeatureCard icon={<Activity className="h-5 w-5" />} title="Retry-safe delivery" description="Atomic claims, leases, idempotency and reconnect-safe WebSocket plus polling delivery." />
            <FeatureCard icon={<Globe className="h-5 w-5" />} title="Multi-branch routing" description="Branch-aware Odoo routing with tenant-scoped agents, printers and print jobs." />
            <FeatureCard icon={<Cpu className="h-5 w-5" />} title="Native Windows agent" description="Go Windows service with local persistence and bounded print workers." />
            <FeatureCard icon={<Printer className="h-5 w-5" />} title="Real printer transports" description="Windows Spooler, RAW TCP and other supported printer transports without browser dialogs." />
            <FeatureCard icon={<ArrowRight className="h-5 w-5" />} title="Commercial controls" description="Plans, subscriptions, server-side entitlements and Stripe-managed billing state." />
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="card card-interactive p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">{icon}</div>
      <h3 className="mt-4 text-[16px] font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{description}</p>
    </div>
  );
}
