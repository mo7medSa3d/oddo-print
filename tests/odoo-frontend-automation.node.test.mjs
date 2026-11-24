import { receiptGeometry, verifiedPrinter } from "./helpers/odoo-printer-geometry.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve("odoo_addons19/print_gateway/static/src");

async function load(relative, extra = {}, overrides = {}) {
  const registry = { category: () => ({ add() {}, contains: () => false }) };
  const stubs = {
    "@odoo/owl": { Component: class {}, onWillStart() {}, onWillUnmount() {}, onMounted() {}, useEffect() {}, useState: v => v, xml: () => "" },
    "@web/core/registry": { registry },
    "@web/core/network/rpc": { rpc() {} },
    "@web/core/l10n/translation": { _t: value => value },
    "@web/core/browser/browser": { browser: {} },
    "@web/core/dropdown/dropdown": { Dropdown: class {} },
    "@web/core/dropdown/dropdown_item": { DropdownItem: class {} },
    "@web/core/user": { user: { lang: "en_US", userId: 4 } },
    "@web/core/utils/hooks": { useService() {} },
    ...overrides,
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...extra });
  const modules = new Map();
  async function moduleFor(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const sourceModule = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), { context, identifier: filename });
    modules.set(filename, sourceModule);
    await sourceModule.link(async (id, importing) => {
      if (stubs[id]) return new vm.SyntheticModule(Object.keys(stubs[id]), function () {
        for (const [key, value] of Object.entries(stubs[id])) this.setExport(key, value);
      }, { context });
      assert.ok(id.startsWith("."), `unknown external Odoo import ${id}`);
      return moduleFor(path.resolve(path.dirname(importing.identifier), `${id}.js`));
    });
    return sourceModule;
  }
  const entryModule = await moduleFor(path.join(root, relative));
  await entryModule.evaluate();
  return entryModule.namespace;
}



test("monthly allowance reset shows the exact UTC boundary from Saudi and western browser timezones", async () => {
  for (const browserZone of ["Asia/Riyadh", "America/Los_Angeles"]) {
    const dialogs = [];
    const { showGatewayBillingLimitDialog } = await load("js/gateway_limit_dialog.js", {
      Intl: { DateTimeFormat: function (_locale, options) {
        return new Intl.DateTimeFormat("en-US", { timeZone: browserZone, ...options });
      } },
    }, {
      "@web/core/confirmation_dialog/confirmation_dialog": { ConfirmationDialog: class {} },
      "@web/core/l10n/translation": { _t: (message, ...values) => {
        let index = 0;
        return message.replace(/%s/g, () => String(values[index++]));
      } },
    });
    assert.equal(showGatewayBillingLimitDialog({ services: {
      dialog: { add: (_component, props) => dialogs.push(props) }, action: {},
    } }, {
      entitlement: "max_prints_per_period", message: "Allowance reached",
      used: 100, limit: 100, retryAfterSeconds: null, periodEnd: "2026-11-01T00:00:00Z",
    }), true);
    assert.match(dialogs[0].body, /Monthly allowance resets \(UTC\): Nov 1, 2026, 12:00 AM UTC/,
      `The commercial boundary must not shift with browser timezone ${browserZone}`);
  }
});

test("mock verification uses native queue/service/device proof instead of claiming all hardware is a Windows queue", async () => {
  const { validatedOperationalVerification } = await load("js/printer_verification.js");
  for (const [id, connectionType, protocol, method, identityStrength] of [
    ["spooler-native", "spooler", "spooler", "windows_queue", "queue"],
    ["network-native", "network", "escpos", "snmp_printer", "device"],
    ["usb-native", "usb", "escpos", "usb_interface", "device"],
    ["ipp-native", "ipp", "ipp", "ipp_attributes", "service"],
  ]) {
    const printer = verifiedPrinter({ id, connectionType, protocol, capabilities: { geometry: receiptGeometry(384, 203, id) } });
    const proof = printer.capabilities.operational_verification;
    assert.equal(proof.method, method);
    assert.equal(proof.identity_strength, identityStrength);
    assert.equal(validatedOperationalVerification(proof, printer)?.method, method);
    if (identityStrength !== "queue") {
      assert.equal(validatedOperationalVerification({ ...proof, identity_strength: "queue" }, printer), null,
        "forged Windows-queue proof cannot represent a different physical transport");
    }
  }
});

test("POS picker offers only physical JPEG transports and declared ESC/POS raster capability", async () => {
  const { RuntimePrinterField } = await load("components/runtime_printer_field.js");
  const field = Object.create(RuntimePrinterField.prototype);
  // The legacy/USB spooler spellings are accepted by the POS transport
  // rule itself; they were previously dropped only as a side effect of
  // the picker's verification filter, which no longer exists (operational
  // verification is background evidence, not an eligibility gate).
  const cases = [
    ["queue", "spooler", "spooler", undefined, true],
    ["legacy-queue", "windows_spooler", "windows_spooler", undefined, true],
    ["usb-queue", "usb", "spooler", undefined, true],
    ["legacy-usb-queue", "usb", "windows_spooler", undefined, true],
    ["tcp-driver-label", "network", "spooler", undefined, false],
    ["tcp-legacy-label", "network", "windows_spooler", undefined, false],
    ["wrong-transport", "serial", "spooler", undefined, false],
    ["escpos", "network", "escpos", undefined, true],
    ["explicit-raster", "network", "escpos", [" JPEG "], true],
    ["explicit-escpos", "network", "escpos", [" ESCPos "], true],
    ["explicit-image", "network", "escpos", ["image"], true],
    ["conflict", "network", "escpos", ["zpl"], false],
    ["empty", "network", "escpos", [], false],
    ["malformed", "network", "escpos", "escpos", false],
    ["null", "network", "escpos", null, false],
    ["direct-usb", "usb", "escpos", ["image"], true],
    ["ipp-document", "ipp", "ipp", ["image"], false],
  ];
  field.props = { record: { data: {} } };
  field.state = { destinationType: "pos", printers: cases.map(([id, connectionType, protocol, supported]) => verifiedPrinter({
    id, connectionType, protocol, capabilities: { geometry: receiptGeometry(576, 203, id),
      ...(supported === undefined ? {} : { supported_protocols: supported }) },
  })) };
  const expected = cases.filter(row => row[4]).map(row => row[0]);
  assert.deepEqual(Array.from(field.filteredPrinters, row => row.id), expected);
  field.state.destinationType = "pos_printer";
  assert.deepEqual(Array.from(field.filteredPrinters, row => row.id), expected);
  field.state.destinationType = "report";
  assert.deepEqual(Array.from(field.filteredPrinters, row => row.id),
    cases.map(row => row[0]),
    "reports list every discovered printer: no verification or canonical-transport eligibility filter remains");
});

test("POS picker rejects unknown, mismatched or incomplete geometry before selecting a receipt destination", async () => {
  const { RuntimePrinterField } = await load("components/runtime_printer_field.js");
  const field = Object.create(RuntimePrinterField.prototype);
  field.props = { record: { data: {} } };
  const printer = (id, connectionType, changes = {}, absent = []) => {
    const geometry = { ...receiptGeometry(576, 203, id), ...changes };
    for (const key of absent) delete geometry[key];
    return { id, connectionType, protocol: connectionType === "spooler" ? "spooler" : "escpos",
      capabilities: { geometry } };
  };
  const printers = [
    { id: "unknown", connectionType: "spooler", protocol: "spooler", capabilities: {} },
    printer("wrong-id", "spooler", { printer_id: "different-printer" }),
    printer("no-dpi", "spooler", {}, ["dpi_y"]),
    printer("no-media", "spooler", {}, ["paper_width_mm"]),
    printer("raw-no-command", "usb", {}, ["raster_command"]),
    printer("raw-typography", "usb", {}, ["paper_width_mm"]),
    printer("driver-complete", "spooler"),
  ];
  field.state = { destinationType: "pos", printers: printers.map(verifiedPrinter) };
  for (const destinationType of ["pos", "pos_printer"]) {
    field.state.destinationType = destinationType;
    assert.deepEqual(Array.from(field.filteredPrinters, row => row.id), ["raw-typography", "driver-complete"]);
  }
});

test("synchronous RPC factory failure releases its timer/XHR and cannot later cancel a completed request", async () => {
  const timers = new Set();
  let aborted = 0;
  const { startRpcWithDeadline } = await load("js/async_control.js", {
    XMLHttpRequest: class { abort() { aborted += 1; } },
    setTimeout: callback => { timers.add(callback); return callback; },
    clearTimeout: timer => timers.delete(timer),
  });
  const failure = new Error("RPC setup failed");
  const request = startRpcWithDeadline(() => { throw failure; }, "/read-only", {});
  await assert.rejects(request.promise, error => error === failure);
  assert.equal(timers.size, 0);
  assert.equal(aborted, 1);
  request.cancel();
  assert.equal(aborted, 1, "settled request cancellation is a no-op");
});

test("language failure after unmount cannot notify, while a mounted failure still gives feedback", async () => {
  const { PrintGatewayLanguageSwitcher } = await load("components/language_switcher.js");
  for (const alive of [false, true]) {
    const messages = [];
    const field = Object.create(PrintGatewayLanguageSwitcher.prototype);
    field.alive = alive;
    field.orm = { write: async () => { throw new Error("language write failed"); } };
    field.notification = { add: (...args) => messages.push(args) };
    await field.selectLanguage("ar_001");
    assert.equal(messages.length, alive ? 1 : 0);
  }
});

test("language change refreshes the server session before the first page reload", async () => {
  const events = [];
  let resolveSession;
  const session = new Promise(resolve => { resolveSession = resolve; });
  const { PrintGatewayLanguageSwitcher } = await load("components/language_switcher.js", {}, {
    "@web/core/network/rpc": { rpc: async (route, params) => {
      assert.equal(route, "/web/session/get_session_info");
      assert.equal(Object.keys(params).length, 0);
      events.push("refresh-session");
      return session;
    } },
    "@web/core/user": { user: { lang: "en-US", userId: 4, updateContext: () => events.push("update-client") } },
    "@web/core/browser/browser": { browser: { location: { reload: () => events.push("reload") } } },
  });
  const field = Object.create(PrintGatewayLanguageSwitcher.prototype);
  field.alive = true;
  field.orm = { write: async () => events.push("write-language") };
  field.notification = { add() { assert.fail("successful switch must not show an error"); } };
  const pending = field.selectLanguage("ar_001");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["write-language", "refresh-session"]);
  resolveSession({ user_context: { lang: "ar_001" } });
  await pending;
  assert.deepEqual(events, ["write-language", "refresh-session", "update-client", "reload"]);
});

test("an unavailable or stale language session never reloads with the previous layout", async () => {
  for (const reply of [null, { user_context: { lang: "en_US" } }]) {
    let reloaded = false;
    const messages = [];
    const { PrintGatewayLanguageSwitcher } = await load("components/language_switcher.js", {}, {
      "@web/core/network/rpc": { rpc: async () => { if (reply === null) throw new Error("session unavailable"); return reply; } },
      "@web/core/user": { user: { lang: "en-US", userId: 4, updateContext() {} } },
      "@web/core/browser/browser": { browser: { location: { reload: () => { reloaded = true; } } } },
    });
    const field = Object.create(PrintGatewayLanguageSwitcher.prototype);
    field.alive = true;
    field.orm = { write: async () => true };
    field.notification = { add: (...args) => messages.push(args) };
    await field.selectLanguage("ar_001");
    assert.equal(reloaded, false);
    assert.equal(messages.length, 1);
  }
});


test("Odoo Apps description uses translated manifest metadata without a static override", () => {
  const base = path.resolve("odoo_addons19/print_gateway");
  const manifest = fs.readFileSync(path.join(base, "__manifest__.py"), "utf8");
  const catalog = fs.readFileSync(path.join(base, "i18n/ar.po"), "utf8");
  const routing = fs.readFileSync(path.join(base, "views/binding_views.xml"), "utf8");
  const config = fs.readFileSync(path.join(base, "models/print_config.py"), "utf8");
  const menus = fs.readFileSync(path.join(base, "views/menu.xml"), "utf8");
  assert.equal(fs.existsSync(path.join(base, "static/description/index.html")), false);
  for (const image of ["pos-receipt-printing.jpg", "invoice-printing.jpg"]) {
    assert.equal(fs.existsSync(path.join(base, "static/description", image)), false);
    assert.doesNotMatch(manifest, new RegExp(`static/description/${image}`));
  }
  assert.doesNotMatch(manifest, /github\.com/);
  assert.match(manifest, /https:\/\/print\.yaseir\.cloud\//);
  assert.match(catalog, /model:ir\.module\.module,description:base\.module_print_gateway/);
  assert.match(catalog, /model:ir\.module\.module,summary:base\.module_print_gateway/);
  assert.match(routing, /widget="gateway_runtime_agent_binding"/);
  assert.match(routing, /widget="gateway_runtime_printer"/);
  assert.equal(fs.existsSync(path.join(base, "static/src/components/printers_overview.xml")), false);
  assert.equal(fs.existsSync(path.join(base, "static/src/components/printers_overview.js")), false);
  assert.doesNotMatch(menus, /menu_print_gateway_printers|menu_print_gateway_advanced|action_print_gateway_printers/);
  assert.match(config, /context\["default_branch_id"\] = self\.env\.company\.id/);
  assert.match(menus, /name="Automatic Printing"/);
});


test("native print route switches Agent without retaining a printer from another Agent", async () => {
  const { RuntimeAgentField } = await load("components/runtime_agent_field.js");
  const updates = [];
  const view = Object.create(RuntimeAgentField.prototype);
  view.props = { name: "runtime_agent_id", record: {
    data: { company_id: [10, "Company"], branch_id: [21, "Branch"], runtime_agent_id: "agent-old", printer_id: "printer-old" },
    fields: { printer_id: {} },
    update: value => updates.push(value),
  } };
  assert.equal(view.companyId, 10);
  assert.equal(view.branchId, 21);
  assert.equal(view.scopeKey(10, 21, true), "10|21|1");
  view.onChange({ target: { value: "agent-new" } });
  assert.deepEqual({ ...updates[0] }, { runtime_agent_id: "agent-new", printer_id: false });
});

test("native runtime printer picker is tied to the selected Agent and Odoo branch", async () => {
  const { RuntimePrinterField } = await load("components/runtime_printer_field.js");
  const view = Object.create(RuntimePrinterField.prototype);
  view.props = { name: "printer_id", record: { data: {
    company_id: [10, "Company"], branch_id: [21, "Branch"], runtime_agent_id: "agent-123",
    destination_type: "report", report_id: [60, "Report"], document_type: "invoice", printer_id: false,
  } } };
  assert.equal(view.companyId, 10);
  assert.equal(view.branchId, 21);
  assert.equal(view.agentId, "agent-123");
  assert.equal(view.destinationType, "report");
  assert.equal(view.reportId, 60);
  assert.equal(view.scopeKey(10, 21, "agent-123"), "10|21|agent-123|report|60|invoice");
});

test("Odoo 19 binding-only Agent field loads printer_id while generic Branch Devices remains valid", async () => {
  const fields = new Map();
  const registry = { category: name => {
    assert.equal(name, "fields");
    return { add(key, value) { fields.set(key, value); }, contains: key => fields.has(key) };
  } };
  await load("components/runtime_agent_field.js", {}, { "@web/core/registry": { registry } });
  const generic = fields.get("gateway_runtime_agent");
  const binding = fields.get("gateway_runtime_agent_binding");
  assert.ok(generic);
  assert.ok(binding);
  assert.ok(generic.fieldDependencies.some(field => field.name === "company_id" && field.type === "many2one"));
  assert.ok(generic.fieldDependencies.some(field => field.name === "branch_id" && field.type === "many2one"));
  assert.ok(!generic.fieldDependencies.some(field => field.name === "printer_id"),
    "Branch Devices and the pairing wizard have no printer_id and must remain usable");
  assert.ok(binding.fieldDependencies.some(field => field.name === "printer_id" && field.type === "char"),
    "the binding-only field must have the old printer in record.fields to clear it when changing Agent");
  assert.equal(binding.extractProps().assignmentOnly, true,
    "binding discovery must still enforce exact company/branch assignment");
});

test("Odoo 19 printer widget declares all cross-field routing dependencies in compact forms", async () => {
  const fields = new Map();
  const registry = { category: name => {
    assert.equal(name, "fields");
    return { add(key, value) { fields.set(key, value); }, contains: key => fields.has(key) };
  } };
  await load("components/runtime_printer_field.js", {}, { "@web/core/registry": { registry } });
  const descriptor = fields.get("gateway_runtime_printer");
  assert.ok(descriptor);
  assert.deepEqual(Array.from(descriptor.supportedTypes), ["char"]);
  for (const [name, type] of [
    ["company_id", "many2one"],
    ["branch_id", "many2one"],
    ["runtime_agent_id", "char"],
    ["destination_type", "selection"],
    ["report_id", "many2one"],
    ["destination_report_id", "many2one"],
    ["document_type", "char"],
    ["printer_protocol", "selection"],
  ]) {
    assert.ok(descriptor.fieldDependencies.some(field => field.name === name && field.type === type),
      "missing routing field dependency: " + name + " (" + type + ")");
  }
});
