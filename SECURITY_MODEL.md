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
