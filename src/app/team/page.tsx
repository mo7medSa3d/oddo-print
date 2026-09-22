"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Users, Mail, Shield, Crown, UserMinus, ArrowRightLeft, Trash2, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { Button, Input, Select, Card, CardHeader, StatusBadge, Modal } from "../../components/ui";

type Member = { userId: string; email: string; role: string };
type Invitation = { id: string; email: string; role: string; expiresAt: string };

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer", desc: "Read-only access" },
  { value: "operator", label: "Operator", desc: "Manage jobs & printers" },
  { value: "admin", label: "Admin", desc: "Full workspace access" },
  { value: "integration_admin", label: "Integration Admin", desc: "Odoo & API keys" },
  { value: "billing_admin", label: "Billing Admin", desc: "Billing & plans" },
];

function roleTone(role: string) {
  if (role === "owner") return "brand" as const;
  if (role === "admin") return "info" as const;
  if (role === "operator") return "ok" as const;
  return "neutral" as const;
}

export default function TeamPage() {
  const router = useRouter();
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [transferTarget, setTransferTarget] = useState<Member | null>(null);

  function showMessage(text: string, type: "ok" | "err" = "ok") {
    setMessage({ text, type });
    requestAnimationFrame(() => feedbackRef.current?.focus());
  }

  async function load() {
    setLoadError(null);
    try {
      const [membersRes, invitationsRes] = await Promise.all([
        fetch("/api/team/members", { credentials: "include", cache: "no-store" }),
        fetch("/api/team/invitations", { credentials: "include", cache: "no-store" }),
      ]);
      if (!membersRes.ok || !invitationsRes.ok) {
        setLoadError(
          !membersRes.ok
            ? "Could not load members. Please refresh to retry."
            : "Could not load invitations. Please refresh to retry."
        );
        return;
      }
      setMembers((await membersRes.json()).members ?? []);
      setInvitations((await invitationsRes.json()).invitations ?? []);
      setLoadError(null);
    } catch {
      setLoadError("Could not load team data. Please refresh to retry.");
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/team/members", { credentials: "include", cache: "no-store" }),
      fetch("/api/team/invitations", { credentials: "include", cache: "no-store" }),
    ])
      .then(async ([membersRes, invitationsRes]) => {
        if (!active) return;
        if (!membersRes.ok || !invitationsRes.ok) {
          setLoadError(
            !membersRes.ok
              ? "Could not load members. Please refresh to retry."
              : "Could not load invitations. Please refresh to retry."
          );
          return;
        }
        setMembers((await membersRes.json()).members ?? []);
        setInvitations((await invitationsRes.json()).invitations ?? []);
        setLoadError(null);
      })
      .catch(() => {
        if (active) setLoadError("Could not load team data. Please refresh to retry.");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => { active = false; };
  }, []);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/team/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, role }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Invitation failed");
      setEmail("");
      showMessage("Invitation sent.", "ok");
      void load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Invitation failed", "err");
    } finally {
      setBusy(false);
    }
  }

  async function updateRole(userId: string, nextRole: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/team/members", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId, role: nextRole }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Role update failed");
      showMessage("Member role updated.", "ok");
      await load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Role update failed", "err");
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvitation(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/team/invitations?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Invitation revocation failed");
      showMessage("Invitation revoked.", "ok");
      await load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Invitation revocation failed", "err");
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/team/members?userId=${encodeURIComponent(userId)}`, { method: "DELETE", credentials: "include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Member removal failed");
      showMessage("Member removed.", "ok");
      await load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Member removal failed", "err");
    } finally {
      setBusy(false);
    }
  }

  async function transfer(userId: string) {
    setTransferTarget(null);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/team/ownership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setBusy(false);
        throw new Error(typeof data.error === "string" ? data.error : "Ownership transfer failed");
      }
      router.push("/login");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Ownership transfer failed", "err");
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-8 sm:px-7 lg:px-8 lg:py-10">
      <header className="mb-7 flex flex-col gap-4 border-b border-edge/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">
            <Users className="h-3.5 w-3.5" /> Team & access
          </div>
          <h1 className="mt-4 text-[28px] font-bold tracking-[-0.04em] text-ink">Team</h1>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-3">Invite staff, assign roles, and control workspace access. RBAC enforced server-side.</p>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-ink-3">
          <Shield className="h-4 w-4" />
          <span>{members.length} members • {invitations.length} pending</span>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader title="Invite member" subtitle="Email invitation with role assignment" icon={<Mail className="h-4 w-4 text-brand" />} />
            <form onSubmit={invite} className="px-6 pb-6 space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
                <div>
                  <label className="block text-[12.5px] font-semibold text-ink">Email address</label>
                  <Input type="email" required disabled={busy} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" className="mt-1.5" />
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-ink">Role</label>
                  <Select value={role} disabled={busy} onChange={(e) => setRole(e.target.value)} className="mt-1.5 w-full">
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-ink-3">
                  {ROLE_OPTIONS.find((r) => r.value === role)?.desc}
                </div>
                <Button type="submit" variant="primary" size="sm" disabled={busy} loading={busy}>Invite member</Button>
              </div>
            </form>
          </Card>

          {message && (
            <div ref={feedbackRef} tabIndex={-1} role={message.type === "ok" ? "status" : "alert"} className={`flex items-start gap-2.5 rounded-[12px] border px-4 py-3 text-[13px] outline-none ${message.type === "ok" ? "border-ok-edge bg-ok-bg text-ok" : "border-bad-edge bg-bad-bg text-bad"}`}>
              {message.type === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{message.text}</span>
            </div>
          )}

          <Card>
            <CardHeader title="Members" subtitle={`${members.length} active members`} icon={<Users className="h-4 w-4 text-brand" />} />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-y border-edge bg-surface-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                  <tr>
                    <th className="px-5 py-3">Member</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {!loaded ? (
                    <tr>
                      <td colSpan={3} className="px-5 py-12 text-center text-[13px] text-ink-3">
                        <span className="skeleton inline-block h-4 w-40 align-middle" aria-hidden />
                        <span className="sr-only">Loading members…</span>
                      </td>
                    </tr>
                  ) : loadError ? (
                    <tr>
                      <td colSpan={3} className="px-5 py-12">
                        <div className="flex flex-col items-center gap-3 text-center">
                          <span role="alert" className="text-[13px] text-bad">{loadError}</span>
                          <Button variant="secondary" size="sm" onClick={() => void load()}>
                            Retry
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ) : members.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-5 py-12 text-center text-[13px] text-ink-3">No members yet.</td>
                    </tr>
                  ) : (
                    members.map((member) => (
                    <tr key={member.userId} className="hover:bg-surface-2/60 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-surface-2 border border-edge text-[11px] font-bold text-ink-2">
                            {member.email.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-ink">{member.email}</div>
                            <div className="text-[11px] text-ink-3 font-mono">{member.userId.slice(0, 8)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          {member.role === "owner" && <Crown className="h-3.5 w-3.5 text-warn-solid" />}
                          <StatusBadge tone={roleTone(member.role)} label={member.role.replace(/_/g, " ")} />
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {member.role !== "owner" && (
                            <>
                              <Select disabled={busy} value={member.role} onChange={(e) => void updateRole(member.userId, e.target.value)} className="w-[160px]">
                                {ROLE_OPTIONS.map((r) => (
                                  <option key={r.value} value={r.value}>{r.label}</option>
                                ))}
                              </Select>
                              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setTransferTarget(member)} icon={<ArrowRightLeft className="h-3.5 w-3.5" />} title="Transfer ownership">Transfer</Button>
                              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(member.userId)} icon={<UserMinus className="h-3.5 w-3.5" />} className="text-bad hover:bg-bad-bg hover:text-bad" title="Remove">Remove</Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Pending invitations" subtitle={`${invitations.length} awaiting acceptance`} icon={<Clock className="h-4 w-4 text-brand" />} />
            <div className="px-5 pb-5">
              {invitations.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-edge p-6 text-center">
                  <div className="text-[13px] font-medium text-ink">No pending invites</div>
                  <div className="mt-1 text-[12px] text-ink-3">Invited members appear here until they accept.</div>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {invitations.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-edge bg-surface-2 p-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink">{inv.email}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-3">
                          <StatusBadge tone="neutral" label={inv.role} />
                          <span>expires {new Date(inv.expiresAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revokeInvitation(inv.id)} icon={<Trash2 className="h-3.5 w-3.5" />} className="text-bad hover:bg-bad-bg hover:text-bad">Revoke</Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <div className="p-5">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Shield className="h-4 w-4 text-brand" /> Role guide</div>
              <div className="mt-3 space-y-2.5">
                {ROLE_OPTIONS.map((r) => (
                  <div key={r.value} className="flex gap-3 rounded-[8px] bg-surface-2 border border-edge px-3 py-2.5">
                    <div className="text-[12px] font-semibold text-ink min-w-[110px]">{r.label}</div>
                    <div className="text-[11px] text-ink-3 leading-snug">{r.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={transferTarget !== null}
        onClose={() => setTransferTarget(null)}
        title="Transfer workspace ownership"
        description="This action cannot be undone."
        footer={
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setTransferTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              loading={busy}
              onClick={transferTarget ? () => void transfer(transferTarget.userId) : undefined}
            >
              Transfer ownership
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-2">
          You are about to make <span className="font-semibold text-ink">{transferTarget?.email}</span> the
          workspace owner. You will be demoted to admin and signed out of this session.
        </p>
      </Modal>
    </div>
  );
}
