# PostgreSQL deployment roles

The bundled Compose profile is for a dedicated Gateway PostgreSQL cluster. It
separates initialization, migrations and application access. The official
PostgreSQL image initializes `POSTGRES_USER` as a superuser; that credential must
remain confined to the database bootstrap and role-management jobs. See the
[official image documentation](https://hub.docker.com/_/postgres/).

| Identity | Credential mount | Authority |
|---|---|---|
| Existing `POSTGRES_USER` bootstrap account | PostgreSQL and `database_roles` only | Cluster administration and explicit role/ownership setup |
| `POSTGRES_OWNER_USER` (default `yaseir_owner`) | `migrate` and `database_roles` only | Owns the Gateway database, public objects and migration ledger; no superuser, role creation, database creation, replication or RLS bypass |
| `POSTGRES_RUNTIME_USER` (default `yaseir_runtime`) | Gateway, `database_verify` and `database_roles` | CONNECT to the Gateway database, public schema USAGE, application table SELECT/INSERT/UPDATE/DELETE except `audit_events` SELECT/INSERT only, sequence USAGE/SELECT; no DDL, temporary tables, TRUNCATE, migration-ledger access, role memberships or other database connections |

`audit_events` is append-only for this profile's runtime identity. Profile
application restricts existing tables, and every owner migration run repeats
the audit privilege postcondition so a fresh install cannot inherit broad
default table grants. The startup verifier rejects table-level or column-level
audit mutation grants. Tenant deletion remains a lifecycle update plus an
appended audit event; its historical audit foreign key does not cascade.
Owner/administrator maintenance remains available for explicitly authorized
correction and retention. This does not make the primary database immutable
against its administrator or replace a separately protected security-log sink.

All three names and passwords must be distinct. Passwords require at least 32
characters and should be generated independently. Secret files take precedence;
an empty or missing configured file fails the job. Role setup does not print
passwords, password verifiers or SQL errors containing statements. Passwords are
never command-line arguments. The profile installs SCRAM verifiers and checks
that an existing profile role still matches its configured credential. It does
not silently rotate a mismatched credential or elevate an existing role.

Startup order is PostgreSQL health → `database_roles` → owner migration →
`database_verify` → Gateway. The last job checks the runtime's actual database
privileges and application-table access before the Gateway starts. Default
privileges give future owner-created public tables and sequences the same DML
permissions, while the `drizzle` schema remains inaccessible to runtime. The
Gateway receives neither the bootstrap/owner secrets nor the role-state volume.

## Fresh installation

Configure these values in the protected deployment environment in addition to
the ordinary Gateway secrets:

```dotenv
POSTGRES_DB=yasser_db
POSTGRES_USER=odoo_print
POSTGRES_PASSWORD=<independent-generated-bootstrap-secret>
POSTGRES_OWNER_USER=yaseir_owner
POSTGRES_OWNER_PASSWORD=<independent-generated-owner-secret>
POSTGRES_RUNTIME_USER=yaseir_runtime
POSTGRES_RUNTIME_PASSWORD=<independent-generated-runtime-secret>
```

`POSTGRES_USER` is an administrator identity, even though historical examples
used an application-like name. Gateway now uses `POSTGRES_RUNTIME_USER` instead.
Run the normal Compose startup. Do not supply the administrator URL to the
Gateway, a desktop client, a browser or an application background worker.

## Existing volume conversion

Role setup runs as an explicit job on every requested rollout; it does not rely
on `/docker-entrypoint-initdb.d` or assume an existing volume will be initialized
again. The following maintenance procedure preserves table data and identities:

1. Take and validate a database backup and preserve the existing bootstrap
   credential, JWT key and deployment configuration.
2. Retain the **actual existing** `POSTGRES_USER`, `POSTGRES_DB` and
   `POSTGRES_PASSWORD`. Changing initialization variables does not rename an
   existing stored PostgreSQL account or reset its password.
3. Add two new independent owner/runtime credentials and distinct role names.
   Build the reviewed release image. Stop Gateway and all other clients of the
   target database. Role setup refuses active target-database clients.
4. Run the explicit role job against the existing database:

   ```sh
   docker compose run --rm database_roles
   ```

   It verifies the dedicated cluster, records original owners and effective
   PUBLIC/runtime ACLs in a mode-0600 JSON file under the separate `role_state`
   volume, and changes ownership/grants in one transaction. The output gives
   the exact metadata filename. Copy that file to the protected deployment
   recovery location before continuing; it contains no passwords or data rows.
5. Run migrations using the owner, then verify runtime access:

   ```sh
   docker compose run --rm migrate
   docker compose run --rm database_verify
   docker compose up -d gateway caddy
   ```

   Repeated dependency jobs are safe with unchanged credentials. Check every
   exit code. Keep the previous configuration and permission-state file until
   the new Gateway has passed the intended acceptance checks.

The helper deliberately refuses unrelated databases, unrelated non-system
roles, unexpected application schemas/object owners except the known owner-managed `legacy_billing` and `legacy_printing` archives, custom enum/domain/range
types, security-definer functions and unsupported routines. It also refuses
preexisting owner/runtime roles without the exact profile identity and safe
attributes. A shared or customized PostgreSQL service needs an explicitly
reviewed role/HBA policy; do not delete unrelated roles or databases to make this
helper pass. The dedicated profile revokes PUBLIC access to `postgres` and
`template1`, so the runtime cannot use their default CONNECT/TEMP privileges.
Any future additional database requires another explicit access review.

## Permission rollback

Keep Gateway stopped. Supply the exact metadata filename emitted by the
successful conversion, using the same bootstrap identity and cluster:

```sh
docker compose run --rm database_roles \
  node scripts/postgres-role-profile.mjs rollback \
  /var/lib/yaseir-role-state/role-profile-<recorded-id>.json
```

Rollback verifies the PostgreSQL cluster identifier, target database OID/name,
role identities and absence of other target-database clients. In one transaction
it restores recorded object ownership and PUBLIC/runtime grants; objects added
by later migrations are preserved and returned to the original database owner.
It changes no rows, drops no tables and reverses no schema migration. Newly
created owner/runtime accounts become NOLOGIN and remain non-administrative.
This is a permission rollback for maintenance, not authorization to put the
bootstrap superuser credential back into the running Gateway. Correct the
configuration, reapply the safe profile, rerun migrations/runtime verification,
and then resume admission. Schema rollback, if actually needed, uses a separately
verified database restore into an explicitly authorized target.

The `role_state` volume belongs with protected operational recovery metadata.
Do not remove production volumes while cleaning up a failed rollout. Synthetic
acceptance uses a uniquely named disposable project and may remove only its own
volumes.

## Native acceptance and boundaries

`scripts/acceptance/postgres-roles.mjs` runs against a new, isolated PostgreSQL
cluster supplied by its caller. It applies all real migrations as the owner,
checks existing rows and new-table/sequence DML as runtime, exercises production
print-job triggers, denies administrative/DDL/ledger/file/temp operations and
cross-database connections, checks idempotency and credential mismatch refusal,
then verifies permission rollback and reapplication without data loss. It
deletes private permission-state files after verification. The caller must stop
and remove that fresh cluster and treat cleanup failure as a failing result.

This role profile does not create per-tenant PostgreSQL identities or RLS.
Runtime DML spans the `public` application tables only. Archived provider data in `legacy_billing` and retired printer/job evidence in `legacy_printing` are owned by the migration owner and denied to the runtime role, with explicit startup checks preventing reintroduced schema or table grants. The application's tenant/authorization
checks remain necessary. It is separate from image-build/scan acceptance and
from the wider workload capacity, backup storage and production recovery gates.
