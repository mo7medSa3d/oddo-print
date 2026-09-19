import React, { useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Modal, Select } from "../../components/ui";
import { updateGatewayPrinter, type PrinterInfo } from "../lib/ipc";

type ConnectionType = "network" | "spooler" | "usb" | "ipp" | "ipps";

function readConfig(printer: PrinterInfo): Record<string, unknown> {
  return printer.config && typeof printer.config === "object" ? printer.config : {};
}

function stringConfig(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function defaultProtocol(connectionType: ConnectionType): string {
  switch (connectionType) {
    case "spooler": return "spooler";
    case "ipp": return "ipp";
    case "ipps": return "ipps";
    default: return "raw";
  }
}

function protocolOptions(connectionType: ConnectionType): Array<{ value: string; label: string }> {
  switch (connectionType) {
    case "spooler":
      return [{ value: "spooler", label: "Spooler" }, { value: "unknown", label: "Unknown" }];
    case "ipp":
      return [{ value: "ipp", label: "IPP" }, { value: "unknown", label: "Unknown" }];
    case "ipps":
      return [{ value: "ipps", label: "IPPS" }, { value: "unknown", label: "Unknown" }];
    case "usb":
      return [
        { value: "raw", label: "RAW" },
        { value: "escpos", label: "ESC/POS" },
        { value: "zpl", label: "ZPL" },
        { value: "tspl", label: "TSPL" },
        { value: "unknown", label: "Unknown" },
      ];
    default:
      return [
        { value: "raw", label: "RAW" },
        { value: "escpos", label: "ESC/POS" },
        { value: "zpl", label: "ZPL" },
        { value: "tspl", label: "TSPL" },
        { value: "ipp", label: "IPP" },
      ];
  }
}

export function EditPrinterDialog({
  open,
  printer,
  gatewayUrl,
  onClose,
  onSaved,
  onError,
}: {
  open: boolean;
  printer: PrinterInfo | null;
  gatewayUrl: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const initialConfig = useMemo(() => readConfig(printer || {
    id: "",
    name: "",
    status: "unknown",
    enabled: false,
  }), [printer]);
  const [name, setName] = useState("");
  const [connectionType, setConnectionType] = useState<ConnectionType>("network");
  const [protocol, setProtocol] = useState("raw");
  const [host, setHost] = useState(() =>
    typeof initialConfig.ip === "string" ? initialConfig.ip : ""
  );
  const [port, setPort] = useState(() =>
    typeof initialConfig.port === "number" ? String(initialConfig.port) : "9100"
  );
  const [address, setAddress] = useState(() =>
    typeof initialConfig.address === "string" ? initialConfig.address : ""
  );
  const [spoolerName, setSpoolerName] = useState(() =>
    typeof initialConfig.spooler_name === "string" ? initialConfig.spooler_name : ""
  );
  const [usbVid, setUsbVid] = useState("");
  const [usbPid, setUsbPid] = useState("");
  const [usbSerial, setUsbSerial] = useState("");
  const [deviceClass, setDeviceClass] = useState("unknown");
  const [printerType, setPrinterType] = useState("physical");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!printer || !open) return;
    const cfg = readConfig(printer);
    const conn = (
      printer.connectionType ||
      printer.connection_type ||
      "network"
    ) as ConnectionType;
    setName(printer.name ?? "");
    setConnectionType(conn);
    setProtocol(printer.protocol || defaultProtocol(conn));
    setHost(stringConfig(cfg, "ip"));
    setPort(typeof cfg.port === "number" ? String(cfg.port) : "9100");
    setAddress(stringConfig(cfg, "address"));
    setSpoolerName(stringConfig(cfg, "spooler_name"));
    setUsbVid(printer.usbVid ?? (cfg.vid != null ? String(cfg.vid) : ""));
    setUsbPid(printer.usbPid ?? (cfg.pid != null ? String(cfg.pid) : ""));
    setUsbSerial(printer.usbSerial ?? stringConfig(cfg, "serial"));
    setDeviceClass(printer.deviceClass || printer.device_class || printer.observedDeviceClass || "unknown");
    setPrinterType(printer.printerType || printer.printer_type || "physical");
  }, [printer, open]);
  async function save() {
    if (!printer) return;
    if (!gatewayUrl) {
      onError("Gateway URL is not configured.");
      return;
    }
    if (!name.trim()) {
      onError("Printer name is required.");
      return;
    }

    const nextConfig: Record<string, unknown> = { ...config };
    delete nextConfig.ip;
    delete nextConfig.port;
    delete nextConfig.address;
    delete nextConfig.spooler_name;

    if (connectionType === "network") {
      const n = Number(port);
      const ippPorts = new Set([80, 443, 631]);
      const validPort = protocol === "ipp" ? ippPorts.has(n) : n === 9100;
      if (!host.trim() || !Number.isInteger(n) || !validPort) {
        onError(protocol === "ipp"
          ? "Network IPP printers require a private host and TCP port 80, 443, or 631."
          : "Network printers require a private host and TCP port 9100.");
        return;
      }
      nextConfig.ip = host.trim();
      nextConfig.port = n;
    } else if (connectionType === "spooler") {
      if (!spoolerName.trim()) {
        onError("Windows spooler printer name is required.");
        return;
      }
      nextConfig.spooler_name = spoolerName.trim();
      nextConfig.address = spoolerName.trim();
    } else if (connectionType === "usb") {
      const vid = Number(usbVid);
      const pid = Number(usbPid);
      if (!usbVid.trim() || !Number.isInteger(vid) || vid < 0 || vid > 65535) {
        onError("USB printers require a valid VID.");
        return;
      }
      if (!usbPid.trim() || !Number.isInteger(pid) || pid < 0 || pid > 65535) {
        onError("USB printers require a valid PID.");
        return;
      }
      if (!address.trim()) {
        onError("Direct USB printers require a Windows device path.");
        return;
      }
      nextConfig.vid = vid;
      nextConfig.pid = pid;
      if (usbSerial.trim()) nextConfig.serial = usbSerial.trim();
      nextConfig.address = address.trim();
    } else {
      if (!address.trim()) {
        onError("IPP printer URL is required.");
        return;
      }
      if (!/^(ipp|ipps|http|https):\/\//i.test(address.trim())) {
        onError("IPP address must be an ipp://, ipps://, http:// or https:// URL.");
        return;
      }
      nextConfig.address = address.trim();
    }

    setBusy(true);
    try {
      await updateGatewayPrinter(gatewayUrl, printer.id, {
        name: name.trim(),
        printerType,
        deviceClass,
        connectionType,
        protocol,
        config: nextConfig,
      });
      await onSaved();
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update printer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Edit printer"
      description="Changes here update Gateway desired state. The Agent applies them asynchronously and reports the applied revision."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>Save changes</Button>
        </>
      }
    >
      {printer && (
        <div className="space-y-5">
          <Field label="Printer name" htmlFor="edit-printer-name">
            <Input id="edit-printer-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Connection" htmlFor="edit-printer-connection">
            <Select
              id="edit-printer-connection"
              value={connectionType}
              onChange={(e) => {
                const nextConnection = e.target.value as ConnectionType;
                setConnectionType(nextConnection);
                setProtocol(defaultProtocol(nextConnection));
              }}
            >
              <option value="network">Network TCP</option>
              <option value="spooler">Windows spooler</option>
              <option value="usb">USB</option>
              <option value="ipp">IPP</option>
              <option value="ipps">IPPS</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Protocol" htmlFor="edit-printer-protocol">
              <Select id="edit-printer-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                {protocolOptions(connectionType).map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Device class" htmlFor="edit-printer-class">
              <Select id="edit-printer-class" value={deviceClass} onChange={(e) => setDeviceClass(e.target.value)}>
                <option value="unknown">Unknown</option>
                <option value="thermal">Thermal</option>
                <option value="laser">Laser</option>
                <option value="inkjet">Inkjet</option>
                <option value="label">Label</option>
                <option value="other">Other</option>
              </Select>
            </Field>
          </div>
          {connectionType === "network" && (
            <div className="grid grid-cols-[1.6fr_1fr] gap-4">
              <Field label="Host" htmlFor="edit-printer-host">
                <Input id="edit-printer-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" />
              </Field>
              <Field label="Port" htmlFor="edit-printer-port">
                <Input id="edit-printer-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
          )}
          {connectionType === "spooler" && (
            <Field label="Windows printer name" htmlFor="edit-printer-spooler">
              <Input id="edit-printer-spooler" value={spoolerName} onChange={(e) => setSpoolerName(e.target.value)} />
            </Field>
          )}
          {(connectionType === "ipp" || connectionType === "ipps") && (
            <Field label="Printer URL" htmlFor="edit-printer-address">
              <Input id="edit-printer-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="ipp://192.168.1.50/ipp/print" />
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}
