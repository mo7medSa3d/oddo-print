"use client";

import { useState } from "react";

type StepStatus = "ok" | "error" | "blocked" | "pending" | "running";
type CertificationStep = {
  id: string;
  label: string;
  description: string;
  status: StepStatus;
  at?: string | null;
  message?: string;
  evidence?: string;
};

function statusColor(s: StepStatus) {
  switch (s) {
    case "ok": return "bg-ok-bg text-ok border-ok-edge";
    case "error": return "bg-bad-bg text-bad border-bad-edge";
    case "blocked": return "bg-amber-50 text-amber-700 border-amber-200";
    case "running": return "bg-blue-50 text-blue-700 border-blue-200";
    default: return "bg-zinc-100 text-zinc-600 border-zinc-200";
  }
}

export default function PrintCertificationWizard({ printerId }: { printerId: string }) {
  const [steps, setSteps] = useState<CertificationStep[] | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [certified, setCertified] = useState<boolean>(false);
  const [blocked, setBlocked] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineUrl, setTimelineUrl] = useState<string | null>(null);

  async function runCertification() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/printers/${printerId}/certify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testPage: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSteps(data.steps);
      setJobId(data.jobId);
      setRequestId(data.requestId);
      setCertified(data.certified);
      setBlocked(data.blocked);
      setTimelineUrl(data.timelineUrl ?? (data.jobId ? `/api/jobs/${data.jobId}/timeline` : null));
    } catch (e: any) {
      setError(e.message ?? "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-edge bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Real Print Certification Mode</h3>
        <button
          onClick={runCertification}
          disabled={loading}
          className="rounded-full bg-ink px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {loading ? "Running…" : "Run Certification"}
        </button>
      </div>
      <p className="mt-1 text-[12px] text-ink-3">Gateway → Auth → Queue → Claim → Agent → Transport → Physical → Ack → Final with BLOCKED handling.</p>

      {error && <div className="mt-3 rounded border border-bad-edge bg-bad-bg p-2 text-xs text-bad">{error}</div>}

      {steps && (
        <div className="mt-4 space-y-2">
          <div className="flex gap-2 text-[11px]">
            <span className={`rounded-full border px-2 py-0.5 ${certified ? "bg-ok-bg text-ok border-ok-edge" : blocked ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-zinc-100"}`}>
              {certified ? "CERTIFIED" : blocked ? "BLOCKED" : "PENDING"}
            </span>
            {requestId && <span className="font-mono text-zinc-500">req {requestId.slice(0, 16)}…</span>}
            {jobId && <span className="font-mono text-zinc-500">job {jobId}</span>}
          </div>

          <div className="grid gap-2">
            {steps.map((s, idx) => (
              <div key={s.id} className="flex gap-3 rounded-lg border border-edge p-3">
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-bold">{idx + 1}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">{s.label}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusColor(s.status)}`}>{s.status.toUpperCase()}</span>
                    {s.at && <span className="text-[10px] text-zinc-400">{new Date(s.at).toLocaleTimeString()}</span>}
                  </div>
                  <div className="mt-1 text-[12px] text-ink-2">{s.message}</div>
                  {s.evidence && <div className="mt-1 font-mono text-[11px] text-zinc-500">{s.evidence}</div>}
                  <div className="mt-1 text-[11px] text-zinc-400">{s.description}</div>
                </div>
              </div>
            ))}
          </div>

          {timelineUrl && (
            <div className="mt-3">
              <a href={timelineUrl} target="_blank" className="text-xs underline">View Job Timeline (API)</a>
              {jobId && <a href={`/api/jobs/${jobId}/timeline`} className="ml-3 text-xs underline">Timeline JSON</a>}
            </div>
          )}

          <div className="mt-3 rounded bg-amber-50 p-3 text-[11px] text-amber-800">
            <strong>BLOCKED handling:</strong> In sandbox without physical printer, Physical step is BLOCKED by design. On real hardware, verify YASSER TEST PAGE paper output, check spoolerJobId linking (Gateway↔Windows Spooler), and confirm ack success for full certification.
          </div>
        </div>
      )}
    </div>
  );
}
