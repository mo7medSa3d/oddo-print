-- Independent Odoo -> Gateway -> Agent PDF capture test queue.
-- NEVER reference print_jobs/printers or any physical print accounting.
CREATE TABLE "e2e_capture_runs" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL,
  "api_key_id" text NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "payload_json" jsonb,
  "paper_mm" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'queued',
  "claim_token_hash" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "pages" integer,
  "pdf_sha256" text,
  "pdf_bytes" integer,
  "preview_jpeg" text,
  "error_code" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "claimed_at" timestamp,
  "finished_at" timestamp,
  "expires_at" timestamp NOT NULL DEFAULT (now() + interval '12 minutes'),
  CONSTRAINT "e2e_capture_runs_tenant_agent_fk" FOREIGN KEY ("tenant_id", "agent_id")
    REFERENCES "agents"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "e2e_capture_runs_idempotency_unique" UNIQUE ("tenant_id", "api_key_id", "idempotency_key"),
  CONSTRAINT "e2e_capture_runs_status_check" CHECK ("status" IN ('queued', 'claimed', 'rendered_locally', 'failed', 'expired')),
  CONSTRAINT "e2e_capture_runs_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 3),
  CONSTRAINT "e2e_capture_runs_paper_check" CHECK ("paper_mm" IN (0, 58, 80)),
  CONSTRAINT "e2e_capture_runs_pages_check" CHECK ("pages" IS NULL OR ("pages" BETWEEN 1 AND 10)),
  CONSTRAINT "e2e_capture_runs_pdf_bytes_check" CHECK ("pdf_bytes" IS NULL OR "pdf_bytes" BETWEEN 1 AND 8388608),
  CONSTRAINT "e2e_capture_runs_finished_payload_check" CHECK (
    ("status" IN ('queued','claimed') AND "payload_json" IS NOT NULL)
    OR ("status" IN ('rendered_locally','failed','expired') AND "payload_json" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "e2e_capture_runs_agent_claim_idx" ON "e2e_capture_runs"
  ("tenant_id", "agent_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "e2e_capture_runs_retention_idx" ON "e2e_capture_runs" ("tenant_id", "created_at");
