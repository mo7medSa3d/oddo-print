/**
 * Actual Chromium + exact Odoo19 html-to-image + production receipt renderer.
 * Synthetic mixed Arabic/English, QR, Code128 and long-receipt fixtures.
 * Required environment: YASEIR_PLAYWRIGHT_MODULE, YASEIR_CHROMIUM_EXECUTABLE,
 * YASEIR_ODOO_SOURCE, YASEIR_BARCODE_PYTHON, YASEIR_RECEIPT_OUTPUT.
 * Optional YASEIR_RECEIPT_BASELINE=1 demonstrates the imported width defect.
 * No physical printer, Windows driver, authenticated POS session or scanner
 * is represented by this browser-only rendering test.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const output = process.env.YASEIR_RECEIPT_OUTPUT;
const odoo = process.env.YASEIR_ODOO_SOURCE;
const python = process.env.YASEIR_BARCODE_PYTHON;
const executablePath = process.env.YASEIR_CHROMIUM_EXECUTABLE;
const playwright = process.env.YASEIR_PLAYWRIGHT_MODULE;
assert(output && odoo && python && executablePath && playwright, "Set the documented verified tool paths and output directory");
const baseline = process.env.YASEIR_RECEIPT_BASELINE === "1";
fs.mkdirSync(output, { recursive: true });
const barcodePath = path.join(output, "code128-fixture.svg");
execFileSync(python, ["scripts/acceptance/verify-odoo-receipt-codes.py", "--generate-svg", barcodePath], { cwd: root });
const sha = value => createHash("sha256").update(value).digest("hex");
const addon = "odoo_addons/print_gateway/static/src/";
const read = relative => baseline && ["js/receipt_raster.js", "css/receipt_raster.css"].includes(relative)
  ? execFileSync("git", ["show", `HEAD:${addon}${relative}`], { cwd: root, encoding: "utf8" })
  : fs.readFileSync(path.join(root, addon, relative), "utf8");
const rendererSource = read("js/receipt_raster.js");
const css = read("css/receipt_raster.css");
const geometrySource = read("js/printer_geometry.js");
const canvasPath = path.join(odoo, "addons/point_of_sale/static/src/app/utils/html-to-image.js");
const utilsPath = path.join(odoo, "addons/point_of_sale/static/src/utils.js");
const canvasSource = fs.readFileSync(canvasPath, "utf8");
const utilsSource = fs.readFileSync(utilsPath, "utf8");
// Import only the exact dependency-free waitImages export; other Odoo utils
// require the ORM/Owl application, which is outside this renderer-only gate.
const waitStart = utilsSource.indexOf("export function waitImages(");
const waitEnd = utilsSource.indexOf("export class Counter", waitStart);
assert(waitStart >= 0 && waitEnd > waitStart);
const waitImages = utilsSource.slice(waitStart, waitEnd);
const rendererModule = rendererSource
  .replace('"@point_of_sale/app/utils/html-to-image"', '"/odoo-html-to-image.js"')
  .replace('"@point_of_sale/utils"', '"/odoo-utils.js"')
  .replace('"@web/core/l10n/translation"', '"/translation.js"')
  .replace('"./printer_geometry"', '"/printer_geometry.js"');
const barcode = fs.readFileSync(barcodePath, "utf8").replace(/<\?xml[^>]*\?>/, "")
  .replace(/<!DOCTYPE[\s\S]*?>/, "").replace("<svg ", '<svg style="width:42mm;max-width:100%;height:12mm" ');
const fixturePath = path.join(root, "tests/fixtures/receipt-geometry.html");
const fixtureSource = fs.readFileSync(fixturePath, "utf8");
const html = fixtureSource
  .replace('href="../../odoo_addons/print_gateway/static/src/css/receipt_raster.css"', 'href="/receipt.css"')
  .replace('<div class="fixture-qr">', `<div class="fixture-code128" style="display:flex;justify-content:center">${barcode}</div><div class="fixture-qr">`);
const sources = new Map([
  ["/", ["text/html", html]], ["/receipt.css", ["text/css", css]],
  ["/receipt.js", ["text/javascript", rendererModule]], ["/printer_geometry.js", ["text/javascript", geometrySource]],
  ["/odoo-html-to-image.js", ["text/javascript", canvasSource]], ["/odoo-utils.js", ["text/javascript", waitImages]],
  ["/translation.js", ["text/javascript", "export const _t = value => value;"]],
]);
const server = createServer((request, response) => {
  const item = sources.get(request.url?.split("?")[0]);
  if (!item) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", `${item[0]}; charset=utf-8`);
  response.end(item[1]);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const { chromium } = await import(pathToFileURL(playwright).href);
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const report = { success: false, baseline, browser_version: browser.version(), node_version: process.version,
  scope: "Actual digital browser rendering and decode; synthetic content/measurements; no physical printer, Windows driver, scanner or live POS session",
  source_hashes: { renderer: sha(rendererSource), css: sha(css), geometry: sha(geometrySource),
    odoo_html_to_image: sha(canvasSource), odoo_utils: sha(utilsSource), exact_waitImages_export: sha(waitImages),
    fixture: sha(fixtureSource), barcode_svg: sha(fs.readFileSync(barcodePath)) }, cases: [] };
try {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  context.setDefaultTimeout(20_000);
  const cases = baseline ? [["300dpi-baseline", 851, 300, 300, 80, 0]] : [
    ["58mm-203dpi", 384, 203, 203, 58, 0], ["80mm-203dpi", 576, 203, 203, 80, 0],
    ["80mm-300dpi", 851, 300, 300, 80, 0], ["80mm-600dpi", 1702, 600, 600, 80, 0],
    ["custom104mm-300dpi", 1200, 300, 300, 104, 0], ["mixed203x300dpi", 576, 203, 300, 80, 0],
    ["long80mm-600dpi", 1702, 600, 600, 80, 2000],
  ];
  for (const [name, dots, dpiX, dpiY, paperMm, minHeight] of cases) {
    const page = await context.newPage();
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    await page.goto(origin, { waitUntil: "networkidle" });
    const profile = { version: 1, source: "validated_profile", validation: "configured",
      observed_at: "2026-10-24T12:00:00Z", printer_id: "synthetic-selected-printer",
      config_fingerprint: sha(JSON.stringify({ dots, dpiX, dpiY, paperMm })),
      printable_width_dots: dots, dpi_x: dpiX, dpi_y: dpiY, paper_width_mm: paperMm };
    const measured = await page.evaluate(async ({ geometry, minimumHeight }) => {
      const { renderGatewayReceiptJpeg } = await import("/receipt.js");
      const element = document.querySelector("#receipt");
      if (minimumHeight) {
        element.style.minHeight = `${minimumHeight}px`;
        const lines = element.querySelector(".orderlines");
        for (let i = 0; i < 4; i++) lines.appendChild(lines.firstElementChild.cloneNode(true));
      }
      const jpeg = await renderGatewayReceiptJpeg(element, {
        // width is supplied only to reproduce the historical implementation;
        // production now consumes geometry and ignores this legacy argument.
        geometry, width: geometry.printable_width_dots,
        renderer: { whenMounted: ({ el, callback }) => callback(el) },
      });
      const image = new Image();
      image.src = `data:image/jpeg;base64,${jpeg}`;
      await image.decode();
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const rows = [...element.querySelectorAll(".fixture-columns")];
      const overlap = rows.some(row => {
        const boxes = [...row.children].map(child => child.getBoundingClientRect());
        return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1].right - 0.1);
      });
      const qr = element.querySelector(".fixture-qr svg").getBoundingClientRect();
      return { jpeg, css_width: bounds.width, css_height: element.scrollHeight,
        raster_width: image.naturalWidth, raster_height: image.naturalHeight,
        font_size_css_px: parseFloat(style.fontSize), font_family: style.fontFamily,
        physical_font_mm: parseFloat(style.fontSize) * 25.4 / 96,
        scroll_width: element.scrollWidth, column_overlap: overlap,
        receipt_line_count: element.querySelectorAll(".orderline").length,
        rtl_direction: getComputedStyle(element.querySelector('h2[lang="ar"]')).direction,
        qr_css_width: qr.width, qr_expected_dot_width: qr.width * geometry.dpi_x / 96 };
    }, { geometry: profile, minimumHeight: minHeight });
    const { jpeg, ...measurements } = measured;
    const filename = `receipt-${name}.jpg`;
    const bytes = Buffer.from(jpeg, "base64");
    fs.writeFileSync(path.join(output, filename), bytes);
    report.cases.push({ name, geometry: profile, ...measurements, filename, encoded_bytes: bytes.length,
      jpeg_sha256: sha(bytes), external_requests: requests.filter(url => !url.startsWith(origin) && !url.startsWith("data:")) });
    assert.equal(measurements.raster_width, dots, `${name}: printer width must never be substituted or shrunk`);
    assert.equal(measurements.raster_height, Math.ceil(measurements.css_height * dpiY / 96));
    assert(Math.abs(measurements.css_width - dots * 96 / dpiX) <= 1 / 64, `${name}: physical CSS width`);
    assert.equal(measurements.font_size_css_px, 14, `${name}: physical type size independent of device DPI`);
    assert.equal(measurements.column_overlap, false, `${name}: quantity/price columns overlap`);
    assert.equal(measurements.rtl_direction, "rtl");
    assert(measurements.scroll_width <= measurements.css_width + 2);
    assert.equal(report.cases.at(-1).external_requests.length, 0, "Receipt must not fetch remote fonts/resources");
    assert(bytes.length <= 5 * 1024 * 1024);
    if (minHeight) {
      assert(measurements.raster_height >= 12500, "Long receipt fixture was not exercised");
      assert.equal(measurements.receipt_line_count, 16, "Long receipt must include additional real content");
    }
    if (["58mm-203dpi", "80mm-600dpi"].includes(name)) {
      await page.screenshot({ path: path.join(output, `preview-${name}.png`),
        clip: { x: 0, y: 0, width: Math.ceil(measurements.css_width), height: 700 } });
    }
    await page.close();
  }
  execFileSync(python, ["scripts/acceptance/verify-odoo-receipt-codes.py", "--verify-directory", output], { cwd: root });
  report.success = true;
} finally {
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: report.success, baseline, cases: report.cases.length, output }));
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
