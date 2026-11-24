#!/usr/bin/env node
// Generates the Print Agent icon set from the ONE canonical Agent mark:
// the artwork shown in the Desktop Settings "About" surface
// (src/desktop/public/brand/print-agent.svg — the icon labelled
// "Print Agent"). Every Agent surface consumes these outputs: the Tauri
// bundle icons (exe resource, taskbar, installer/uninstaller), the
// system tray (via the app default window icon), and the Desktop web
// favicon. The Gateway mark is a DIFFERENT icon (src/app/icon.svg, the
// "ط" tile) and is never touched here — see generate-icons.mjs, which
// owns the Gateway/Odoo outputs from the Gateway source only.
import sharp from "sharp";
import { copyFile, readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcSvg = join(root, "src/desktop/public/brand/print-agent.svg");
const outDir = join(root, "src-tauri/icons");

const sizes = [
  { name: "16x16.png", size: 16 },
  { name: "24x24.png", size: 24 },
  { name: "32x32.png", size: 32 },
  { name: "48x48.png", size: 48 },
  { name: "64x64.png", size: 64 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "icon.png", size: 512 },
];

async function generatePNGs(svgBuf) {
  for (const { name, size } of sizes) {
    const outPath = join(outDir, name);
    await sharp(svgBuf)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outPath);
    console.log(`✓ ${name} (${size}x${size})`);
  }
  // The Desktop (Vite) browser favicon is the Agent mark too: the
  // Desktop app IS the Print Agent app.
  await writeFile(join(root, "src/desktop/icon.svg"), svgBuf);
  console.log("✓ src/desktop/icon.svg (Agent mark)");
}

async function generateICO(svgBuf) {
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = [];
  for (const s of icoSizes) {
    const buf = await sharp(svgBuf)
      .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push({ size: s, buf });
  }

  // Build ICO with PNG entries (Vista+ style)
  const count = pngBuffers.length;
  const headerSize = 6;
  const entrySize = 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type ico
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(entrySize * count);
  let offset = headerSize + entrySize * count;
  const images = [];

  for (let i = 0; i < count; i++) {
    const { size, buf } = pngBuffers[i];
    const entryOffset = i * entrySize;
    entries[entryOffset] = size === 256 ? 0 : size; // width 0 means 256
    entries[entryOffset + 1] = size === 256 ? 0 : size; // height
    entries[entryOffset + 2] = 0; // color count
    entries[entryOffset + 3] = 0; // reserved
    entries.writeUInt16LE(1, entryOffset + 4); // planes
    entries.writeUInt16LE(32, entryOffset + 6); // bitCount
    entries.writeUInt32LE(buf.length, entryOffset + 8); // bytesInRes
    entries.writeUInt32LE(offset, entryOffset + 12); // imageOffset
    offset += buf.length;
    images.push(buf);
  }

  const icoPath = join(outDir, "icon.ico");
  const icoBuf = Buffer.concat([header, entries, ...images]);
  await writeFile(icoPath, icoBuf);
  console.log(`✓ icon.ico (${icoBuf.length} bytes, ${count} images PNG)`);
}

async function main() {
  const svgBuf = await readFile(srcSvg);
  console.log(`Agent icon source: src/desktop/public/brand/print-agent.svg (${svgBuf.length} bytes)`);
  // Keep the Tauri source copy byte-identical to the canonical mark so
  // provenance is checkable in tests.
  await copyFile(srcSvg, join(outDir, "icon-source.svg"));
  console.log("✓ src-tauri/icons/icon-source.svg (copy of the canonical Agent mark)");
  await generatePNGs(svgBuf);
  await generateICO(svgBuf);
  console.log("\nAgent icons generated from the Print Agent mark.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
