import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Printer,
  ShieldCheck,
  Activity,
  Globe,
  Cpu,
  Cloud,
  Server,
  Network,
  Zap,
  Lock,
  RefreshCw,
  CheckCircle2,
} from "lucide-react";

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
            A managed print gateway for branches, agents, printers, queues and Odoo
            integrations. Keep business truth in Odoo while the Gateway handles durable,
            retry-safe runtime delivery — with no browser print dialogs.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/signup" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-95 focusable">
              Start a trial <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/pricing" className="inline-flex items-center justify-center rounded-lg border border-edge bg-surface px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 focusable">
              View pricing
            </Link>
            <Link href="/login" className="inline-flex items-center justify-center rounded-lg border border-edge bg-surface px-5 py-3 text-sm font-semibold text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focusable">
              Sign in
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-medium text-ink-3">
            <TrustPoint>Silent printing — no browser dialogs</TrustPoint>
            <TrustPoint>Idempotent, at-least-once delivery</TrustPoint>
            <TrustPoint>Multi-tenant isolation</TrustPoint>
            <TrustPoint>Native Windows service</TrustPoint>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="w-full bg-app">
        <div className="mx-auto max-w-[1440px] px-4 py-16 sm:px-6 md:py-20">
          <div className="mb-10 text-center">
            <p className="label-caps">How it works</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink">A single durable path from document to paper</h2>
            <p className="mx-auto mt-2 max-w-2xl text-sm text-ink-3">
              Every job is committed durably, claimed atomically and delivered over a persistent
              WebSocket with a polling fallback — so a print never silently disappears.
            </p>
          </div>
          <ol className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StepCard step={1} icon={<Cloud className="h-5 w-5" />} title="Odoo intent" description="A report or POS receipt is intercepted in Odoo and sent to the Gateway with an idempotency key — never to a browser dialog." />
            <StepCard step={2} icon={<Server className="h-5 w-5" />} title="Gateway commit" description="The Gateway validates the payload, enforces tenant scope and commits a durable job in PostgreSQL." />
            <StepCard step={3} icon={<Network className="h-5 w-5" />} title="Agent delivery" description="The job is claimed atomically and pushed to the paired agent over WebSocket, with reconnect-safe polling as a backstop." />
            <StepCard step={4} icon={<Printer className="h-5 w-5" />} title="Physical print" description="The Windows agent renders and submits via Spooler / RAW TCP / IPP, then reports the real physical outcome." />
          </ol>
        </div>
      </section>

      {/* Platform features */}
      <section className="w-full border-t border-edge bg-surface">
        <div className="mx-auto max-w-[1440px] px-4 py-16 sm:px-6 md:py-20">
          <div className="mb-10 text-center">
            <p className="label-caps">Platform</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink">Production print architecture</h2>
            <p className="mt-2 text-sm text-ink-3">Odoo → Gateway → PostgreSQL → Windows Agent → Printer</p>
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            <FeatureCard icon={<ShieldCheck className="h-5 w-5" />} title="Secure customer access" description="Email/password accounts, server-side sessions, tenant membership and role-based permissions." />
            <FeatureCard icon={<Activity className="h-5 w-5" />} title="Retry-safe delivery" description="Atomic claims, leases, idempotency and reconnect-safe WebSocket plus polling delivery." />
            <FeatureCard icon={<Globe className="h-5 w-5" />} title="Multi-branch routing" description="Branch-aware Odoo routing with tenant-scoped agents, printers and print jobs." />
            <FeatureCard icon={<Cpu className="h-5 w-5" />} title="Native Windows agent" description="Go Windows service with local persistence and bounded print queues." />
            <FeatureCard icon={<Printer className="h-5 w-5" />} title="Real printer transports" description="Windows Spooler, RAW TCP and other supported printer transports without browser dialogs." />
            <FeatureCard icon={<RefreshCw className="h-5 w-5" />} title="Commercial controls" description="Plans, subscriptions, server-side entitlements and Stripe-managed billing state." />
          </div>
        </div>
      </section>

      {/* Reliability & security */}
      <section className="w-full bg-app">
        <div className="mx-auto max-w-[1440px] px-4 py-16 sm:px-6 md:py-20">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="card brand-hairline p-7">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
                <Zap className="h-5 w-5" aria-hidden />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-ink">Built for reliability</h3>
              <ul className="mt-4 space-y-3">
                <CheckItem>Durable job commit before any delivery attempt</CheckItem>
                <CheckItem>Atomic claim and lease fencing prevent double delivery</CheckItem>
                <CheckItem>Crash recovery never guesses an unknown physical outcome</CheckItem>
                <CheckItem>Bounded local queue with idempotent retries</CheckItem>
              </ul>
            </div>
            <div className="card brand-hairline p-7">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
                <Lock className="h-5 w-5" aria-hidden />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-ink">Secure by design</h3>
              <ul className="mt-4 space-y-3">
                <CheckItem>Per-tenant isolation across agents, printers and jobs</CheckItem>
                <CheckItem>Installation-scoped Odoo API keys, stored only as hashes</CheckItem>
                <CheckItem>Signed agent identity with one-time pairing codes</CheckItem>
                <CheckItem>Payload validation and SSRF-safe printer addressing</CheckItem>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="w-full border-t border-edge bg-surface">
        <div className="mx-auto max-w-[1440px] px-4 py-16 text-center sm:px-6 md:py-20">
          <h2 className="mx-auto max-w-2xl text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Start printing from Odoo in minutes.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
            Create an account, pair a Windows agent, and route your first branch — no browser
            print dialogs, no manual re-printing.
          </p>
          <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/signup" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-95 focusable">
              Start a trial <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <Link href="/pricing" className="inline-flex items-center justify-center rounded-lg border border-edge bg-surface px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 focusable">
              Compare plans
            </Link>
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

function TrustPoint({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <CheckCircle2 className="h-3.5 w-3.5 text-brand" aria-hidden />
      {children}
    </span>
  );
}

function StepCard({
  step,
  icon,
  title,
  description,
}: {
  step: number;
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <li className="card card-interactive relative p-6">
      <span className="absolute right-5 top-5 text-2xl font-bold tabular-nums text-surface-3" aria-hidden>
        {step.toString().padStart(2, "0")}
      </span>
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-edge-accent bg-brand-subtle text-brand">
        {icon}
      </div>
      <h3 className="mt-4 text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{description}</p>
    </li>
  );
}

function CheckItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-ink-2">
      <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" aria-hidden />
      <span>{children}</span>
    </li>
  );
}
