"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Users,
  Mail,
  Shield,
  Crown,
  UserMinus,
  ArrowRightLeft,
  Clock,
  CheckCircle2,
  AlertCircle,
  MoreHorizontal,
  Info,
} from "lucide-react";
import {
  Avatar,
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Menu,
  Modal,
  PageContainer,
  PageHeader,
  Select,
  StatusBadge,
  StatusDot,
  type MenuItemSpec,
} from "../../components/ui";
import { shortId } from "../../lib/utils";

type Member = { userId: string; email: string; role: string };
type Invitation = { id: string; email: string; role: string; expiresAt: string };

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer", desc: "Read-only access to the console." },
  { value: "operator", label: "Operator", desc: "Manage printers, agents and print jobs." },
  { value: "admin", label: "Admin", desc: "Full workspace access including team and billing." },
  { value: "integration_admin", label: "Integration admin", desc: "Odoo integration and API keys." },
  { value: "billing_admin", label: "Billing admin", desc: "Subscription, plans and invoices." },
];

const ROLE_TONE: Record<string, "brand" | "info" | "ok" | "neutral" | "warn"> = {
  owner: "brand",
  admin: "info",
  operator: "ok",
  integration_admin: "neutral",
  billing_admin: "neutral",
  viewer: "neutral",
};

const ROLE_ORDER = ROLE_OPTIONS.map((r) => r.value);

function roleLabel(role: string) {
  return role.replace(/_/g, " ");
}

function expiryLabel(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  const hours = Math.round(ms / 3_600_000);
  if (hours <= 0) return "Expired";
  if (hours < 48) return `Expires in ${hours}h`;
  return `Expires in ${Math.round(hours / 24)}d`;
}

export default function TeamPage() {
  const router = useRouter();
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [message, setMessage] = useState<{ text: string; type: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [transferTarget, setTransferTarget] = useState<Member | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);

  function showMessage(text: string, type: "ok" | "err" = "ok") {
    setMessage({ text, type });
    requestAnimationFrame(() => feedbackRef.current?.focus());
  }

  async function load() {
    // NOTE: no optimistic setLoadError(null) here — this function runs
    // inside the mount effect, where synchronous setState is a lint error
    // (cascading renders). Retry buttons clear the error in their own
    // onClick (event handlers may set state freely).
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
    // Single implementation of the initial fetch — load() is the same block,
    // invoked on mount and after every mutation. Deferred past the effect
    // body: calling load() synchronously here is a setState-in-effect lint
    // error (its state updates must run in a callback, as before).
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return load();
    });
    return () => {
      active = false;
    };
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
    setRemoveTarget(null);
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

  const ownerCount = members.filter((m) => m.role === "owner").length;

  function memberMenu(member: Member): MenuItemSpec[] {
    return [
      {
        key: "transfer",
        label: "Transfer ownership…",
        icon: <ArrowRightLeft className="h-4 w-4" />,
        disabled: busy,
        onSelect: () => setTransferTarget(member),
      },
      {
        key: "remove",
        label: "Remove from workspace…",
        icon: <UserMinus className="h-4 w-4" />,
        tone: "danger",
        separatorBefore: true,
        disabled: busy,
        onSelect: () => setRemoveTarget(member),
      },
    ];
  }

  return (
    <>
      <PageHeader
        width="wide"
        eyebrow="Administration"
        icon={<Users className="h-4 w-4" />}
        title="Team"
        description="Who can reach this workspace, and what each person is allowed to change."
        meta={
          loaded ? (
            <div className="flex items-center gap-2">
              <StatusBadge tone="neutral" label={`${members.length} member${members.length === 1 ? "" : "s"}`} />
              {invitations.length > 0 && (
                <StatusBadge tone="warn" label={`${invitations.length} pending`} />
              )}
            </div>
          ) : null
        }
      />

      <PageContainer width="wide">
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.85fr)]">
          <div className="space-y-5">
            {message && (
              <div
                ref={feedbackRef}
                tabIndex={-1}
                role={message.type === "ok" ? "status" : "alert"}
                className={`flex items-start gap-2.5 rounded-sg border px-4 py-3 text-sm outline-none ${
                  message.type === "ok"
                    ? "border-ok-edge bg-ok-bg text-ok"
                    : "border-bad-edge bg-bad-bg text-bad"
                }`}
              >
                {message.type === "ok" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                )}
                <span>{message.text}</span>
              </div>
            )}

            <Card className="overflow-hidden">
              <CardHeader
                title="Members"
                subtitle="Roles apply immediately across the console and the API."
                icon={<Users className="h-4 w-4" />}
              />

              {!loaded ? (
                <ul className="divide-y divide-edge-subtle" role="status" aria-label="Loading members">
                  {[0, 1, 2].map((i) => (
                    <li key={i} className="flex items-center gap-3 px-5 py-4">
                      <span className="skeleton h-9 w-9 rounded-full" aria-hidden />
                      <span className="flex-1 space-y-2">
                        <span className="skeleton block h-3 w-48" aria-hidden />
                        <span className="skeleton block h-2.5 w-24" aria-hidden />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : loadError ? (
                <div className="px-5 py-5">
                  <ErrorState
                    title="Team unavailable"
                    message={loadError}
                    retry={() => {
                      setLoadError(null);
                      void load();
                    }}
                  />
                </div>
              ) : members.length === 0 ? (
                <EmptyState
                  icon={<Users className="h-5 w-5" />}
                  title="No members yet"
                  description="Invite a teammate with the form beside this table to give them console access."
                />
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden overflow-x-auto md:block">
                    {/* `min-w` matters: the card clips its overflow, so without a
                        floor the role badge and the actions button get cut off
                        by the card edge when the sidebar narrows the content
                        column. The scroller turns that clipping into a scroll. */}
                    <table className="data-table min-w-[560px]">
                      <caption className="sr-only">Workspace members and their roles</caption>
                      <thead>
                        <tr>
                          <th scope="col">Member</th>
                          <th scope="col">Role</th>
                          <th scope="col" className="w-[1%] text-end">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((member) => (
                          <tr key={member.userId}>
                            <td>
                              <div className="flex items-center gap-3">
                                <Avatar name={member.email} size="sm" />
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-[550] text-ink">{member.email}</div>
                                  <div className="font-mono text-2xs text-ink-3" title={member.userId}>
                                    {shortId(member.userId)}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="whitespace-nowrap">
                              <div className="flex items-center gap-2">
                                {member.role === "owner" && (
                                  <Crown className="h-3.5 w-3.5 text-warn" aria-hidden />
                                )}
                                {member.role === "owner" ? (
                                  <StatusBadge tone="brand" label="Owner" />
                                ) : (
                                  <Select
                                    aria-label={`Role for ${member.email}`}
                                    disabled={busy}
                                    value={member.role}
                                    onChange={(e) => void updateRole(member.userId, e.target.value)}
                                    className="h-8 w-[168px] text-sm"
                                  >
                                    {ROLE_ORDER.map((value) => (
                                      <option key={value} value={value}>
                                        {roleLabel(value)}
                                      </option>
                                    ))}
                                  </Select>
                                )}
                              </div>
                            </td>
                            <td className="text-end">
                              {member.role !== "owner" && (
                                <Menu
                                  label={`Actions for ${member.email}`}
                                  items={memberMenu(member)}
                                  trigger={
                                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-sm text-ink-3 transition-colors duration-[140ms] hover:bg-surface-2 hover:text-ink">
                                      <MoreHorizontal className="h-4 w-4" aria-hidden />
                                    </span>
                                  }
                                />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile list */}
                  <ul className="divide-y divide-edge-subtle md:hidden">
                    {members.map((member) => (
                      <li key={member.userId} className="px-4 py-4">
                        <div className="flex items-start gap-3">
                          <Avatar name={member.email} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="break-words text-sm font-[550] text-ink">{member.email}</div>
                            <div className="mt-0.5 font-mono text-2xs text-ink-3" title={member.userId}>
                              {shortId(member.userId)}
                            </div>
                          </div>
                          {member.role === "owner" ? (
                            <StatusBadge tone="brand" label="Owner" />
                          ) : (
                            <StatusBadge tone={ROLE_TONE[member.role] ?? "neutral"} label={roleLabel(member.role)} />
                          )}
                        </div>
                        {member.role !== "owner" && (
                          <div className="mt-3 flex items-center gap-2">
                            <Select
                              aria-label={`Role for ${member.email}`}
                              disabled={busy}
                              value={member.role}
                              onChange={(e) => void updateRole(member.userId, e.target.value)}
                              className="h-9 flex-1 text-sm"
                            >
                              {ROLE_ORDER.map((value) => (
                                <option key={value} value={value}>
                                  {roleLabel(value)}
                                </option>
                              ))}
                            </Select>
                            <Menu
                              label={`Actions for ${member.email}`}
                              align="end"
                              items={memberMenu(member)}
                              trigger={
                                <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-edge text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink">
                                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                                </span>
                              }
                            />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>

            <Card className="overflow-hidden">
              <CardHeader
                title="Pending invitations"
                subtitle="Invitations expire automatically. Revoke any that are no longer wanted."
                icon={<Clock className="h-4 w-4" />}
              />
              {!loaded ? (
                <div className="space-y-3 px-5 py-4" role="status" aria-label="Loading invitations">
                  {[0, 1].map((i) => (
                    <span key={i} className="skeleton block h-3.5 w-56" aria-hidden />
                  ))}
                </div>
              ) : invitations.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={<Mail className="h-4 w-4" />}
                  title="No invitations outstanding"
                  description="Invite a teammate and the pending invite will be listed here until it is accepted."
                />
              ) : (
                <ul className="divide-y divide-edge-subtle">
                  {invitations.map((invitation) => (
                    <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-[550] text-ink">{invitation.email}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
                          <StatusBadge tone={ROLE_TONE[invitation.role] ?? "neutral"} label={roleLabel(invitation.role)} size="sm" />
                          <span>{expiryLabel(invitation.expiresAt)}</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void revokeInvitation(invitation.id)}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <aside className="space-y-5">
            <Card>
              <CardHeader
                title="Invite a teammate"
                subtitle="They receive an email link to join this workspace."
                icon={<Mail className="h-4 w-4" />}
              />
              <form onSubmit={invite} className="space-y-4 px-5 py-5">
                <Field label="Email address" htmlFor="invite-email" required>
                  <Input
                    id="invite-email"
                    type="email"
                    required
                    disabled={busy}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="colleague@company.com"
                    autoComplete="email"
                  />
                </Field>
                <Field
                  label="Role"
                  htmlFor="invite-role"
                  hint={ROLE_OPTIONS.find((r) => r.value === role)?.desc}
                >
                  <Select
                    id="invite-role"
                    value={role}
                    disabled={busy}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full"
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </Select>
                </Field>
                <Button type="submit" variant="primary" disabled={busy} loading={busy} className="w-full">
                  {busy ? "Sending…" : "Send invitation"}
                </Button>
              </form>
            </Card>

            <Card>
              <CardHeader
                title="Roles"
                subtitle="Least privilege by default."
                icon={<Shield className="h-4 w-4" />}
              />
              <ul className="space-y-3 px-5 py-5">
                {ROLE_OPTIONS.map((option) => (
                  <li key={option.value} className="flex gap-2.5">
                    <StatusDot tone={ROLE_TONE[option.value] ?? "neutral"} className="mt-1.5" />
                    <div className="min-w-0">
                      <div className="text-sm font-[550] text-ink">{option.label}</div>
                      <p className="text-sm leading-relaxed text-ink-3">{option.desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            {ownerCount === 1 && (
              <Callout tone="info" icon={<Info className="h-4 w-4" />} title="One owner per workspace">
                Ownership can be transferred from the member row menu. Transferring signs you out and
                demotes your account to admin.
              </Callout>
            )}
          </aside>
        </div>
      </PageContainer>

      <Modal
        open={transferTarget !== null}
        onClose={() => setTransferTarget(null)}
        title="Transfer workspace ownership?"
        description="This action cannot be undone."
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setTransferTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              loading={busy}
              onClick={transferTarget ? () => void transfer(transferTarget.userId) : undefined}
            >
              Transfer ownership
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-2">
            <span className="font-[600] text-ink">{transferTarget?.email}</span> becomes the workspace
            owner. Your account is demoted to admin and this session is signed out immediately.
          </p>
          <Callout tone="warn" title="Billing and ownership follow the account">
            The new owner controls the subscription, plan changes and workspace deletion.
          </Callout>
        </div>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Remove this member?"
        description={removeTarget?.email}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              loading={busy}
              onClick={removeTarget ? () => void remove(removeTarget.userId) : undefined}
            >
              Remove member
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-2">
          They lose console access immediately. Print history they requested remains in the audit
          log.
        </p>
      </Modal>
    </>
  );
}
