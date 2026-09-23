"use client";

import { useEffect, useState } from "react";
import { Building2, User, Shield, Save, AlertCircle, CheckCircle2, Settings as SettingsIcon } from "lucide-react";
import { Button, Input, Field, Card, CardHeader } from "../../components/ui";

const SETTINGS_NAV = [
  { id: "general", label: "General", icon: SettingsIcon, desc: "Workspace details" },
  { id: "security", label: "Security", icon: Shield, desc: "Account security" },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("general");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings", { credentials: "include", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Unable to load settings");
        const d = await r.json();
        setName(d.tenant?.name ?? "");
        setEmail(d.email ?? "");
        setRole(d.role ?? "");
      })
      .catch((e) => setMessage({ text: e instanceof Error ? e.message : "Unable to load settings", type: "err" }))
      .finally(() => setLoading(false));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Unable to save settings");
      setMessage({ text: "Workspace settings saved.", type: "ok" });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Unable to save settings", type: "err" });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <div className="space-y-4">
          <div className="skeleton h-8 w-48" />
          <div className="skeleton h-4 w-80" />
          <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
            <div className="skeleton h-[400px] rounded-[14px]" />
            <div className="skeleton h-[400px] rounded-[14px]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-8 sm:px-7 lg:px-8">
      <header className="mb-7 border-b border-edge/80 pb-6">
        <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
          <SettingsIcon className="h-3.5 w-3.5" /> Workspace
        </div>
        <h1 className="mt-2.5 text-[28px] font-bold tracking-[-0.04em] text-ink">Settings</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-3">Workspace details and account security.</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <nav className="h-fit rounded-[14px] border border-edge bg-surface p-2 shadow-card" aria-label="Settings sections">
          <div className="space-y-1">
            {SETTINGS_NAV.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition ${active ? "bg-brand-subtle text-brand-subtle-text font-semibold" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${active ? "text-brand" : "text-ink-3"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] leading-tight">{item.label}</div>
                    <div className="text-[11px] text-ink-3">{item.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-4 border-t border-edge px-2 pt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">Signed in</div>
            <div className="mt-2 truncate text-[13px] font-medium text-ink">{email || "—"}</div>
            <div className="mt-1 text-[11px] text-ink-3">Role: {role || "—"}</div>
          </div>
        </nav>

        <div className="space-y-6">
          {activeTab === "general" && (
            <>
              <Card>
                <CardHeader title="Workspace identity" subtitle="Shown to your team and in audit history." icon={<Building2 className="h-4 w-4 text-brand" />} />
                <form onSubmit={save} className="space-y-6 px-6 pb-6">
                  <Field label="Workspace name" hint="2–120 characters. Used in billing, audit, and Odoo sync.">
                    <Input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required placeholder="Acme Inc." />
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                        <User className="h-3.5 w-3.5" /> Your role
                      </div>
                      <div className="mt-2 text-[14px] font-semibold text-ink">{role || "—"}</div>
                      <div className="mt-1 text-[11px] text-ink-3">Controls what you can manage.</div>
                    </div>
                    <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                        <Shield className="h-3.5 w-3.5" /> Account
                      </div>
                      <div className="mt-2 truncate text-[14px] font-semibold text-ink">{email || "—"}</div>
                    </div>
                  </div>

                  {message && (
                    <div className={`flex items-start gap-2.5 rounded-[10px] border px-4 py-3 text-[13px] ${message.type === "ok" ? "border-ok-edge bg-ok-bg text-ok" : "border-bad-edge bg-bad-bg text-bad"}`}>
                      {message.type === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                      <span>{message.text}</span>
                    </div>
                  )}

                  <div className="flex justify-end border-t border-edge pt-5">
                    <Button type="submit" variant="primary" disabled={busy} loading={busy} icon={<Save className="h-4 w-4" />}>
                      {busy ? "Saving…" : "Save changes"}
                    </Button>
                  </div>
                </form>
              </Card>

              <Card>
                <CardHeader title="Danger zone" subtitle="Permanent actions" icon={<AlertCircle className="h-4 w-4 text-bad" />} />
                <div className="px-6 pb-6">
                  <div className="rounded-[10px] border border-bad-edge bg-bad-bg/40 p-4 text-[13px] text-ink-2">
                    <div className="font-semibold text-bad">Workspace deletion is controlled by Platform Admin.</div>
                    <p className="mt-1 text-[12px] leading-relaxed">Contact Platform Admin to delete the workspace.</p>
                  </div>
                </div>
              </Card>
            </>
          )}

          {activeTab === "security" && (
            <Card>
              <CardHeader title="Security" subtitle="Session and connection security" icon={<Shield className="h-4 w-4 text-brand" />} />
              <div className="space-y-4 px-6 pb-6">
                <div className="rounded-[10px] border border-edge bg-surface-2 p-4 text-[13px]">
                  <div className="font-medium text-ink">Session persistence</div>
                </div>
                <div className="rounded-[10px] border border-edge bg-surface-2 p-4 text-[13px]">
                  <div className="font-medium text-ink">Transport</div>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
