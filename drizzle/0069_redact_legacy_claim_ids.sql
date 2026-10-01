-- 0069: remove historically persisted raw claim tokens from job timeline.
-- Claim tokens are bearer credentials. Existing UUID-form claim ids are replaced
-- with an irreversible opaque identifier; non-UUID correlation ids are left intact.
UPDATE job_events
SET claim_id = 'claim_' || substr(md5(claim_id), 1, 12)
WHERE claim_id ~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$';
