#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo 'Partial source verification: full builds, live database, Odoo and Windows hardware checks remain separate gates.'
node --experimental-vm-modules tests/fresh-printing-admission.test.mjs

(
  cd agent
  go test -mod=readonly -count=1 -race ./internal/config ./internal/payload ./internal/queue ./internal/storage
  # Compile actual transport files using pinned module dependencies; execute
  # CPU/in-memory cases only. No substitute versions or synthetic production
  # stubs are introduced. The non-Windows stubs are the repository's own.
  go test -mod=readonly -count=1 -race \
    -run 'Test(DispatchAdmission|IPPAdmissionRefusal|NetworkAdmissionRefusal|PDFPaper|PDFDevMode|PDFRejects|PDFPhysicalOrigin|BufferedTargets|PayloadCompatible|Capability|JPEG|Raster|WrapPeripheral|DocumentContext|PDFDocumentContext|ParseIPP|InterpretIPP|IPPBuild|IPPRequested)' \
    internal/printer/printer.go internal/printer/document.go \
    internal/printer/capability.go internal/printer/network.go \
    internal/printer/health.go internal/printer/image.go \
    internal/printer/peripherals.go internal/printer/outcome.go \
    internal/printer/pdf.go internal/printer/pdf_other.go internal/printer/ipp.go \
    internal/printer/factory.go internal/printer/raster_capability.go \
    internal/printer/spooler_stub.go internal/printer/usb_other.go \
    internal/printer/dispatch_admission.go internal/printer/dispatch_admission_test.go \
    internal/printer/admission_transport_test.go internal/printer/ipp_test.go \
    internal/printer/network_test.go internal/printer/network_test_fastpath_test.go \
    internal/printer/health_test.go internal/printer/health_framing_test.go \
    internal/printer/image_test.go internal/printer/peripherals_test.go \
    internal/printer/capability_test.go internal/printer/pdf_geometry.go \
    internal/printer/pdf_geometry_test.go internal/printer/discovery_scan.go \
    internal/printer/discovery_scan_test.go internal/printer/document_timeout_test.go
)

python3 scripts/check-odoo-translations.py
# Run the real catalog checker with Node's built-in TS transform and an
# extension-resolving VM linker, without requiring the missing tsx executable.
node --experimental-vm-modules --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
const context = createContext({ console, process, Buffer });
const cache = new Map();
async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const source = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'transform' });
  const module = new SourceTextModule(source, { context, identifier: file });
  cache.set(file, module);
  await module.link(async (specifier) => {
    if (specifier.startsWith('node:')) {
      const namespace = await import(specifier);
      return new SyntheticModule(Object.keys(namespace), function () {
        for (const key of Object.keys(namespace)) this.setExport(key, namespace[key]);
      }, { context });
    }
    return load(path.resolve(path.dirname(file), specifier + '.ts'));
  });
  return module;
}
await (await load(path.resolve('scripts/check-i18n.ts'))).evaluate();
NODE

git diff --check
echo 'PASS: partial source verification. This does not establish production readiness.'
