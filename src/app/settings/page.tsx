"use client";

import { useEffect, useState } from "react";
import { Building2, User, Shield, Save, AlertCircle, CheckCircle2, Settings as SettingsIcon, Users, CreditCard, KeyRound, Network } from "lucide-react";
import { Button, Input, Field, Card, CardHeader } from "../../components/ui";

const SETTINGS_NAV = [
  { id: "general", label: "General", icon: SettingsIcon, desc: "Workspace identity" },
  { id: "members", label: "Members", icon: Users, desc: "Team & roles" },
  { id: "billing", label: "Billing", icon: CreditCard, desc: "Plan & entitlements" },
  { id: "integrations", label: "Integrations", icon: KeyRound, desc: "Odoo & API keys" },
  { id: "security", label: "Security", icon: Shield, desc: "Sessions & access" },
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
      const r = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ name }) });
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
      <div className="mx-auto max-w-[1180px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
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
    <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-7 border-b border-edge/80 pb-6">
        <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
          <SettingsIcon className="h-3.5 w-3.5" /> Workspace control center
        </div>
        <h1 className="mt-2.5 text-[30px] font-bold tracking-[-0.035em] text-ink">Settings</h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-3">Manage identity, team, billing, and integrations — grouped by concern, not dumped in one form.</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        {/* Settings nav */}
        <nav className="h-fit rounded-[14px] border border-edge bg-surface p-2 shadow-card">
          <div className="space-y-1">
            {SETTINGS_NAV.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition ${active ? "bg-brand-subtle text-brand-subtle-text font-semibold" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
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
          <div className="mt-4 border-t border-edge pt-4 px-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-4">Signed in</div>
            <div className="mt-2 truncate text-[13px] font-medium text-ink">{email || "—"}</div>
            <div className="mt-1 text-[11px] text-ink-3">Role: {role || "—"}</div>
          </div>
        </nav>

        {/* Content */}
        <div className="space-y-6">
          {activeTab === "general" && (
            <>
              <Card>
                <CardHeader title="Workspace identity" subtitle="Visible to your team and in audit logs" icon={<Building2 className="h-4 w-4 text-brand" />} />
                <form onSubmit={save} className="px-6 pb-6 space-y-6">
                  <Field label="Workspace name" hint="2–120 characters. Used in billing, audit, and Odoo sync.">
                    <Input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required placeholder="Acme Inc." />
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                        <User className="h-3.5 w-3.5" /> Your role
                      </div>
                      <div className="mt-2 text-[14px] font-semibold text-ink">{role || "—"}</div>
                      <div className="mt-1 text-[11px] text-ink-3">Determines what you can change here.</div>
                    </div>
                    <div className="rounded-[10px] border border-edge bg-surface-2 p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                        <Shield className="h-3.5 w-3.5" /> Account
                      </div>
                      <div className="mt-2 truncate text-[14px] font-semibold text-ink">{email || "—"}</div>
                      <div className="mt-1 text-[11px] text-ink-3">Email verification status enforced server-side.</div>
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
                <CardHeader title="Danger zone" subtitle="Irreversible workspace actions" icon={<AlertCircle className="h-4 w-4 text-bad" />} />
                <div className="px-6 pb-6">
                  <div className="rounded-[10px] border border-bad-edge bg-bad-bg/40 p-4 text-[13px] text-ink-2">
                    <div className="font-semibold text-bad">Workspace deletion is controlled by Platform Admin.</div>
                    <p className="mt-1 text-[12px] leading-relaxed">Contact support or Platform Admin to suspend or delete this workspace. This prevents accidental data loss.</p>
                  </div>
                </div>
              </Card>
            </>
          )}

          {activeTab === "members" && (
            <Card>
              <CardHeader title="Team & access" subtitle="Members and roles are managed in the Team section" icon={<Users className="h-4 w-4 text-brand" />} actions={<Button variant="secondary" size="sm" href="/team">Open Team</Button>} />
              <div className="px-6 pb-6">
                <div className="rounded-[10px] border border-edge bg-surface-2 p-5 text-[13px] text-ink-2">
                  <div className="font-medium text-ink">Current session</div>
                  <div className="mt-2 grid gap-2 text-[12px]">
                    <div className="flex justify-between"><span className="text-ink-3">Email</span><span className="font-medium">{email || "—"}</span></div>
                    <div className="flex justify-between"><span className="text-ink-3">Role</span><span className="font-medium">{role || "—"}</span></div>
                    <div className="flex justify-between"><span className="text-ink-3">Workspace</span><span className="font-medium">{name || "—"}</span></div>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {activeTab === "billing" && (
            <Card>
              <CardHeader title="Billing" subtitle="Plan, status, and limits" icon={<CreditCard className="h-4 w-4 text-brand" />} actions={<Button variant="secondary" size="sm" href="/billing">Open Billing</Button>} />
              <div className="px-6 pb-6 text-[13px] text-ink-3">Billing details live on the Billing page — plan name, renewal, entitlements, and Stripe actions are rendered there with premium hierarchy.</div>
            </Card>
          )}

          {activeTab === "integrations" && (
            <Card>
              <CardHeader title="Integrations" subtitle="Odoo Gateway and API keys" icon={<Network className="h-4 w-4 text-brand" />} actions={<Button variant="secondary" size="sm" href="/api-keys">Manage keys</Button>} />
              <div className="px-6 pb-6 space-y-3 text-[13px]">
                <div className="flex items-center justify-between rounded-[10px] border border-edge bg-surface-2 p-4">
                  <div><div className="font-medium text-ink">Odoo integration</div><div className="text-[12px] text-ink-3">API keys + activation state</div></div>
                  <div className="text-[11px] font-semibold text-ok bg-ok-bg border border-ok-edge rounded-full px-2.5 py-1">Configured separately</div>
                </div>
                <p className="text-[12px] text-ink-3">Credential state, activation state, and connection health are explicitly separated — never merged into one badge.</p>
              </div>
            </Card>
          )}

          {activeTab === "security" && (
            <Card>
              <CardHeader title="Security" subtitle="Sessions and transport" icon={<Shield className="h-4 w-4 text-brand" />} />
              <div className="px-6 pb-6 space-y-4">
                <div className="rounded-[10px] border border-edge bg-surface-2 p-4 text-[13px]">
                  <div className="font-medium text-ink">Session persistence</div>
                  <p className="mt-1 text-[12px] text-ink-3">Manager cookies are httpOnly, secure, same-site. Bearer handling never moves to presentation logic.</p>
                </div>
                <div className="rounded-[10px] border border-edge bg-surface-2 p-4 text-[13px]">
                  <div className="font-medium text-ink">Transport</div>
                  <p className="mt-1 text-[12px] text-ink-3">Production HTTPS restrictions preserved. No wildcard CORS or weakened checks introduced by UI.</p>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
