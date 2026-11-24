"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Crown, Mail, Users } from "lucide-react";
import { useI18n } from "../../i18n/react";
import { ensureCustomerSession } from "../../lib/session-config";
import { fetchWithSessionRetry, isSessionRenewedNotResent } from "../../lib/fetch-timeout";
import { codeMessageKey } from "../../lib/api-error-keys";
import { Avatar, Button, Card, CardHeader, ConfirmDialog, ErrorState, Input, PageContainer, PageHeader, Skeleton, StatusBadge } from "../../components/ui";

type Member = { userId: string; email: string; role: string; platformOwner: boolean; removableByCurrentOwner: boolean };
type Invitation = { id: string; email: string; expiresAt: string };
type Profile = { userId: string; email: string; role: string; platformOwner: boolean; tenant: { id: string } };
type Notice = { kind: "ok" | "err" | "warn"; message: string };
const PAGE_SIZE = 50;

export default function TeamPage() {
  const { t, formatDate } = useI18n();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [memberOffset, setMemberOffset] = useState(0);
  const [inviteOffset, setInviteOffset] = useState(0);
  const [moreMembers, setMoreMembers] = useState(false);
  const [moreInvitations, setMoreInvitations] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  // Guide form rule: move focus to the first error (the page-level
  // notice lives outside the invite form, so it gets its own ref).
  useEffect(() => {
    if (notice?.kind === "err") noticeRef.current?.focus();
  }, [notice]);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);

  const clearTeamData = useCallback(() => {
    setMembers([]);
    setInvitations([]);
    setMoreMembers(false);
    setMoreInvitations(false);
    setProfile(null);
    setMemberToRemove(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const session = await ensureCustomerSession();
        if (cancelled) return;
        if (!session.authenticated) {
          router.replace("/login?next=%2Fteam");
          return;
        }
        const [membersRes, settingsRes] = await Promise.all([
          fetchWithSessionRetry(`/api/team/members?limit=${PAGE_SIZE}&offset=${memberOffset}`, {
            credentials: "include", cache: "no-store", signal: controller.signal,
          }),
          fetchWithSessionRetry("/api/settings", {
            credentials: "include", cache: "no-store", signal: controller.signal,
          }),
        ]);
        if (!membersRes.ok || !settingsRes.ok) {
          if (!cancelled && (membersRes.status === 401 || settingsRes.status === 401)) router.replace("/login?next=%2Fteam");
          throw new Error("TEAM_LIST_UNAVAILABLE");
        }
        const [team, account] = await Promise.all([
          membersRes.json() as Promise<{ members: Member[]; hasMore: boolean }>,
          settingsRes.json() as Promise<Profile>,
        ]);
        let pending: { invitations: Invitation[]; hasMore: boolean } = { invitations: [], hasMore: false };
        if (account.role === "owner" && !cancelled) {
          const invitesRes = await fetchWithSessionRetry(`/api/team/invitations?limit=${PAGE_SIZE}&offset=${inviteOffset}`, {
            credentials: "include", cache: "no-store", signal: controller.signal,
          });
          if (!invitesRes.ok) {
            if (!cancelled && invitesRes.status === 401) router.replace("/login?next=%2Fteam");
            throw new Error("TEAM_INVITATIONS_UNAVAILABLE");
          }
          pending = await invitesRes.json() as { invitations: Invitation[]; hasMore: boolean };
        }
        if (cancelled) return;
        setMembers(team.members ?? []);
        setMoreMembers(team.hasMore === true);
        setInvitations(pending.invitations ?? []);
        setMoreInvitations(pending.hasMore === true);
        setProfile(account);
        setLoadError(false);
      } catch {
        if (!cancelled) {
          clearTeamData();
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [memberOffset, inviteOffset, revision, router, clearTeamData]);

  function refresh() {
    setLoading(true);
    setRevision(value => value + 1);
  }

  async function sendInvitation(event: React.FormEvent) {
    event.preventDefault();
    if (profile?.role !== "owner" || busy) return;
    const invitedEmail = email.trim();
    if (!invitedEmail) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetchWithSessionRetry("/api/team/invitations", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: invitedEmail }),
      }, { autoRetry: false });
      const result = await response.json().catch(() => ({})) as { code?: string };
      if (isSessionRenewedNotResent(response)) {
        setNotice({ kind: "warn", message: t("errors.sessionRenewedRetry") });
        return;
      }
      if (response.status === 503 && result.code === "INVITATION_DELIVERY_UNAVAILABLE") {
        setNotice({ kind: "warn", message: t("team.deliveryUnconfirmed") });
        setEmail("");
        if (inviteOffset !== 0) setInviteOffset(0);
        else refresh();
        return;
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          clearTeamData();
          if (response.status === 401) router.replace("/login?next=%2Fteam");
        }
        setNotice({ kind: "err", message: t(codeMessageKey(result.code) ?? "team.invitationFailed") });
        return;
      }
      setEmail("");
      setNotice({ kind: "ok", message: t("success.invitationSent") });
      if (inviteOffset !== 0) setInviteOffset(0);
      else refresh();
    } catch {
      setNotice({ kind: "err", message: t("team.invitationFailed") });
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvitation(id: string) {
    if (profile?.role !== "owner" || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetchWithSessionRetry(`/api/team/invitations?id=${encodeURIComponent(id)}`, {
        method: "DELETE", credentials: "include", cache: "no-store",
      });
      const result = await response.json().catch(() => ({})) as { code?: string };
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          clearTeamData();
          if (response.status === 401) router.replace("/login?next=%2Fteam");
        }
        setNotice({ kind: "err", message: t(codeMessageKey(result.code) ?? "team.invitationRevocationFailed") });
        return;
      }
      setNotice({ kind: "ok", message: t("success.invitationRevoked") });
      if (invitations.length === 1 && inviteOffset > 0) {
        setLoading(true);
        setInviteOffset(Math.max(0, inviteOffset - PAGE_SIZE));
      } else refresh();
    } catch {
      setNotice({ kind: "err", message: t("team.invitationRevocationFailed") });
    } finally {
      setBusy(false);
    }
  }

  async function removeMember() {
    const member = memberToRemove;
    if (profile?.role !== "owner" || !member?.removableByCurrentOwner || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetchWithSessionRetry(`/api/team/members?userId=${encodeURIComponent(member.userId)}`, {
        method: "DELETE", credentials: "include", cache: "no-store",
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          clearTeamData();
          if (response.status === 401) router.replace("/login?next=%2Fteam");
        }
        throw new Error("MEMBER_REMOVE_FAILED");
      }
      setNotice({ kind: "ok", message: t("success.memberRemoved") });
      if (members.length === 1 && memberOffset > 0) {
        setLoading(true);
        setMemberOffset(Math.max(0, memberOffset - PAGE_SIZE));
      } else refresh();
    } catch {
      setNotice({ kind: "err", message: t("team.memberRemoveFailed") });
    } finally {
      setBusy(false);
      setMemberToRemove(null);
    }
  }

  return (
    <>
      <PageHeader
        width="wide"
        icon={<Users className="h-4 w-4" />}
        title={t("nav.team")}
      />
      <PageContainer width="wide">
        <div className="space-y-6">
          {notice && (
            <p
              ref={noticeRef}
              tabIndex={-1}
              role={notice.kind === "err" ? "alert" : "status"}
              aria-live={notice.kind === "err" ? "assertive" : "polite"}
              className={`rounded-2xl border border-edge-subtle bg-surface px-4 py-3 text-sm ${
                notice.kind === "err" ? "text-bad" : notice.kind === "warn" ? "text-warn" : "text-ok"
              }`}
            >
              {notice.message}
            </p>
          )}

          {profile?.role === "owner" && (
            <Card className="rounded-[22px] border border-edge-subtle p-6 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Crown className="h-4 w-4 text-brand" aria-hidden />
                  <h2 className="text-base font-semibold text-ink">{t("team.inviteTitle")}</h2>
                </div>
                <StatusBadge tone="brand" icon={<Crown className="h-3.5 w-3.5 text-warn" aria-hidden />} label={t("team.role.owner")} size="sm" />
              </div>
              <form onSubmit={sendInvitation} className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <label className="block text-sm text-ink-2">
                  {t("team.inviteEmail")}
                  <Input
                    type="email"
                    dir="ltr"
                    required
                    maxLength={320}
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                </label>
                <Button type="submit" variant="primary" loading={busy} disabled={busy || !email.trim()}>
                  {busy ? t("team.inviteSending") : t("team.inviteSubmit")}
                </Button>
              </form>
            </Card>
          )}

          <div className={profile?.role === "owner" ? "grid items-start gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]" : "grid items-start gap-6"}>
            <Card className="overflow-hidden rounded-[22px] border border-edge-subtle shadow-sm">
              <CardHeader title={t("team.members")} icon={<Users className="h-4 w-4" />} />
              {loadError && (
                <div className="p-5">
                  <ErrorState title={t("team.loadMembersFailed")} message={t("team.loadMembersFailed")} retry={refresh} />
                </div>
              )}
              <ul className="divide-y divide-edge-subtle">
                {members.map(member => (
                  <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar name={member.email} size="sm" />
                      <bdi dir="ltr" className="min-w-0 break-all text-sm font-medium text-ink">{member.email}</bdi>
                    </span>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        tone={member.role === "owner" ? "brand" : "info"}
                        size="sm"
                        icon={member.role === "owner" ? <Crown className="h-3.5 w-3.5 text-warn" aria-hidden /> : undefined}
                        label={member.role === "owner" ? t("team.role.owner") : t("v4.team.fullAccess")}
                      />
                      {member.removableByCurrentOwner && (
                        <Button variant="danger" size="sm" disabled={busy} onClick={() => setMemberToRemove(member)}>
                          {t("team.removeFromWorkspace")}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {loading && (
                <div role="status" aria-busy="true" aria-label={t("common.loading")} className="space-y-3 p-5">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-5/6" />
                  <span className="sr-only">{t("common.loading")}</span>
                </div>
              )}
              {!loading && !loadError && members.length === 0 && (
                <p className="p-5 text-sm text-ink-3">{t("empty.members.description")}</p>
              )}
              {!loading && (memberOffset > 0 || moreMembers) && (
                <div className="flex justify-end gap-2 border-t border-edge-subtle p-4">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || memberOffset === 0}
                    onClick={() => { setLoading(true); setMemberOffset(v => Math.max(0, v - PAGE_SIZE)); }}
                  >
                    {t("common.previousPage")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !moreMembers}
                    onClick={() => { setLoading(true); setMemberOffset(v => v + PAGE_SIZE); }}
                  >
                    {t("common.nextPage")}
                  </Button>
                </div>
              )}
            </Card>

            {profile?.role === "owner" && (
              <Card className="overflow-hidden rounded-[22px] border border-edge-subtle shadow-sm">
                <CardHeader title={t("team.pendingInvitations")} icon={<Mail className="h-4 w-4" />} />
                {loadError && (
                  <div className="p-5">
                    <ErrorState title={t("team.loadInvitationsFailed")} message={t("team.loadInvitationsFailed")} retry={refresh} />
                  </div>
                )}
                <ul className="divide-y divide-edge-subtle">
                  {invitations.map(invitation => (
                    <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                      <span className="min-w-0">
                        <bdi dir="ltr" className="block break-all text-sm font-medium text-ink">{invitation.email}</bdi>
                        <span className="block text-xs tabular-nums text-ink-3">{formatDate(invitation.expiresAt)}</span>
                      </span>
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void revokeInvitation(invitation.id)}>
                        {t("team.revoke")}
                      </Button>
                    </li>
                  ))}
                </ul>
                {loading && (
                  <div role="status" aria-busy="true" aria-label={t("common.loading")} className="space-y-3 p-5">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-4/5" />
                    <span className="sr-only">{t("common.loading")}</span>
                  </div>
                )}
                {!loading && !loadError && invitations.length === 0 && (
                  <p className="p-5 text-sm text-ink-3">{t("team.noInvitations")}</p>
                )}
                {!loading && (inviteOffset > 0 || moreInvitations) && (
                  <div className="flex justify-end gap-2 border-t border-edge-subtle p-4">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || inviteOffset === 0}
                      onClick={() => { setLoading(true); setInviteOffset(v => Math.max(0, v - PAGE_SIZE)); }}
                    >
                      {t("common.previousPage")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || !moreInvitations}
                      onClick={() => { setLoading(true); setInviteOffset(v => v + PAGE_SIZE); }}
                    >
                      {t("common.nextPage")}
                    </Button>
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      </PageContainer>

      <ConfirmDialog
        open={memberToRemove !== null}
        onClose={() => setMemberToRemove(null)}
        onConfirm={removeMember}
        busy={busy}
        title={t("team.removeTitle")}
        description={t("team.removeBodyHistory")}
        confirmLabel={t("team.removeConfirm")}
      >
        {memberToRemove && (
          <div className="flex items-center gap-3 rounded-2xl border border-edge-subtle bg-surface-2 p-4">
            <Avatar name={memberToRemove.email} size="lg" tone="bad" />
            <bdi dir="ltr" className="min-w-0 break-all text-sm font-semibold text-ink">{memberToRemove.email}</bdi>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}
