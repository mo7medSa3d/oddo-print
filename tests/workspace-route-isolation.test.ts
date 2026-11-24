// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSegmentKey } from "next/dist/client/components/router-reducer/create-segment-key";
import { I18nProvider } from "../src/i18n/react";
import WorkspaceDetail from "../src/app/platform/tenants/[id]/page";

const fixture = vi.hoisted(() => ({ request: vi.fn(), searchParams: new URLSearchParams(), a: (key: string) => key,
  format: (value: unknown) => String(value ?? "") }));
vi.mock("next/navigation", () => ({ useSearchParams: () => fixture.searchParams }));
vi.mock("../src/components/platform/ManualAdmin", () => ({
  adminJson: fixture.request, controlClass: "control",
  useAdminText: () => ({ a: fixture.a, t: fixture.a, formatNumber: fixture.format, formatDate: fixture.format, formatDateTime: fixture.format }),
  AdminMetric: ({ label, value }: { label: string; value: ReactNode }) => h("p", null, label, value),
  AdminStatus: ({ status }: { status: string }) => h("span", null, status),
}));
vi.mock("../src/components/ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/components/ui")>(),
  Button: ({ loading: _loading, variant: _variant, ...props }: Record<string, unknown>) => h("button", props),
  Card: ({ children }: { children: ReactNode }) => h("div", null, children),
  PageHeader: ({ title }: { title: string }) => h("h1", null, title),
}));
vi.mock("next/link", () => ({ default: (props: Record<string, unknown>) => h("a", props) }));

const subscription = (id: string) => ({ planId: `plan-${id}`, planName: `Plan ${id}`, status: "active", effectiveStatus: "active",
  subscriptionType: "paid", monthlyQuota: 1000, term: "monthly", currentPeriodStart: "2026-10-01T00:00:00Z",
  currentPeriodEnd: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: false, internalReference: null,
  revision: 1, monthlyUsed: 0, nextReset: "2026-11-01T00:00:00Z" });
const detail = (id: string) => ({ workspace: { id, name: `Workspace ${id}`, lifecycle: "active", created_at: "2026-10-01", updated_at: "2026-10-01" },
  subscription: subscription(id), members: [], agents: [], printers: [], installations: [], credentials: [], jobs: [], events: [], history: [], requests: [],
  usage: { today: 0, month: 0, year: 0, monthlyHistory: [] } });
const plans = ["A", "B"].map(id => ({ id: `plan-${id}`, name: `Plan ${id}`, description: "", entitlements: { max_prints_per_period: 1000 }, isActive: true, isPublic: true, displayOrder: 0 }));
const params = (id: string) => Object.assign(Promise.resolve({ id }), { status: "fulfilled", value: { id } });
let root: Root, host: HTMLDivElement;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!;
async function render(id: string) {
  // Next16.4.2 layout-router uses this exact installed key for dynamic segments.
  // It deliberately omits the param value, so A→B retains the outer page state.
  // The tenants page now resolves copy through the shared t() catalogue, so
  // it renders under a real provider instead of the key-echo mock labels.
  await act(async () => root.render(h(I18nProvider, { initialLocale: "en", children: h(WorkspaceDetail, { key: createSegmentKey(["id", id, "d", null]), params: params(id) }) })));
}
async function enter(node: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.request.mockReset(); fixture.searchParams = new URLSearchParams(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("resets the exact workspace data and subscription draft before the next workspace loads", async () => {
  let resolveB!: (value: ReturnType<typeof detail>) => void;
  const pendingB = new Promise<ReturnType<typeof detail>>(resolve => { resolveB = resolve; });
  fixture.request.mockImplementation((url: string) => url === "/api/platform/plans" ? Promise.resolve({ plans })
    : url.endsWith("/A") ? Promise.resolve(detail("A")) : pendingB);
  expect(createSegmentKey(["id", "A", "d", null])).toBe(createSegmentKey(["id", "B", "d", null]));
  await render("A");
  await act(async () => button("Plans & subscriptions").click());
  // The reason now appears only in the confirmation step, not the main form.
  expect(host.querySelector("textarea")).toBeNull();
  await act(async () => button("Review changes").click());
  await enter(host.querySelector("textarea")!, "A private draft");
  // No step-up: the preview form has no password field anymore; the draft
  // alone proves the state that must reset across workspaces.
  expect(host.textContent).toContain("A private draft");
  await render("A");
  expect(host.textContent).toContain("A private draft");
  await render("B");
  expect(host.textContent).not.toContain("Workspace A");
  expect(host.textContent).not.toContain("A private draft");
  expect(button("Confirm and save")).toBeUndefined();
  await act(async () => resolveB(detail("B")));
  expect(host.textContent).toContain("Workspace B");
  await act(async () => button("Plans & subscriptions").click());
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector("select")!.value).toBe("plan-B");
});

it("follows a different selected customer request in the same workspace without leaking the previous draft", async () => {
  const first = {id:"req_A",planId:"plan-A",term:"monthly",requestedMonthlyQuota:1000,status:"pending",
    requesterName:"First client",requesterEmail:"first@example.test",createdAt:"2026-10-27T00:00:00Z"};
  const second = {...first,id:"req_B",planId:"plan-B",term:"yearly",requesterName:"Second client",requesterEmail:"second@example.test"};
  fixture.request.mockImplementation((url: string) => url === "/api/platform/plans" ? Promise.resolve({plans})
    : Promise.resolve({...detail("A"),requests:[first,second]}));
  fixture.searchParams = new URLSearchParams("request=req_A");
  await render("A");
  expect(host.textContent).toContain("First client");
  expect(host.textContent).toContain("req_A");
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("plan-A");
  fixture.searchParams = new URLSearchParams("request=req_B");
  await render("A");
  expect(host.textContent).toContain("Second client");
  expect(host.textContent).toContain("req_B");
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("plan-B");
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
