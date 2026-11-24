# Content Security Policy reporting

The custom HTTP server keeps its enforcing, request-nonced Content Security Policy and adds one fixed same-origin destination: `report-uri /api/security/csp-report`. No external reporting service or `report-sample` directive is enabled. The collector grants no authority and never reads or writes the database.

`POST /api/security/csp-report` accepts the legacy browser `application/csp-report` JSON envelope. Its `csp-report` object must contain an allowlisted `effective-directive`, a disposition of `enforce` or `report`, and an integer `status-code` of zero or 100–599. Additional fields are discarded. Unsupported media types and content encodings are rejected. This matches the browser serialization specified by [CSP Level 3, Reporting](https://www.w3.org/TR/CSP/#reporting); `report-uri` is the compatibility mechanism and is deprecated by the specification. A future move to the Reporting API must add its separate batch schema and browser acceptance rather than silently treating arbitrary JSON as reports.

The route enforces a 16 KiB total body limit while reading, including when a declared length lies, and a two-second total read deadline. An upload whose cancellation callback stalls cannot delay the response or retain a concurrency slot. Each process admits at most eight concurrent readers and 60 attempts per 60-second monotonic window, including malformed reports. It keeps only counters, with no unbounded caller-keyed rate map. Requests over capacity return an empty `429`; malformed, oversized, timed-out and unsupported reports return empty `400`, `413`, `408` and `415` responses. Accepted reports return empty `204`. All responses are non-cacheable. Process-local bounds are not a distributed availability guarantee; reverse-proxy limits remain necessary for a multi-instance deployment.

Reports are untrusted telemetry and can be fabricated or dropped under load. They are never evidence that a particular person performed an action. The only emitted event is `security.csp_violation`, with a server timestamp, allowlisted directive and disposition, and the numeric status. The collector deliberately bypasses the general correlation logger, which attaches request and tenant identifiers. It never logs URLs, query values, original policy or nonce, source samples, request headers, cookies, IP addresses, user or tenant identifiers, arbitrary strings, or parser/transport errors. The raw report is never stored or fetched. Operators may count these events to investigate policy compatibility and suspected injection; a report does not prove exploitation.

The existing custom-server cookie-origin check still applies. No CSRF exemption was added. Cookie-bearing reports must carry the same-origin Fetch Metadata or matching Origin/Referer signals already required for browser mutations. The custom server also applies the route's 16 KiB declared-body admission cap and retains its existing rejection of transfer-encoded requests without a declared length. The route independently caps streamed bodies for alternate hosting modes.

## Verification

`tests/csp-reporting-policy.test.ts` and `tests/csp-report-handler.test.ts` exercise the actual policy generator and route: ordinary reports, malformed schemas and UTF-8, private query/policy/sample/caller data, exact and over-limit sizes, false declared lengths, stalled streams and cancellation, in-flight saturation, and the global attempt window. The privacy case executes inside a real correlation scope and verifies the log has only the five permitted keys.

Run the real-browser loopback check with locally installed, verified Playwright and Chromium:

```sh
YASEIR_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
YASEIR_CHROMIUM_EXECUTABLE=/absolute/path/to/chrome \
node --import tsx scripts/acceptance/csp-report-browser.mts
```

The acceptance creates an ephemeral local server using the production CSP generator, request guard and report route. It proves that Chromium blocks a no-nonce script, executes the nonced script, sends a report carrying the synthetic ambient cookie, receives `204`, and leaves only permitted telemetry fields. Cross-origin and missing-origin cookie requests remain `403`. This local HTTP exercise is separate from deployed TLS or a full browser compatibility matrix.

`scripts/acceptance/platform-browser.mjs` also injects one harmless no-nonce marker after a real platform login against the production build. It requires the marker to remain unset, the actual browser report with the session cookie to receive `204`, and the Gateway event to contain only permitted keys. The resulting browser console policy violation is intentional; JavaScript page exceptions must still be absent. The V3 evidence records which of these acceptance procedures were actually executed against each source snapshot.
