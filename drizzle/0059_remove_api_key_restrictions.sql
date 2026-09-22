-- Collapse API-key authorization to one full read/write credential model.
-- Historical migration files remain immutable; this migration removes the
-- deprecated runtime columns from existing databases.
ALTER TABLE "api_keys"
  DROP CONSTRAINT IF EXISTS "api_keys_scope_check",
  DROP COLUMN IF EXISTS "scope",
  DROP COLUMN IF EXISTS "allowed_document_types";

-- Older API-key audit records may contain retired restriction metadata. Remove
-- only those obsolete fields while preserving the audit event itself.
UPDATE "audit_events"
SET "metadata" = ("metadata" - 'scope' - 'allowedDocumentTypes' - 'allowed_document_types')
WHERE "action" IN ('api_key.created', 'api_key.rotated')
  AND jsonb_typeof("metadata") = 'object';
