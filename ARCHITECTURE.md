# Yaseir — Direct Odoo Print Architecture

> This is the current supported architecture. The old Cloud Gateway print data plane is retired. Historical `print_gateway` names remain in the Odoo addon/database schema for upgrade compatibility only.

## 1. The only supported print path

```text
Odoo 19
  - Business documents and POS
  - Bindings (company / destination / document type → printer)
  - Durable print outbox, claim lease and final status
       │ HTTPS polling + authenticated ACK
       ▼
Go Agent (Windows service)
  - Pairing and heartbeat
  - Local printer inventory
  - SQLite execution/recovery ledger
  - Physical print execution
       │
       ▼
Windows Spooler / RAW TCP 9100 / USB / IPP → Printer
```

Yaseir Cloud is a separate control plane for account, subscription, licensing and administration. It does not accept print payloads, own the active print queue, claim jobs, or dispatch jobs to Agents.

## 2. Component ownership

| Component | Owns | Does not own |
|---|---|---|
| Odoo addon | Print intent, bindings, durable queue, claims, leases, Agent ACKs and job history | Physical device execution |
| Go Agent | Pairing, local inventory, SQLite crash recovery and printer execution | Business documents or authoritative job history |
| Tauri Desktop Manager | Odoo URL, Agent pairing, local printer setup and service diagnostics | A second print queue or Cloud job history |
| Yaseir Cloud | Tenant/account, subscription, signed entitlement and admin control plane | Print payloads, queue, claim, delivery or retry |

## 3. Direct Agent lifecycle

1. An administrator creates a pairing code in Odoo.
2. Desktop Manager stores the Odoo HTTPS base URL and sends the code to the local Agent.
3. Agent posts `/api/agent/register` and stores the issued credential in its protected local store.
4. Agent reports presence and its local printer inventory through `/api/agent/heartbeat`.
5. Odoo commits a print intent to its outbox. No Cloud HTTP request is made for job submission.
6. Agent polls `/api/agent/jobs`; Odoo atomically claims eligible rows with a token and lease.
7. Agent acknowledges `printing` before invoking the printer, executes locally, and sends a terminal ACK to `/api/agent/ack`.

The Agent polls every five seconds and heartbeats every thirty seconds. This is pull delivery; there is no WebSocket push path in the active runtime.

## 4. Reliability rules

- Odoo is the queue and status source of truth; Agent SQLite is local execution/recovery state.
- Claims are fenced by tokens. A stale claim can be recovered only before the physical execution boundary is acknowledged.
- Once an Agent acknowledges `printing`, a lost final ACK is ambiguous. Do not automatically replay it.
- Agent/spooler success is not independent proof that paper physically exited the printer.
- Exactly-once physical output is not guaranteed.
- Cloud outages do not interrupt an already-paired Agent's direct Odoo job path, provided Odoo itself and the configured entitlement remain available.

## 5. Compatibility boundary

The Odoo technical module and table/field names still include `print_gateway` and `gateway_*`. They are retained to avoid destructive renames and migrations on installed customer databases. The legacy Cloud submit and status-reconciliation Cron jobs are disabled, their compatibility methods are no-ops, and the Cloud job submission/reprint API routes were removed. Legacy Cloud job tables and read-only historical data are not used as an active queue.

The detailed operational API contract is in [API.md](API.md), and deployment steps are in [DIRECT_PRINT_MODE.md](DIRECT_PRINT_MODE.md).

## 6. Database schema and migrations

- **Schema**: 21 tables defined in `src/db/schema.ts`
- **Migrations**: 1 clean initial migration (`0000`) in `drizzle/`
