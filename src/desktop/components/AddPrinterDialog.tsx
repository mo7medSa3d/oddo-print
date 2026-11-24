import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import {
  Button,
  Modal,
  Field,
  Input,
  Select,
  Checkbox,
  ErrorState,
} from "../../components/ui";
import { registerPrinterLocal, type PrinterInfo, type RegisterPrinterRequest } from "../lib/ipc";
import { applySpoolerSelection, errMsg, friendlyAgentError, isPickerEligiblePrinter, pickerAgentMismatchRows, pickerSpoolerRows, printerDisplayName, searchSpoolerRows, spoolerDriverName, spoolerPortName, spoolerRowLabel, validateTypedSpoolerNameAgainst } from "../lib/printers";
import { useI18n } from "../../i18n/react";

type Conn = "spooler" | "network" | "usb" | "ipp" | "ipps";

export function AddPrinterDialog({
  open,
  onClose,
  onSuccess,
  printers,
  onDiscoverRequest,
  gatewayUrl: _gatewayUrl,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  printers: PrinterInfo[];
  /** Runs a fresh Windows-printer discovery on the local Agent and
   * refreshes the inventories this dialog reads. The dialog triggers it
   * automatically when opened with an empty picker, so a fresh install
   * never opens onto a "type the exact queue name" fallback. */
  onDiscoverRequest?: () => Promise<void>;
  gatewayUrl?: string;
}) {
  const { t, locale } = useI18n();
  const [name, setName] = useState("");
  const [conn, setConn] = useState<Conn>("spooler");
  const [spoolerName, setSpoolerName] = useState("");
  // Picker search text and the row the user last picked (for its
  // driver/port/status detail line). The row id, not the queue name, is
  // the Select value: two queues on different servers may share a name.
  const [spoolerSearch, setSpoolerSearch] = useState("");
  const [pickedSpooler, setPickedSpooler] = useState<PrinterInfo | null>(null);
  // In-dialog discovery: opening the dialog with an empty picker runs a
  // fresh scan automatically (once per open). Typing a queue name from
  // memory is an explicit last resort behind "enter manually", never
  // the default face of the dialog.
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [manualSpoolerEntry, setManualSpoolerEntry] = useState(false);
  const autoDiscoverTried = useRef(false);
  const discoverGeneration = useRef(0);
  const [spoolerRaw, setSpoolerRaw] = useState(false);
  const [spoolerEscpos, setSpoolerEscpos] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [protocol, setProtocol] = useState("raw");
  const [ippUrl, setIppUrl] = useState("");
  const [usbSel, setUsbSel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Printer setup is local to this Agent. Odoo receives the inventory through
  // the Agent heartbeat, so there is no Cloud fleet lookup or remote printer
  // registration step.
  const currentAgentId = "";

  // Event-driven reset avoids synchronous setState in a React effect.
  const closeDialog = () => onClose();


  // Clear any previous error when dialog transitions to open
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) setError(null);
    else setDiscovering(false);
  }

  // Only physical printers from this local Agent may be selected for a
  // production binding. Both Tauri camelCase and persisted snake_case keys
  // are accepted because the local registry spans Agent versions.
  // WP4 picker rule (see isPickerEligiblePrinter): a row with NO agentId
  // is eligible — local inventory rows never carry one, and demanding an
  // exact agent match emptied the picker by construction (S3). Only rows
  // owned by a different agent record are excluded, and they are warned
  // about below instead of vanishing into the empty-picker hint.
  const physicalSpoolers = useMemo(
    () => pickerSpoolerRows(printers, currentAgentId),
    [printers, currentAgentId]
  );
  const mismatchSpoolers = useMemo(
    () => pickerAgentMismatchRows(printers, currentAgentId),
    [printers, currentAgentId]
  );
  const filteredSpoolers = useMemo(
    () => searchSpoolerRows(physicalSpoolers, spoolerSearch, locale),
    [physicalSpoolers, spoolerSearch, locale]
  );
  // Keep the picked row visible even when the search text filters it out,
  // so the Select never silently unselects the user's choice.
  const displayedSpoolers = useMemo(
    () => pickedSpooler && !filteredSpoolers.some((p) => p.id === pickedSpooler.id)
      ? [pickedSpooler, ...filteredSpoolers] : filteredSpoolers,
    [pickedSpooler, filteredSpoolers]
  );
  const usbPrinters = useMemo(
    () =>
      printers.filter(
        (p) =>
          isPickerEligiblePrinter(p, currentAgentId) &&
          ((p.connection_type || p.connectionType) || "").toLowerCase() === "usb"
      ),
    [printers, currentAgentId]
  );
  // Typed-name validation runs only in the manual-fallback mode (no
  // pickable rows). Warnings never block submit: discovery can miss
  // per-user queues, so an undiscovered name may still be real.
  const typedSpoolerCheck = conn === "spooler" && physicalSpoolers.length === 0
    ? validateTypedSpoolerNameAgainst(spoolerName, physicalSpoolers, mismatchSpoolers)
    : null;

  const runDiscover = async () => {
    if (!onDiscoverRequest || discovering) return;
    const generation = ++discoverGeneration.current;
    setDiscovering(true);
    setDiscoverError(null);
    try {
      await onDiscoverRequest();
    } catch (e) {
      if (generation === discoverGeneration.current) setDiscoverError(errMsg(e));
    } finally {
      if (generation === discoverGeneration.current) setDiscovering(false);
    }
  };

  // Auto-discover once per dialog open when the picker would otherwise
  // be empty. The guard ref (not state) keeps the effect idempotent
  // under StrictMode double-invocation; it resets when the dialog
  // closes so the next open scans again.
  useEffect(() => () => {
    ++discoverGeneration.current;
  }, []);

  useEffect(() => {
    if (!open) {
      autoDiscoverTried.current = false;
      ++discoverGeneration.current;
      return;
    }
    if (conn !== "spooler" || physicalSpoolers.length > 0 || autoDiscoverTried.current) return;
    autoDiscoverTried.current = true;
    void runDiscover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conn, physicalSpoolers.length]);

  const validate = (): string | null => {
    if (!name.trim()) return t("desktop.add.nameRequired");
    if (conn === "spooler" && !spoolerName.trim())
      return t("desktop.add.spoolerRequired");
    if (conn === "network") {
      const trimmedHost = host.trim();
      if (!trimmedHost) return t("desktop.add.hostRequired");
      if (/\s/.test(trimmedHost)) return t("desktop.add.hostInvalid");
      // The native Agent validates and persists the local printer target.
      const p = Number(port);
      if (!Number.isInteger(p) || p !== 9100) return t("desktop.add.portRequired");
    }
    const trimmedIpp = ippUrl.trim();
    if ((conn === "ipp" || conn === "ipps") && !trimmedIpp) return t("desktop.add.ippEndpointRequired");
    if (
      (conn === "ipp" || conn === "ipps") &&
      trimmedIpp &&
      !/^(https?|ipp|ipps):\/\//i.test(trimmedIpp)
    )
      return t("desktop.add.ippSchemeInvalid");
    if (
      conn === "ipps" &&
      trimmedIpp &&
      !/^(https|ipps):\/\//i.test(trimmedIpp)
    )
      return t("desktop.add.ippsSchemeInvalid");
    if (conn === "usb" && !usbSel) return t("desktop.add.selectUsb");
    return null;
  };

  const reset = () => {
    setName("");
    setHost("");
    setPort("9100");
    setSpoolerName("");
    setSpoolerSearch("");
    setPickedSpooler(null);
    setManualSpoolerEntry(false);
    setDiscoverError(null);
    setSpoolerRaw(false);
    setSpoolerEscpos(false);
    setIppUrl("");
    setUsbSel("");
  };

  // One click fills the spooler name and, when the user has not typed a
  // custom printer name, the printer name too. Driver/port have no
  // Gateway registration field for spooler queues, so they are shown in
  // the detail line below the picker instead of being submitted.
  const handleSpoolerPick = (rowId: string) => {
    const picked = displayedSpoolers.find((p) => p.id === rowId) ?? null;
    setPickedSpooler(picked);
    if (!picked) {
      setSpoolerName("");
      return;
    }
    const filled = applySpoolerSelection(picked, name);
    setName(filled.name);
    setSpoolerName(filled.spoolerName);
  };

  const handleSubmit = async () => {
    if (busy) return;
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const req: RegisterPrinterRequest = { name: name.trim(), connectionType: conn };
      if (conn === "spooler") {
        req.spoolerName = spoolerName.trim();
        req.endpoint = spoolerName.trim();
        req.protocol = "spooler";
        req.spoolerPassthroughProtocols = [
          ...(spoolerRaw ? ["raw" as const] : []),
          ...(spoolerEscpos ? ["escpos" as const] : []),
        ];
      }
      if (conn === "network") {
        req.endpoint = `${host.trim()}:${port.trim()}`;
        req.protocol = protocol;
      }
      if (conn === "ipp" || conn === "ipps") {
        req.endpoint = ippUrl.trim();
        req.protocol = conn;
      }
      if (conn === "usb") {
        // usbPrinters is already eligibility-filtered (agentId-less rows
        // included); re-demanding an agent match here would reject the
        // very rows the picker just offered.
        const sel = usbPrinters.find((p) => p.id === usbSel);
        if (!sel) throw new Error(t("desktop.add.selectUsb"));
        if (sel) {
          const sourceConfig = sel.config && typeof sel.config === "object"
            ? sel.config as Record<string, unknown>
            : {};
          req.usbVid = sourceConfig.vid != null ? String(sourceConfig.vid) : sel.usbVid ? "0x" + sel.usbVid.replace(/^0x/i, "") : undefined;
          req.usbPid = sourceConfig.pid != null ? String(sourceConfig.pid) : sel.usbPid ? "0x" + sel.usbPid.replace(/^0x/i, "") : undefined;
          req.usbSerial = sel.usbSerial ?? (sourceConfig.serial != null ? String(sourceConfig.serial) : undefined);
          const discoveredSpooler = sel.spooler_name ?? sel.spoolerName ?? (typeof sourceConfig.spooler_name === "string" ? sourceConfig.spooler_name : "");
          if (discoveredSpooler.trim()) {
            req.spoolerName = discoveredSpooler.trim();
            req.endpoint = discoveredSpooler.trim();
            req.protocol = "spooler";
          } else {
            req.endpoint = sel.endpoint
              || (typeof sourceConfig.address === "string" ? sourceConfig.address : "");
            // Discovery may not have enough evidence to prove a byte protocol.
            // Preserve that uncertainty instead of guessing RAW and making an
            // otherwise unverified USB device routable.
            req.protocol = sel.protocol || "unknown";
          }
        }
      }
      await registerPrinterLocal(req);
      onSuccess();
      closeDialog();
      reset();
    } catch (e) {
      setError(friendlyAgentError(errMsg(e), locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
      open={open}
      onClose={closeDialog}
      title={t("desktop.add.title")}
      footer={
        <>
          <Button variant="secondary" onClick={closeDialog}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={busy}
            icon={<Plus className="h-5 w-5" />}
          >
            {t("desktop.add.title")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label={t("desktop.add.printerName")} htmlFor="pp-name">
          <Input
            id="pp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("desktop.add.namePlaceholder")}
          />
        </Field>
        <Field label={t("desktop.add.connectionType")} htmlFor="pp-conn">
          <Select
            id="pp-conn"
            value={conn}
            onChange={(e) => setConn(e.target.value as Conn)}
          >
            <option value="spooler">{t("desktop.connection.spooler")}</option>
            <option value="network">{t("desktop.connection.network")}</option>
            <option value="usb">{t("desktop.connection.usb")}</option>
            <option value="ipp">{t("desktop.connection.ipp")}</option>
            <option value="ipps">IPPS</option>
          </Select>
        </Field>
        {conn === "spooler" && (
          <>
            {physicalSpoolers.length > 0 && (
              <Input
                id="pp-spooler-search"
                value={spoolerSearch}
                onChange={(e) => setSpoolerSearch(e.target.value)}
                placeholder={t("desktop.add.spoolerSearchPlaceholder")}
                aria-label={t("desktop.add.spoolerSearchAria")}
              />
            )}
            {physicalSpoolers.length > 0 ? (
              <Field
                label={t("desktop.add.spoolerPrinter")}
                htmlFor="pp-spooler"
                hint={t("desktop.add.onlyPhysicalListed")}
              >
                <Select
                  id="pp-spooler"
                  value={pickedSpooler?.id ?? ""}
                  onChange={(e) => handleSpoolerPick(e.target.value)}
                >
                  <option value="">{t("desktop.add.selectEllipsis")}</option>
                  {displayedSpoolers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {spoolerRowLabel(p, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : discovering ? (
              <Field
                label={t("desktop.add.spoolerPrinter")}
                htmlFor="pp-spooler"
                hint={t("desktop.add.searchingPrinters")}
              >
                <Input
                  id="pp-spooler"
                  disabled
                  value=""
                  placeholder={t("desktop.add.searchingPrinters")}
                />
              </Field>
            ) : manualSpoolerEntry ? (
              <Field
                label={t("desktop.add.spoolerPrinter")}
                htmlFor="pp-spooler"
                hint={t("desktop.add.manualFallbackHint")}
              >
                <Input
                  id="pp-spooler"
                  dir="ltr"
                  value={spoolerName}
                  onChange={(e) => { setSpoolerName(e.target.value); }}
                  placeholder={t("desktop.add.typeWindowsName")}
                />
              </Field>
            ) : (
              <div className="space-y-3 rounded-md border border-control p-3">
                <p className="text-sm text-ink-3" aria-live="polite">
                  {discoverError ? t("desktop.add.discoveryFailedHint") : t("desktop.add.noPrintersFoundYet")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void runDiscover()} loading={discovering} icon={<RefreshCw className="h-4 w-4" />}>
                    {t("desktop.add.searchAgain")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setManualSpoolerEntry(true)}>
                    {t("desktop.add.enterNameManually")}
                  </Button>
                </div>
              </div>
            )}
            {physicalSpoolers.length > 0 && (
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => void runDiscover()} loading={discovering} icon={<RefreshCw className="h-4 w-4" />}>
                  {t("desktop.add.searchAgain")}
                </Button>
              </div>
            )}
            {physicalSpoolers.length > 0 && filteredSpoolers.length === 0 && (
              <p className="text-sm text-ink-3" aria-live="polite">{t("desktop.add.spoolerSearchNoMatches")}</p>
            )}
            {pickedSpooler && spoolerName && (
              <p className="text-sm text-ink-3">
                {t("desktop.add.spoolerDriver")}: {spoolerDriverName(pickedSpooler) ? <span dir="ltr" className="[unicode-bidi:isolate]">{spoolerDriverName(pickedSpooler)}</span> : t("common.notAvailable")} {" · "}
                {t("desktop.add.spoolerPort")}: {spoolerPortName(pickedSpooler) ? <span dir="ltr" className="tabular-nums [unicode-bidi:isolate]">{spoolerPortName(pickedSpooler)}</span> : t("common.notAvailable")} {" · "}
                {t("desktop.add.spoolerStatus")}: {(pickedSpooler.status || "").trim() || t("common.notAvailable")}
              </p>
            )}
            {manualSpoolerEntry && typedSpoolerCheck && typedSpoolerCheck.status === "unknown" && spoolerName.trim() && (
              <p className="text-sm text-ink-3">{t("desktop.add.typedNameUnknownWarning")}</p>
            )}
            {manualSpoolerEntry && typedSpoolerCheck && typedSpoolerCheck.status === "agent_mismatch" && typedSpoolerCheck.suggestion && (
              <p className="text-sm text-ink-3">{t("desktop.add.typedNameAgentMismatchWarning", { name: typedSpoolerCheck.suggestion })}</p>
            )}
            {manualSpoolerEntry && typedSpoolerCheck && typedSpoolerCheck.status === "near_miss" && typedSpoolerCheck.suggestion && (
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
                <span>{t("desktop.add.typedNameNearMissWarning", { name: typedSpoolerCheck.suggestion })}</span>
                <Button variant="ghost" size="sm" onClick={() => setSpoolerName(typedSpoolerCheck.suggestion)}><span dir="ltr">{typedSpoolerCheck.suggestion}</span></Button>
              </p>
            )}
          </>
        )}
        {conn === "spooler" && (
          <div className="space-y-3 rounded-md border border-control p-3">
            <p className="text-sm font-[500] text-ink">{t("desktop.spoolerPassthrough.title")}</p>
            <p className="text-sm text-ink-3">{t("desktop.spoolerPassthrough.description")}</p>
            <Checkbox
              checked={spoolerEscpos}
              onChange={(e) => setSpoolerEscpos(e.target.checked)}
              label={t("desktop.spoolerPassthrough.escpos")}
              description={t("desktop.spoolerPassthrough.escposHint")}
            />
            <Checkbox
              checked={spoolerRaw}
              onChange={(e) => setSpoolerRaw(e.target.checked)}
              label={t("desktop.spoolerPassthrough.raw")}
              description={t("desktop.spoolerPassthrough.rawHint")}
            />
          </div>
        )}
        {conn === "network" && (
          <div className="grid gap-4 sm:grid-cols-[1.6fr_1fr]">
            <Field label={t("desktop.add.host")} htmlFor="pp-host">
              <Input
                id="pp-host"
                dir="ltr"
                className="tabular-nums"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50"
              />
            </Field>
            <Field label={t("desktop.add.port")} htmlFor="pp-port">
              <Input
                id="pp-port"
                dir="ltr"
                className="tabular-nums"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="9100"
                inputMode="numeric"
              />
            </Field>
            <Field
              label={t("desktop.add.protocol")}
              htmlFor="pp-proto"
              className="sm:col-span-2"
              hint={t("desktop.add.protocolHint")}
            >
              <Select
                id="pp-proto"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
              >
                <option value="raw">RAW</option>
                <option value="escpos">ESC/POS</option>
                <option value="zpl">ZPL</option>
                <option value="tspl">TSPL</option>
              </Select>
            </Field>
          </div>
        )}
        {conn === "usb" && (
          <Field
            label={t("desktop.add.usbPrinter")}
            htmlFor="pp-usb"
            hint={t("desktop.add.usbHint")}
          >
            <Select id="pp-usb" value={usbSel} onChange={(e) => setUsbSel(e.target.value)}>
              <option value="">{t("desktop.add.selectEllipsis")}</option>
              {usbPrinters.map((p) => (
                <option key={p.id} value={p.id}>
                  {printerDisplayName(p, locale)} {p.usbVid ? `(${p.usbVid}:${p.usbPid})` : ""}
                </option>
              ))}
              {usbPrinters.length === 0 && <option disabled>{t("desktop.add.noUsbDiscovered")}</option>}
            </Select>
          </Field>
        )}
        {(conn === "ipp" || conn === "ipps") && (
          <Field
            label={conn === "ipps" ? t("desktop.add.ippsEndpoint") : t("desktop.add.ippEndpoint")}
            htmlFor="pp-ipp"
            hint={conn === "ipps" ? t("desktop.add.ippsHint") : t("desktop.add.ippHint")}
          >
            <Input
              id="pp-ipp"
              dir="ltr"
              value={ippUrl}
              onChange={(e) => setIppUrl(e.target.value)}
              placeholder={conn === "ipps" ? "ipps://192.168.1.60/ipp/print" : "ipp://192.168.1.60/ipp/print"}
            />
          </Field>
        )}
        {error && <ErrorState title={t("desktop.add.cannotAdd")} message={error} />}
      </div>
      </Modal>

    </>
  );
}
