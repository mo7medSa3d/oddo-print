import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve("odoo_addons/print_gateway/static/src");
const now = Date.parse("2026-10-24T13:30:00Z");
class Clock extends Date { static now() { return now; } }
async function load(relative) {
  const registry = { category: () => ({ add() {}, contains: () => false }) };
  const stubs = {
    "@odoo/owl": { Component: class {}, onWillUnmount() {}, useEffect() {}, useState: v => v, xml: () => "" },
    "@web/core/registry": { registry }, "@web/core/network/rpc": { rpc() {} },
    "@web/core/l10n/translation": { _t: value => value },
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, Date: Clock });
  const modules = new Map();
  async function moduleFor(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const mod = new vm.SourceTextModule(fs.readFileSync(filename, "utf8"), { context, identifier: filename });
    modules.set(filename, mod);
    await mod.link(async (id, importing) => {
      if (stubs[id]) return new vm.SyntheticModule(Object.keys(stubs[id]), function () {
        for (const [key, value] of Object.entries(stubs[id])) this.setExport(key, value);
      }, { context });
      assert(id.startsWith("."));
      return moduleFor(path.resolve(path.dirname(importing.identifier), `${id}.js`));
    });
    return mod;
  }
  const entry = await moduleFor(path.join(root, relative));
  await entry.evaluate();
  return entry.namespace;
}

function printer(id = "queue-a") {
  const stamp = new Date(now).toISOString();
  return { id, connectionType: "spooler", protocol: "spooler",
    printerType: "physical", deviceClass: "laser", outputMedium: "physical",
    verificationState: "verified", verificationVerifiedAt: stamp, verificationReceivedAt: stamp,
    capabilities: { supported_protocols: ["pdf", "image"],
      operational_verification: { version: 1, verified_at: stamp, printer_id: id,
        binding_digest: "a".repeat(64), logical_queue_key: "a".repeat(64),
        method: "windows_queue", identity_strength: "queue", output_medium: "physical" },
      geometry: { version: 1, source: "validated_profile", validation: "configured", observed_at: stamp,
        printer_id: id, config_fingerprint: "b".repeat(64), paper_width_mm: 210, paper_height_mm: 297,
        printable_width_dots: 2244, printable_height_dots: 3271, offset_x_dots: 118, offset_y_dots: 118,
        dpi_x: 300, dpi_y: 300 } } };
}

async function field(printers) {
  const { RuntimePrinterField } = await load("components/runtime_printer_field.js");
  const result = Object.create(RuntimePrinterField.prototype);
  result.props = { name: "printer_id", record: { data: {}, fields: { printer_protocol: true }, update: () => {} } };
  result.state = { destinationType: "pos", printers };
  return result;
}

test("office driver queues remain selectable for receipts and kitchen", async () => {
  const instance = await field([printer(), printer("office")]);
  for (const destination of ["pos", "pos_printer", "report"]) {
    instance.state.destinationType = destination;
    assert.deepEqual(Array.from(instance.filteredPrinters, p => p.id), ["queue-a", "office"]);
  }
});

test("expired verification does not exclude a printer from selection", async () => {
  // Verification is background evidence: an expired proof neither hides
  // the printer nor blocks selecting it; online status and the reported
  // facts are what the picker uses.
  const expired = printer("expired");
  expired.verificationReceivedAt = new Date(now - 300001).toISOString();
  expired.status = "online";
  const instance = await field([expired, printer()]);
  assert.deepEqual(Array.from(instance.filteredPrinters, p => p.id), ["expired", "queue-a"]);
  let changes = 0, refreshes = 0;
  instance.props.record.update = () => { changes += 1; };
  instance.retryLoad = () => { refreshes += 1; };
  instance.onChange({ target: { value: "expired" } });
  assert.equal(changes, 1);
  assert.equal(refreshes, 0);
});

test("spooler selection records the spooler protocol", async () => {
  const instance = await field([printer()]);
  let change;
  instance.props.record.update = value => { change = value; };
  instance.onChange({ target: { value: "queue-a" } });
  assert.equal(change.printer_protocol, "spooler");
});

test("spooler without measured paper width and raw IPP image are excluded; verification state is not", async () => {
  // The remaining POS exclusions are rendering prerequisites: a spooler
  // queue needs measured paper geometry to render into, and IPP is not a
  // POS image transport. Verification state (pending, or a proof naming
  // another printer) no longer excludes anyone.
  const incomplete = printer("missing-width");
  delete incomplete.capabilities.geometry.paper_width_mm;
  const pending = printer("pending"); pending.verificationState = "pending";
  const wrong = printer("wrong-proof"); wrong.capabilities.operational_verification.printer_id = "elsewhere";
  const ipp = printer("ipp"); ipp.connectionType = ipp.protocol = "ipp";
  ipp.capabilities.operational_verification.method = "ipp_attributes";
  ipp.capabilities.operational_verification.identity_strength = "service";
  const instance = await field([incomplete, pending, wrong, ipp]);
  assert.deepEqual(Array.from(instance.filteredPrinters, p => p.id), ["pending", "wrong-proof"]);
});

test("Odoo browser printer proof uses exact UTF-8 ID and method strength", async () => {
  const { validatedOperationalVerification, isVerifiedRuntimePrinter } = await load("js/printer_verification.js");
  for (const [label, id, expected] of [
    ["120-byte Arabic", "ط".repeat(60), true],
    ["122-byte Arabic", "ط".repeat(61), false],
    ["120-byte emoji", "🖨".repeat(30), true],
    ["124-byte emoji", "🖨".repeat(31), false],
    ["invalid high surrogate", "\uD800", false],
    ["invalid low surrogate", "\uDC00", false],
    ["leading BOM", "\uFEFFprinter", false],
    ["interior BOM", "pri\uFEFFnter", true],
  ]) {
    const current = printer(id);
    assert.equal(Boolean(validatedOperationalVerification(current.capabilities.operational_verification, current, now)), expected, label);
    assert.equal(isVerifiedRuntimePrinter(current, now), expected, label + " picker");
  }
  const forged = printer("hardware-forged");
  forged.capabilities.operational_verification.identity_strength = "device";
  assert.equal(validatedOperationalVerification(forged.capabilities.operational_verification, forged, now), null);
  assert.equal(isVerifiedRuntimePrinter(forged, now), false);
  // The evidence validator still rejects the forged proof as EVIDENCE,
  // but the picker no longer uses verification as an eligibility filter:
  // the printer is offered on its real transport facts.
  const picker = await field([forged]);
  assert.deepEqual(Array.from(picker.filteredPrinters, p => p.id), ["hardware-forged"]);
});

const fixtures = JSON.parse(fs.readFileSync("contracts/printer-operational-verification-fixtures.json", "utf8"));
for (const entry of fixtures.proofCases) {
  test(`operational reader matches shared Gateway/Agent vector: ${entry.name}`, async () => {
    const { validatedOperationalVerification } = await load("js/printer_verification.js");
    assert.equal(Boolean(validatedOperationalVerification(entry.proof, entry.printer, Date.parse(fixtures.now))), entry.valid);
  });
}
