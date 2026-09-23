import React, { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Modal,
  Field,
  Input,
  Select,
  ErrorState,
} from "../../components/ui";
import { fetchGatewayAgents, registerGatewayPrinter, type PrinterInfo, type RegisterPrinterRequest } from "../lib/ipc";
import { errMsg, friendlyGatewayError, friendlyPrinterError, isProductionPrinter } from "../lib/printers";
import UpgradeLimitDialog, { type UpgradeLimitResource } from "../../components/UpgradeLimitDialog";

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
  const [name, setName] = useState("");
  const [conn, setConn] = useState<Conn>("spooler");
  const [spoolerName, setSpoolerName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [protocol, setProtocol] = useState("raw");
  const [ippUrl, setIppUrl] = useState("");
  const [usbSel, setUsbSel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; status?: string; lifecycle?: string }>>([]);
  const [agentId, setAgentId] = useState("");
  const [upgradeLimit, setUpgradeLimit] = useState<{
    resource: UpgradeLimitResource;
    used?: number | null;
    limit?: number | "unlimited" | null;
  } | null>(null);

  const loadAgents = useCallback(async () => {
    if (!gatewayUrl || agents.length > 0) return;
    try {
      const rows = await fetchGatewayAgents(gatewayUrl);
      setAgents(rows);
      const active = rows.find((row) => row.lifecycle === "active");
      if (active) setAgentId((current) => current || active.id);
    } catch {
      setAgents([]);
    }
  }, [gatewayUrl, agents.length]);


  // Clear any previous error when dialog transitions to open
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) setError(null);
  }

  // Only physical printers may be picked for a production binding.
  const physicalSpoolers = useMemo(
    () => printers.filter((p) => isProductionPrinter(p) && p.spooler_name),
    [printers]
  );
  const usbPrinters = useMemo(
    () =>
      printers.filter(
        (p) => (p.connection_type || "").toLowerCase() === "usb" && isProductionPrinter(p)
      ),
    [printers]
  );

  const validate = (): string | null => {
    if (!gatewayUrl) return "Gateway URL is not configured.";
    if (!agentId) return "Select an active Gateway agent.";
    if (!name.trim()) return "Printer name is required.";
    if (conn === "spooler" && !spoolerName.trim())
      return "Select or type a spooler printer name.";
    if (conn === "network") {
      if (!host.trim()) return "Host is required.";
      if (host.includes(" ")) return "Invalid host.";
      const p = Number(port);
      if (!Number.isInteger(p) || p !== 9100) return "Network printer port must be 9100.";
    }
    if ((conn === "ipp" || conn === "ipps") && !ippUrl.trim()) return "IPP endpoint is required.";
    if (
      (conn === "ipp" || conn === "ipps") &&
      ippUrl.trim() &&
      !/^(https?|ipp|ipps):\/\//i.test(ippUrl)
    )
      return "IPP URL must start with http://, https://, ipp:// or ipps://";
    if (
      conn === "ipps" &&
      ippUrl.trim() &&
      !/^(https|ipps):\/\//i.test(ippUrl)
    )
      return "IPPS requires an https:// or ipps:// endpoint.";
    if (conn === "usb" && !usbSel) return "Select a USB printer.";
    return null;
  };

  const reset = () => {
    setName("");
    setHost("");
    setPort("9100");
    setSpoolerName("");
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
        const sel = usbPrinters.find((p) => p.id === usbSel);
        if (sel) {
          const sourceConfig = sel.config && typeof sel.config === "object"
            ? sel.config as Record<string, unknown>
            : {};
          req.usbVid = sel.usbVid ?? (sourceConfig.vid != null ? String(sourceConfig.vid) : undefined);
          req.usbPid = sel.usbPid ?? (sourceConfig.pid != null ? String(sourceConfig.pid) : undefined);
          req.usbSerial = sel.usbSerial ?? (sourceConfig.serial != null ? String(sourceConfig.serial) : undefined);
          const discoveredSpooler = sel.spooler_name ?? (typeof sourceConfig.spooler_name === "string" ? sourceConfig.spooler_name : "");
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
      const raw = errMsg(e);
      let parsed: Record<string, unknown> = {};
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object") parsed = value as Record<string, unknown>;
      } catch {
        // Keep the normal friendly Gateway error path for non-JSON failures.
      }
      const entitlement = typeof parsed.entitlement === "string" ? parsed.entitlement : "";
      if (
        parsed.upgradeRequired === true &&
        (entitlement === "max_printers" || parsed.code === "MAX_PRINTERS_EXCEEDED")
      ) {
        setError(null);
        setUpgradeLimit({
          resource: "printers",
          used: typeof parsed.used === "number" ? parsed.used : null,
          limit: typeof parsed.limit === "number" || parsed.limit === "unlimited" ? parsed.limit : null,
        });
      } else {
        setError(friendlyGatewayError(raw));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add printer"
      description="Register a printer for this agent. Discovery is preferred, but manual registration works for legacy devices."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={busy}
            icon={<Plus className="h-4 w-4" />}
          >
            Add printer
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field
          label="Gateway agent"
          htmlFor="pp-agent"
          hint="The selected Agent owns execution; the Gateway remains authoritative for configuration."
        >
          <Select id="pp-agent" value={agentId} onFocus={loadAgents} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Select an active agent…</option>
            {agents.filter((a) => a.lifecycle === "active").map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.status || "unknown"})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Printer name" htmlFor="pp-name">
          <Input
            id="pp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Kitchen receipt"
            autoFocus
          />
        </Field>
        <Field label="Connection type" htmlFor="pp-conn">
          <Select
            id="pp-conn"
            value={conn}
            onChange={(e) => setConn(e.target.value as Conn)}
          >
            <option value="spooler">Windows spooler</option>
            <option value="network">Network (TCP)</option>
            <option value="usb">USB</option>
            <option value="ipp">IPP</option>
            <option value="ipps">IPPS</option>
          </Select>
        </Field>
        {conn === "spooler" && (
          <Field
            label="Spooler printer"
            htmlFor="pp-spooler"
            hint={
              physicalSpoolers.length === 0
                ? "No physical spooler printers were discovered — run Discovery first, or type the exact Windows printer name. Virtual and redirected printers are never listed."
                : "Only physical printers discovered on this PC are listed."
            }
          >
            <Select
              id="pp-spooler"
              value={spoolerName}
              onChange={(e) => setSpoolerName(e.target.value)}
            >
              <option value="">Select…</option>
              {physicalSpoolers.map((p) => (
                <option key={p.id} value={p.spooler_name || p.name}>
                  {p.name}
                </option>
              ))}
              {physicalSpoolers.length === 0 && <option disabled>None discovered</option>}
            </Select>
            {physicalSpoolers.length === 0 && (
              <Input
                className="mt-3"
                value={spoolerName}
                onChange={(e) => setSpoolerName(e.target.value)}
                placeholder="Type Windows printer name"
              />
            )}
          </Field>
        )}
        {conn === "network" && (
          <div className="grid grid-cols-[1.6fr_1fr] gap-4">
            <Field label="Host" htmlFor="pp-host">
              <Input
                id="pp-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50 (LAN IP)"
              />
            </Field>
            <Field label="Port" htmlFor="pp-port">
              <Input
                id="pp-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="9100"
                inputMode="numeric"
              />
            </Field>
            <Field
              label="Protocol"
              htmlFor="pp-proto"
              className="col-span-2"
              hint="RAW sends bytes as-is; ESC/POS is the usual thermal receipt language."
            >
              <Select
                id="pp-proto"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
              >
                <option value="raw">RAW</option>
                <option value="escpos">ESC/POS</option>
              </Select>
            </Field>
          </div>
        )}
        {conn === "usb" && (
          <Field
            label="USB printer"
            htmlFor="pp-usb"
            hint="Only valid USB printers are listed — generic USB devices are hidden."
          >
            <Select id="pp-usb" value={usbSel} onChange={(e) => setUsbSel(e.target.value)}>
              <option value="">Select…</option>
              {usbPrinters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.usbVid ? `(${p.usbVid}:${p.usbPid})` : ""}
                </option>
              ))}
              {usbPrinters.length === 0 && <option disabled>No USB printers discovered</option>}
            </Select>
          </Field>
        )}
        {(conn === "ipp" || conn === "ipps") && (
          <Field
            label={conn === "ipps" ? "IPPS endpoint" : "IPP endpoint"}
            htmlFor="pp-ipp"
            hint={conn === "ipps"
              ? "Use a private/link-local IPPS endpoint, e.g. ipps://192.168.1.60/ipp/print"
              : "Use a private/link-local printer IP, e.g. ipp://192.168.1.60/ipp/print"}
          >
            <Input
              id="pp-ipp"
              value={ippUrl}
              onChange={(e) => setIppUrl(e.target.value)}
              placeholder={conn === "ipps" ? "ipps://192.168.1.60/ipp/print" : "ipp://192.168.1.60/ipp/print"}
            />
          </Field>
        )}
        {error && <ErrorState title="Cannot add printer" message={error} />}
      </div>
    </Modal>

    <UpgradeLimitDialog
      open={upgradeLimit !== null}
      onClose={() => setUpgradeLimit(null)}
      resource={upgradeLimit?.resource ?? "printers"}
      used={upgradeLimit?.used}
      limit={upgradeLimit?.limit}
    />
  );
}
