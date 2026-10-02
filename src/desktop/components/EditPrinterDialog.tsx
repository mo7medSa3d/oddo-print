import React, { useMemo, useState } from "react";
import { Button, Field, Input, Modal, Select } from "../../components/ui";
import { friendlyGatewayError } from "../lib/printers";
import { updateGatewayPrinter, type PrinterInfo } from "../lib/ipc";
import { useI18n } from "../../i18n/react";
import type { Translator } from "../../i18n/translate";
import type { MessageKey } from "../../i18n/messages/en";

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

function protocolOptions(connectionType: ConnectionType, t: Translator): Array<{ value: string; label: string }> {
  switch (connectionType) {
    case "spooler":
      return [{ value: "spooler", label: t("desktop.connection.spooler") }, { value: "unknown", label: t("desktop.edit.deviceUnknown") }];
    case "ipp":
      return [{ value: "ipp", label: t("desktop.connection.ipp") }, { value: "unknown", label: t("desktop.edit.deviceUnknown") }];
    case "ipps":
      return [{ value: "ipps", label: "IPPS" }, { value: "unknown", label: "Unknown" }];
    case "usb":
      return [
        { value: "raw", label: "RAW" },
        { value: "escpos", label: "ESC/POS" },
        { value: "zpl", label: "ZPL" },
        { value: "tspl", label: "TSPL" },
        { value: "unknown", label: t("desktop.edit.deviceUnknown") },
      ];
    default:
      return [
        { value: "raw", label: "RAW" },
        { value: "escpos", label: "ESC/POS" },
        { value: "zpl", label: "ZPL" },
        { value: "tspl", label: "TSPL" },
        { value: "ipp", label: t("desktop.connection.ipp") },
        { value: "unknown", label: t("desktop.edit.deviceUnknown") },
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
  const { t, locale } = useI18n();
  const [name, setName] = useState(() => printer?.name ?? "");
  const [connectionType, setConnectionType] = useState<ConnectionType>(() =>
    (printer?.connectionType || printer?.connection_type || "network") as ConnectionType
  );
  const [protocol, setProtocol] = useState(() => printer?.protocol || defaultProtocol(
    (printer?.connectionType || printer?.connection_type || "network") as ConnectionType
  ));
  const [host, setHost] = useState(() => stringConfig(initialConfig, "ip"));
  const [port, setPort] = useState(() => typeof initialConfig.port === "number" ? String(initialConfig.port) : "9100");
  const [address, setAddress] = useState(() => stringConfig(initialConfig, "address"));
  const [spoolerName, setSpoolerName] = useState(() => stringConfig(initialConfig, "spooler_name"));
  const [usbVid, setUsbVid] = useState(() =>
    printer?.usbVid ?? (initialConfig.vid != null ? String(initialConfig.vid) : "")
  );
  const [usbPid, setUsbPid] = useState(() =>
    printer?.usbPid ?? (initialConfig.pid != null ? String(initialConfig.pid) : "")
  );
  const [usbSerial, setUsbSerial] = useState(() =>
    printer?.usbSerial ?? stringConfig(initialConfig, "serial")
  );
  const [deviceClass, setDeviceClass] = useState(() =>
    printer?.deviceClass || printer?.device_class || printer?.observedDeviceClass || "unknown"
  );
  const [printerType, setPrinterType] = useState(() =>
    printer?.printerType || printer?.printer_type || "physical"
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!printer) return;
    if (!gatewayUrl) {
      onError(t("desktop.add.gatewayUrlMissing"));
      return;
    }
    if (!name.trim()) {
      onError(t("desktop.add.nameRequired"));
      return;
    }

      const nextConfig: Record<string, unknown> = { ...initialConfig };
    delete nextConfig.ip;
    delete nextConfig.port;
    delete nextConfig.address;
    delete nextConfig.spooler_name;

    if (connectionType === "network") {
      const n = Number(port);
      const ippPorts = new Set([80, 443, 631]);
      const validPort = protocol === "ipp" ? ippPorts.has(n) : n === 9100;
      if (!host.trim() || !Number.isInteger(n) || !validPort) {
        onError(
          protocol === "ipp" ? t("desktop.edit.ippNetworkRule") : t("desktop.edit.networkRule"),
        );
        return;
      }
      nextConfig.ip = host.trim();
      nextConfig.port = n;
    } else if (connectionType === "spooler") {
      if (!spoolerName.trim()) {
        onError(t("desktop.edit.spoolerRequired"));
        return;
      }
      nextConfig.spooler_name = spoolerName.trim();
      nextConfig.address = spoolerName.trim();
    } else if (connectionType === "usb") {
      const vid = Number(usbVid);
      const pid = Number(usbPid);
      if (!usbVid.trim() || !Number.isInteger(vid) || vid < 0 || vid > 65535) {
        onError(t("desktop.edit.usbVidRequired"));
        return;
      }
      if (!usbPid.trim() || !Number.isInteger(pid) || pid < 0 || pid > 65535) {
        onError(t("desktop.edit.usbPidRequired"));
        return;
      }
      if (!address.trim()) {
        onError(t("desktop.edit.usbPathRequired"));
        return;
      }
      nextConfig.vid = vid;
      nextConfig.pid = pid;
      if (usbSerial.trim()) nextConfig.serial = usbSerial.trim();
      nextConfig.address = address.trim();
    } else {
      if (!address.trim()) {
        onError(t("desktop.edit.ippUrlRequired"));
        return;
      }
      if (!/^(ipp|ipps|http|https):\/\//i.test(address.trim())) {
        onError(t("desktop.edit.ippUrlInvalid"));
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
      onError(friendlyGatewayError(e instanceof Error ? e.message : t("desktop.edit.saveFailed"), locale));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={t("desktop.edit.title")}
      description={t("desktop.edit.description")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save} loading={busy}>{t("desktop.edit.saveChanges")}</Button>
        </>
      }
    >
      {printer && (
        <div className="space-y-5">
          <Field label={t("desktop.edit.printerName")} htmlFor="edit-printer-name">
            <Input id="edit-printer-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("desktop.edit.connection")} htmlFor="edit-printer-connection">
            <Select
              id="edit-printer-connection"
              value={connectionType}
              onChange={(e) => {
                const nextConnection = e.target.value as ConnectionType;
                setConnectionType(nextConnection);
                setProtocol(defaultProtocol(nextConnection));
              }}
            >
              <option value="network">{t("desktop.edit.networkTcp")}</option>
              <option value="spooler">{t("desktop.connection.spooler")}</option>
              <option value="usb">{t("desktop.connection.usb")}</option>
              <option value="ipp">{t("desktop.connection.ipp")}</option>
              <option value="ipps">IPPS</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("desktop.edit.protocol")} htmlFor="edit-printer-protocol">
              <Select id="edit-printer-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                {protocolOptions(connectionType, t).map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("desktop.edit.deviceClass")} htmlFor="edit-printer-class">
              <Select id="edit-printer-class" value={deviceClass} onChange={(e) => setDeviceClass(e.target.value)}>
                <option value="unknown">{t("desktop.edit.deviceUnknown")}</option>
                <option value="thermal">{t("desktop.edit.deviceThermal")}</option>
                <option value="laser">{t("desktop.edit.deviceLaser")}</option>
                <option value="inkjet">{t("desktop.edit.deviceInkjet")}</option>
                <option value="label">{t("desktop.edit.deviceLabel")}</option>
                <option value="other">{t("desktop.edit.deviceOther")}</option>
              </Select>
            </Field>
          </div>
          {connectionType === "network" && (
            <div className="grid grid-cols-[1.6fr_1fr] gap-4">
              <Field label={t("desktop.edit.host")} htmlFor="edit-printer-host">
                <Input id="edit-printer-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" />
              </Field>
              <Field label={t("desktop.edit.port")} htmlFor="edit-printer-port">
                <Input id="edit-printer-port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
          )}
          {connectionType === "spooler" && (
            <Field label={t("desktop.edit.windowsPrinterName")} htmlFor="edit-printer-spooler">
              <Input id="edit-printer-spooler" value={spoolerName} onChange={(e) => setSpoolerName(e.target.value)} />
            </Field>
          )}
          {(connectionType === "ipp" || connectionType === "ipps") && (
            <Field label={t("desktop.edit.printerUrl")} htmlFor="edit-printer-address">
              <Input id="edit-printer-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="ipp://192.168.1.50/ipp/print" />
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}
