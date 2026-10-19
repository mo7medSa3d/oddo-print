import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve("odoo_addons/print_gateway/static/src");

async function load(relative, extra = {}, overrides = {}) {
  const registry = { category: () => ({ add() {}, contains: () => false }) };
  const stubs = {
    "@odoo/owl": { Component: class {}, onWillUnmount() {}, onMounted() {}, useEffect() {}, useState: v => v, xml: () => "" },
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

test("POS picker offers only physical JPEG transports and declared ESC/POS raster capability", async () => {
  const { RuntimePrinterField } = await load("components/runtime_printer_field.js");
  const field = Object.create(RuntimePrinterField.prototype);
  const cases = [
    ["queue", "spooler", "unknown", undefined, true],
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
    ["direct-usb", "usb", "escpos", ["image"], false],
    ["ipp-document", "ipp", "ipp", ["image"], false],
  ];
  field.props = { record: { data: {} } };
  field.state = { destinationType: "pos", printers: cases.map(([id, connectionType, protocol, supported]) => ({
    id, connectionType, protocol, capabilities: supported === undefined ? {} : { supported_protocols: supported },
  })) };
  const expected = cases.filter(row => row[4]).map(row => row[0]);
  assert.deepEqual(Array.from(field.filteredPrinters, row => row.id), expected);
  field.state.destinationType = "pos_printer";
  assert.deepEqual(Array.from(field.filteredPrinters, row => row.id), expected);
  field.state.destinationType = "report";
  assert.equal(field.filteredPrinters, field.state.printers, "do not alter unrelated report picker semantics");
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
