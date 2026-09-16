# Security Model

## Identity
Human manager sessions, Odoo API keys, Agents, and future API clients are separate credential classes. Agent credentials are not treated as human sessions.

## Authorization
Server-side tenant context is mandatory for runtime resources. Client-supplied `tenant_id` is not trusted. Manager sessions bind the tenant at authentication time. Odoo tenant context comes from the API-key record.

## Pairing
Pairing remains short-lived/hashed and is intended only for bootstrap. Successful pairing mints the Agent credential; the pairing value is not the long-term identity.

## Job security
Keep the existing claim-token fencing, stale-claim recovery, and `SKIP LOCKED` behavior. Do not retry blindly after uncertain physical outcomes.

## Request security
The custom Next.js server guard checks `Content-Length` without consuming the incoming request stream. The reverse proxy remains responsible for the edge request-size limit.

## Secrets
Never log raw API keys, Agent secrets, passwords, or pairing values. Production Manager login requires a password hash rather than plaintext configuration.

## Customer SaaS identity and billing boundaries

Customer accounts authenticate with email/password. Passwords use Argon2id on the required Node 24 runtime; legacy manager scrypt hashes are upgraded after successful authentication. Verification and password-reset tokens are stored only as SHA-256 hashes and consumed atomically.

A customer session is still backed by the existing server-side `manager_sessions` table and signed HttpOnly cookie, preserving the current session architecture while binding the session to `userId`, `tenantId`, and role. Authorization is derived from tenant membership, never from a browser-supplied tenant ID.

Stripe is only the billing provider. Stripe webhooks update `tenant_subscriptions`; runtime entitlement checks use local subscription state and reject expired periods. Billing operations require the `billing.manage` permission, while billing visibility requires `billing.read`.

## Odoo Gateway Credential Protection

The Odoo-to-Gateway installation credential is stored as authenticated ciphertext using AES-256-GCM. The encryption root is deployment-managed and MUST NOT be stored in PostgreSQL, source control, the addon, or the same backup set as the database.

Configure these deployment secrets before installing/upgrading the addon:

- `ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION` — active key version, for example `1`.
- `ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64` — base64-encoded 32-byte key for version `1`.
- Additional versions use the same naming pattern, for example `ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V2_B64`.

Generate the key outside the repository and place it in the deployment secret store, for example with a secret-manager/KMS-backed runtime injection. Never place an actual key in documentation, `.env` files committed to source, database backups, or logs.

On upgrade to addon `19.0.2.4.0`, existing plaintext Gateway credentials are migrated to authenticated ciphertext. Missing/invalid deployment key material causes the migration or credential use to fail closed; there is no plaintext fallback. Rotation is performed by provisioning the new version, switching `ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION`, and completing the addon upgrade/re-encryption before removing the previous version from the deployment secret store.
