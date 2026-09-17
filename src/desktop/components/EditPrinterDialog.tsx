import React, { useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Modal, Select } from "../../components/ui";
import { updateGatewayPrinter, type PrinterInfo } from "../lib/ipc";

type ConnectionType = "network" | "spooler" | "ipp" | "ipps";

function readConfig(printer: PrinterInfo): Record<string, unknown> {
  return printer.config && typeof printer.config === "object" ? printer.config : {};
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
  const [name, setName] = useState("");
  const [connectionType, setConnectionType] = useState<ConnectionType>("network");
  const [protocol, setProtocol] = useState("raw");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [address, setAddress] = useState("");
  const [spoolerName, setSpoolerName] = useState("");
  const [deviceClass, setDeviceClass] = useState("unknown");
  const [printerType, setPrinterType] = useState("physical");
  const [busy, setBusy] = useState(false);
  const config = useMemo(() => (printer ? readConfig(printer) : {}), [printer]);

  useEffect(() => {
    if (!open || !printer) return;
    setName(printer.name);
    setConnectionType(((printer.connectionType || printer.connection_type || "network") as ConnectionType));
    setProtocol(printer.protocol || "raw");
    setPrinterType(printer.printerType || printer.printer_type || "physical");
    setDeviceClass(printer.deviceClass || printer.device_class || printer.observedDeviceClass || "unknown");
    setHost(typeof config.ip === "string" ? config.ip : "");
    setPort(typeof config.port === "number" ? String(config.port) : "9100");
    setAddress(typeof config.address === "string" ? config.address : "");
    setSpoolerName(typeof config.spooler_name === "string" ? config.spooler_name : "");
  }, [open, printer, config]);

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
      if (!host.trim() || !Number.isInteger(n) || n !== 9100) {
        onError("Network printers require a host and TCP port 9100.");
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
    } else {
      if (!address.trim()) {
        onError("IPP printer URL is required.");
        return;
      }
      if (!/^ipp(s)?:\\/\\//i.test(address.trim()) && !/^https?:\\/\\//i.test(address.trim())) {
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
            <Select id="edit-printer-connection" value={connectionType} onChange={(e) => setConnectionType(e.target.value as ConnectionType)}>
              <option value="network">Network TCP</option>
              <option value="spooler">Windows spooler</option>
              <option value="ipp">IPP</option>
              <option value="ipps">IPPS</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Protocol" htmlFor="edit-printer-protocol">
              <Select id="edit-printer-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                <option value="raw">RAW</option>
                <option value="escpos">ESC/POS</option>
                <option value="zpl">ZPL</option>
                <option value="tspl">TSPL</option>
                <option value="ipp">IPP</option>
                <option value="ipps">IPPS</option>
                <option value="spooler">Spooler</option>
                <option value="unknown">Unknown</option>
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
