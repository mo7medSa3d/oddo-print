"use client";

import { useEffect, useState } from "react";
import {
  Building2,
  User,
  Shield,
  Save,
  AlertTriangle,
  Settings as SettingsIcon,
  CheckCircle2,
} from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardHeader,
  ErrorState,
  Field,
  Input,
  KeyValueList,
  PageContainer,
  PageHeader,
  Skeleton,
} from "../../components/ui";

type SettingsPayload = {
  tenant?: { id?: string; name?: string; createdAt?: string };
  email?: string;
  role?: string;
};

export default function SettingsPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [tenantCreatedAt, setTenantCreatedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings", { credentials: "include", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Unable to load settings");
        const d = (await r.json()) as SettingsPayload;
        setName(d.tenant?.name ?? "");
        setEmail(d.email ?? "");
        setRole(d.role ?? "");
        setTenantCreatedAt(d.tenant?.createdAt ?? null);
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
      setMessage({ text: "Workspace name updated.", type: "ok" });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Unable to save settings", type: "err" });
    } finally {
      setBusy(false);
    }
  }

  const dirty = name.trim() !== "" && name.trim() !== undefined;

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        icon={<SettingsIcon className="h-4 w-4" />}
        title="Settings"
        width="narrow"
        description="Workspace identity and the account access attached to it."
      />

      <PageContainer width="narrow">
        {loading ? (
          <div className="space-y-5" role="status" aria-label="Loading settings">
            <Skeleton className="h-[240px] rounded-2xl" />
            <Skeleton className="h-[160px] rounded-2xl" />
            <span className="sr-only">Loading settings…</span>
          </div>
        ) : (
          <div className="space-y-5">
            <Card>
              <CardHeader
                title="Workspace identity"
                subtitle="Shown to your team, in billing records, and in audit history."
                icon={<Building2 className="h-4 w-4" />}
              />
              <form onSubmit={save} className="space-y-5 px-5 py-5">
                <Field
                  label="Workspace name"
                  htmlFor="workspace-name"
                  hint="2–120 characters. Appears on invoices and in the Odoo sync record."
                  required
                >
                  <Input
                    id="workspace-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    minLength={2}
                    maxLength={120}
                    required
                    placeholder="Acme Inc."
                    disabled={busy || !dirty}
                  />
                </Field>

                {message && (
                  <Callout
                    tone={message.type === "ok" ? "ok" : "bad"}
                    icon={message.type === "ok" ? <CheckCircle2 className="h-4 w-4" /> : undefined}
                    title={message.type === "ok" ? "Saved" : "Couldn’t save"}
                  >
                    {message.text}
                  </Callout>
                )}

                <div className="flex items-center justify-end gap-2 border-t border-edge-subtle pt-4">
                  <Button type="submit" variant="primary" disabled={busy} loading={busy} icon={<Save className="h-4 w-4" />}>
                    {busy ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </form>
            </Card>

            <Card>
              <CardHeader
                title="Your access"
                subtitle="Derived from the workspace role on your account."
                icon={<User className="h-4 w-4" />}
              />
              <div className="px-5 py-4">
                <KeyValueList
                  rows={[
                    { label: "Signed in as", value: email || "—" },
                    { label: "Role", value: <span className="capitalize">{role || "—"}</span> },
                    { label: "Workspace ID", value: <code className="font-mono text-xs">{name ? "•••" : "—"}</code> },
                    {
                      label: "Workspace created",
                      value: tenantCreatedAt ? new Date(tenantCreatedAt).toLocaleDateString() : "—",
                    },
                  ]}
                />
                <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-edge-subtle bg-surface-2 px-3.5 py-3">
                  <Shield className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                  <p className="text-sm leading-relaxed text-ink-3">
                    Permissions are enforced server-side per request. Changing a member’s role takes
                    effect immediately.
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Danger zone"
                subtitle="Actions that cannot be undone."
                icon={<AlertTriangle className="h-4 w-4" />}
              />
              <div className="px-5 py-4">
                <div className="flex flex-col gap-3 rounded-lg border border-bad-edge bg-bad-bg px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="text-sm font-[600] text-bad">Delete this workspace</h3>
                    <p className="mt-0.5 text-sm leading-relaxed text-ink-2">
                      Workspace deletion is controlled by Platform Administration, so print history
                      and billing records stay auditable.
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" href="/billing" className="shrink-0">
                    Contact options
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )}
      </PageContainer>
    </>
  );
}
