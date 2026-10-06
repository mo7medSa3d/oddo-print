-- Deployment-time binding only: runtime authentication stays identical to main.
BEGIN;
CREATE TEMP TABLE staging_domain_config (domain text, tenant_id text, platform_tenant_id text) ON COMMIT DROP;
INSERT INTO staging_domain_config VALUES (:'domain', :'manager_tenant_id', :'platform_tenant_id');

DO $configure$
DECLARE
  config staging_domain_config%ROWTYPE;
  bound_tenant text;
  target_tenant text;
  candidate_count integer;
BEGIN
  SELECT * INTO config FROM staging_domain_config;
  IF config.domain <> 'print.yaseir.cloud' THEN
    RAISE EXCEPTION 'Unexpected staging domain';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('staging-domain:' || config.domain));
  SELECT tenant_id INTO bound_tenant FROM tenant_domains WHERE domain = config.domain FOR UPDATE;

  IF bound_tenant IS NOT NULL THEN
    IF config.tenant_id <> '' AND config.tenant_id <> bound_tenant THEN
      RAISE EXCEPTION 'Staging domain already belongs to another workspace; refusing to reassign it';
    END IF;
    target_tenant := bound_tenant;
  ELSIF config.tenant_id <> '' THEN
    target_tenant := config.tenant_id;
  ELSE
    -- Select once during trusted deployment, never from a login request.
    SELECT count(*), min(id) INTO candidate_count, target_tenant
      FROM tenants WHERE lifecycle = 'active' AND id <> config.platform_tenant_id;
    IF candidate_count = 0 THEN
      RAISE NOTICE 'No staging workspace yet; rerun setup after creating the workspace';
      RETURN;
    ELSIF candidate_count > 1 THEN
      RAISE EXCEPTION 'Multiple staging workspaces: set MANAGER_TENANT_ID once to choose the domain owner';
    END IF;
  END IF;

  PERFORM id FROM tenants WHERE id = target_tenant AND lifecycle = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The staging domain owner must be an existing active workspace';
  END IF;

  INSERT INTO tenant_domains (id, tenant_id, domain, verified_at, is_primary)
    VALUES ('staging_domain_' || md5(config.domain), target_tenant, config.domain, now(), true)
    ON CONFLICT (domain) DO UPDATE SET verified_at = COALESCE(tenant_domains.verified_at, EXCLUDED.verified_at);
  RAISE NOTICE 'Staging domain configured for workspace %', target_tenant;
END;
$configure$;
COMMIT;
