// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TeamPage from "../src/app/team/page";
import WorkspaceDetail from "../src/app/platform/tenants/[id]/page";
import { I18nProvider } from "../src/i18n/react";
import { translate } from "../src/i18n/translate";
import { fetchWithTimeout } from "../src/lib/fetch-timeout";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), searchParams: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, useSearchParams: () => navigation.searchParams }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: Record<string, unknown>) => h("a", props, children as ReactNode) }));
// Team page loads and removals now go through fetchWithSessionRetry
// (silent refresh + retry once) instead of plain fetchWithTimeout. One
// shared mock keeps the existing call assertions (deletes(), URLs) intact;
// the renewed-not-resent stub mirrors the real header check for fixture
// responses, which never carry the renewal marker.
const sharedFetch = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/fetch-timeout", () => ({ fetchWithTimeout: sharedFetch, fetchWithSessionRetry: sharedFetch, isSessionRenewedNotResent: (response: { headers?: { get: (name: string) => string | null } }) => { try { return response.headers?.get("X-Yaseir-Session-Renewed") === "1"; } catch { return false; } } }));
vi.mock("../src/lib/session-config", () => ({ ensureCustomerSession: vi.fn(async () => ({ authenticated: true })) }));

const member = { id: "member-one", userId: "member-one", name: "Demo member", email: "member@example.invalid", role: "admin", platformOwner: false, removableByCurrentOwner: true };
const workspace = { id: "demo-workspace", name: "Demo workspace", ownerName: "Demo owner", lifecycle: "active", created_at: "2026-10-31T12:00:00Z", updated_at: "2026-10-31T12:00:00Z" };
const response = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value }) as Response;
const fetchMock = vi.mocked(fetchWithTimeout);
const deletes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "DELETE");
let root: Root;
let host: HTMLDivElement;
let finishDelete: (value: Response) => void;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear();
  fetchMock.mockReset();
  vi.spyOn(window, "confirm").mockImplementation(() => { throw new Error("Native browser confirmation must not be used"); });
  fetchMock.mockImplementation(async (input, options) => {
    if (options?.method === "DELETE") return new Promise<Response>(resolve => { finishDelete = resolve; });
    const url = String(input);
    if (url === "/api/settings") return response({ userId: "owner", role: "owner", tenant: { id: workspace.id } });
    if (url.startsWith("/api/team/members")) return response({ members: [member], hasMore: false });
    if (url.startsWith("/api/team/invitations")) return response({ invitations: [], hasMore: false });
    if (url === "/api/platform/plans") return response({ plans: [] });
    return response({ workspace, subscription: null, members: [member], agents: [], printers: [], installations: [], credentials: [], jobs: [], events: [], history: [], requests: [], usage: { today: 0, month: 0, year: 0, monthlyHistory: [] } });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(label: string, within: ParentNode = document): HTMLButtonElement {
  const result = [...within.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  expect(result, `Missing button: ${label}`).toBeDefined();
  return result!;
}

async function render(surface: "team" | "platform", locale: "en" | "ar") {
  localStorage.setItem("yaseir:locale", locale);
  document.cookie = `yaseir_locale=${locale}; path=/`;
  const params = Promise.resolve({ id: workspace.id });
  await act(async () => {
    await params;
    root.render(h(I18nProvider, { initialLocale: locale, children: surface === "team" ? h(TeamPage) : h(WorkspaceDetail, { params }) }));
  });
  if (surface === "platform") await act(async () => button(translate(locale, "v4.admin.members"), host).click());
}

for (const surface of ["team", "platform"] as const) {
  describe(`${surface} member removal confirmation`, () => {
    it.each(["en", "ar"] as const)("requires explicit confirmation, allows cancel, and blocks repeat submission (%s)", async locale => {
      await render(surface, locale);
      const opener = button(translate(locale, "team.removeFromWorkspace"), host);
      await act(async () => { opener.focus(); opener.click(); });
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.getAttribute("aria-label")).toBe(translate(locale, "team.removeTitle"));
      expect(dialog.textContent).toContain(member.email);
      expect(dialog.textContent).toContain(translate(locale, "team.removeBodyHistory"));
      expect(deletes()).toHaveLength(0);
      expect(window.confirm).not.toHaveBeenCalled();
      await act(async () => button(translate(locale, "common.cancel"), dialog).click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(deletes()).toHaveLength(0);
      expect(document.activeElement).toBe(opener);
      await act(async () => { opener.focus(); opener.click(); });
      const confirm = button(translate(locale, "team.removeConfirm"), document.querySelector('[role="dialog"]')!);
      await act(async () => confirm.click());
      expect(deletes()).toHaveLength(1);
      expect(String(deletes()[0][0])).toContain(`userId=${member.userId}`);
      expect(confirm.disabled).toBe(true);
      await act(async () => {
        confirm.click();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(deletes()).toHaveLength(1);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => finishDelete(response({ ok: true })));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("reports failure without claiming the member was removed", async () => {
      await render(surface, "en");
      await act(async () => button(translate("en", "team.removeFromWorkspace"), host).click());
      await act(async () => button(translate("en", "team.removeConfirm"), document.querySelector('[role="dialog"]')!).click());
      await act(async () => finishDelete(response({ error: "Unavailable" }, 503)));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
      expect(host.textContent).toContain(member.email);
    });
  });
}
