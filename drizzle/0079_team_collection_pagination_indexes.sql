-- Support bounded, stable tenant Team pagination without sorting the full
-- tenant collection for every page. PostgreSQL can scan these btrees backward
-- for the DESC created_at / identity ordering used by the API routes.
CREATE INDEX IF NOT EXISTS "tenant_users_tenant_created_user_idx"
  ON "tenant_users" USING btree ("tenant_id", "created_at", "user_id");

CREATE INDEX IF NOT EXISTS "tenant_invitations_tenant_created_id_idx"
  ON "tenant_invitations" USING btree ("tenant_id", "created_at", "id");
