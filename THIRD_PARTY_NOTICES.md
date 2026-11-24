# Third-party notices — embedded PDF printing

## Klippa go-pdfium

The Agent uses `github.com/klippa-app/go-pdfium` v1.21.3. The upstream Go wrapper is licensed under the MIT License.

Copyright (c) 2022 Klippa App BV.

Upstream source: https://github.com/klippa-app/go-pdfium/tree/v1.21.3

## Google PDFium

The go-pdfium WebAssembly payload contains the PDFium engine and its bundled dependencies. The wrapper's MIT license does not establish the licenses of the embedded engine or its third-party components. PDFium's upstream LICENSE currently includes both its BSD-style notice and Apache License 2.0 text; release packaging must retain the notices applicable to the exact embedded source revision and components.

Upstream project: https://pdfium.googlesource.com/pdfium/

Upstream license: https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE

The V3 native SBOM identifies the embedded `internal/pdfium_wasm/pdfium.wasm` by SHA-256 separately from the Go wrapper. This source inventory does not certify that a final signed Windows installer includes every required embedded-component notice.

## Wazero

The embedded WebAssembly runtime is `github.com/tetratelabs/wazero` v1.12.0, licensed under Apache License 2.0.

Upstream source: https://github.com/tetratelabs/wazero/tree/v1.12.0

Release packaging must preserve the upstream license/notice texts required by the selected versions. The Agent does not download these components at runtime.
