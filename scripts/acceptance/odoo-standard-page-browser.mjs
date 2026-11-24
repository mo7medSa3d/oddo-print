/** Actual Odoo19 Owl templates + Chromium + production receipt renderer.
 * Synthetic model/service data and configured geometry; no authenticated POS,
 * Windows execution, or physical printer result is claimed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.YASEIR_RECEIPT_OUTPUT;
const odoo = process.env.YASEIR_ODOO_SOURCE;
const python = process.env.YASEIR_BARCODE_PYTHON;
const odooPython = process.env.YASEIR_ODOO_PYTHON;
assert(output && odoo && python && odooPython && process.env.YASEIR_PLAYWRIGHT_MODULE && process.env.YASEIR_CHROMIUM_EXECUTABLE);
fs.mkdirSync(output, { recursive: true });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hashes = {};
const read = filename => { const data = fs.readFileSync(filename, "utf8"); hashes[filename] = sha(data); return data; };
const addon = path.resolve("odoo_addons/print_gateway/static/src");
const pos = path.join(odoo, "addons/point_of_sale/static/src");
const dependencies = {
  "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt": "app/screens/receipt_screen/receipt/order_receipt",
  "@point_of_sale/app/screens/receipt_screen/receipt/receipt_header/receipt_header": "app/screens/receipt_screen/receipt/receipt_header/receipt_header",
  "@point_of_sale/app/components/orderline/orderline": "app/components/orderline/orderline",
  "@point_of_sale/app/components/order_display/order_display": "app/components/order_display/order_display",
};
const sources = new Map();
const put = (url, type, content) => sources.set(url, [type, content]);
const replaceImports = source => source.replace(/from "([^"]+)"/g, (match, name) => {
  if (dependencies[name]) return `from "/${dependencies[name]}.js"`;
  const mapped = { "@odoo/owl": "/owl-module.js", "@web/core/l10n/translation": "/fixture-services.js",
    "@web/core/currency": "/fixture-services.js", "@point_of_sale/utils": "/fixture-services.js",
    "@point_of_sale/app/utils/use_timed_press": "/fixture-services.js", "@web/core/tags_list/tags_list": "/fixture-services.js",
    "@point_of_sale/app/components/centered_icon/centered_icon": "/fixture-services.js",
    "@point_of_sale/app/utils/html-to-image": "/html-to-image.js", "./printer_geometry": "/printer_geometry.js" }[name];
  assert(mapped, `Unhandled exact Odoo dependency ${name}`);
  return `from "${mapped}"`;
});
put("/owl.js", "text/javascript", read(path.join(odoo, "addons/web/static/lib/owl/owl.js")));
put("/owl-module.js", "text/javascript", "export const {App,Component,useRef,useEffect,xml}=window.owl;");
for (const base of Object.values(dependencies)) put(`/${base}.js`, "text/javascript", replaceImports(read(path.join(pos, `${base}.js`))));
put("/html-to-image.js", "text/javascript", read(path.join(pos, "app/utils/html-to-image.js")));
put("/receipt.js", "text/javascript", replaceImports(read(path.join(addon, "js/receipt_raster.js"))));
put("/printer_geometry.js", "text/javascript", read(path.join(addon, "js/printer_geometry.js")));
const templates = [...Object.values(dependencies).map(base => `${base}.xml`),
  "app/components/navbar/sale_details_button/sales_detail_report.xml", "app/store/order_change_receipt_template.xml"];
put("/templates.json", "application/json", JSON.stringify(templates.map(file => read(path.join(pos, file)))));
const utils = read(path.join(pos, "utils.js"));
const waitStart = utils.indexOf("export function waitImages(");
const waitEnd = utils.indexOf("export class Counter", waitStart);
assert(waitStart >= 0 && waitEnd > waitStart);
const qrSource = read(path.resolve("tests/fixtures/receipt-geometry.html"));
const qr = qrSource.match(/<div class="fixture-qr">\s*(<svg[\s\S]*?<\/svg>)/)?.[1];
assert(qr);
put("/qr.svg", "image/svg+xml", qr);
const barcodePath = path.join(output, "code128-fixture.svg");
execFileSync(python, ["scripts/acceptance/verify-odoo-receipt-codes.py", "--generate-svg", barcodePath]);
put("/code128.svg", "image/svg+xml", read(barcodePath));
put("/logo.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="50"><text x="8" y="30" font-family="Arial" font-size="22">YASEIR SAMPLE</text></svg>');
put("/fixture-services.js", "text/javascript", `${utils.slice(waitStart, waitEnd)}
export const _t=(value,...args)=>value.replace(/%\(([^)]+)\)s/g,(_,key)=>args[0]?.[key]??'').replace(/%s/g,()=>args.shift()??'');
export const formatCurrency=value=>Number(value).toFixed(2)+' SAR';
export const generateQRCodeDataUrl=()=>'/qr.svg';
export const useTimedPress=()=>{throw Error('Display-only hook reached receipt fixture');};
export class TagsList extends window.owl.Component {static template=window.owl.xml\`<div/>\`;}
export class CenteredIcon extends window.owl.Component {static template=window.owl.xml\`<div/>\`;}
`);
const bootstrapScss = path.join(odoo, "addons/web/static/lib/bootstrap/scss/bootstrap.scss");
read(bootstrapScss);
const bootstrap = execFileSync(odooPython, ["-c", "import sass,sys; print(sass.compile(filename=sys.argv[1], output_style='compressed'))", bootstrapScss], { maxBuffer: 4 * 1024 * 1024 }).toString();
hashes.compiled_bootstrap_css = sha(bootstrap);
put("/receipt.css", "text/css", bootstrap + "\n" + read(path.join(pos, "css/pos_receipts.css")) + "\n" + read(path.join(addon, "css/receipt_raster.css")));
put("/", "text/html", '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/receipt.css"><script src="/owl.js"></script></head><body><div id="fixture"></div></body></html>');
const server = createServer((request, response) => {
  const url = request.url?.split("?")[0];
  const item = sources.get(url === "/web/image" ? "/logo.svg" : url);
  if (!item) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", `${item[0]}; charset=utf-8`); response.end(item[1]);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.YASEIR_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({ executablePath: process.env.YASEIR_CHROMIUM_EXECUTABLE, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const report = { success: false, browser_version: browser.version(), node_version: process.version,
  scope: "Exact Odoo19 Owl templates/components and production raster renderer with synthetic model/service data; configured standard-page profiles; no authenticated POS, hardware or Windows claim",
  source_hashes: hashes, cases: [] };
try {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1100, height: 1000 } });
  context.setDefaultTimeout(30000);
  const papers = [["A4", 210, 297, 203, 203], ["A5", 148, 210, 300, 300], ["Letter", 215.9, 279.4, 600, 600], ["Legal", 215.9, 355.6, 203, 300]];
  for (const [paper, width, height, dpiX, dpiY] of papers) for (const workflow of ["sale", "refund", "sales-details", "kitchen"]) {
    const name = `${paper}-${workflow}`;
    const profile = { version: 1, source: "validated_profile", validation: "configured", observed_at: "2026-10-24T14:00:00Z",
      printer_id: `fixture-${name}`, config_fingerprint: sha(name), dpi_x: dpiX, dpi_y: dpiY,
      paper_width_mm: width, paper_height_mm: height,
      printable_width_dots: Math.floor((width - 20) * dpiX / 25.4), printable_height_dots: Math.floor((height - 20) * dpiY / 25.4),
      offset_x_dots: Math.floor(10 * dpiX / 25.4), offset_y_dots: Math.floor(10 * dpiY / 25.4) };
    const page = await context.newPage();
    const requests = [], errors = [];
    page.on("request", r => requests.push(r.url())); page.on("pageerror", e => errors.push(String(e)));
    await page.goto(origin, { waitUntil: "networkidle" });
    const measured = await page.evaluate(async ({ geometry, workflow }) => {
      const { App, Component } = window.owl;
      const xmlFiles = await (await fetch("/templates.json")).json();
      const doc = new DOMParser().parseFromString("<templates/>", "text/xml");
      for (const xml of xmlFiles) for (const child of new DOMParser().parseFromString(xml, "text/xml").documentElement.children) doc.documentElement.appendChild(doc.importNode(child, true));
      const templates = new XMLSerializer().serializeToString(doc);
      const money = value => Number(value).toFixed(2) + " SAR";
      const negative = workflow === "refund";
      const order = { company: { name: "شركة الاختبار Sample Store", street: "شارع النور 12", city: "Riyadh الرياض", phone: "+966 11 123 4567", vat: "300000000000003", point_of_sale_use_ticket_qr_code: true, point_of_sale_ticket_portal_url_display_mode: "qr_code" },
        config: { receiptLogoUrl: "/logo.svg", receipt_header: "Customer receipt إيصال العميل", receipt_footer: "شكراً لزيارتكم — Thank you", name: "Main Point of Sale الفرع الرئيسي", _base_url: "https://example.invalid" },
        currency: { id: 1 }, access_token: "synthetic", ticket_code: "SAMPLE-1234", pos_reference: negative ? "REFUND / مرتجع 0042" : "SALE / مبيعات 0042",
        date_order: true, formatDateOrTime: () => "2026-10-24 14:00", getCashierName: () => "موظف Sample Cashier", finalized: true,
        prices: { taxDetails: { has_tax_groups: false } }, getTotalDiscount: () => 0, payment_ids: [], lines: [],
        priceExcl: negative ? -123.45 : 123.45, currencyDisplayPriceIncl: money(negative ? -123.45 : 123.45) };
      order.payment_ids = [{ payment_method_id: { name: "Cash نقداً" }, getAmount: () => order.priceExcl }];
      for (let i = 0; i < 8; i++) order.lines.push({ order_id: order, product_id: { getImageUrl: () => null, tracking: "none", uom_id: { name: "Units" } },
        combo_line_ids: [], orderDisplayProductName: { name: "Sample coffee قهوة عربية", attributeString: "" },
        full_product_name: `Sample coffee قهوة عربية ${i + 1}`, currency: order.currency, currencyDisplayPriceUnit: money(12.5),
        currencyDisplayPrice: money(negative ? -12.5 : 12.5), price: 12.5, displayPriceNoDiscount: 12.5,
        getQuantityStr: () => ({ unitPart: negative ? "-1" : "1", decimalPart: "", decimalPoint: "." }),
        getDiscountStr: () => "0", isSelected: () => false, getDisplayClasses: () => ({}) });
      let Root, props = {};
      if (["sale", "refund"].includes(workflow)) {
        Root = (await import("/app/screens/receipt_screen/receipt/order_receipt.js")).OrderReceipt;
        props = { order };
      } else {
        class Report extends Component {
          static template = workflow === "kitchen" ? "point_of_sale.OrderChangeReceipt" : "point_of_sale.SaleDetailsReport";
          setup() { Object.assign(this, this.props.data); }
        }
        Root = Report;
        props = { data: workflow === "kitchen" ? { data: { config_name: "Kitchen المطبخ", employee_name: "موظف", time: "14:00", pos_reference: "KITCHEN / تحضير 0042", tracking_number: "42",
          changes: { title: "NEW / طلب جديد", data: order.lines.map((line, index) => ({ quantity: 1, basic_name: line.full_product_name, customer_note: index % 2 ? "بدون سكر / No sugar" : "" })) } } }
          : { pos: { company: { id: 1 }, models: { "decimal.precision": [{ name: "Product Unit", round: value => value }] } },
            products: [{ name: "Coffee", products: order.lines.map(line => ({ product_name: line.full_product_name, quantity: 2, price_unit: 12.5, discount: 0, uom: "Units" })) }],
            refund_products: [{ name: "Refund", products: [{ product_name: "مرتجع Refund coffee", quantity: -1, price_unit: 12.5, discount: 0, uom: "Units" }] }],
            payments: [{ name: "Cash نقداً", total: 187.5 }], taxes: [{ name: "VAT ضريبة", tax_amount: 28.13 }], currency: { total_paid: 215.63 },
            date: "2026-10-24 14:00", formatCurrency: money } };
      }
      const app = new App(Root, { templates, props, dev: false });
      await app.mount(document.querySelector("#fixture"));
      const element = document.querySelector("#fixture > .pos-receipt");
      if (!element) throw Error("Actual Odoo receipt template did not mount");
      element.style.width = `${geometry.printable_width_dots * 96 / geometry.dpi_x}px`;
      const spacer = document.createElement("div");
      const codes = document.createElement("div"); codes.style.cssText = "display:flex;flex-direction:column;align-items:center;padding:3mm 0";
      codes.innerHTML = '<img class="fixture-code128" src="/code128.svg" style="width:42mm;height:12mm"><img class="fixture-qr" src="/qr.svg" style="width:32mm;height:32mm">';
      element.append(spacer, codes);
      await Promise.all([...element.querySelectorAll("img")].map(img => img.decode()));
      // Measure the real production layout before moving a whole QR across
      // the old fixed raster boundary. The final render must retain it.
      const { renderGatewayReceiptJpeg } = await import("/receipt.js");
      await renderGatewayReceiptJpeg(element, { geometry, renderer: { whenMounted: ({ el, callback }) => callback(el) } });
      const pageCss = geometry.printable_height_dots * 96 / geometry.dpi_y;
      const qr = codes.querySelector(".fixture-qr");
      const relative = qr.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const boundary = Math.ceil((relative + qr.getBoundingClientRect().height / 2) / pageCss) * pageCss;
      spacer.style.height = `${Math.max(0, boundary - relative - qr.getBoundingClientRect().height / 2)}px`;
      const jpeg = await renderGatewayReceiptJpeg(element, { geometry, renderer: { whenMounted: ({ el, callback }) => callback(el) } });
      const image = new Image(); image.src = `data:image/jpeg;base64,${jpeg}`; await image.decode();
      const bounds = element.getBoundingClientRect(), style = getComputedStyle(element), qrBounds = qr.getBoundingClientRect();
      const rtlProbe = document.createElement("span"); rtlProbe.dir = "rtl"; rtlProbe.textContent = "قهوة عربية"; element.appendChild(rtlProbe);
      const rtl = getComputedStyle(rtlProbe).direction; rtlProbe.remove();
      const rows = [...element.querySelectorAll(".line-details")];
      const overlap = rows.some(row => { const name = row.querySelector(".product-name")?.getBoundingClientRect(), price = row.querySelector(".product-price")?.getBoundingClientRect(); return name && price && name.right > price.left + 0.5; });
      const text = element.textContent;
      const result = { jpeg, css_width: bounds.width, css_height: element.scrollHeight,
        raster_width: image.naturalWidth, raster_height: image.naturalHeight, font_size_css_px: parseFloat(style.fontSize),
        physical_font_mm: parseFloat(style.fontSize) * 25.4 / 96, column_overlap: overlap, rtl_direction: rtl,
        margin_top_css_px: parseFloat(style.marginTop), margin_bottom_css_px: parseFloat(style.marginBottom),
        arabic_text_present: /[\u0600-\u06ff]/.test(text), english_text_present: /[A-Za-z]/.test(text),
        refund_negative_present: workflow !== "refund" || text.includes("-123.45") && text.includes("-1"),
        qr_source_top_dots: (qrBounds.top - bounds.top) * geometry.dpi_y / 96,
        qr_source_bottom_dots: (qrBounds.bottom - bounds.top) * geometry.dpi_y / 96,
        old_fixed_boundary_dots: boundary * geometry.dpi_y / 96,
        source_text_sha_input: text, workflow, exact_owl_template: Root.template };
      return result;
    }, { geometry: profile, workflow });
    const { jpeg, source_text_sha_input: text, ...metrics } = measured;
    const filename = `receipt-${name}.jpg`;
    const bytes = Buffer.from(jpeg, "base64");
    fs.writeFileSync(path.join(output, filename), bytes);
    fs.writeFileSync(path.join(output, `${name}.geometry.json`), JSON.stringify(profile, null, 2) + "\n");
    const item = { name, paper, workflow, geometry: profile, ...metrics, filename, jpeg_sha256: sha(bytes), encoded_bytes: bytes.length,
      source_text_sha256: sha(text), page_errors: errors, external_requests: requests.filter(url => !url.startsWith(origin) && !url.startsWith("data:")) };
    report.cases.push(item);
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
    assert.equal(errors.length, 0); assert.equal(item.external_requests.length, 0);
    assert.equal(metrics.raster_width, profile.printable_width_dots);
    assert.equal(metrics.raster_height, Math.ceil(metrics.css_height * dpiY / 96));
    assert.equal(metrics.font_size_css_px, 14); assert.equal(metrics.column_overlap, false);
    assert.equal(metrics.margin_top_css_px, 0); assert.equal(metrics.margin_bottom_css_px, 0);
    assert(metrics.arabic_text_present && metrics.english_text_present && metrics.refund_negative_present);
    assert(metrics.qr_source_top_dots < metrics.old_fixed_boundary_dots && metrics.qr_source_bottom_dots > metrics.old_fixed_boundary_dots);
    assert(bytes.length <= 5 * 1024 * 1024 && metrics.raster_width * metrics.raster_height <= 40 * 1024 * 1024);
    await page.screenshot({ path: path.join(output, `preview-${name}.png`), fullPage: true });
    await page.close();
  }
  execFileSync(python, ["scripts/acceptance/verify-odoo-receipt-codes.py", "--verify-directory", output]);
  report.success = true;
} finally {
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: report.success, cases: report.cases.length, output }));
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
