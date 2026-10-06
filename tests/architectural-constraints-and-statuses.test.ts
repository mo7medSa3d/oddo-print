import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("Architectural Constraints, ACLs, and Runtime Statuses", () => {
  it("enforces parent-company gateway config and branch inheritance in Odoo models", () => {
    const configPy = read("odoo_addons/print_gateway/models/gateway_config.py");
    expect(configPy).toContain("domain=\"[('parent_id', '=', False)]\"");
    expect(configPy).toContain("def _check_company_id(self):");
    expect(configPy).toContain("record.company_id and record.company_id.parent_id");
    expect(configPy).toContain("def unlink(self):");
    expect(configPy).toContain("self._check_admin()");

    const routerPy = read("odoo_addons/print_gateway/models/print_router.py");
    expect(routerPy).toContain("while root_company.parent_id:");
    expect(routerPy).toContain("root_company = root_company.parent_id");
    expect(routerPy).toContain('("company_id", "=", root_company.id)');
  });

  it("enables unlink permissions and removes delete='0' from Gateway Configuration views", () => {
    const accessCsv = read("odoo_addons/print_gateway/security/ir.model.access.csv");
    const adminLine = accessCsv.split("\n").find((line) => line.startsWith("access_print_gateway_config_admin,"));
    expect(adminLine).toBeDefined();
    expect(adminLine?.trim()).toBe(
      "access_print_gateway_config_admin,print_gateway.gateway_config admin,model_print_gateway_gateway_config,base.group_system,1,1,1,1"
    );

    const viewsXml = read("odoo_addons/print_gateway/views/gateway_config_views.xml");
    expect(viewsXml).not.toMatch(/<list[^>]*delete="0"/);
    expect(viewsXml).not.toMatch(/<form[^>]*delete="0"/);
  });

  it("keeps Pair Agent discovery broad while scoping Binding runtime agents to branch assignments", () => {
    const ctrlPy = read("odoo_addons/print_gateway/controllers/runtime_printers.py");
    expect(ctrlPy).toContain("api/odoo/agents");
    expect(ctrlPy).toContain("selected_agent_id");
    expect(ctrlPy).toContain("_assigned_runtime_agent_ids");
    expect(ctrlPy).toContain("assignment_only=False");
    expect(ctrlPy).toContain("if assignment_only:");
    expect(ctrlPy).toContain("assigned_agent_ids(company, branch)");
    expect(ctrlPy).toContain("The selected Gateway Agent is not assigned to this Odoo scope.");
    expect(ctrlPy).toContain("'selectedAgentId': selected");
  });

  it("dynamically computes live agent status using isAgentAvailableForJob", () => {
    const agentRoute = read("src/app/api/odoo/agents/route.ts");
    expect(agentRoute).toContain("isAgentAvailableForJob");
    expect(agentRoute).toContain("isAgentAvailableForJob(agent, now) ? \"online\" : \"offline\"");

    const agentFieldJs = read("odoo_addons/print_gateway/static/src/components/runtime_agent_field.js");
    expect(agentFieldJs).toContain("<t t-esc=\"agent.name\"/> — <t t-esc=\"agent.id\"/>");
    expect(agentFieldJs).not.toContain("<t t-esc=\"agent.name\"/> — <t t-esc=\"agent.id\"/> — <t t-esc=\"agent.status\"/>");
  });

  it("uses the paired Agent identity for the Desktop Gateway console without Manager login UI", () => {
    const consoleAuth = read("src/lib/console-auth.ts");
    expect(consoleAuth).toContain("validateAgent");
    expect(consoleAuth).toContain('kind: "agent"');

    const jobsPage = read("src/desktop/pages/Jobs.tsx");
    expect(jobsPage).not.toContain("loginManager");
    expect(jobsPage).not.toContain("Gateway manager sign-in");
    expect(jobsPage).not.toContain("managerUsername");
    expect(jobsPage).not.toContain("managerPassword");

    const ipcTs = read("src/desktop/lib/ipc.ts");
    expect(ipcTs).toContain('invoke<string>("gateway_agent_request"');
    expect(ipcTs).toContain("async function gatewayConsoleRequest(");

    const printersRoute = read("src/app/api/printers/route.ts");
    expect(printersRoute).toContain("validateConsoleAuth");
    expect(printersRoute).toContain("auth.agent.id");
    expect(printersRoute).toContain("eq(printers.agentId, agentId)");

    const jobsRoute = read("src/app/api/jobs/route.ts");
    expect(jobsRoute).toContain("validateConsoleAuth");
    expect(jobsRoute).toContain("eq(printJobs.agentId, auth.agent.id)");
  });

  it("keeps Windows HALFTONE rendering aligned with SetBrushOrgEx", () => {
    const pdfWindows = read("agent/internal/printer/pdf_windows.go");
    const mode = pdfWindows.indexOf("procSetStretchBltMode.Call(hdc, halftone)");
    const brush = pdfWindows.indexOf("procSetBrushOrgEx.Call(hdc, 0, 0, 0)");
    const stretch = pdfWindows.indexOf("procStretchDIBits.Call(");
    expect(mode).toBeGreaterThan(-1);
    expect(brush).toBeGreaterThan(mode);
    expect(stretch).toBeGreaterThan(brush);
    expect(pdfWindows).toContain("SetStretchBltMode(HALFTONE) failed");
    expect(pdfWindows).toContain("SetBrushOrgEx after HALFTONE failed");
  });

  it("does not classify an existing offline printer as an unassigned job", () => {
    const mainTsx = read("src/desktop/main.tsx");
    expect(mainTsx).toContain('dest === "unassigned" || pid === "unassigned" || !printers.some((p) => p.id === pid)');
    expect(mainTsx).not.toContain('dest === "unassigned" || pid === "unassigned" || !printers.some((p) => p.id === pid && p.status === "online")');
  });

  it("emits and listens for gateway:config_changed and unifies gateway status across desktop UI", () => {
    const commandsRs = read("src-tauri/src/commands.rs");
    expect(commandsRs).toContain("pub fn set_gateway_config(url: String, app: tauri::AppHandle)");
    expect(commandsRs).toContain("pub fn get_gateway_config() -> Result<GatewayConfig, String>");
    expect(commandsRs).toContain("fn atomic_write_settings(path: &Path, contents: &[u8]) -> Result<(), String>");
    expect(commandsRs).toContain("MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH");
    expect(commandsRs).toContain("file.sync_all()");
    expect(commandsRs).not.toContain("std::fs::write(&path, json)");
    expect(commandsRs).toContain("app.emit(\"gateway:config_changed\", &url)");

    const ipcTs = read("src/desktop/lib/ipc.ts");
    expect(ipcTs).toContain("export function onGatewayConfigChanged(");
    expect(ipcTs).toContain("listen<string>(\"gateway:config_changed\"");

    const mainTsx = read("src/desktop/main.tsx");
    expect(mainTsx).toContain("onGatewayConfigChanged");
    // Affirmative health only (C046): an empty/missing health object, a stale
    // probe, or a non-true ok flag must never read as connected.
    expect(mainTsx).toContain("ok === true");
    expect(mainTsx).toContain("healthFresh");
    expect(mainTsx).toContain("healthCheckedAt");
    expect(mainTsx).toContain("const [savedGatewayUrl, setSavedGatewayUrl] = useState(\"\");");
    expect(mainTsx).toContain("const [checkedGatewayUrl, setCheckedGatewayUrl] = useState(\"\");");
    expect(mainTsx).toContain("const probeGateway = useCallback(async (targetUrl: string): Promise<boolean>");
    expect(mainTsx).toContain("window.setTimeout(() => {");
    expect(mainTsx).toContain("const gatewayConnected = Boolean(");
    expect(mainTsx).toContain("checkedGatewayUrl === normalizedGatewayUrl");
    expect(mainTsx).toContain("const raw = gatewayUrl.trim();");
    expect(mainTsx).toContain("Auto-probe only the already-persisted Gateway");
    expect(mainTsx).toContain("const raw = savedGatewayUrl.trim();");
    expect(mainTsx).toContain("await setGatewayUrl(target);");
    expect(mainTsx).toContain('setMsg({ text: t("desktop.app.connectionVerified"), type: "success" });');
    expect(mainTsx).toContain('setMsg({ text: t("desktop.app.gatewaySettingsReadFailed"), type: "error" });');
    expect(mainTsx).not.toContain("const saveGateway = useCallback");

    const overviewTsx = read("src/desktop/pages/Overview.tsx");
    expect(overviewTsx).toContain('s.gatewayUrl ? (s.gatewayConnected ? t("desktop.status.connected") : t("desktop.status.unreachable")) : t("desktop.status.notConfigured")');

    const settingsTsx = read("src/desktop/pages/Settings.tsx");
    expect(settingsTsx).toContain('s.gatewayConnected ? t("desktop.settings.connected") : s.gatewayUrl ? t("desktop.settings.unreachable") : t("desktop.settings.notConfigured")');
  });
});


describe("Part 6 desktop hardening", () => {

  it("loads persisted local printers at desktop startup and preserves them across gateway changes", () => {
    const source = read("src/desktop/main.tsx");
    expect(source).toContain("void refreshLocalPrinters();");
    expect(source).toContain("const list = await getPrinters();");
    expect(source).not.toContain("setDiscoveredPrinters([])");
    const overview = read("src/desktop/pages/Overview.tsx");
    expect(overview).toContain("pendingLocalPrinters");
    expect(overview).toContain("desktop.printers.waitingTitle");
  });

  it("closes the mobile sidebar toward the correct physical side in RTL", () => {
    const source = read("src/desktop/components/Sidebar.tsx");
    expect(source).toContain("max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full");
    expect(source).toContain("lg:translate-x-0");
  });

  it("keeps raw agent operational diagnostics out of localized desktop status copy", () => {
    const main = read("src/desktop/main.tsx");
    const agents = read("src/desktop/pages/Agents.tsx");
    expect(main).toContain('t("desktop.app.agentStarted")');
    expect(main).toContain('t("desktop.app.agentPaired")');
    expect(main).not.toContain("setMsg({ text: r ||");
    expect(agents).toContain("agentStatusNoteKey");
    expect(agents).not.toContain("String(anyStatus.note)");
  });

});


describe("Part 6 status evidence hardening", () => {

  it("exposes freshness separately from reported physical printer status", () => {
    const api = read("src/app/api/printers/route.ts");
    const odoo = read("src/app/api/odoo/printers/route.ts");
    const shared = read("src/shared/job-vocabulary.ts");
    expect(api).toContain("reportedStatus: printer.status");
    expect(api).toContain("freshness: getPrinterObservationFreshness");
    expect(api).toContain("agentFreshness: getAgentHeartbeatFreshness");
    expect(odoo).toContain("reportedStatus: row.status");
    expect(odoo).toContain("freshness: getPrinterObservationFreshness");
    expect(shared).toContain('case "stale":');
    expect(shared).toContain('return word("status.stale");');
    expect(shared).toContain("printerObservationFreshness(");
  });

  it("classifies persisted capability and unsupported-transport job failures for both UIs", () => {
    const shared = read("src/shared/job-vocabulary.ts");
    const desktop = read("src/desktop/main.tsx");
    const web = read("src/app/dashboard/dashboard-client.tsx");
    expect(shared).toContain('value.includes("CAPABILITY_MISMATCH")');
    expect(shared).toContain('value.includes("ERR_UNSUPPORTED_TRANSPORT")');
    expect(shared).toContain('value.includes("UNSUPPORTED PROTOCOL")');
    expect(shared).toContain('job.unsupportedProtocol');
    expect(desktop).toContain("jobFailurePresentation");
    expect(web).toContain("jobFailurePresentation(selectedJobView.error, locale)");
  });

});
