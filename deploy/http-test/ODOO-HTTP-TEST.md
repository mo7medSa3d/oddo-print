# Odoo HTTP Test Mode

This file is only for the temporary no-domain/no-TLS integration test.

Use the Gateway origin printed by `setup-http-test.sh`, for example:

`http://SERVER_PUBLIC_IP:8080`

The Odoo addon on `test/http-server-ready` accepts both `http://` and `https://` Gateway origins directly. No additional HTTP opt-in flag is required for this isolated staging branch.

The explicit test opt-in remains documented for Odoo processes that still carry it:

`ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP=1`

The production configuration on `main` remains HTTPS-only. Remove the test flag before moving the deployment to the real Domain + HTTPS path.
