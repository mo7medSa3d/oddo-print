# Odoo HTTP Test Mode

This file is only for the temporary no-domain/no-TLS integration test.

Set the Odoo process environment variable:

`ODOO_PRINT_GATEWAY_ALLOW_INSECURE_HTTP=1`

Then use the Gateway origin printed by `setup-http-test.sh`, for example:

`http://SERVER_PUBLIC_IP:8080`

The Odoo addon already rejects plain HTTP unless this explicit test flag is enabled.

The production configuration remains HTTPS-only. Remove the test flag before moving the deployment to the real Domain + HTTPS path.
