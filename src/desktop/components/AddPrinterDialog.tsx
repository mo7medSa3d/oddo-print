import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Modal,
  Field,
  Input,
  Select,
  Checkbox,
  ErrorState,
} from "../../components/ui";
import { fetchGatewayAgents, registerGatewayPrinter, type GatewayApiError, type PrinterInfo, type RegisterPrinterRequest } from "../lib/ipc";
import { agentLiveView, errMsg, friendlyGatewayError, isProductionPrinter } from "../lib/printers";
import UpgradeLimitDialog, { type UpgradeLimitResource } from "../../components/UpgradeLimitDialog";
import { useI18n } from "../../i18n/react";

type Conn = "spooler" | "network" | "usb" | "ipp" | "ipps";

export function AddPrinterDialog({
  open,
  onClose,
  onSuccess,
  printers,
  gatewayUrl,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  printers: PrinterInfo[];
  gatewayUrl: string;
}) {
  const { t, locale } = useI18n();
  const [name, setName] = useState("");
  const [conn, setConn] = useState<Conn>("spooler");
  const [spoolerName, setSpoolerName] = useState("");
  const [spoolerRaw, setSpoolerRaw] = useState(false);
  const [spoolerEscpos, setSpoolerEscpos] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [protocol, setProtocol] = useState("raw");
  const [ippUrl, setIppUrl] = useState("");
  const [usbSel, setUsbSel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; status?: string; lifecycle?: string; lastSeenAt?: string | null }>>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState(false);
  // Which gateway URL the cached agents were fetched from. The cache must
  // be keyed by URL: reusing gateway A's agents after switching to gateway
  // B would register the printer against an agentId B never issued.
  const [agentsForUrl, setAgentsForUrl] = useState("");
  const agentsGeneration = useRef(0);

  // Staleness is derived from the heartbeat (90s by default), so an honest
  // status needs a clock that advances while the screen stays open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const [agentId, setAgentId] = useState("");
  const [upgradeLimit, setUpgradeLimit] = useState<{
    resource: UpgradeLimitResource;
    used?: number | null;
    limit?: number | "unlimited" | null;
  } | null>(null);

  const loadAgents = useCallback(async () => {
    if (!gatewayUrl || agentsForUrl === gatewayUrl) return;
    // Generation guard: a late response for a previous gateway (or an older
    // attempt) must never overwrite the current picker's list.
    const generation = ++agentsGeneration.current;
    setAgentsLoading(true);
    setAgentsError(false);
    try {
      const rows = await fetchGatewayAgents(gatewayUrl);
      if (agentsGeneration.current !== generation) return;
      setAgents(rows);
      setAgentsForUrl(gatewayUrl);
      const active = rows.find((row) => row.lifecycle === "active");
      // Keep the selection only if it exists on THIS gateway; otherwise
      // fall back to its active agent (or empty when none is active).
      setAgentId((current) => rows.some((row) => row.id === current) ? current : (active?.id ?? ""));
    } catch {
      if (agentsGeneration.current !== generation) return;
      setAgents([]);
      setAgentsForUrl("");
      setAgentsError(true);
    } finally {
      if (agentsGeneration.current === generation) setAgentsLoading(false);
    }
  }, [gatewayUrl, agentsForUrl]);


  // Clear any previous error when dialog transitions to open
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) setError(null);
  }

  // Only physical printers may be picked for a production binding.
  // Both wire casings must be accepted: the Tauri `discover_printers` command
  // serializes camelCase (`spoolerName`, `connectionType`) while the Gateway
  // `/api/printers` rows are camelCase too, so reading only snake_case made
  // these two lists permanently empty.
  const physicalSpoolers = useMemo(
    () => printers.filter((p) => p.agentId === agentId && isProductionPrinter(p) && (p.spooler_name || p.spoolerName)),
    [printers, agentId]
  );
  const usbPrinters = useMemo(
    () =>
      printers.filter(
        (p) =>
          p.agentId === agentId &&
          ((p.connection_type || p.connectionType) || "").toLowerCase() === "usb" &&
          isProductionPrinter(p)
      ),
    [printers, agentId]
  );

  const validate = (): string | null => {
    if (!gatewayUrl) return t("desktop.add.gatewayUrlMissing");
    if (!agentId) return t("desktop.add.selectAgent");
    if (!name.trim()) return t("desktop.add.nameRequired");
    if (conn === "spooler" && !spoolerName.trim())
      return t("desktop.add.spoolerRequired");
    if (conn === "network") {
      if (!host.trim()) return t("desktop.add.hostRequired");
      if (host.includes(" ")) return t("desktop.add.hostInvalid");
      // Deliberately no private-IP allowlist here: the shared gateway
      // validator (printer-model.ts) depends on node:net, which cannot ship
      // in the Tauri browser bundle. The Gateway re-validates every field
      // server-side (private destination + port policy) and its error is
      // surfaced below via setError, so an invalid host fails closed.
      const p = Number(port);
      if (!Number.isInteger(p) || p !== 9100) return t("desktop.add.portRequired");
    }
    if ((conn === "ipp" || conn === "ipps") && !ippUrl.trim()) return t("desktop.add.ippEndpointRequired");
    if (
      (conn === "ipp" || conn === "ipps") &&
      ippUrl.trim() &&
      !/^(https?|ipp|ipps):\/\//i.test(ippUrl)
    )
      return t("desktop.add.ippSchemeInvalid");
    if (
      conn === "ipps" &&
      ippUrl.trim() &&
      !/^(https|ipps):\/\//i.test(ippUrl)
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
    setSpoolerRaw(false);
    setSpoolerEscpos(false);
    setIppUrl("");
    setUsbSel("");
  };

  const handleSubmit = async () => {
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
        const sel = usbPrinters.find((p) => p.id === usbSel && p.agentId === agentId);
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
      await registerGatewayPrinter(gatewayUrl, { ...req, agentId });
      onSuccess();
      onClose();
      reset();
    } catch (e) {
      // Prefer the structured fields preserved across the IPC transport;
      // fall back to parsing the message for legacy/unexpected shapes.
      const api = e as Partial<GatewayApiError>;
      let code = typeof api.code === "string" ? api.code : "";
      let entitlement = typeof api.entitlement === "string" ? api.entitlement : "";
      let upgradeRequired = api.upgradeRequired === true;
      let used = typeof api.used === "number" ? api.used : null;
      let limit: number | "unlimited" | null = typeof api.limit === "number" || api.limit === "unlimited" ? api.limit : null;
      if (!code && !entitlement && !upgradeRequired) {
        const raw = errMsg(e);
        let parsed: Record<string, unknown> = {};
        try {
          const value = JSON.parse(raw);
          if (value && typeof value === "object") parsed = value as Record<string, unknown>;
        } catch {
          // Keep the normal friendly Gateway error path for non-JSON failures.
        }
        if (typeof parsed.code === "string") code = parsed.code;
        if (typeof parsed.entitlement === "string") entitlement = parsed.entitlement;
        if (parsed.upgradeRequired === true) upgradeRequired = true;
        if (typeof parsed.used === "number") used = parsed.used;
        if (typeof parsed.limit === "number" || parsed.limit === "unlimited") limit = parsed.limit;
      }
      if (
        upgradeRequired === true &&
        (entitlement === "max_printers" || code === "MAX_PRINTERS_EXCEEDED")
      ) {
        setError(null);
        setUpgradeLimit({
          resource: "printers",
          used,
          limit,
        });
      } else {
        setError(friendlyGatewayError(errMsg(e), locale));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
      open={open}
      onClose={onClose}
      title={t("desktop.add.title")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={busy}
            icon={<Plus className="h-4 w-4" />}
          >
            {t("desktop.add.title")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field
          label={t("desktop.add.agent")}
          htmlFor="pp-agent"
          hint={t("desktop.add.agentHint")}
        >
          <Select id="pp-agent" value={agentId} onFocus={loadAgents} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">{agentsLoading ? t("desktop.add.loadingAgents") : t("desktop.add.selectActiveAgent")}</option>
            {agents.filter((a) => a.lifecycle === "active").map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({agentLiveView({ status: a.status ?? null, lifecycle: a.lifecycle ?? null, lastSeenAt: a.lastSeenAt ?? null }, nowMs, locale).label})
              </option>
            ))}
          </Select>
          {agentsError && (
            <div className="mt-2 flex items-center gap-2 text-xs text-ink-3">
              <span>{t("desktop.add.agentsLoadFailed")}</span>
              <Button variant="ghost" size="sm" onClick={() => { setAgentsForUrl(""); void loadAgents(); }}>{t("common.retry")}</Button>
            </div>
          )}
        </Field>
        <Field label={t("desktop.add.printerName")} htmlFor="pp-name">
          <Input
            id="pp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("desktop.add.namePlaceholder")}
            autoFocus
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
          <Field
            label={t("desktop.add.spoolerPrinter")}
            htmlFor="pp-spooler"
            hint={
              physicalSpoolers.length === 0
                ? t("desktop.add.noSpoolerDiscovered")
                : t("desktop.add.onlyPhysicalListed")
            }
          >
            <Select
              id="pp-spooler"
              value={spoolerName}
              onChange={(e) => setSpoolerName(e.target.value)}
            >
              <option value="">{t("desktop.add.selectEllipsis")}</option>
              {physicalSpoolers.map((p) => (
                <option key={p.id} value={p.spooler_name || p.spoolerName || p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
            {physicalSpoolers.length === 0 && (
              <Input
                className="mt-3"
                value={spoolerName}
                onChange={(e) => setSpoolerName(e.target.value)}
                placeholder={t("desktop.add.typeWindowsName")}
              />
            )}
          </Field>
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
          <div className="grid grid-cols-[1.6fr_1fr] gap-4">
            <Field label={t("desktop.add.host")} htmlFor="pp-host">
              <Input
                id="pp-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50"
              />
            </Field>
            <Field label={t("desktop.add.port")} htmlFor="pp-port">
              <Input
                id="pp-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="9100"
                inputMode="numeric"
              />
            </Field>
            <Field
              label={t("desktop.add.protocol")}
              htmlFor="pp-proto"
              className="col-span-2"
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
                  {p.name} {p.usbVid ? `(${p.usbVid}:${p.usbPid})` : ""}
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
              value={ippUrl}
              onChange={(e) => setIppUrl(e.target.value)}
              placeholder={conn === "ipps" ? "ipps://192.168.1.60/ipp/print" : "ipp://192.168.1.60/ipp/print"}
            />
          </Field>
        )}
        {error && <ErrorState title={t("desktop.add.cannotAdd")} message={error} />}
      </div>
      </Modal>

      <UpgradeLimitDialog
      open={upgradeLimit !== null}
      onClose={() => setUpgradeLimit(null)}
      resource={upgradeLimit?.resource ?? "printers"}
      used={upgradeLimit?.used}
        limit={upgradeLimit?.limit}
      />
    </>
  );
}
