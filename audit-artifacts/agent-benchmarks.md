# Agent Hot-Path Benchmarks

Real `go test -bench` results captured on the local environment. **No numbers
in this file are fabricated** — they are the direct output of the commands
shown. Microbenchmarks measure CPU/allocation cost of individual operations,
**not** end-to-end print latency (which is dominated by network + printer I/O
and PDF rendering and could not be measured here — see Environment Limitations).

## Environment

- Go: `go1.26.7 linux/amd64`
- CPU: `Intel(R) Core(TM) i7-9850H CPU @ 2.60GHz`
- No PostgreSQL, no Docker, no Odoo runtime available (constraint: no local
  installs). Live integration / E2E / end-to-end latency (T0–T12) were
  therefore **not measured** and are **not** reported here.

## Benchmark files added

- `agent/internal/payload/payload_bench_test.go` — payload decode/validation.
- `agent/internal/printer/hotpath_bench_test.go` — capability compatibility,
  protocol support, media (raster) normalization, stable-ID (discovery dedup),
  device classification, and a 200-probe dedup loop.
- `agent/internal/queue/queue_bench_test.go` — local durable-queue Push /
  IsProcessed / full lifecycle (real SQLite commit cost).

## Command

```
cd agent && go test -run '^$' -bench=. -benchmem \
  ./internal/payload/ ./internal/printer/ ./internal/queue/
```

## Results

### payload (dispatch-path decode/validation)

| Benchmark | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| ParseESCPOS_Small (512B) | ~776 | 688 | 2 |
| ParseESCPOS_Medium (8KB) | ~8,405 | 9,584 | 2 |
| ParseRaw_Small (512B) | ~753 | 688 | 2 |
| ParseRaw_Medium (64KB) | ~64,515 | 73,840 | 2 |
| ParsePDF_100KB | ~104,000 | 106,608 | 2 |
| ParsePDF_1MB | ~1,020,000 | 1,056,880 | 2 |
| ParseReject_BadType | ~607 | 128 | 3 |

Observation: parse cost is linear in payload size and dominated by the single
base64 decode (2 allocs regardless of size). This is expected and near-optimal;
the decode buffer is unavoidable. No change justified.

### printer (discovery + validation hot paths)

| Benchmark | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| PayloadCompatible_ThermalMatch | ~58 | 0 | 0 |
| PayloadCompatible_Mismatch | ~37 | 0 | 0 |
| SupportedProtocolsForDevice | ~34 | 16 | 1 |
| RasterMaxWidthFromCapabilities | ~12 | 0 | 0 |
| StableIDForDevice_Network | ~675 | 152 | 7 |
| StableIDForDevice_USB | ~552 | 128 | 6 |
| ClassifyDeviceInfo | ~933 | 72 | 7 |
| DiscoveryDedup_200 | ~125,000 | 34,587 | 1,303 |

Observation: capability/media checks are effectively free (tens of ns, zero
alloc). Stable-ID and classification allocate a handful of times each (string
building + hashing). At realistic device counts (tens, not thousands) this is
negligible relative to the network probe timeouts that dominate discovery.
**No source change justified from these numbers** — per the brief, changing
already-correct, non-bottleneck logic would be an artificial change.

### queue (local durable queue, real SQLite)

| Benchmark | ns/op | B/op | allocs/op |
|---|---:|---:|---:|
| QueuePush | ~26,000 | 366 | 11 |
| QueueIsProcessed_Hit | ~11,000 | 552 | 16 |
| QueueIsProcessed_Miss | ~10,300 | 552 | 16 |
| QueueLifecycle (queued→printing→success) | ~79,900 | 911 | 29 |

Observation: per-op cost is dominated by SQLite commit/journal behaviour, as
expected for a durable queue. These are microseconds — far below the delivery
and printing timescales — so they are not a delivery-latency bottleneck.

## Conclusion

The benchmarked hot paths are already fast and allocate modestly. **The
evidence does not justify any micro-optimization source change**; the real
end-to-end latency budget lives in network/printer transport and PDF rendering,
which require a live integration environment (unavailable here) to measure.
The benchmarks are committed so a future run with live infra can compare
against this baseline and detect regressions.
