import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Copy, FileImage, FileText, FlaskConical, Play, ShieldCheck, Upload } from "lucide-react";
import { Button, Card } from "../../components/ui";
import { useI18n } from "../../i18n/react";
import { captureTestDocument, fetchE2ECaptureInbox, fetchE2ECapturePreview, getGatewayUrl, isTauri, type E2ECaptureRun, type LocalCaptureResult } from "../lib/ipc";

type Sample = "pos" | "kitchen" | "bar" | "invoice";
const sampleMessageKeys = {
  pos: "desktop.testCenter.sample.pos",
  kitchen: "desktop.testCenter.sample.kitchen",
  bar: "desktop.testCenter.sample.bar",
  invoice: "desktop.testCenter.sample.invoice",
} as const;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

// This preview is deliberately a SAMPLE, not Odoo's real QWeb/OWL layout.
// To verify actual Odoo 19/20 output, import an exported receipt JPEG or PDF.
function sampleJPEG(sample: Sample, paperMM: 58 | 80): Uint8Array {
  const invoice = sample === "invoice";
  const canvas = document.createElement("canvas");
  canvas.width = invoice ? 794 : paperMM === 58 ? 384 : 512;
  canvas.height = invoice ? 1122 : sample === "pos" ? 780 : 610;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is unavailable");
  const w = canvas.width;
  const margin = invoice ? 44 : 24;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, canvas.height);
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.direction = "ltr";
  ctx.font = invoice ? "bold 32px sans-serif" : "bold 27px sans-serif";
  ctx.fillText("YASEIR TEST", w / 2, 35);
  ctx.font = invoice ? "20px sans-serif" : "17px sans-serif";
  ctx.fillText("LOCAL SIMULATION — NOT PRINTED", w / 2, invoice ? 81 : 78);

  ctx.direction = "rtl";
  ctx.textAlign = "right";
  ctx.font = invoice ? "bold 28px sans-serif" : "bold 23px sans-serif";
  ctx.fillText(sample === "kitchen" ? "طلب مطبخ تجريبي" :
    sample === "bar" ? "طلب مشروبات تجريبي" :
    sample === "invoice" ? "فاتورة اختبارية" : "إيصال تجريبي", w - margin, 134);

  ctx.direction = "ltr";
  ctx.textAlign = "left";
  ctx.font = invoice ? "21px sans-serif" : "19px sans-serif";
  const top = invoice ? 219 : 199;
  const rows: Array<[string, string]> = sample === "kitchen"
    ? [["2 x", "Burger / برجر"], ["1 x", "No onions / بدون بصل"], ["1 x", "Fries / بطاطس"]]
    : sample === "bar"
      ? [["2 x", "Coffee / قهوة"], ["1 x", "Tea / شاي"], ["1 x", "Water / ماء"]]
      : [["1 x", "Coffee / قهوة"], ["2 x", "Sandwich / ساندويتش"], ["1 x", "Water / ماء"]];
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#333";
  ctx.beginPath();
  ctx.moveTo(margin, top - 15);
  ctx.lineTo(w - margin, top - 15);
  ctx.stroke();
  const rowGap = invoice ? 90 : 74;
  rows.forEach(([quantity, label], i) => {
    const y = top + i * rowGap;
    ctx.fillStyle = "#111";
    ctx.fillText(quantity, margin, y);
    ctx.fillText(label, margin + 59, y);
    ctx.textAlign = "right";
    ctx.fillText(["12.00", "24.00", "6.00"][i], w - margin, y + 30);
    ctx.textAlign = "left";
  });
  const summaryY = top + rows.length * rowGap + 38;
  ctx.beginPath();
  ctx.moveTo(margin, summaryY - 15);
  ctx.lineTo(w - margin, summaryY - 15);
  ctx.stroke();
  ctx.font = invoice ? "bold 26px sans-serif" : "bold 22px sans-serif";
  ctx.fillText(sample === "invoice" ? "TOTAL" : "TEST ONLY", margin, summaryY);
  ctx.textAlign = "right";
  ctx.fillText(sample === "invoice" || sample === "pos" ? "42.00" : "3 ITEMS", w - margin, summaryY);
  ctx.textAlign = "center";
  ctx.font = invoice ? "20px sans-serif" : "17px sans-serif";
  ctx.fillText("No hardware was contacted", w / 2, summaryY + 76);
  ctx.fillText("لا توجد طباعة فعلية", w / 2, summaryY + 111);
  const data = canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  const binary = atob(data);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importedDocument(file: File): Promise<{ data: Uint8Array; format: "pdf" | "jpeg" }> {
  if (file.size < 1 || file.size > MAX_DOCUMENT_BYTES) {
    throw new Error("Choose a document smaller than 4 MiB");
  }
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") && (file.type === "application/pdf" || file.type === "")) {
    return { data: new Uint8Array(await file.arrayBuffer()), format: "pdf" };
  }
  if (!/\.(jpe?g|png)$/.test(name) || !["image/jpeg", "image/png", ""].includes(file.type)) {
    throw new Error("Only PDF, JPEG and PNG documents are supported");
  }
  const picture = await createImageBitmap(file);
  try {
    if (picture.width < 1 || picture.height < 1 || picture.width > 4096 ||
        picture.height > 10000 || picture.width * picture.height > 12_000_000) {
      throw new Error("Image dimensions exceed the safe capture limit");
    }
    const canvas = document.createElement("canvas");
    canvas.width = picture.width;
    canvas.height = picture.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas rendering is unavailable");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(picture, 0, 0);
    const encoded = canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
    const decoded = atob(encoded);
    const data = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (data.length > MAX_DOCUMENT_BYTES) {
      throw new Error("Converted image exceeds 4 MiB");
    }
    return { data, format: "jpeg" };
  } finally {
    picture.close();
  }
}

export function TestCenterPage() {
  const { t } = useI18n();
  const [sample, setSample] = useState<Sample>("pos");
  const [paperMM, setPaperMM] = useState<58 | 80>(80);
  // Uploaded images may be full-sized reports or receipt rasters.
  // Never silently squeeze an imported invoice onto 80mm roll paper.
  const [importPaperMM, setImportPaperMM] = useState<0 | 58 | 80>(0);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LocalCaptureResult | null>(null);
  const [remoteRuns, setRemoteRuns] = useState<E2ECaptureRun[]>([]);
  const [remoteError, setRemoteError] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remotePreview, setRemotePreview] = useState<{ id: string; uri: string } | null>(null);
  const [remotePreviewError, setRemotePreviewError] = useState("");

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let running = false;
    const refresh = async () => {
      if (running || !active) return;
      running = true;
      setRemoteLoading(true);
      try {
        const origin = await getGatewayUrl();
        if (!origin) throw new Error("GATEWAY_NOT_CONFIGURED");
        const rows = await fetchE2ECaptureInbox(origin);
        if (active) { setRemoteRuns(rows); setRemoteError(""); }
      } catch (e) {
        if (active) { setRemoteRuns([]); setRemoteError(e instanceof Error ? e.message : "UNKNOWN"); }
      } finally {
        running = false;
        if (active) setRemoteLoading(false);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const showRemotePreview = async (id: string) => {
    setRemotePreview(null);
    setRemotePreviewError("");
    try {
      const origin = await getGatewayUrl();
      if (!origin) throw new Error("GATEWAY_NOT_CONFIGURED");
      const uri = await fetchE2ECapturePreview(origin, id);
      setRemotePreview({ id, uri });
    } catch (e) {
      setRemotePreviewError(e instanceof Error ? e.message : "UNKNOWN");
    }
  };

  const chooseSample = (next: Sample) => {
    setSample(next);
    setFile(null);
    setResult(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const run = async () => {
    if (!isTauri || busy) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const input = file
        ? await importedDocument(file)
        : { data: sampleJPEG(sample, paperMM), format: "jpeg" as const };
      const width = input.format === "pdf" ? 0
        : file ? importPaperMM : sample === "invoice" ? 0 : paperMM;
      const response = await captureTestDocument({
        documentBytes: Array.from(input.data),
        format: input.format,
        paperMm: width,
      });
      if (response.outcome !== "rendered_locally" || response.renderer !== "embedded_pdfium") {
        throw new Error("Local PDFium render confirmation is missing");
      }
      setResult(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-edge bg-surface p-5">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-brand"><FlaskConical className="h-5 w-5" /><span className="text-sm font-semibold">{t("desktop.testCenter.title")}</span></div>
          <h2 className="text-xl font-bold text-ink">{t("desktop.testCenter.heading")}</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-ink-3">{t("desktop.testCenter.description")}</p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-xs text-ink-2">
          <ShieldCheck className="h-4 w-4 text-ok" />{t("desktop.testCenter.localOnly")}
        </div>
      </div>

      <Card className="p-5">
        <div className="space-y-5">
          <div>
            <h3 className="mb-3 text-sm font-semibold text-ink">{t("desktop.testCenter.sampleTitle")}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(["pos", "kitchen", "bar", "invoice"] as const).map((kind) => (
                <Button key={kind} variant={!file && sample === kind ? "primary" : "secondary"}
                  onClick={() => chooseSample(kind)} className="min-h-11">
                  {t(sampleMessageKeys[kind])}
                </Button>
              ))}
            </div>
          </div>

          {(!file && sample !== "invoice") && (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-ink">{t("desktop.testCenter.paperTitle")}</legend>
              <div className="flex gap-2">
                {([58, 80] as const).map((mm) => (
                  <Button key={mm} variant={paperMM === mm ? "primary" : "secondary"}
                    onClick={() => { setPaperMM(mm); setResult(null); }}>{mm} mm</Button>
                ))}
              </div>
            </fieldset>
          )}

          <div className="rounded-lg border border-dashed border-edge bg-surface-2/50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Upload className="h-4 w-4" />{t("desktop.testCenter.importTitle")}</h3>
                <p className="mt-1 text-xs text-ink-3">{t("desktop.testCenter.importBody")}</p>
              </div>
              <label className="cursor-pointer rounded-lg border border-edge bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-hover">
                {t("desktop.testCenter.chooseFile")}
                <input ref={fileInput} className="sr-only" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                  onChange={(event) => {
                    const next = event.currentTarget.files?.[0] ?? null;
                    setFile(next);
                    setImportPaperMM(0);
                    setResult(null);
                    setError(null);
                  }} />
              </label>
            </div>
            {file && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-2">
              <FileText className="h-4 w-4" /><span className="max-w-full break-all">{file.name}</span>
              <Button size="sm" variant="ghost" onClick={() => chooseSample(sample)}>{t("desktop.testCenter.clearFile")}</Button>
            </div>}
          </div>

          {file && !file.name.toLowerCase().endsWith(".pdf") && (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-ink">{t("desktop.testCenter.importPaperTitle")}</legend>
              <div className="flex flex-wrap gap-2">
                {([0, 58, 80] as const).map((mm) => (
                  <Button key={mm} variant={importPaperMM === mm ? "primary" : "secondary"}
                    onClick={() => { setImportPaperMM(mm); setResult(null); }}>
                    {mm === 0 ? t("desktop.testCenter.keepOriginal") : `${mm} mm`}
                  </Button>
                ))}
              </div>
            </fieldset>
          )}

          <Button variant="primary" className="min-h-11 w-full sm:w-auto"
            loading={busy} disabled={!isTauri || busy} onClick={() => void run()}
            icon={<Play className="h-4 w-4" />}>{t("desktop.testCenter.run")}</Button>
          {!isTauri && <p className="text-xs text-ink-3">{t("desktop.testCenter.windowsOnly")}</p>}
          {error && <div role="alert" className="rounded-lg border border-bad-edge bg-bad-bg px-4 py-3 text-sm text-bad">{t("desktop.testCenter.failed")}: {error}</div>}
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-ink">{t("desktop.testCenter.remoteTitle")}</h3>
            <p className="mt-1 text-sm text-ink-3">{t("desktop.testCenter.remoteDescription")}</p>
          </div>
          <span className="text-xs text-ink-3">{remoteLoading ? t("desktop.testCenter.remoteChecking") : t("desktop.testCenter.remoteAutoRefresh")}</span>
        </div>
        {remoteError ? (
          <p role="status" className="rounded-md border border-edge bg-surface-2 p-3 text-sm text-ink-2">
            {remoteError.includes("CAPTURE_NOT_ENABLED") ? t("desktop.testCenter.remoteDisabled")
              : remoteError === "GATEWAY_NOT_CONFIGURED" ? t("desktop.testCenter.remoteNoGateway")
              : t("desktop.testCenter.remoteUnavailable") + ": " + remoteError}
          </p>
        ) : remoteRuns.length === 0 ? (
          <p className="rounded-md bg-surface-2 p-3 text-sm text-ink-3">{t("desktop.testCenter.remoteEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {remoteRuns.map((run) => (
              <div key={run.runId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{t("desktop.testCenter.remoteTask")} <span className="font-mono text-xs" dir="ltr">{run.runId.slice(-8)}</span></p>
                  <p className="mt-1 text-xs text-ink-3">{new Date(run.createdAt).toLocaleString()} · {run.paperMm ? run.paperMm + " mm" : "PDF"}</p>
                  {run.status === "rendered_locally" && <p className="mt-1 text-xs text-ink-3">{run.pages ?? 0} {t("desktop.testCenter.remotePages")}</p>}
                  {run.errorCode && <p className="mt-1 text-xs text-bad" dir="ltr">{run.errorCode}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold text-ink-2">
                    {t(("desktop.testCenter.remoteStatus." + run.status) as "desktop.testCenter.remoteStatus.queued")}
                  </span>
                  {run.status === "rendered_locally" && (
                    <Button size="sm" variant="secondary" onClick={() => void showRemotePreview(run.runId)}>
                      {t("desktop.testCenter.remotePreview")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {remotePreviewError && <p role="alert" className="mt-3 text-sm text-bad">{remotePreviewError}</p>}
        {remotePreview && <div className="mt-4 rounded-lg border border-edge bg-surface-2 p-4">
          <p className="mb-3 text-xs text-ink-3">{t("desktop.testCenter.remoteNotPrinted")}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={remotePreview.uri} alt={t("desktop.testCenter.remotePreview")} className="mx-auto max-h-[520px] max-w-full object-contain" />
          <Button size="sm" variant="ghost" onClick={() => setRemotePreview(null)}>{t("desktop.testCenter.remoteClose")}</Button>
        </div>}
      </Card>

      {result && (
        <Card className="overflow-hidden">
          <div className="border-b border-edge p-5">
            <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
              <CheckCircle2 className="h-5 w-5 text-ok" />{t("desktop.testCenter.complete")}
            </h3>
            <p className="mt-2 text-sm text-ink-3">{t("desktop.testCenter.notPrinted")}</p>
          </div>
          <div className="grid gap-5 p-5 lg:grid-cols-2">
            <div className="flex max-h-[520px] justify-center overflow-auto rounded-lg border border-edge bg-surface-2 p-4">
              {/* This is a local PNG decoded from the PDF rendered by PDFium. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result.previewDataUri} alt={t("desktop.testCenter.previewAlt")} className="h-auto max-w-full self-start shadow-sm" />
            </div>
            <div className="min-w-0 space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-ink"><FileImage className="h-4 w-4" />{t("desktop.testCenter.artifacts")}</div>
              <div className="rounded-lg border border-edge bg-surface-2 p-3 text-sm">
                <p>{t("desktop.testCenter.renderer")}: PDFium</p>
                <p>{t("desktop.testCenter.pages")}: {result.pages}</p>
                <p>{t("desktop.testCenter.bytes")}: {result.pdfBytes.toLocaleString()}</p>
                <p>{t("desktop.testCenter.sha")}: <span className="break-all font-mono text-xs">{result.sha256}</span></p>
              </div>
              {([{ label: t("desktop.testCenter.pdfPath"), value: result.pdfPath },
                { label: t("desktop.testCenter.pngPath"), value: result.previewPath }]).map((item) => (
                <div key={item.label} className="space-y-2">
                  <div className="text-xs font-semibold text-ink-2">{item.label}</div>
                  <div className="flex min-w-0 items-start gap-2 rounded-lg border border-edge p-3">
                    <span dir="ltr" className="min-w-0 flex-1 break-all font-mono text-xs text-ink-3">{item.value}</span>
                    <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(item.value)}
                      icon={<Copy className="h-4 w-4" />}>{t("desktop.testCenter.copy")}</Button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-ink-3">{t("desktop.testCenter.retention")}</p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
