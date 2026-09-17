from pathlib import Path
import json, re, time


def text(path): return Path(path).read_text()
def put(path, value): Path(path).write_text(value)
def once(value, old, new, label):
    if old not in value:
        raise SystemExit(f'missing anchor: {label}')
    return value.replace(old, new, 1)

# Database contract.
p = Path('src/db/schema.ts'); s = text(p)
s = once(s, '  lifecycle: text("lifecycle").notNull().default("active"),\n',
'''  lifecycle: text("lifecycle").notNull().default("active"),
  managementSource: text("management_source").notNull().default("agent"),
  desiredRevision: bigint("desired_revision", { mode: "number" }).notNull().default(0),
  appliedDesiredRevision: bigint("applied_desired_revision", { mode: "number" }).notNull().default(0),
  observedDesiredRevision: bigint("observed_desired_revision", { mode: "number" }).notNull().default(0),
''', 'schema desired fields')
s = once(s, '  statusIdx: index("printers_status_idx").on(table.status),\n',
'''  statusIdx: index("printers_status_idx").on(table.status),
  managementSourceCheck: check("printers_management_source_check", sql`${table.managementSource} in ('agent','manager')`),
  desiredRevisionCheck: check("printers_desired_revision_check", sql`${table.desiredRevision} >= 0 AND ${table.appliedDesiredRevision} >= 0 AND ${table.observedDesiredRevision} >= 0 AND ${table.appliedDesiredRevision} <= ${table.desiredRevision} AND ${table.observedDesiredRevision} <= ${table.appliedDesiredRevision}`),
  desiredAgentIdx: index("printers_agent_lifecycle_desired_idx").on(table.tenantId, table.agentId, table.lifecycle, table.managementSource),
''', 'schema desired constraints')
put(p, s)

mig = """ALTER TABLE printers ADD COLUMN management_source text NOT NULL DEFAULT 'agent';
ALTER TABLE printers ADD COLUMN desired_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN applied_desired_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN observed_desired_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE printers ADD CONSTRAINT printers_management_source_check CHECK (management_source IN ('agent','manager'));
ALTER TABLE printers ADD CONSTRAINT printers_desired_revision_check CHECK (desired_revision >= 0 AND applied_desired_revision >= 0 AND observed_desired_revision >= 0 AND applied_desired_revision <= desired_revision AND observed_desired_revision <= applied_desired_revision);
CREATE INDEX printers_agent_lifecycle_desired_idx ON printers(tenant_id, agent_id, lifecycle, management_source);
"""
put('drizzle/0037_desired_printer_reconciliation.sql', mig)
j = Path('drizzle/meta/_journal.json'); data = json.loads(text(j))
if not any(e.get('tag') == '0037_desired_printer_reconciliation' for e in data['entries']):
    data['entries'].append({'idx': max(e['idx'] for e in data['entries']) + 1, 'version': '7', 'when': int(time.time()*1000), 'tag': '0037_desired_printer_reconciliation', 'breakpoints': False})
    put(j, json.dumps(data, indent=2) + '\n')

# Gateway heartbeat desired ack + snapshot.
p = Path('src/app/api/agent/heartbeat/route.ts'); s = text(p)
s = once(s, 'type ReportedPrinter = {\n', 'type DesiredStateAck = { printerId?: unknown; appliedDesiredRevision?: unknown; observedDesiredRevision?: unknown };\n\ntype ReportedPrinter = {\n', 'heartbeat ack type')
s = once(s, '    const skipped: Array<{ id: string; reason: string }> = [];\n', '''    const desiredStateAcks = Array.isArray(body?.desiredStateAcks) ? (body.desiredStateAcks as unknown[]).slice(0, 500) : [];
    for (const rawAck of desiredStateAcks) {
      if (!rawAck || typeof rawAck !== "object") continue;
      const ack = rawAck as DesiredStateAck;
      const printerId = typeof ack.printerId === "string" ? ack.printerId.trim() : "";
      const applied = typeof ack.appliedDesiredRevision === "number" && Number.isSafeInteger(ack.appliedDesiredRevision) && ack.appliedDesiredRevision >= 0 ? ack.appliedDesiredRevision : -1;
      const observed = typeof ack.observedDesiredRevision === "number" && Number.isSafeInteger(ack.observedDesiredRevision) && ack.observedDesiredRevision >= 0 ? ack.observedDesiredRevision : -1;
      if (!printerId || applied < 0 || observed < 0) continue;
      await db.update(printers).set({ appliedDesiredRevision: sql`LEAST(${printers.desiredRevision}, GREATEST(${printers.appliedDesiredRevision}, ${applied}))` }).where(and(eq(printers.id, printerId), eq(printers.tenantId, agent.tenantId), eq(printers.agentId, agent.id), eq(printers.managementSource, "manager")));
      await db.update(printers).set({ observedDesiredRevision: sql`LEAST(${printers.desiredRevision}, ${printers.appliedDesiredRevision}, GREATEST(${printers.observedDesiredRevision}, ${observed}))` }).where(and(eq(printers.id, printerId), eq(printers.tenantId, agent.tenantId), eq(printers.agentId, agent.id), eq(printers.managementSource, "manager")));
    }

    const skipped: Array<{ id: string; reason: string }> = [];
''', 'heartbeat ack processing')
s = once(s, '''    const desiredRows = await db.query.printers.findMany({
      where: and(eq(printers.tenantId, agent.tenantId), eq(printers.agentId, agent.id)),
      columns: {
        id: true,
        name: true,
        printerType: true,
        deviceClass: true,
        connectionType: true,
        protocol: true,
        lifecycle: true,
        config: true,
        capabilities: true,
        updatedAt: true,
      },
    });
''', '''    const desiredRows = await db.query.printers.findMany({
      where: and(eq(printers.tenantId, agent.tenantId), eq(printers.agentId, agent.id), eq(printers.managementSource, "manager")),
      columns: {
        id: true, name: true, printerType: true, deviceClass: true, connectionType: true, protocol: true,
        lifecycle: true, config: true, capabilities: true, desiredRevision: true, appliedDesiredRevision: true, observedDesiredRevision: true,
      },
    });
''', 'heartbeat desired query')
s = once(s, '        desiredRevision: row.updatedAt.toISOString(),\n', '        desiredRevision: row.desiredRevision,\n        appliedDesiredRevision: row.appliedDesiredRevision,\n        observedDesiredRevision: row.observedDesiredRevision,\n', 'heartbeat revision response')
put(p, s)

# Manager printer mutations: status is observed-only and desired edits advance revision.
p = Path('src/app/api/printers/[id]/route.ts'); s = text(p)
s = once(s, 'import { and, eq } from "drizzle-orm";', 'import { and, eq, sql } from "drizzle-orm";', 'printer patch sql import')
s = once(s, '  status: z.enum(["online", "offline", "busy", "error", "unknown"]).optional(),\n', '', 'remove manager status')
s = once(s, '  if (parsed.data.status !== undefined) update.status = parsed.data.status;\n', '', 'remove manager status update')
s = once(s, '  const update: Partial<typeof printers.$inferInsert> = { updatedAt: new Date() };\n', '''  const desiredStateChanged = parsed.data.name !== undefined || parsed.data.printerType !== undefined || parsed.data.deviceClass !== undefined || parsed.data.connectionType !== undefined || parsed.data.protocol !== undefined || parsed.data.config !== undefined || parsed.data.capabilities !== undefined || parsed.data.lifecycle !== undefined;
  const update: Partial<typeof printers.$inferInsert> = { updatedAt: new Date() };
  if (desiredStateChanged) {
    update.managementSource = "manager";
    update.desiredRevision = sql`${printers.desiredRevision} + 1`;
  }
''', 'printer desired revision')
put(p, s)

p = Path('src/app/api/printers/route.ts'); s = text(p)
s = once(s, '          capabilities: data.capabilities ?? null,\n', '          capabilities: data.capabilities ?? null,\n          managementSource: "manager", desiredRevision: 1, appliedDesiredRevision: 0, observedDesiredRevision: 0,\n', 'manager printer registration')
put(p, s)

# Claim only converged manager-owned printers.
p = Path('src/app/api/agent/jobs/route.ts'); s = text(p)
needle = "        AND pr.status = 'online'\n"
replacement = needle + "        AND (pr.management_source = 'agent' OR pr.applied_desired_revision >= pr.desired_revision)\n"
if s.count(needle) < 3: raise SystemExit('claim printer anchors missing')
s = s.replace(needle, replacement)
put(p, s)

# Agent fields, startup recovery, heartbeat response/ack consumption, and execution fence.
p = Path('agent/internal/agent/agent.go'); s = text(p)
s = once(s, '\tprobeStates  map[string]*printerProbeState\n', '''\tprobeStates  map[string]*printerProbeState
\tdesiredStateMu sync.Mutex
\tdesiredStates map[string]desiredPrinterRecord
\tgatewayOwned map[string]struct{}
\tdesiredStatePath string
''', 'agent desired state fields')
s = once(s, '\t\tdiscoverySem:     make(chan struct{}, 1),\n', '''\t\tdiscoverySem:     make(chan struct{}, 1),
\t\tdesiredStates:    make(map[string]desiredPrinterRecord),
\t\tgatewayOwned:     make(map[string]struct{}),
\t\tdesiredStatePath: desiredStatePath(configPath),
''', 'agent desired state initialization')
s = once(s, '\t// 1. Load configured printers from YAML (legacy, still supported for backward compat)\n', '\tif err := a.loadDesiredState(); err != nil { log.Printf("WARNING: desired-state recovery unavailable: %v", err) }\n\n\t// 1. Load configured printers from YAML (legacy, still supported for backward compat)\n', 'agent desired recovery')
s = once(s, '\tdefer a.printersMu.Unlock()\n\tif old, exists := a.printerConfigs[id]; exists {\n', '\tdefer a.printersMu.Unlock()\n\tif _, managed := a.gatewayOwned[id]; managed { return false }\n\tif old, exists := a.printerConfigs[id]; exists {\n', 'discovery cannot overwrite gateway state')
s = once(s, '\tp, ok := a.getPrinter(printerID)\n\tif !ok {\n', '''\tif !a.isPrinterExecutionAllowed(printerID) {
\t\tlog.Printf("Job %s blocked: printer %s is not at the current Gateway desired revision or is disabled/retired", jobID, printerID)
\t\ta.rejectJob(jobID, claimToken, "printer_not_at_desired_state")
\t\treturn
\t}

\tp, ok := a.getPrinter(printerID)
\tif !ok {
''', 'local job execution fence')
s = once(s, '\t\t"printers": a.printerStatusPayload(),\n\t}\n', '\t\t"printers": a.printerStatusPayload(),\n\t\t"desiredStateAcks": a.desiredStateAcksPayload(),\n\t}\n', 'agent desired ack payload')
s = once(s, '\tvar hbResp struct {\n\t\tSuccess         bool `json:"success"`\n', '\tvar hbResp struct {\n\t\tSuccess         bool `json:"success"`\n\t\tDesiredState []desiredPrinterWire `json:"desiredState"`\n', 'agent desired response type')
s = once(s, '\tif err := json.Unmarshal(body, &hbResp); err == nil {\n\t\tif len(hbResp.SkippedPrinters) > 0 {\n', '\tif err := json.Unmarshal(body, &hbResp); err == nil {\n\t\tacks := a.reconcileGatewayDesiredState(hbResp.DesiredState)\n\t\tif len(acks) > 0 { log.Printf("[heartbeat] reconciled %d Gateway-managed printer(s)", len(acks)) }\n\t\tif len(hbResp.SkippedPrinters) > 0 {\n', 'agent desired response consume')
# Protect registry-owned cleanup from deleting Gateway-managed runtime.
needle = '\tfor id := range a.registryOwned {\n\t\tif _, stillPresent := present[id]; stillPresent {\n'
replacement = '\tfor id := range a.registryOwned {\n\t\tif _, gatewayManaged := a.gatewayOwned[id]; gatewayManaged { continue }\n\t\tif _, stillPresent := present[id]; stillPresent {\n'
if needle in s: s = s.replace(needle, replacement, 1)
put(p, s)

# Persistent, revision-fenced Gateway desired-state reconciler.
desired = r'''package agent

import (
    "encoding/json"
    "fmt"
    "net"
    "os"
    "path/filepath"
    "strconv"
    "strings"

    "github.com/yasser-agent/agent/internal/config"
    "github.com/yasser-agent/agent/internal/printer"
)

type desiredPrinterWire struct {
    ID string `json:"id"`
    Name string `json:"name"`
    PrinterType string `json:"printerType"`
    DeviceClass string `json:"deviceClass"`
    ConnectionType string `json:"connectionType"`
    Protocol string `json:"protocol"`
    Lifecycle string `json:"lifecycle"`
    Config map[string]interface{} `json:"config"`
    Capabilities map[string]interface{} `json:"capabilities"`
    DesiredRevision int64 `json:"desiredRevision"`
}

type desiredPrinterRecord struct {
    Desired desiredPrinterWire `json:"desired"`
    AppliedDesiredRevision int64 `json:"appliedDesiredRevision"`
    ObservedDesiredRevision int64 `json:"observedDesiredRevision"`
    ApplyError string `json:"applyError,omitempty"`
}

func desiredStatePath(configPath string) string {
    dir := filepath.Dir(configPath)
    if configPath == "" || dir == "." { if exe, err := os.Executable(); err == nil { dir = filepath.Dir(exe) } }
    return filepath.Join(dir, "desired-state.json")
}

func (a *Agent) loadDesiredState() error {
    raw, err := os.ReadFile(a.desiredStatePath)
    if err != nil { if os.IsNotExist(err) { return nil }; return err }
    var rows []desiredPrinterRecord
    if err := json.Unmarshal(raw, &rows); err != nil { return fmt.Errorf("parse %s: %w", a.desiredStatePath, err) }
    for _, row := range rows {
        if row.Desired.ID == "" || row.Desired.DesiredRevision < 0 { continue }
        a.desiredStateMu.Lock(); a.desiredStates[row.Desired.ID] = row; a.desiredStateMu.Unlock()
        if row.Desired.Lifecycle == "active" { if err := a.applyDesiredPrinter(row); err != nil { _ = a.recordDesiredError(row.Desired.ID, err) } } else { a.removeGatewayPrinter(row.Desired.ID) }
    }
    return nil
}

func (a *Agent) persistDesiredState() error {
    a.desiredStateMu.Lock(); rows := make([]desiredPrinterRecord, 0, len(a.desiredStates)); for _, r := range a.desiredStates { rows = append(rows, r) }; a.desiredStateMu.Unlock()
    data, err := json.MarshalIndent(rows, "", "  "); if err != nil { return err }
    tmp := a.desiredStatePath + ".tmp"
    if err := os.WriteFile(tmp, data, 0600); err != nil { return err }
    if err := os.Remove(a.desiredStatePath); err != nil && !os.IsNotExist(err) { _ = os.Remove(tmp); return err }
    return os.Rename(tmp, a.desiredStatePath)
}

func (a *Agent) recordDesiredError(id string, err error) error {
    a.desiredStateMu.Lock(); row, ok := a.desiredStates[id]; if !ok { a.desiredStateMu.Unlock(); return nil }; row.ApplyError = err.Error(); a.desiredStates[id] = row; a.desiredStateMu.Unlock(); return a.persistDesiredState()
}

func (a *Agent) isPrinterExecutionAllowed(id string) bool {
    a.desiredStateMu.Lock(); row, managed := a.desiredStates[id]; a.desiredStateMu.Unlock()
    if !managed { return true }
    return row.Desired.Lifecycle == "active" && row.AppliedDesiredRevision >= row.Desired.DesiredRevision
}

func (a *Agent) desiredStateAcksPayload() []map[string]interface{} {
    a.desiredStateMu.Lock(); defer a.desiredStateMu.Unlock(); out := make([]map[string]interface{}, 0, len(a.desiredStates))
    for id, row := range a.desiredStates { out = append(out, map[string]interface{}{"printerId": id, "appliedDesiredRevision": row.AppliedDesiredRevision, "observedDesiredRevision": row.ObservedDesiredRevision}) }
    return out
}

func stringValue(m map[string]interface{}, key string) string { if v, ok := m[key].(string); ok { return strings.TrimSpace(v) }; return "" }
func numberValue(m map[string]interface{}, key string) int { switch v := m[key].(type) { case float64: return int(v); case int: return v; case json.Number: n,_ := strconv.Atoi(v.String()); return n }; return 0 }
func desiredEndpoint(c map[string]interface{}, ct string) string { if v := stringValue(c,"address"); v != "" { return v }; if v := stringValue(c,"spooler_name"); v != "" && ct == "spooler" { return v }; if ip := stringValue(c,"ip"); ip != "" { if port := numberValue(c,"port"); port > 0 { return net.JoinHostPort(ip, strconv.Itoa(port)) }; return ip }; return "" }
func desiredConfig(p desiredPrinterWire) config.PrinterConfig { enabled := p.Lifecycle == "active"; c := p.Config; return config.PrinterConfig{ID:p.ID, Name:p.Name, Type:p.ConnectionType, Endpoint:desiredEndpoint(c,p.ConnectionType), Protocol:p.Protocol, SpoolerName:stringValue(c,"spooler_name"), ConnectionType:p.ConnectionType, PrinterType:p.PrinterType, USBVID:stringValue(c,"vid"), USBPID:stringValue(c,"pid"), USBSerial:stringValue(c,"serial"), Capabilities:p.Capabilities, Enabled:&enabled} }

func (a *Agent) removeGatewayPrinter(id string) { a.printersMu.Lock(); delete(a.printers,id); delete(a.printerConfigs,id); a.gatewayOwned[id]=struct{}{}; a.printersMu.Unlock() }
func (a *Agent) applyDesiredPrinter(row desiredPrinterRecord) error { if row.Desired.Lifecycle != "active" { a.removeGatewayPrinter(row.Desired.ID); return nil }; pc := desiredConfig(row.Desired); backend, err := printer.New(pc); if err != nil { return fmt.Errorf("initialize printer %s at revision %d: %w", pc.ID, row.Desired.DesiredRevision, err) }; a.printersMu.Lock(); a.printers[pc.ID]=backend; a.printerConfigs[pc.ID]=pc; a.gatewayOwned[pc.ID]=struct{}{}; a.printersMu.Unlock(); return nil }

func (a *Agent) reconcileGatewayDesiredState(rows []desiredPrinterWire) []desiredPrinterRecord {
    incoming := make(map[string]struct{}, len(rows))
    for _, desired := range rows {
        if desired.ID == "" || desired.DesiredRevision < 0 { continue }
        incoming[desired.ID]=struct{}{}
        a.desiredStateMu.Lock(); current, exists := a.desiredStates[desired.ID]; if exists && desired.DesiredRevision < current.Desired.DesiredRevision { a.desiredStateMu.Unlock(); continue }; row := current; row.Desired=desired; row.ApplyError=""; a.desiredStates[desired.ID]=row; a.desiredStateMu.Unlock()
        if exists && desired.DesiredRevision == current.Desired.DesiredRevision && current.Desired.Lifecycle == desired.Lifecycle { continue }
        if err := a.applyDesiredPrinter(row); err != nil { _ = a.recordDesiredError(desired.ID, err); continue }
        a.desiredStateMu.Lock(); row=a.desiredStates[desired.ID]; row.AppliedDesiredRevision=desired.DesiredRevision; row.ObservedDesiredRevision=desired.DesiredRevision; row.ApplyError=""; a.desiredStates[desired.ID]=row; a.desiredStateMu.Unlock()
    }
    a.desiredStateMu.Lock()
    missing := make([]string,0)
    for id := range a.desiredStates { if _, ok := incoming[id]; !ok { missing=append(missing,id); delete(a.desiredStates,id) } }
    a.desiredStateMu.Unlock()
    for _, id := range missing { a.printersMu.Lock(); delete(a.printers,id); delete(a.printerConfigs,id); delete(a.gatewayOwned,id); a.printersMu.Unlock() }
    _ = a.persistDesiredState()
    a.desiredStateMu.Lock(); out := make([]desiredPrinterRecord,0,len(a.desiredStates)); for _, r := range a.desiredStates { out=append(out,r) }; a.desiredStateMu.Unlock(); return out
}
'''
put('agent/internal/agent/desired_state.go', desired)

# Desktop IPC exposes the Gateway-owned printer model.
p = Path('src/desktop/lib/ipc.ts'); s = text(p)
s = once(s, '  capabilities?: Record<string, unknown> | null;\n', '''  capabilities?: Record<string, unknown> | null;
  lifecycle?: "active" | "disabled" | "retired";
  managementSource?: "agent" | "manager";
  desiredRevision?: number;
  appliedDesiredRevision?: number;
  observedDesiredRevision?: number;
  agentId?: string;
''', 'desktop printer fields')
insert = r'''
export async function fetchGatewayPrinters(gatewayUrl: string): Promise<PrinterInfo[]> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const browserToken = getBrowserManagerToken();
  const headers: Record<string, string> = {};
  if (browserToken) headers.Authorization = `Bearer ${browserToken}`;
  const { status, body } = await gatewayRequest(base, "/api/printers", "GET", headers);
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) throw new Error(body || `printers fetch failed (${status})`);
  const rows = JSON.parse(body) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const cfg = (row.config && typeof row.config === "object" ? row.config : {}) as Record<string, unknown>;
    const lifecycle = String(row.lifecycle ?? "active") as PrinterInfo["lifecycle"];
    const ip = typeof cfg.ip === "string" ? cfg.ip : "";
    const port = typeof cfg.port === "number" ? cfg.port : null;
    const endpoint = typeof cfg.address === "string" ? cfg.address : (ip ? `${ip}${port ? `:${port}` : ""}` : undefined);
    return { ...row, enabled: lifecycle === "active", endpoint, port, networkAddress: ip || undefined } as PrinterInfo;
  });
}

export async function updateGatewayPrinter(gatewayUrl: string, printerId: string, patch: Record<string, unknown>): Promise<PrinterInfo> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const browserToken = getBrowserManagerToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (browserToken) headers.Authorization = `Bearer ${browserToken}`;
  const { status, body } = await gatewayRequest(base, `/api/printers/${encodeURIComponent(printerId)}`, "PATCH", headers, JSON.stringify(patch));
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) throw new Error(body || `printer update failed (${status})`);
  return JSON.parse(body) as PrinterInfo;
}

'''
s = s.replace('\nexport interface DiscoverResult {', '\n' + insert + 'export interface DiscoverResult {', 1)
# Add a manager API registration helper instead of the old local-only registration path.
s = s.replace('export function registerPrinter(req: RegisterPrinterRequest): Promise<string> {\n  return invoke<string>("register_printer", { request: req });\n}', '''export async function registerGatewayPrinter(gatewayUrl: string, req: RegisterPrinterRequest & { agentId: string }): Promise<PrinterInfo> {
  const base = normalizeGatewayUrl(gatewayUrl);
  const browserToken = getBrowserManagerToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (browserToken) headers.Authorization = `Bearer ${browserToken}`;
  const config: Record<string, unknown> = {};
  if (req.endpoint) config.address = req.endpoint;
  if (req.spoolerName) config.spooler_name = req.spoolerName;
  if (req.connectionType === "network" && req.endpoint?.includes(":")) { const i = req.endpoint.lastIndexOf(":"); config.ip = req.endpoint.slice(0,i); config.port = Number(req.endpoint.slice(i+1)); delete config.address; }
  if (req.usbVid) config.vid = req.usbVid;
  if (req.usbPid) config.pid = req.usbPid;
  if (req.usbSerial) config.serial = req.usbSerial;
  const { status, body } = await gatewayRequest(base, "/api/printers", "POST", headers, JSON.stringify({ name:req.name, agentId:req.agentId, connectionType:req.connectionType, protocol:req.protocol ?? "unknown", printerType:req.printerType ?? "physical", config }));
  if (status === 401 || status === 403) await clearManagerSession();
  if (status < 200 || status >= 300) throw new Error(body || `printer registration failed (${status})`);
  return JSON.parse(body) as PrinterInfo;
}''')
put(p, s)

p = Path('src/desktop/types.ts'); s = text(p).replace('lastHeartbeat: string | null;', 'lastStatusCheck: string | null;')
s = s.replace('  handleTest: (id: string) => void;\n', '  handleTest: (id: string) => void;\n  updatePrinterLifecycle: (id: string, lifecycle: "active" | "disabled" | "retired") => void;\n')
put(p,s)

p = Path('src/desktop/main.tsx'); s = text(p)
s = s.replace('  fetchGatewayHealth,\n', '  fetchGatewayHealth,\n  fetchGatewayPrinters,\n  updateGatewayPrinter,\n')
s = s.replace('  getPrinters,\n', '')
s = s.replace('lastHeartbeat','lastStatusCheck')
s = once(s, '      const list = await getPrinters();\n      setPrinters(list.filter(isProductionPrinter));\n', '      if (!gatewayUrl) throw new Error("Gateway URL not configured");\n      const list = await fetchGatewayPrinters(gatewayUrl);\n      setPrinters(list.filter(isProductionPrinter));\n', 'desktop printer refresh source')
# Discovery now refreshes the Gateway view after the local discovery request.
s = s.replace('      setPrinters(list);\n      setMsg({ text: `Discovery found ${list.length} printers`, type: "success" });', '      setMsg({ text: `Discovery found ${list.length} printers locally`, type: "success" });\n      await refreshPrinters();', 1)
# Lifecycle callback.
marker = '  const handleTest = useCallback(\n'
start = s.find(marker); end = s.find('\n\n  const saveGateway', start)
if start < 0 or end < 0: raise SystemExit('desktop lifecycle insertion anchor missing')
life = '''
  const updatePrinterLifecycle = useCallback(async (id: string, lifecycle: "active" | "disabled" | "retired") => {
    try {
      setBusyBoth(true);
      await updateGatewayPrinter(gatewayUrl, id, { lifecycle });
      await refreshPrinters();
      setMsg({ text: lifecycle === "disabled" ? "Printer disabled" : lifecycle === "retired" ? "Printer retired" : "Printer enabled", type: "success" });
    } catch (e) {
      setMsg({ text: friendlyPrinterError(errMsg(e)), type: "error" });
    } finally { setBusyBoth(false); }
  }, [gatewayUrl, refreshPrinters, setBusyBoth]);
'''
s = s[:end] + life + s[end:]
s = s.replace('    lastStatusCheck,\n', '    lastStatusCheck,\n    updatePrinterLifecycle,\n')
s = s.replace('        lastStatusCheck={lastStatusCheck}\n', '        lastStatusCheck={lastStatusCheck}\n')
# Add gatewayUrl to AddPrinterDialog.
s = s.replace('        printers={printers}\n      />', '        printers={printers}\n        gatewayUrl={gatewayUrl}\n      />', 1)
put(p,s)

# Add dialog writes to Gateway and lets the manager select an agent.
p = Path('src/desktop/components/AddPrinterDialog.tsx'); s = text(p)
s = s.replace('import { registerPrinter, type PrinterInfo, type RegisterPrinterRequest } from "../lib/ipc";', 'import { fetchGatewayAgents, registerGatewayPrinter, type PrinterInfo, type RegisterPrinterRequest } from "../lib/ipc";')
s = once(s, '  printers,\n}: {\n', '  printers,\n  gatewayUrl,\n}: {\n', 'dialog gateway prop')
s = s.replace('  printers: PrinterInfo[];\n}) {', '  printers: PrinterInfo[];\n  gatewayUrl: string;\n}) {')
s = s.replace('  const [busy, setBusy] = useState(false);\n', '  const [busy, setBusy] = useState(false);\n  const [agents, setAgents] = useState<Array<{ id: string; name: string; status?: string; lifecycle?: string }>>([]);\n  const [agentId, setAgentId] = useState("");\n')
s = s.replace('  // Clear any previous error when dialog transitions to open\n', '  React.useEffect(() => { if (open && gatewayUrl) fetchGatewayAgents(gatewayUrl).then(setAgents).catch(() => setAgents([])); }, [open, gatewayUrl]);\n\n  // Clear any previous error when dialog transitions to open\n')
s = s.replace('      const req: RegisterPrinterRequest = { name: name.trim(), connectionType: conn };', '      if (!gatewayUrl) throw new Error("Gateway URL is not configured");\n      if (!agentId) throw new Error("Select an agent");\n      const req: RegisterPrinterRequest = { name: name.trim(), connectionType: conn };')
s = s.replace('      await registerPrinter(req);', '      await registerGatewayPrinter(gatewayUrl, { ...req, agentId });')
# Add agent picker before connection fields.
s = s.replace('      <div className="space-y-5">\n        <Field label="Printer name"', '''      <div className="space-y-5">
        <Field label="Gateway agent" htmlFor="pp-agent">
          <Select id="pp-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Select an active agent…</option>
            {agents.filter((a) => a.lifecycle === "active").map((a) => <option key={a.id} value={a.id}>{a.name} ({a.status ?? "unknown"})</option>)}
          </Select>
        </Field>
        <Field label="Printer name"''', 1)
put(p,s)

# Extend IPC with agent/printer helpers used by Add dialog.
p = Path('src/desktop/lib/ipc.ts'); s = text(p)
agent_helper = '''\nexport async function fetchGatewayAgents(gatewayUrl: string): Promise<Array<{ id: string; name: string; status?: string; lifecycle?: string }>> {\n  const base = normalizeGatewayUrl(gatewayUrl);\n  const browserToken = getBrowserManagerToken();\n  const headers: Record<string, string> = {};\n  if (browserToken) headers.Authorization = `Bearer ${browserToken}`;\n  const { status, body } = await gatewayRequest(base, "/api/agents", "GET", headers);\n  if (status === 401 || status === 403) await clearManagerSession();\n  if (status < 200 || status >= 300) throw new Error(body || `agents fetch failed (${status})`);\n  return JSON.parse(body) as Array<{ id: string; name: string; status?: string; lifecycle?: string }>;\n}\n\n'''
s = s.replace('\nexport async function fetchGatewayPrinters', agent_helper + 'export async function fetchGatewayPrinters', 1)
put(p,s)

# Printer page: expose observed vs desired and lifecycle controls.
p = Path('src/desktop/pages/Printers.tsx'); s = text(p)
s = s.replace('import { Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, Play } from "lucide-react";', 'import { Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, Play, Power, Archive } from "lucide-react";')
s = s.replace('                  <th className="px-4 py-3">Status</th>\n', '                  <th className="px-4 py-3">Connectivity</th>\n                  <th className="px-4 py-3">Lifecycle</th>\n                  <th className="px-4 py-3">Applied / desired</th>\n')
s = s.replace('''                      <StatusBadge
                        tone={printerTone(p.status)}
                        label={labelPrinter(p.status)}
                      />
                    </td>
                    <td className="px-6 py-4">''', '''                      <div className="space-y-1"><StatusBadge tone={printerTone(p.status)} label={labelPrinter(p.status)} /><div className="text-[11px] text-ink-4">{p.managementSource === "manager" ? "Gateway" : "Agent"}</div></div>
                    </td>
                    <td className="px-4 py-4 text-[13px] text-ink-2">{p.lifecycle ?? "active"}</td>
                    <td className="px-4 py-4 text-[13px] text-ink-2">{p.appliedDesiredRevision ?? 0} / {p.desiredRevision ?? 0}</td>
                    <td className="px-6 py-4">''', 1)
old = '''                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => s.setSelectedPrinter(p)}
                          icon={<Eye className="h-4 w-4" />}
                        >
                          Details
                        </Button>'''
new = '''                        {p.managementSource === "manager" && (p.lifecycle ?? "active") === "active" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "disabled")} icon={<Power className="h-4 w-4" />}>Disable</Button>}
                        {p.managementSource === "manager" && (p.lifecycle ?? "active") === "disabled" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "active")} icon={<Power className="h-4 w-4" />}>Enable</Button>}
                        {p.managementSource === "manager" && (p.lifecycle ?? "active") !== "retired" && <Button size="sm" variant="ghost" onClick={() => s.updatePrinterLifecycle(p.id, "retired")} icon={<Archive className="h-4 w-4" />}>Retire</Button>}
                        <Button size="sm" variant="ghost" onClick={() => s.setSelectedPrinter(p)} icon={<Eye className="h-4 w-4" />}>Details</Button>'''
s = once(s, old, new, 'printer lifecycle actions')
put(p,s)

# Remove this temporary repair machinery once its commit is ready.
Path('.github/workflows/_apply-final-repair.yml').unlink(missing_ok=True)
Path('.github/repair-final.py').unlink()
PY

gofmt -w agent/internal/agent/agent.go agent/internal/agent/desired_state.go
git diff --check
npm run typecheck
cd agent && go test ./... && go vet ./...
cd ..
git status --short

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
git commit -m "chore(repair): finalize desired-state reconciliation"
git push origin HEAD:production-repair/main-concurrency-hardening
