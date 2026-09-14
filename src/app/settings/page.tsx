"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { fetch("/api/settings", { credentials: "include", cache: "no-store" }).then(async (r) => { if (!r.ok) throw new Error("Unable to load settings"); const d = await r.json(); setName(d.tenant?.name ?? ""); setEmail(d.email ?? ""); setRole(d.role ?? ""); }).catch((e) => setMessage(e instanceof Error ? e.message : "Unable to load settings")); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMessage("");
    try { const r = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ name }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Unable to save settings"); setMessage("Workspace settings saved."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Unable to save settings"); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-3xl px-4 py-10"><h1 className="text-2xl font-bold text-ink">Settings</h1><p className="mt-1 text-sm text-ink-3">Manage the workspace identity visible to your team.</p><form onSubmit={save} className="mt-6 card space-y-5 p-6"><label className="block text-sm font-semibold text-ink">Workspace name<input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required className="mt-1 w-full rounded-lg border border-edge bg-surface p-2.5 font-normal" /></label><div className="grid gap-5 md:grid-cols-2"><div><div className="text-xs uppercase tracking-wide text-ink-3">Signed-in role</div><div className="mt-1 font-semibold text-ink">{role || "—"}</div></div><div><div className="text-xs uppercase tracking-wide text-ink-3">User</div><div className="mt-1 font-semibold text-ink">{email || "—"}</div></div></div>{message && <p className="text-sm text-ink-2">{message}</p>}<button disabled={busy} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save changes"}</button></form></main>;
}
