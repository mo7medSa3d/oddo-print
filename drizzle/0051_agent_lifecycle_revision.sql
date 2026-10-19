ALTER TABLE agents
  ADD COLUMN lifecycle_revision integer NOT NULL DEFAULT 0;

ALTER TABLE agents
  ADD CONSTRAINT agents_lifecycle_revision_check
  CHECK (lifecycle_revision >= 0);
