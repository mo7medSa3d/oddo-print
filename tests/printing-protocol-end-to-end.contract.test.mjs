// Cross-runtime contract guard. Executes the Gateway production outcome
// interpreter; other platform boundaries are compared from active sources.
// NOT a substitute for installed Odoo/PostgreSQL, native Windows or paper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const agent = read('agent/internal/printer/outcome.go');
const jobStatus = read('src/lib/job-status.ts');
const odoo = read('odoo_addons/print_gateway/models/print_job.py');
function markers(source, anchor, closing) {
  const start = source.indexOf(anchor);
  assert.ok(start >= 0, `production marker ${anchor} missing`);
  const end = source.indexOf(closing, start + anchor.length);
  assert.ok(end > start, `${anchor} terminator missing`);
  return [...source.slice(start + anchor.length, end).matchAll(/["']([A-Z][A-Z0-9_]+)["']/g)].map(match => match[1]);
}
function gatewayExports() {
  const compiled = ts.transpileModule(jobStatus, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = {exports:{}};
  vm.runInNewContext(compiled, {
    module,exports:module.exports, require: () => ({parseDbTimeMs: () => null}),
  });
  return module.exports;
}
test('Gateway, Agent and Odoo agree on all ambiguity markers in the same order', () => {
  const ag = markers(agent, 'var OutcomeMarkers = []string{', '}');
  const gw = markers(jobStatus, 'export const PHYSICAL_OUTCOME_UNKNOWN_MARKERS = [', '] as const');
  const od = markers(odoo, '_GATEWAY_UNKNOWN_MARKERS = (', ')');
  assert.deepEqual(ag, gw);
  assert.deepEqual(od, gw);
  assert.ok(gw.includes('UNKNOWN_PARTIAL_DELIVERY'));
});
test('real Gateway physical-outcome interpreter never mistakes transport acceptance for physical paper', () => {
  const { derivePhysicalOutcome, hasUnknownPhysicalOutcomeMarker } = gatewayExports();
  for (const stage of ['queued','claimed','printing','success']) {
    const value = derivePhysicalOutcome(stage, null);
    assert.notEqual(value, 'printed', `${stage} has no physical-paper sensor evidence`);
  }
  assert.equal(derivePhysicalOutcome('success', null), 'unknown');
  for (const marker of markers(agent,'var OutcomeMarkers = []string{','}')) {
    assert.equal(hasUnknownPhysicalOutcomeMarker(`${marker}: lost acknowledgement`),true);
    assert.equal(derivePhysicalOutcome('failed', `${marker}: lost acknowledgement`), 'unknown');
  }
  assert.equal(derivePhysicalOutcome('failed', 'NO_PRINTER_CONFIG'), 'not_printed');
});
test('IPP never sends RAW/ESC-POS/ZPL as a falsely labeled PDF document', () => {
  const ipp = read('agent/internal/printer/ipp.go');
  const formats = read('agent/internal/printer/ipp_formats.go');
  const selector = ipp.slice(ipp.indexOf('func ippDocumentFormatFor('),ipp.indexOf('func preDispatchIRErr('));
  assert.match(selector, /case KindPDF:/);
  for (const other of ['KindRaw','KindESCPOS','KindZPL','KindTSPL']) assert.ok(!selector.includes(`case ${other}`));
  assert.match(formats, /document-format-supported/);
  assert.match(formats, /renderIPPPDFToPWG/);
  assert.match(formats, /renderIPPPDFToJPEG/);
  assert.match(formats, /"image\/pwg-raster"/);
});
test('Agent status reports preserve the original claim fence and ambiguous submission marker', () => {
  const src=read('agent/internal/agent/agent.go');
  const status=src.slice(src.indexOf('func (a *Agent) updateJobStatus('),src.indexOf('func (a *Agent) doAuthorizedRequest('));
  assert.match(status, /body\["claimToken"\] = claimToken/);
  assert.match(status, /body\["spoolerJobId"\] = spoolerJobID/);
  assert.match(src, /UpdateTerminalWithEvidence\(jobID, "success"/);
  assert.match(src, /UpdateTerminalWithEvidence\(jobID, "failed"/);
  const route=read('src/app/api/agent/jobs/route.ts');
  assert.match(route, /derivePhysicalOutcome\(requestedStatus, nextError\)/);
});
test('embedded Windows PDF engine uses in-process PDFium WASM with no configured host filesystem mounts', () => {
  const pdf=read('agent/internal/printer/pdf_windows.go');
  assert.match(pdf,/webassembly\.Init/);
  assert.match(pdf,/wazero\.NewFSConfig\(\)/);
  assert.match(pdf,/io\.Discard/);
  assert.match(pdf,/RenderPage/);
  // This is code inspection, not runtime proof that the service has a valid Win32 HDC.
});
