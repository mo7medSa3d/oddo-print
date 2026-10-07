# Gateway connection findings — 2026-10-07

| ID | Severity | Evidence | Repair | Status |
| --- | --- | --- | --- | --- |
| GW01 | P2 | Settings/Agents call friendlyGatewayError on already localized state; the mapper falls back to generic copy. | Render localized state once; normalize failures in the App shell. | Fixed; regression verified |
| GW02 | P2 | App calls errMsg before mapping GatewayApiError, losing its HTTP status when the server message is a machine code. | Map the original failure; prioritize structured status. | Fixed; en/ar regression verified |
| GW03 | P2 | probe_gateway_health has no start/outcome/error logging; reqwest Display hides nested connection causes. The supplied Manager log contains no connection-check outcome. | Add bounded native diagnostics with elapsed time/status/sanitized request ID and URL-free transport cause chains. | Implemented; contract verified; Rust build pending CI |

The original Windows connectivity failure remains unconfirmed. The live probe and health endpoints returned 200 during investigation. These repairs expose the actual failure and correct its presentation; they do not establish that the connection itself is repaired on the user's PC. The strict public identity probe, TLS verification, timeouts, credential isolation and configuration-save rules are preserved.
