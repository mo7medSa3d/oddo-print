.PHONY: all build-agent build-cli release test vet clean linux resources

BINARY_AGENT=YaseirAgent.exe
BINARY_CLI=yaseir-agent-cli.exe

# Build-time pinned Ed25519 license public key (base64); optional for dev builds, required for release and linux.
LICENSE_PUBKEY_LDFLAG=$(if $(strip $(YASEIR_LICENSE_PUBLIC_KEY_B64)),-X github.com/yaseir-agent/agent/internal/license.PinnedPublicKeyB64=$(strip $(YASEIR_LICENSE_PUBLIC_KEY_B64)),)
BUILD_LDFLAGS=$(strip $(LICENSE_PUBKEY_LDFLAG))
RELEASE_LDFLAGS=$(strip -s -w $(LICENSE_PUBKEY_LDFLAG))

# Production flags: strip symbol/debug tables (-s -w) and remove local build
# paths (-trimpath) so shipped binaries are smaller and leak no build topology.
# NOTE: the agent links mattn/go-sqlite3 (CGO), so Windows .exe builds must run
# on a Windows host (or with a mingw cross toolchain), never with CGO_ENABLED=0.
RELEASE_FLAGS=-trimpath -ldflags "$(RELEASE_LDFLAGS)"

all: build-agent build-cli

# Regenerate the committed Windows resources (multi-size Print Agent
# icon + requireAdministrator manifest + version info) embedded into
# both executables. The .syso files are committed, so normal builds do
# not need goversioninfo; run this only after changing
# cmd/*/versioninfo.json, cmd/*/app.manifest, or the Agent icon
# (src-tauri/icons/icon.ico — see scripts/generate-agent-icons.mjs).
resources:
	cd cmd/agent && goversioninfo -64 -o resource_windows_amd64.syso versioninfo.json
	cd cmd/cli && goversioninfo -64 -o resource_windows_amd64.syso versioninfo.json

build-agent:
	go build $(if $(BUILD_LDFLAGS),-ldflags "$(BUILD_LDFLAGS)",) -o $(BINARY_AGENT) ./cmd/agent

build-cli:
	go build $(if $(BUILD_LDFLAGS),-ldflags "$(BUILD_LDFLAGS)",) -o $(BINARY_CLI) ./cmd/cli

release:
	@test -n "$(strip $(YASEIR_LICENSE_PUBLIC_KEY_B64))" || (echo "ERROR: YASEIR_LICENSE_PUBLIC_KEY_B64 must be set for release builds" >&2; exit 1)
	go build $(RELEASE_FLAGS) -o $(BINARY_AGENT) ./cmd/agent
	go build $(RELEASE_FLAGS) -o $(BINARY_CLI) ./cmd/cli

vet:
	go vet ./...

test: vet
	go test ./... -race -count=1

clean:
	rm -f $(BINARY_AGENT) $(BINARY_CLI)

# Cross-compilation for Linux (e.g. for Raspberry Pi — requires a working
# CGO cross toolchain for go-sqlite3, e.g. aarch64-linux-gnu-gcc).
linux:
	@test -n "$(strip $(YASEIR_LICENSE_PUBLIC_KEY_B64))" || (echo "ERROR: YASEIR_LICENSE_PUBLIC_KEY_B64 must be set for release builds" >&2; exit 1)
	CC=aarch64-linux-gnu-gcc CGO_ENABLED=1 GOOS=linux GOARCH=arm64 go build $(RELEASE_FLAGS) -o odoo-agent-linux-arm64 ./cmd/agent
