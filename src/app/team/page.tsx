"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/react";
import type { Translator } from "../../i18n/translate";
import type { MessageKey } from "../../i18n/messages/en";
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
import { codeMessageKey } from "../../lib/api-error-keys";

type Member = { userId: string; email: string; role: string };
type Invitation = { id: string; email: string; role: string; expiresAt: string };

const ROLE_VALUES = ["viewer", "operator", "admin", "integration_admin", "billing_admin"] as const;

/** Built per render so role names follow the active language. */
function roleOptions(t: Translator) {
  return [
    { value: "viewer", label: t("team.role.viewer"), desc: t("team.role.viewerDesc") },
    { value: "operator", label: t("team.role.operator"), desc: t("team.role.operatorDesc") },
    { value: "admin", label: t("team.role.admin"), desc: t("team.role.adminDesc") },
    { value: "integration_admin", label: t("team.role.integrationAdmin"), desc: t("team.role.integrationAdminDesc") },
    { value: "billing_admin", label: t("team.role.billingAdmin"), desc: t("team.role.billingAdminDesc") },
  ];
}

const ROLE_TONE: Record<string, "brand" | "info" | "ok" | "neutral" | "warn"> = {
  owner: "brand",
  admin: "info",
  operator: "ok",
  integration_admin: "neutral",
  billing_admin: "neutral",
  viewer: "neutral",
};

const ROLE_ORDER = [...ROLE_VALUES];

function roleLabel(role: string) {
  return role.replace(/_/g, " ");
}

function expiryLabel(expiresAt: string, t: Translator) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  const hours = Math.round(ms / 3_600_000);
  if (hours <= 0) return t("team.expired");
  if (hours < 48) return t("team.expiresInHours", { hours });
  return t("team.expiresInDays", { days: Math.round(hours / 24) });
}

export default function TeamPage() {
  const router = useRouter();
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const { t } = useI18n();
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
            ? t("team.loadMembersFailed")
            : t("team.loadInvitationsFailed")
        );
        return;
      }
      setMembers((await membersRes.json()).members ?? []);
      setInvitations((await invitationsRes.json()).invitations ?? []);
      setLoadError(null);
    } catch {
      setLoadError(t("team.loadFailed"));
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
      if (!response.ok) throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "team.invitationFailed"));
      setEmail("");
      showMessage(t("success.invitationSent"), "ok");
      void load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t("team.invitationFailed"), "err");
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
      if (!response.ok) throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "team.roleUpdateFailed"));
      showMessage(t("success.roleUpdated"), "ok");
      await load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t("team.roleUpdateFailed"), "err");
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
      if (!response.ok) throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "team.invitationRevocationFailed"));
      showMessage(t("success.invitationRevoked"), "ok");
      await load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t("team.invitationRevocationFailed"), "err");
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
      if (!response.ok) throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "team.memberRemovalFailed"));
      showMessage(t("success.memberRemoved"), "ok");
      await load();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t("team.memberRemovalFailed"), "err");
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
        throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "team.ownershipTransferFailed"));
      }
      router.push("/login");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t("team.ownershipTransferFailed"), "err");
      setBusy(false);
    }
  }

  const ownerCount = members.filter((m) => m.role === "owner").length;

  function memberMenu(member: Member): MenuItemSpec[] {
    return [
      {
        key: "transfer",
        label: t("team.transferOwnership"),
        icon: <ArrowRightLeft className="h-4 w-4" />,
        disabled: busy,
        onSelect: () => setTransferTarget(member),
      },
      {
        key: "remove",
        label: t("team.removeFromWorkspace"),
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
        eyebrow={t("nav.section.administration")}
        icon={<Users className="h-4 w-4" />}
        title={t("nav.team")}
        description={t("team.pageDescription")}
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
                title={t("team.members")}
                subtitle={t("team.membersDescription")}
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
                    title={t("team.unavailable")}
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
                  title={t("empty.members.title")}
                  description={t("empty.members.description")}
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
                      <caption className="sr-only">{t("team.tableCaption")}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t("team.member")}</th>
                          <th scope="col">{t("team.role")}</th>
                          <th scope="col" className="w-[1%] text-end">{t("common.actions")}</th>
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
                                  <StatusBadge tone="brand" label={t("team.role.owner")} />
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
                                  label={t("team.actionsFor", { name: member.email })}
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
                            <StatusBadge tone="brand" label={t("team.role.owner")} />
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
                              label={t("team.actionsFor", { name: member.email })}
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
                title={t("team.pendingInvitations")}
                subtitle={t("team.invitationsHint")}
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
                  title={t("team.noInvitations")}
                  description={t("team.emptyInvites")}
                />
              ) : (
                <ul className="divide-y divide-edge-subtle">
                  {invitations.map((invitation) => (
                    <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-[550] text-ink">{invitation.email}</div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
                          <StatusBadge tone={ROLE_TONE[invitation.role] ?? "neutral"} label={roleLabel(invitation.role)} size="sm" />
                          <span>{expiryLabel(invitation.expiresAt, t)}</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void revokeInvitation(invitation.id)}
                      >
                        {t("team.revoke")}
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
                title={t("team.inviteTitle")}
                subtitle={t("team.inviteHint")}
                icon={<Mail className="h-4 w-4" />}
              />
              <form onSubmit={invite} className="space-y-4 px-5 py-5">
                <Field label={t("team.inviteEmail")} htmlFor="invite-email" required>
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
                  label={t("team.role")}
                  htmlFor="invite-role"
                  hint={roleOptions(t).find((r) => r.value === role)?.desc}
                >
                  <Select
                    id="invite-role"
                    value={role}
                    disabled={busy}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full"
                  >
                    {roleOptions(t).map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </Select>
                </Field>
                <Button type="submit" variant="primary" disabled={busy} loading={busy} className="w-full">
                  {busy ? t("team.inviteSending") : t("team.inviteSubmit")}
                </Button>
              </form>
            </Card>

            <Card>
              <CardHeader
                title={t("team.rolesTitle")}
                subtitle={t("team.rolesSubtitle")}
                icon={<Shield className="h-4 w-4" />}
              />
              <ul className="space-y-3 px-5 py-5">
                {roleOptions(t).map((option) => (
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
              <Callout tone="info" icon={<Info className="h-4 w-4" />} title={t("team.oneOwnerTitle")}>
                {t("team.oneOwnerBody")}
              </Callout>
            )}
          </aside>
        </div>
      </PageContainer>

      <Modal
        open={transferTarget !== null}
        onClose={() => setTransferTarget(null)}
        title={t("team.transferTitle")}
        description={t("team.transferCannotUndo")}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setTransferTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              loading={busy}
              onClick={transferTarget ? () => void transfer(transferTarget.userId) : undefined}
            >
              {t("team.transferConfirm")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-2">
            <span className="font-[600] text-ink">{transferTarget?.email}</span>{" "}
            {t("team.transferBodyPrefix")}
          </p>
          <Callout tone="warn" title={t("team.transferBillingNote")}>
            {t("team.transferBillingNoteBody")}
          </Callout>
        </div>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t("team.removeTitle")}
        description={removeTarget?.email}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setRemoveTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              loading={busy}
              onClick={removeTarget ? () => void remove(removeTarget.userId) : undefined}
            >
              {t("team.removeConfirm")}
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
