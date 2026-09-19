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

  it("discovers active tenant agents without making branch assignment a discovery gate", () => {
    const ctrlPy = read("odoo_addons/print_gateway/controllers/runtime_printers.py");
    expect(ctrlPy).toContain("api/odoo/agents");
    expect(ctrlPy).toContain("selected_agent_id");
    expect(ctrlPy).toContain("same Gateway tenant");
    expect(ctrlPy).not.toContain("allowed_agent_ids = {");
    expect(ctrlPy).not.toContain("print_gateway.runtime_agent_assignment");
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

  it("emits and listens for gateway:config_changed and unifies gateway status across desktop UI", () => {
    const commandsRs = read("src-tauri/src/commands.rs");
    expect(commandsRs).toContain("pub fn set_gateway_config(url: String, app: tauri::AppHandle)");
    expect(commandsRs).toContain("app.emit(\"gateway:config_changed\", &url)");

    const ipcTs = read("src/desktop/lib/ipc.ts");
    expect(ipcTs).toContain("export function onGatewayConfigChanged(");
    expect(ipcTs).toContain("listen<string>(\"gateway:config_changed\"");

    const mainTsx = read("src/desktop/main.tsx");
    expect(mainTsx).toContain("onGatewayConfigChanged");
    expect(mainTsx).toContain("const healthOk = Boolean(health && (health as { ok?: boolean }).ok !== false && !healthError);");
    expect(mainTsx).toContain("const [savedGatewayUrl, setSavedGatewayUrl] = useState(\"\");");
    expect(mainTsx).toContain("const [checkedGatewayUrl, setCheckedGatewayUrl] = useState(\"\");");
    expect(mainTsx).toContain("const probeGateway = useCallback(async (targetUrl: string): Promise<boolean>");
    expect(mainTsx).toContain("window.setTimeout(() => {");
    expect(mainTsx).toContain("const gatewayConnected = Boolean(");
    expect(mainTsx).toContain("checkedGatewayUrl === normalizedGatewayUrl");
    expect(mainTsx).toContain("await setGatewayUrl(target);");
    expect(mainTsx).toContain("setMsg({ text: \"Gateway connection verified and saved\", type: \"success\" });");
    expect(mainTsx).not.toContain("const saveGateway = useCallback");

    const overviewTsx = read("src/desktop/pages/Overview.tsx");
    expect(overviewTsx).toContain('s.gatewayUrl ? (s.gatewayConnected ? "Connected" : "Unreachable") : "Not configured"');

    const settingsTsx = read("src/desktop/pages/Settings.tsx");
    expect(settingsTsx).toContain("s.gatewayConnected ? \"Connected\" : s.gatewayUrl ? \"Unreachable\" : \"Not configured\"");
  });
});
