"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button, Modal, Toast } from "./ui";
import { useI18n } from "../i18n/react";
import { codeMessageKey } from "../lib/api-error-keys";
import { PRINT_JOB_RETENTION_HOURS, PRINT_JOB_RETENTION_MS } from "../shared/job-retention";

export function JobCleanupButton() {
  const router = useRouter();
  const { t, tc, formatNumber } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const cleanup = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const cutoff = new Date(Date.now() - PRINT_JOB_RETENTION_MS).toISOString();
      const response = await fetch(
        `/api/jobs?before=${encodeURIComponent(cutoff)}&limit=5000&confirm=1`,
        { method: "DELETE", credentials: "include" },
      );
      const data = (await response.json().catch(() => ({}))) as {
        deleted?: number;
        error?: string;
        code?: string;
      };
      if (!response.ok) throw new Error(t(codeMessageKey(typeof data.code === "string" ? data.code : undefined) ?? "jobs.cleanup.failed"));

      const count = Number(data.deleted ?? 0);
      setSuccessMessage(
        count === 0
          ? t("jobs.cleanup.noneEligible")
          : tc("jobs.cleanup.removed", count, { count: formatNumber(count) })
      );
      router.refresh();
      return true;
    } catch (cleanupError) {
      setError(
        cleanupError instanceof Error ? cleanupError.message : t("jobs.cleanup.failed")
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    if (await cleanup()) {
      setDone(t("jobs.cleanup.done"));
      setOpen(false);
    }
  };

  return (
    <>
      <div className="flex flex-col items-end gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setError(null);
            setSuccessMessage(null);
            setOpen(true);
          }}
          icon={<Trash2 className="h-4 w-4" />}
        >
          {t("jobs.cleanup.action")}
        </Button>
        {successMessage ? (
          <span role="status" className="text-xs text-ok font-medium">
            {successMessage}
          </span>
        ) : null}
        {error ? <span role="alert" className="text-xs text-bad">{error}</span> : null}
      </div>

      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={t("jobs.cleanup.title")}
        description={t("jobs.cleanup.description", { hours: PRINT_JOB_RETENTION_HOURS })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => void runCleanup()}
              loading={busy}
              icon={<Trash2 className="h-4 w-4" />}
            >
              {t("jobs.cleanup.action")}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-2">
          <p>{t("jobs.cleanup.bodyScope", { hours: PRINT_JOB_RETENTION_HOURS })}</p>
          <p>{t("jobs.cleanup.bodyActive")}</p>
          <p className="font-medium text-warn">{t("jobs.cleanup.bodyIrreversible")}</p>
        </div>
      </Modal>

      <Toast
        toast={done ? { text: done, type: "success" } : null}
        onDismiss={() => setDone(null)}
      />
    </>
  );
}
