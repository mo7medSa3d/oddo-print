"use client";

import { useEffect, useState } from "react";

type TimelineEvent = {
  id: string;
  stage: string;
  status: string;
  at?: string;
  message?: string;
  errorCode?: string;
  attemptId?: string;
  claimId?: string;
  spoolerJobId?: string;
  agentId?: string;
  printerId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

function stageColor(status: string) {
  switch (status) {
    case "ok": return "bg-ok-bg text-ok border-ok-edge";
    case "error": return "bg-bad-bg text-bad border-bad-edge";
    case "blocked": return "bg-amber-50 text-amber-700 border-amber-200";
    case "pending": return "bg-zinc-100 text-zinc-600 border-zinc-200";
    default: return "bg-zinc-100 text-zinc-600";
  }
}

export default function JobTimeline({ jobId }: { jobId: string }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correlation, setCorrelation] = useState<any>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/jobs/${jobId}/timeline`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setEvents(data.timeline ?? []);
        setCorrelation(data.correlation ?? null);
      } catch (e: any) {
        setError(e.message ?? "Failed");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [jobId]);

  if (loading) return <div className="text-xs text-ink-3">Loading timeline…</div>;
  if (error) return <div className="text-xs text-bad">Failed: {error}</div>;
  if (!events || events.length === 0) return <div className="text-xs text-ink-3">No timeline events yet.</div>;

  return (
    <div className="space-y-3">
      {correlation && (
        <div className="rounded-lg bg-zinc-50 p-3 text-[11px] font-mono">
          <div className="font-semibold">Correlation IDs</div>
          <div className="mt-1 grid grid-cols-2 gap-1 text-zinc-600">
            {Object.entries(correlation).map(([k, v]) => v ? <div key={k}><span className="font-bold">{k}:</span> {String(v).slice(0, 32)}</div> : null)}
          </div>
        </div>
      )}
      <div className="relative pl-6">
        <div className="absolute left-2 top-0 bottom-0 w-px bg-edge" />
        {events.map((ev, idx) => (
          <div key={ev.id} className="relative mb-4">
            <div className={`absolute -left-6 top-1 h-3 w-3 rounded-full border ${stageColor(ev.status)}`} />
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">{ev.stage}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${stageColor(ev.status)}`}>{ev.status.toUpperCase()}</span>
              {ev.at && <span className="text-[10px] text-zinc-400">{new Date(ev.at).toLocaleTimeString()}</span>}
            </div>
            {ev.message && <div className="mt-1 text-[12px] text-ink-2">{ev.message}</div>}
            <div className="mt-1 flex flex-wrap gap-2 text-[10px] font-mono text-zinc-500">
              {ev.attemptId && <span>attempt:{ev.attemptId.slice(0,12)}</span>}
              {ev.claimId && <span>claim:{ev.claimId.slice(0,8)}…</span>}
              {ev.spoolerJobId && <span className="font-bold text-ink">spooler:{ev.spoolerJobId}</span>}
              {ev.requestId && <span>req:{ev.requestId.slice(0,12)}</span>}
            </div>
            {ev.metadata && Object.keys(ev.metadata).length > 0 && (
              <pre className="mt-1 max-h-20 overflow-auto rounded bg-zinc-50 p-2 text-[10px]">{JSON.stringify(ev.metadata, null, 2)}</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
