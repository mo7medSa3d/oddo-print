# Installation

The system has three runtime components: Gateway, Windows Agent/Desktop Manager, and the Odoo integration addon.


### Gateway connection

The Odoo addon uses HTTPS for Gateway communication by default. The `gateway_api_key` is stored as authenticated AES-256-GCM ciphertext using a deployment-managed key that is external to the Odoo database. Plain HTTP is an explicitly opt-in development mode only via `ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP=1`; do not use it for production credentials.


## 1. Gateway

```bash
git clone https://github.com/mo7medSa3d/oddo-print.git
cd oddo-print
npm ci
cp .env.example .env
npm run db:migrate
npm run build
npm start
```

Configure PostgreSQL, manager authentication, and the production TLS reverse proxy according to deployment policy.

Verify:

```text
GET /api/health -> {"ok":true}
```

## 2. Windows Agent

### Linux desktop build prerequisites

The Tauri desktop manager requires native GTK 3, GLib, WebKitGTK 4.1, and tray development libraries. Check the current machine before running Cargo:

```bash
npm run desktop:linux:deps
```

If modules are missing, print the distribution-specific command with `bash scripts/setup-tauri-linux.sh --print`, or install interactively with:

```bash
npm run desktop:linux:deps:install
```

The script supports Fedora/RHEL, Debian/Ubuntu, and Arch-family distributions and verifies `gdk-3.0`, `gobject-2.0`, and `webkit2gtk-4.1` through `pkg-config`.

Install the Windows Agent/Desktop Manager bundle. Pair the Agent with the Gateway using the pairing flow exposed by the Gateway manager. The Agent owns local printer discovery, heartbeat, queueing and physical execution.

The Gateway manager can inspect runtime agents/printers and their health. Odoo does not create or synchronize these resources.

### PDF Printing in Windows Service (Session 0)

The Windows Agent includes an embedded PDFium renderer running through WebAssembly/wazero. PDF pages are rendered in-process and printed through the Windows printer device context, so Session 0 does not require an interactive desktop, a PDF application, file associations, PATH configuration, or a separate PDF executable. The PDFium WebAssembly payload is embedded by the Go module and requires no runtime download or manual DLL installation.

The renderer processes one page at a time and enforces bounded rendering dimensions to prevent pathological PDF pages from allocating unbounded bitmap memory.

## 3. Gateway API key

In the Gateway manager:

1. Open **API Keys**.
2. Select **Generate API Key**.
3. Copy the raw key immediately.
4. Store it in the Odoo Gateway Configuration screen.
5. Revoke the key from the same Gateway screen when it is no longer trusted.

The raw key is shown only once.

## 4. Odoo addon

Install/upgrade the addon:

```bash
cp -r odoo_addons/print_gateway /path/to/odoo/addons/
odoo-bin -c /etc/odoo.conf -d <db> -i print_gateway --stop-after-init
# later upgrades: -u print_gateway
```

Open **Print Gateway → Gateway Configuration** and enter only:

- Gateway URL
- API Key
- Test Connection
- Gateway Printing Enabled

Then create **Print Bindings**:

`Destination + Document Type -> Printer`

The destination is an existing Odoo object such as POS configuration, warehouse operation type, report action, or company context. The printer is a Gateway runtime printer id.

No Gateway branch identifier, Gateway destination object, Gateway document catalog, Agent record, or Gateway Printer record is configured in Odoo.

## 5. Printing

Use the normal Odoo Print action for supported backend reports.

For POS, use the normal POS receipt/reprint/Print Bill controls. When Gateway printing is enabled, the addon intercepts the Odoo 19 POS print service and queues the operation through the central router without browser printing.

## 6. Upgrade

Gateway: install dependencies, apply the repository migrations, rebuild and restart.
Agent: install the new signed/approved Windows build according to deployment policy.
Odoo: run `-u print_gateway`.

## 7. Release validation

A production release is not complete until CI, Odoo 19 installation/upgrade, Gateway/Agent integration, and physical-printer staging tests are green. The repository does not claim physical E2E from source inspection alone.

## Credential encryption prerequisite

Before installing or upgrading `print_gateway` to `19.0.2.4.0`, provision the deployment-managed credential encryption root outside the repository:

```text
ODOO_PRINT_GATEWAY_CREDENTIAL_ACTIVE_VERSION=1
ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64=<base64 of a random 32-byte key>
# Or use a protected mounted secret file instead:
# ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V1_B64_FILE=/run/secrets/odoo_print_gateway_credential_key_v1
```

The key must come from the deployment's protected secret-management mechanism (for example a KMS/Vault/secret-manager-backed secret injection). Do not commit it to source or place it in the PostgreSQL database. The addon fails closed if key material is missing or invalid. Existing `gateway_api_key` values are migrated to AES-256-GCM ciphertext by the `19.0.2.4.0` post-migration step.
