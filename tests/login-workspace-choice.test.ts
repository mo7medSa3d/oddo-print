// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../src/app/login/page";
import { fetchWithTimeout } from "../src/lib/fetch-timeout";

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }));

vi.mock("../src/lib/fetch-timeout", () => ({ fetchWithTimeout: vi.fn() }));
vi.mock("../src/lib/session-config", () => ({ ensureCustomerSession: async () => ({ authenticated: false }) }));
vi.mock("../src/components/AuthShell", () => ({ AuthShell: ({ children }: { children: ReactNode }) => h("div", null, children) }));
vi.mock("next/navigation", () => {
  return { useRouter: () => router };
});
vi.mock("next/link", () => ({ default: ({ children, ...props }: Record<string, unknown>) => h("a", props, children as ReactNode) }));

let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.mocked(fetchWithTimeout);
const workspaceResponse = {
  selectionToken: "synthetic-selection-token",
  workspaces: ["tenant-reception", "tenant-kitchen"],
  workspaceOptions: [{ id: "tenant-reception", name: "Reception team" }, { id: "tenant-kitchen", name: "Kitchen team" }],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock.mockReset();
  router.replace.mockReset(); router.refresh.mockReset();
  window.history.replaceState({}, "", "/login");
  fetchMock.mockResolvedValue({ status: 409, ok: false, json: async () => workspaceResponse } as Response);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function signIn() {
  await act(async () => { root.render(h(LoginPage)); });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

describe("workspace selection after authenticated sign in", () => {
  it("forwards an offer from the validated invitation destination and opens the joined workspace", async () => {
    window.history.replaceState({}, "", "/login?switch=1&next=" + encodeURIComponent("/invite?token=offered-token"));
    fetchMock.mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ invitationAccepted: true, tenantId: "invited" }) } as Response);
    await signIn();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).inviteToken).toBe("offered-token");
    expect(router.replace).toHaveBeenCalledWith("/dashboard");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("never forwards a token taken from an external return destination", async () => {
    window.history.replaceState({}, "", "/login?switch=1&next=" + encodeURIComponent("https://other.test/invite?token=untrusted"));
    await signIn();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty("inviteToken");
  });

  it("shows workspace names and submits the selected immutable ID and selection token", async () => {
    await signIn();
    const choice = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("Kitchen team"));
    expect(choice).toBeDefined();
    await act(async () => choice?.click());
    const [path, request] = fetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/auth/select-tenant");
    expect(JSON.parse(String(request?.body))).toEqual({ tenantId: "tenant-kitchen", selectionToken: "synthetic-selection-token" });
  });

  it("retains legacy ID-only selection without allowing unrelated option IDs", async () => {
    fetchMock.mockResolvedValueOnce({ status: 409, ok: false, json: async () => ({ ...workspaceResponse, workspaceOptions: [{ id: "tenant-unrelated", name: "Wrong workspace" }] }) } as Response);
    await signIn();
    expect(host.textContent).toContain("Workspace …itchen");
    expect(host.textContent).not.toContain("Wrong workspace");
    const legacyChoice = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("Workspace …itchen"));
    await act(async () => legacyChoice?.click());
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).tenantId).toBe("tenant-kitchen");
  });

  it.each(["email", "password"])("clears stale workspace choices when %s changes", async (field) => {
    await signIn();
    const input = host.querySelector<HTMLInputElement>(`#${field}`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "another-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).not.toContain("Choose a workspace");
    expect(host.textContent).not.toContain("Workspace …itchen");
    expect(host.textContent).not.toContain("Kitchen team");
  });
});
