# Pinned Odoo 19 runtime profile

This directory contains the source patch and complete Python dependency locks used to harden the isolated Odoo verification runtime. It applies to **Odoo Community 19.0, commit `14f9b8149d5260d92fb74404df09483fb42dd820`, CPython 3.12, Linux x86_64**. The original native runtime verification used `print_gateway` version `19.0.2.18.0`; the **historical V3** printer-hardening acceptance used `19.0.2.19.0` on this same pinned upstream runtime. The current checked-in addon is `19.0.2.36.0` (V5). Historical V3 results do not establish current-addon or current-image acceptance; use [`RELEASE_GATES.md`](../RELEASE_GATES.md) for the current upgrade and image gates.

The profile is a separate deployment choice. Installing the addon into an existing Odoo container does **not** replace that container's Python/system packages or patch its Odoo source. `Dockerfile.odoo-hardened` implements the profile as a separate image. No resulting image has been built or scanned in this workspace: a fresh isolated Docker daemon started, but an actual restricted container failed to register its layer with `unshare: operation not permitted`; mapped-user proc mounting and the official rootless helper also failed their required host prerequisites. The image recipe and executable acceptance gate below remain subject to actual image execution on a container-capable host. Remote scans of the exact parent images remain separate evidence, with their raw findings retained.

## Files and purpose

| File | Purpose |
|---|---|
| `requirements-python312-linux-x86_64.lock` | All 62 resolved runtime distributions, exact versions and downloaded artifact SHA-256 hashes |
| `artifacts-python312-linux-x86_64.json` | Official PyPI artifact URLs and matching hashes for that runtime lock |
| `build-tools.lock` | Exact pip, setuptools, wheel and packaging versions/hashes used to reproduce installation without unpinned build isolation |
| `build-tools-artifacts.json` | Official PyPI artifact metadata for those four build tools |
| `odoo19-pypdf-bounds.patch` | Minimal upstream adapter change preserving modern pypdf decompression bounds |
| `apply-odoo19-pdf-bounds.py` | Standard-library-only, exact-source-hash guarded, atomic and idempotent patch application |
| `verify-odoo19-pdf-bounds.py` | Safe live-import check of decompression bounds, ordinary streams and an Odoo PDF writer/reader round-trip |
| `os-security-artifacts.json` | Twenty-three exact Ubuntu packages and one JavaScript security artifact, SHA-256/size locks, official URLs and signed Ubuntu/registry provenance |
| `alpine-security-artifacts.json` | Exact signed PostgreSQL/Caddy Alpine security packages for x86_64 and aarch64, with SHA-256 locks |
| `gosu/go.mod`, `gosu/go.sum` | Complete fixed gosu build dependency graph and Go checksum records |
| `caddy/go.mod`, `caddy/go.sum` | Complete fixed Caddy build dependency graph and Go checksum records |
| `apply-os-security-profile.py` | Offline artifact verification and guarded replacement of rtlcss's source-map-js dependency; no downloads or package-manager execution |
| `verify-source-map-js-security.cjs` | Nine bounded source-map rejection and ordinary mapping/Arabic rtlcss compatibility cases |

The lock is platform specific. It includes the exact Linux/CPython wheels used in verification, not hashes for every operating system or interpreter. The four source distributions are `docopt`, `ofxparse`, `rjsmin` and `vobject`. Install the pinned build tools first, then disable build isolation as shown below. This prevents a source build from fetching a separate, unpinned build environment. A C compiler and matching Python headers are needed if a cached compatible `rjsmin` wheel is unavailable. The source artifact hashes remain checked when pip uses its locally built wheel cache.

## Why both dependency updates and a source patch are required

The pinned upstream requirements use several versions with known security advisories. The verification profile replaces the affected active Python 3.12 dependencies, including Requests, urllib3, cryptography, Jinja2, lxml, Pillow, Werkzeug and the PDF library. The runtime lock records the complete resolved dependency graph rather than only a list of overrides.

Odoo's pinned source already supports modern `pypdf` through its own compatibility adapter. The profile installs `pypdf==6.21.4` and does not install legacy PyPDF2. However, the upstream adapter unconditionally replaces `pypdf.filters.decompress` with an unbounded zlib decompressor. Updating the package alone therefore does not preserve its configured decompression limit.

The accompanying patch applies the historical workaround only to the legacy `PyPDF2` adapter. Modern pypdf retains its native bounded implementation. The safe regression sets a 128-byte output limit and decodes a compressed 1 KiB fixture: the original Odoo import bypassed the limit; the patched import raises pypdf's `LimitReachedError`. No large decompression payload is used.

The guarded patch accepts exactly these SHA-256 hashes of `odoo/tools/pdf/__init__.py`:

| State | SHA-256 |
|---|---|
| Original pinned source | `d62adaee9cd31ff535c9fe9b9a5097a7809dd082c1e2b7ffc7da23cded0c4f6a` |
| Reviewed patched source | `da8fb075e7949f8d9b02b0cc1f365f11e296a7749a318bd0fa9a790b23764672` |

Unknown source fails closed without modifying the file. Applying the patch twice is a no-op on the second invocation. The application script refuses a symlink in place of the target source file, preserves its mode, writes a temporary file in the same directory, flushes it, and replaces the target atomically. It does not download anything, change a database, restart services or alter the original checkout unless explicitly pointed there. Review the change anew when upgrading Odoo; do not weaken its hash guard to make another revision pass.

## Reproduce a source deployment

Use a separate checkout and a fresh virtual environment. Do not upgrade packages inside a running Odoo process. The example paths are placeholders for an operator-controlled staging directory; no production database is selected by these commands.

```sh
export YASEIR_ODOO_SOURCE=/srv/yaseir-staging/odoo-19-source
export YASEIR_ODOO_VENV=/srv/yaseir-staging/odoo-19-venv
export YASEIR_PROFILE=/srv/yaseir-release/docs/runtime-hardening

git clone --branch 19.0 --single-branch https://github.com/odoo/odoo.git "$YASEIR_ODOO_SOURCE"
git -C "$YASEIR_ODOO_SOURCE" checkout --detach 14f9b8149d5260d92fb74404df09483fb42dd820
git -C "$YASEIR_ODOO_SOURCE" rev-parse HEAD

python3.12 -m venv "$YASEIR_ODOO_VENV"
"$YASEIR_ODOO_VENV/bin/python" -m pip install --require-hashes -r "$YASEIR_PROFILE/build-tools.lock"
"$YASEIR_ODOO_VENV/bin/python" -m pip install --require-hashes --no-build-isolation --no-deps -r "$YASEIR_PROFILE/requirements-python312-linux-x86_64.lock"
"$YASEIR_ODOO_VENV/bin/python" -m pip check

"$YASEIR_ODOO_VENV/bin/python" "$YASEIR_PROFILE/apply-odoo19-pdf-bounds.py" "$YASEIR_ODOO_SOURCE"
"$YASEIR_ODOO_VENV/bin/python" "$YASEIR_PROFILE/verify-odoo19-pdf-bounds.py" "$YASEIR_ODOO_SOURCE"
"$YASEIR_ODOO_VENV/bin/python" "$YASEIR_ODOO_SOURCE/odoo-bin" --version
"$YASEIR_ODOO_VENV/bin/python" -m pip freeze --all
```

The addon dependency closure exercised in this mission comprised 71 Odoo modules: its declared base/web/sale/account/stock/purchase/point_of_sale dependencies and their installed dependencies. LDAP authentication was not installed or tested, so `python-ldap` is intentionally absent. The database adapter is `psycopg2-binary==2.9.13`. Deployments using LDAP or other Odoo modules must build and validate an extended profile; this lock is not a compatibility certification for every Odoo module or third-party addon.

Provide required operating-system libraries, fonts and the report renderer separately. Verification used PostgreSQL 16.15 with `unaccent`/`pg_trgm`, patched-Qt wkhtmltopdf 0.12.6.1, Node 24.22.1 and rtlcss 4.3.0. Those components are outside the Python lock and need their own provenance, vulnerability review and deployment lifecycle. In particular, an audit of Python distributions is not an audit of the wkhtmltopdf binary, OpenSSL/system packages, a container base image or an external printer driver.

Run the service as an unprivileged account, keep application/source directories read-only to that account where practical, and grant write access only to its intended data/log directories. Provide database credentials, the deployment-managed credential encryption key, and any private CA bundle through the deployment's secret/configuration mechanism. Do not bake them into source, wheels, images or this directory.

## Container deployment procedure

From the repository root, build the supplied **Linux x86_64 / CPython 3.12** profile:

```sh
docker build --platform=linux/amd64 --file Dockerfile.odoo-hardened \
  --iidfile odoo-hardened.image-id --tag yaseir-odoo:acceptance .
```

Both platform-specific base manifests were retrieved from Docker's official registry on 2026-10-24, with the returned bytes' SHA-256 checked against the manifest digest. The builder is `python:3.12.15-bookworm@sha256:dc0705844ae55b4c07e4c06de75c4e706ca7debfbb9ce017bdceeb3922ea5c29`; the runtime parent is `odoo:19.0@sha256:08af340902122af116a92c917359cd8bb411ca6960c0b4877dc636423a8d5b26`. The latter is the amd64 child of the previously pinned Odoo index `sha256:144175ec0039d52daff1d79f7e51c9281ca3c98b96c830feb49d09764a9f5d7c`. Registry provenance is recorded in `container-bases.json`. These identities prove the selected input manifests, not successful image execution or an absence of vulnerabilities.

The builder fetches only the exact Odoo commit and verifies its Git identity, applies the exact-source-hash PDF patch, installs the hash-locked build tools, downloads all hash-locked dependency artifacts, and builds the four source distributions without an unpinned build environment. The runtime stage creates an isolated virtual environment with system packages excluded, installs only the carried wheels, runs `pip check`, verifies the bounded Odoo PDF adapter in that final environment, and runs as the inherited unprivileged `odoo` user. Source, addon and environment directories are read-only to that account. No database or application credentials are build arguments.

The fixed runtime parent supplies the OS libraries, fonts, Node/rtlcss and patched-Qt wkhtmltopdf layers. The recipe applies the 25 immutable security artifacts described below and never runs `apt update`, resolves an unpinned package version, or fetches npm dependencies during runtime installation. Other inherited packages, including inactive distro Python packages, remain present and can still appear in image scans. The final-image scan is required and is not replaced by the Python virtual-environment audit or by these targeted fixes. An updated base needs a new manifest record, a rebuilt image, the PDF/native/report gates and a new scan.

### Immutable Ubuntu and rtlcss security updates

The V3 scan of the exact Odoo parent identified `CVE-2026-84782` in three Ubuntu OpenSSL packages and `CVE-2026-93749` in rtlcss's `source-map-js`. The Python environment and PDF adapter fix do not repair these components. The recipe downloads 22 exact Ubuntu packages from the immutable Ubuntu `20261024T000000Z` snapshot plus the independently SHA-256-pinned Ubuntu `noble-security` Brotli patch and the exact npm `source-map-js` **1.2.2** artifact. The set includes `libssl3t64`, `libssl-dev` and `openssl` **3.0.13-0ubuntu3.16 amd64** plus all other inherited package groups for which this scan and the signed repository publish compatible fixed versions: curl/libcurl, c-ares, expat, FreeType, GLib, Perl with its exact-version companion packages, PNG, SQLite, X11, libxml2, distro lxml/Requests/urllib3 and zlib. The manifest records each package name, previous and fixed version, size, dependency constraints and hash. No mutable dependency resolver runs during installation. Every Docker `ADD` has a SHA-256 checksum, independently checked again against the carried manifest before installation. No advisory baseline was widened.

The additional Brotli package is `libbrotli1=1.1.0-2ubuntu0.1` (security fix for CVE-2026-111497 / Ubuntu USN-8956-1), obtained from `security.ubuntu.com`. On 2026-10-28 an isolated Ubuntu 24.04 GitHub Actions job verified its package name, version and amd64 architecture, exact size 330,968 bytes, and SHA-256 `70b188a86d81f30d7510aab30e25d638ed5037dded6691af1533952b71ac61de` (run 40592443466). The Dockerfile pins that digest, checks the inherited version and asserts the installed version. Existing historical packages remain from the original signed snapshot. No previous security exception is added.

A second post-snapshot package was added on 2026-11-05: `libpcre2-8-0=10.42-4ubuntu2.2` (Ubuntu USN-8974-1, published 2026-11-03), obtained from `security.ubuntu.com`. USN-8974-1 is the first noble release fixing the seven reviewed `libpcre2-8-0` findings (CVE-2026-103111, CVE-2026-86145, CVE-2026-89156, CVE-2026-89157, CVE-2026-89158, CVE-2026-89160, CVE-2026-89161); the retained snapshot predates it. The downloaded artifact's package name, version `10.42-4ubuntu2.2`, amd64 architecture, exact size 228,546 bytes and SHA-256 `f41da7cb7e979d6b037ea92650c72ec8ec532ec3c93aa8d5b997207de56695ea` were verified from the `.deb` control fields during the 2026-11-05 review, and the Dockerfile fences it exactly like the Brotli package. The seven findings left the Trivy baseline in that review (`security/odoo19-image-review-2026-11-05.md`); no security exception is added for them.

The Ubuntu hashes were verified against the `noble-security` main and universe amd64 package indexes, whose hashes matched the signed `InRelease`. The signature validated with Ubuntu's archive key fingerprint `F6ECB3762474EDA9D21B7022871920D1991BC93C`. The npm artifact matched its official registry SHA-512 integrity metadata; the manifest additionally pins its SHA-256. See [Ubuntu USN-8847-1](https://ubuntu.com/security/notices/USN-8847-1) and [the source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).

During image assembly, `dpkg` installs only those 24 carried `.deb` files. Architecture and each original package version are checked first, refusing an unreviewed parent or accidental downgrade; all resulting versions must equal the reviewed fixes. Those versions meet the recorded fixes for 116 OS package/advisory occurrences. Together with source-map-js, the recipe addresses 117 of the 182 parent occurrences. The other 65 have no fixed version in the retained scanner result and remain unresolved. These counts describe source intent and artifact identity, not a rebuilt-image scan or a risk acceptance. The Node dependency replacement accepts only the pinned rtlcss4.3.0 parent and source-map-js1.2.1/1.2.2, rejects archive traversal/links/duplicates and unknown package identities, and replaces the complete dependency contents, including its license. Reapplication requires byte-identical reviewed contents. No npm lifecycle scripts run. The image build then executes the bounded JavaScript regressions and OpenSSL's version command before deleting the downloaded artifacts.

Fresh host verification checked the actual downloaded package identities and ran the extracted OpenSSL executable. A dynamic Python process was confirmed to map the extracted patched `libssl.so.3` and `libcrypto.so.3`; five real HTTPS trust, identity, redirect and proxy cases exercised the production Odoo transport with those libraries. The primary verification Python links another OpenSSL statically, so an earlier environment-variable-only test was not accepted as evidence for the Ubuntu update. The rtlcss fixture reconstructed the exact seven package versions observed in the scanned parent from registry-integrity-verified artifacts. The unchanged security assertions fail against source-map-js1.2.1 and pass against1.2.2; ordinary mapping and Arabic CSS conversion also pass. These checks prove the specified artifacts and host behavior, not `dpkg` execution in the final image, final-image vulnerability absence, or current wkhtmltopdf report output. Those gates remain required on a container-capable host.

`scripts/odoo-hardened-entrypoint.py` accepts database and administrative secrets through `PGPASSWORD_FILE` and `ODOO_ADMIN_PASSWORD_FILE`, validates the active `ODOO_PRINT_GATEWAY_CREDENTIAL_KEY_V<version>_B64_FILE`, generates a private 0600 configuration, and places only its filename in process arguments. `PGHOST`, `PGUSER` and a single explicit `PGDATABASE` are required. Database listing is disabled and the database filter is anchored to that exact name. Mount `/var/lib/odoo` persistently: it holds the filestore and external installation identity scope. `ODOO_CONFIG_FILE` may supply reviewed worker/resource/SMTP settings; database identity and addon paths remain fixed by the entrypoint. Do not publish port 8069 directly; use the reviewed HTTPS proxy deployment.

Record the resulting image digest and imported package versions. Run the PDF limit verification **inside that final image**, then perform clean-install, ordinary-upgrade, report rendering and native addon regression gates against an isolated PostgreSQL instance. Generate and inspect English and Arabic diagnostic PDFs at 58/80 mm. Scan the final image separately. A successful source-venv gate is not a substitute for these image-specific checks.

The Odoo job in `.github/workflows/ci.yml` builds this Dockerfile, tests the image carried addon and environment by the emitted immutable local image ID, and uses the same ID for CycloneDX and full-severity vulnerability gates with unfixed findings retained. Runtime profile inputs, including the executable files and dependency locks under this directory, always activate that job. The checked-in workflow is an executable acceptance requirement; its hosted execution is not claimed by local static validation.

The executable cross-image acceptance gate requires Docker/Compose and Trivy already installed:

```sh
python3 scripts/acceptance/container-release.py --output /absolute/new/container-evidence
```

It builds and records exact Gateway, PostgreSQL, Caddy and hardened Odoo image IDs, emits CycloneDX inventories, retains UNKNOWN/LOW/MEDIUM/HIGH/CRITICAL findings, includes unfixed advisories, and fails on any image finding because this acceptance has no exceptions, verifies the Odoo PDF guard inside the exact image with networking disabled, and runs disposable Gateway/PostgreSQL/migrations/Caddy services. The local staging stack uses newly generated synthetic secrets, loopback-only published ports, Caddy's internal CA and no configured email/payment provider. It checks CA-verified readiness, rejection of an untrusted CA and unauthenticated WSS admission. It then removes only its uniquely named project and volumes. Any failed build, scan, assertion or cleanup leaves a nonzero result; no container-dependent step is reported as passed if no image was built. Authenticated workflows and the complete native Odoo suite remain additional gates.

Mount persistent Odoo data and external installation proof storage according to the main installation guide. Preserve the encryption key, database, filestore and external enrollment proof together for a same-name restore. An independent clone needs its own external installation identity scope; copied historical v2 jobs must remain fenced until their original receipts are reconciled. Never remove a proof or change old operation IDs merely to make a retry go through.

### PostgreSQL and Caddy dependency profiles

`Dockerfile.secure-images` preserves the exact PostgreSQL16.15 and Caddy2.11.7 parents and their entrypoints. The PostgreSQL runtime selects musl/musl-utils1.2.6-r3 and zlib1.3.2-r1 on its Alpine3.24 branch. Caddy selects musl/musl-utils1.2.5-r24, zlib1.3.2-r1 and Brotli1.2.1-r0 on its Alpine3.23 branch. Both architectures have separately pinned APK hashes. Docker verifies each download; native APK signature and payload checks remain enabled during offline installation. The recipe verifies the expected parent release, installs only carried APKs without network access, and requires each installed version to equal its fixed pin. An absent exact artifact fails the build instead of silently selecting another release.

The gosu source stays at commit `6456aaa0f3c854d199d0f037f068eb97515b7513` (1.19). Its complete Go lock selects `github.com/moby/sys/user v0.4.1` and `golang.org/x/sys v0.44.0`. The Caddy2.11.7 lock selects `github.com/go-chi/chi/v5 v5.4.0` and `golang.org/x/net v0.62.0`. Both use the checksum-verified Go1.26.11 toolchain, `go mod verify` and `go build -mod=readonly`; image assembly does not run `go get`. Review the complete graph and rerun dependency and application gates when changing these locks.

The two `dependency_security_test.go` files exercise bounded account-file parsing, ordinary account/group compatibility and trusted immediate-peer handling. They use local fixtures and do not change host account databases. Reproduce their checks from the repository root with the pinned Go toolchain:

```sh
(cd docs/runtime-hardening/gosu && go test -mod=readonly -count=1 -race ./...)
(cd docs/runtime-hardening/caddy && go test -mod=readonly -count=1 -race ./...)
```

The native rebuilt graphs need their own vulnerability and reachability review. A finding against `golang.org/x/crypto/openpgp` must be evaluated against Caddy's actual imported packages and binary; the Agent's separate reachability evidence does not transfer. Installed Alpine packages, full Caddy reverse-proxy behavior, PostgreSQL entrypoint/data-volume behavior and final image scans still require exact built-image acceptance. Host compilation and an isolated APK directory install with maintainer scripts disabled do not complete those gates.

Primary fixes: [moby/sys user parser advisory](https://github.com/moby/sys/security/advisories/GHSA-mjcv-p78q-w5fw), [chi trusted-peer advisory](https://github.com/go-chi/chi/security/advisories/GHSA-j6qf-3m9c-vwj3), [Alpine3.24 security database](https://secdb.alpinelinux.org/v3.24/main.json), and [Alpine3.23 security database](https://secdb.alpinelinux.org/v3.23/main.json).

## Addon HTTP transport and operational behavior

All addon Gateway HTTP boundaries use a request-local connection pool. The destination policy checks the exact deployment allowlist, DNS answers and forbidden addresses; the connection then uses a validated numeric address. The original hostname remains the HTTP Host header, TLS SNI and certificate verification name. IDNA spelling follows Requests' UTS46/IDNA2008 preparation. Numeric IPv6 scope IDs returned by the OS resolver are preserved for explicitly allowlisted private deployments.

Redirect following, explicit proxies and disabled TLS verification are refused. Environment proxies and `.netrc` credentials are not used. A deployment `REQUESTS_CA_BUNDLE` or `CURL_CA_BUNDLE` is honored explicitly, so a private Gateway CA can be trusted without disabling certificate checks. These settings are controlled by the service environment, not by ordinary Odoo users.

Each request attempts only the first validated address and performs no transparent transport retry. This deliberately trades address-fallback availability for a clear dispatch boundary. A failed address can delay progress until the existing bounded outbox or control-plane retry; the library does not replay a print POST against another address. Temporary DNS failures keep a typed pre-connection cause so the existing safe retry classifier can distinguish them from a response lost after dispatch.

Connect/read timeouts are finite and capped at 60 seconds at this boundary; actual call sites generally request smaller values. Control-plane responses are streamed and capped at 2 MiB before they are exposed through the ordinary Requests `content`/`json()` interface. The limit applies after HTTP content decoding, including gzip, and also rejects an advertised length above the limit. The explicitly streamed inventory path retains its own 2 MiB decoded-byte limit. An oversized response closes the connection and raises a generic request error: a print POST may already have been accepted, so the existing outbox marks that outcome ambiguous rather than automatically retrying or failing over. OS DNS lookup duration, total wall-clock deadlines and service-wide resource budgets remain separate concerns. The transport change does not claim universal denial-of-service protection. Keep the Gateway allowlist and network egress policy appropriately restricted.

## Verification and release boundaries

The release evidence distinguishes package scanning, runtime behavior and physical output. The clean runtime dependency set initially reported zero known advisories for its 62 runtime distributions. The reproducible installation also records its four pinned build tools; the release audit records the exact expanded set and scan date. An advisory result means the consulted database had no matching known advisory at that time, not that the packages contain no vulnerabilities.

Historical V2 verification included the original/patched decompression probe, native Odoo PDF reader/writer behavior, English/Arabic wkhtmltopdf reports, PostgreSQL install/upgrade/identity scenarios and the addon test suite. Those historical results do not certify a later source revision. Fresh V3 evidence separately records the pinned source-venv PDF limit/reader-writer probe, 238 native addon test methods, an ordinary addon upgrade and preservation of existing synthetic account/password/membership state. Exact final-image checks, current English/Arabic wkhtmltopdf reports, native Windows execution and physical output require their own fresh evidence. Consult the accompanying workstream report for exact source hashes, commands, counts and retained failures; an interrupted run or a failed upstream fixture run is never counted as a pass.

Software pipeline checks use a local Gateway and isolated consumers. Successful job admission or an IPP software peer response does not establish physical paper output. Real printer language/media/driver behavior, duplex/cutter/drawer behavior and physical delivery still require the hardware acceptance matrix. Do not replace that limitation with a “printed” label based solely on transport success.

### Primary implementation references

- [Pinned Odoo source](https://github.com/odoo/odoo/tree/14f9b8149d5260d92fb74404df09483fb42dd820)
- [Pinned Odoo PDF adapter](https://github.com/odoo/odoo/blob/14f9b8149d5260d92fb74404df09483fb42dd820/odoo/tools/pdf/__init__.py)
- [urllib3 custom TLS hostname and certificate verification](https://urllib3.readthedocs.io/en/stable/advanced-usage.html#custom-sni-hostname)
- [Requests HTTPAdapter interface](https://requests.readthedocs.io/en/latest/api/#requests.adapters.HTTPAdapter)
- [PyPI artifact metadata](https://pypi.org/)

## Security patch, 2026-10-31

Following the 2026-10-30 publication of seven pypdf HIGH advisories (CVE-2026-119203 through CVE-2026-119209), the isolated runtime lock now pins **pypdf 6.21.4**. The upstream fixes are present in 6.21.3 and 6.21.4, and PyPI's trusted-publishing wheel SHA-256 is `33e4fb41ca352810eb4e9838aa0d82d6888a5f8bf682f43e99cce5faa666255c`. The artifact manifest records the same official wheel URL and digest. This update does not modify the bounded-decompression Odoo adapter patch, relax any image severity gate, or add CVEs to the security baseline. The exact rebuilt image still requires real Odoo addon tests, PDF bounds verification and a fresh Trivy scan before acceptance.

## Runtime image security correction, 2026-11-05

The exact-image Trivy run on 2026-11-05 found two inherited runtime packages
that were separate from the already pinned application venv:

- Ubuntu's system python3-pil 10.2.0-1ubuntu1.3 remained installed in the
  upstream Odoo image even though the isolated Odoo venv already used Pillow
  13.0.0. The upstream Pillow 13.0.0 wheel is now repackaged as the system
  python3-pil 13.0.0-1yaseir1 package. The conversion script accepts only the
  exact CPython 3.12 x86_64 wheel and verifies its SHA-256 from the runtime
  dependency lock before writing the Debian package. This preserves the base
  image's system package dependency graph while making both Python runtimes
  use the same patched Pillow release.
- apt 2.8.3 and libapt-pkg6.0t64 2.8.3 were inherited from the upstream image.
  APT is not used by Odoo after image assembly, so both packages are purged
  from the final runtime. dpkg remains available for package inventory and
  build-time installation. The runtime no longer ships apt, apt-get, apt-cache,
  or the vulnerable libapt HTTP backend.

This correction does not whitelist the findings, change the Trivy baseline,
or lower any severity threshold. The acceptance gate still scans the exact
built image with UNKNOWN, LOW, MEDIUM, HIGH, and CRITICAL severities, rejects
new and unfixed findings, and retains the full SARIF and SBOM. A fresh final
scan must confirm that the inherited APT and Pillow findings are absent
before release.

## Ubuntu FreeType package mirror correction, 2026-11-05

The hardened-image rebuild found that the immutable snapshot URL returned
libfreetype6 2.13.2+dfsg-1ubuntu0.2 bytes whose SHA-256 differed from the
expected package hash. The build correctly failed closed. Canonical's Ubuntu
package download metadata confirms the official amd64 package size is 402610
bytes and its SHA-256 is 8c6d3bac5a6197fa2f48b2d56f04f3ffecaa7082eeab91b0939f97a40adc88a6.
The Dockerfile and artifact manifest now fetch that same immutable package
from the official noble-security origin at security.ubuntu.com while keeping
the previously verified SHA-256 and size unchanged. The full checksum check
remains enabled; the digest reported by the mismatching snapshot response was
not accepted.