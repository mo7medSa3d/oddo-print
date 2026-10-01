"use client";

import { AlertTriangle, LayoutDashboard, LifeBuoy } from "lucide-react";
import { Button, Mono } from "../components/ui";

/**
 * Branded error boundary for the web console.
 * Recovery is deliberately navigation-based so the production gateway
 * does not expose a misleading in-app retry control.
 */
export default function GlobalError({
  error,
  reset: _reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="ambient-surface flex min-h-[calc(100vh-3.5rem)] items-center justify-center py-14">
      <div className="relative z-10 mx-auto w-full max-w-[560px] px-5">
        <div className="card p-7 sm:p-8" role="alert">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-bad-edge bg-bad-bg text-bad">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </div>

          <p className="text-eyebrow mt-5">Unexpected error</p>
          <h1 className="mt-1.5 text-2xl font-[640] tracking-[-0.02em] text-ink">
            This view couldn’t finish loading
          </h1>
          <p className="mt-2 text-base leading-relaxed text-ink-2">
            Agents, printers and queued jobs are unaffected — no print jobs were lost. Return to the
            console and retry the action.
          </p>

          {error?.digest && (
            <div className="mt-4 flex items-center gap-2 rounded-md border border-edge-subtle bg-surface-2 px-3 py-2">
              <span className="label-caps">Reference</span>
              <Mono className="text-ink-2">{error.digest}</Mono>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-2.5">
            <Button variant="primary" href="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />}>
              Back to console
            </Button>
            <Button
              variant="ghost"
              href="/system-health"
              icon={<LifeBuoy className="h-4 w-4" />}
            >
              Check system health
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
