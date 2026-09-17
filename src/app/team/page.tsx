"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Member = { userId: string; email: string; role: string };
type Invitation = { id: string; email: string; role: string; expiresAt: string };

export default function TeamPage() {
  const router = useRouter();
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  function showMessage(nextMessage: string, isError = false) {
    setMessageIsError(isError);
    setMessage(nextMessage);
    requestAnimationFrame(() => feedbackRef.current?.focus());
  }

  async function load() {
    const [membersRes, invitationsRes] = await Promise.all([
      fetch("/api/team/members", {
        credentials: "include",
        cache: "no-store",
      }),
      fetch("/api/team/invitations", {
        credentials: "include",
        cache: "no-store",
      }),
    ]);
    if (membersRes.ok) setMembers((await membersRes.json()).members ?? []);
    if (invitationsRes.ok) {
      setInvitations((await invitationsRes.json()).invitations ?? []);
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/team/members", {
        credentials: "include",
        cache: "no-store",
      }),
      fetch("/api/team/invitations", {
        credentials: "include",
        cache: "no-store",
      }),
    ])
      .then(async ([membersRes, invitationsRes]) => {
        if (!active) return;
        if (membersRes.ok) setMembers((await membersRes.json()).members ?? []);
        if (invitationsRes.ok) {
          setInvitations((await invitationsRes.json()).invitations ?? []);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
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
      showMessage("Invitation sent.");
      void load();
    } catch (error) {
      showMessage(
        error instanceof Error ? error.message : "Invitation failed",
        true
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateRole(userId: string, nextRole: string) {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/team/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ userId, role: nextRole }),
    });
    if (response.ok) {
      await load();
    } else {
      showMessage((await response.json()).error ?? "Role update failed", true);
    }
    setBusy(false);
  }

  async function revokeInvitation(id: string) {
    setBusy(true);
    setMessage("");
    const response = await fetch(
      `/api/team/invitations?id=${encodeURIComponent(id)}`,
      { method: "DELETE", credentials: "include" }
    );
    if (response.ok) {
      await load();
    } else {
      showMessage(
        (await response.json()).error ?? "Invitation revocation failed",
        true
      );
    }
    setBusy(false);
  }

  async function remove(userId: string) {
    setBusy(true);
    setMessage("");
    const response = await fetch(
      `/api/team/members?userId=${encodeURIComponent(userId)}`,
      { method: "DELETE", credentials: "include" }
    );
    if (response.ok) {
      await load();
    } else {
      showMessage((await response.json()).error ?? "Member removal failed", true);
    }
    setBusy(false);
  }

  async function transfer(userId: string) {
    if (
      !window.confirm(
        "Transfer workspace ownership to this member? Your current session will be signed out."
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/team/ownership", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ userId }),
    });
    const data = await response.json();
    if (!response.ok) {
      showMessage(data.error ?? "Ownership transfer failed", true);
      setBusy(false);
      return;
    }
    router.push("/login");
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-bold text-ink">Team</h1>
      <p className="mt-1 text-sm text-ink-3">
        Invite staff and manage workspace roles.
      </p>
      <form
        onSubmit={invite}
        aria-busy={busy}
        className="card mt-6 flex flex-col gap-3 p-5 md:flex-row md:items-end"
      >
        <label className="flex-1 text-sm font-semibold text-ink">
          Email
          <input
            type="email"
            required
            disabled={busy}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-lg border border-edge bg-surface p-2.5 font-normal disabled:opacity-50"
          />
        </label>
        <label className="text-sm font-semibold text-ink">
          Role
          <select
            value={role}
            disabled={busy}
            onChange={(event) => setRole(event.target.value)}
            className="mt-1 rounded-lg border border-edge bg-surface p-2.5 font-normal disabled:opacity-50"
          >
            <option>viewer</option>
            <option>operator</option>
            <option>admin</option>
            <option>integration_admin</option>
            <option>billing_admin</option>
          </select>
        </label>
        <button
          disabled={busy}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Sending…" : "Invite"}
        </button>
      </form>
      {message && (
        <p
          ref={feedbackRef}
          role={messageIsError ? "alert" : "status"}
          tabIndex={-1}
          className="mt-3 text-sm text-ink-2 outline-none"
        >
          {message}
        </p>
      )}
      <div className="mt-6 overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-surface-2 text-ink-3">
            <tr>
              <th className="p-3">Member</th>
              <th className="p-3">Role</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId} className="border-t border-edge">
                <td className="p-3 text-ink">{member.email}</td>
                <td className="p-3">
                  <select
                    disabled={member.role === "owner" || busy}
                    value={member.role}
                    onChange={(event) =>
                      void updateRole(member.userId, event.target.value)
                    }
                    className="rounded border border-edge bg-surface p-1.5 disabled:opacity-50"
                  >
                    <option>owner</option>
                    <option>admin</option>
                    <option>operator</option>
                    <option>viewer</option>
                    <option>integration_admin</option>
                    <option>billing_admin</option>
                  </select>
                </td>
                <td className="p-3 text-right">
                  {member.role !== "owner" && (
                    <span className="space-x-3 whitespace-nowrap">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Transfer ownership to ${member.email}`}
                        onClick={() => void transfer(member.userId)}
                        className="font-semibold text-brand disabled:opacity-50"
                      >
                        Transfer
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Remove ${member.email}`}
                        onClick={() => void remove(member.userId)}
                        className="font-semibold text-bad disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {invitations.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl border border-edge bg-surface">
          <div className="border-b border-edge bg-surface-2 p-3 text-sm font-semibold text-ink">
            Pending invitations
          </div>
          <div className="divide-y divide-edge">
            {invitations.map((invitation) => (
              <div
                key={invitation.id}
                className="flex items-center justify-between gap-4 p-3 text-sm"
              >
                <div>
                  <div className="font-semibold text-ink">
                    {invitation.email}
                  </div>
                  <div className="text-xs text-ink-3">
                    {invitation.role} · expires{" "}
                    {new Date(invitation.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Revoke invitation for ${invitation.email}`}
                  onClick={() => void revokeInvitation(invitation.id)}
                  className="font-semibold text-bad disabled:opacity-50"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
