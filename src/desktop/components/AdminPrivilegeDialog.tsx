import React, { useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Button, Modal } from "../../components/ui";
import { closeApp } from "../lib/ipc";
import { useI18n } from "../../i18n/react";

export interface AdminPrivilegeDialogProps {
  open: boolean;
  onClose: () => void;
  onRelaunch?: () => void;
}

export function AdminPrivilegeDialog({
  open,
  onClose,
  onRelaunch,
}: AdminPrivilegeDialogProps) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(false);

  const handleCloseAndReopen = async () => {
    setClosing(true);
    try {
      // Start any relaunch action first, then always close this unelevated
      // process so the current window cannot remain open in read-only mode.
      onRelaunch?.();
    } finally {
      try {
        await closeApp();
      } catch {
        // Best-effort window close if the native close command is unavailable.
        if (typeof window !== "undefined") window.close();
      }
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("desktop.admin.title")}
      description={t("desktop.admin.description")}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={closing}
          >
            {t("desktop.admin.readOnlyCta")}
          </Button>
          <Button
            variant="primary"
            onClick={handleCloseAndReopen}
            loading={closing}
            icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />}
          >
            {t("desktop.admin.relaunch")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-base leading-relaxed text-ink-2">
        <div
          className="flex items-start gap-3 rounded-md border border-warn-edge bg-warn-bg p-4 text-warn"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="text-sm leading-normal text-ink">
            <strong className="font-semibold text-warn">{t("desktop.admin.restricted")}</strong>{" "}
            {t("desktop.admin.restrictedBody")}
          </div>
        </div>

        <p className="text-ink">
          {t("desktop.admin.intro")}
        </p>

        <div className="rounded-md border border-edge bg-surface-2 p-4 text-sm text-ink-3">
          <div className="font-medium text-ink mb-1.5">{t("desktop.admin.howTo")}</div>
          <ol className="list-decimal ps-5 space-y-1">
            <li>{t("desktop.admin.step1")}</li>
            <li>
              {t("desktop.admin.step2a")} <strong>{t("desktop.admin.step2b")}</strong>{" "}
              {t("desktop.admin.step2Tail")}
            </li>
            <li>
              {t("desktop.admin.step3a")} <strong>{t("desktop.admin.step3b")}</strong>{" "}
              {t("desktop.admin.step3Tail")}
            </li>
          </ol>
        </div>
      </div>
    </Modal>
  );
}
