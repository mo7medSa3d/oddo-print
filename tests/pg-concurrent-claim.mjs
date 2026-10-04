// Real PG concurrency verification harness — requires DATABASE_URL and seeded jobs.
// Run: DATABASE_URL=... node tests/pg-concurrent-claim.mjs
// SQL-lock probe, not an HTTP/production admission test. Use a test database.
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(2);
}
const pool = new Pool({ connectionString: url });
const fixtureSuffix = randomUUID().replaceAll("-", "");
const AGENT_ID = `agt_cc_${fixtureSuffix}`;
const PRINTER_ID = `printer_cc_${fixtureSuffix}`;
const tenantId = `tenant_cc_${fixtureSuffix}`;
const jobPrefix = `job_cc_${fixtureSuffix}_`;

async function ensureFixture() {
  // Tenant contract (migrations 0028-0031): runtime rows are tenant-owned.
  await pool.query(`INSERT INTO tenants (id, name) VALUES ($1, 'concurrent-claim tenant')`, [tenantId]);
  // ensure agent and printer exist for FK
  await pool.query(`INSERT INTO agents (id, tenant_id, name, status, lifecycle) VALUES ($1, $2, 'concurrent-test', 'online', 'active')`, [AGENT_ID, tenantId]);
  await pool.query(`INSERT INTO printers (id, tenant_id, agent_id, name, printer_type, device_class, connection_type, protocol, status, lifecycle, config) VALUES ($1, $2, $3, 'concurrent', 'physical', 'other', 'network', 'raw', 'online', 'active', '{"ip":"127.0.0.1","port":9100}'::jsonb)`, [PRINTER_ID, tenantId, AGENT_ID]);
  for (let i = 0; i < 20; i++) {
    await pool.query(
      `INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, status, payload, expires_at) VALUES ($1,$2,$3,$4,'queued','{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb, now()+interval '1 hour')`,
      [`${jobPrefix}${String(i).padStart(2,"0")}`, tenantId, AGENT_ID, PRINTER_ID]
    );
  }
  await pool.query(`INSERT INTO print_jobs (id,tenant_id,agent_id,printer_id,status,payload,expires_at,updated_at,delivered_at,error)
      VALUES ($1,$2,$3,$4,'printing','{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb,now()+interval '1 hour',now()-interval '5 minutes',NULL,NULL),
             ($5,$2,$3,$4,'claimed','{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb,now()+interval '1 hour',now()-interval '5 minutes',now(),NULL),
             ($6,$2,$3,$4,'claimed','{"type":"raw","protocol":"raw","encoding":"base64","data":"aGVsbG8="}'::jsonb,now()+interval '1 hour',now()-interval '5 minutes',NULL,'DELIVERY_EVIDENCE_PENDING')`,
      [jobPrefix+'printing',tenantId,AGENT_ID,PRINTER_ID,jobPrefix+'delivered',jobPrefix+'evidence']);
  console.log("Seeded 20 queued jobs and three nonreclaimable execution/evidence records");
}

async function claim() {
  // Simplified SKIP LOCKED claim probe. The authoritative claim transaction is
  // `claimJobForDelivery` (src/lib/job-delivery.ts) / `src/app/api/agent/jobs/route.ts`;
  // `tests/job-status-postgres-concurrency.test.ts` is the maintained concurrency proof.
  const res = await pool.query(`
    WITH claimable AS (
      SELECT id FROM print_jobs
      WHERE agent_id = $1
        AND expires_at > now()
        AND (status = 'queued' OR (status = 'claimed' AND delivered_at IS NULL AND acked_at IS NULL AND COALESCE(error, '') <> 'DELIVERY_EVIDENCE_PENDING' AND updated_at < now() - interval '90 seconds' AND retries < 5))
      ORDER BY created_at ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE print_jobs SET status='claimed', claimed_at=now(), updated_at=now(),
      retries = CASE WHEN print_jobs.status = 'claimed' THEN retries+1 ELSE retries END
    FROM claimable WHERE print_jobs.id=claimable.id
    RETURNING print_jobs.id
  `, [AGENT_ID]);
  return res.rows.map(r => r.id);
}

async function main() {
  await ensureFixture();
  // fire 3 concurrent claims
  const [a,b,c] = await Promise.all([claim(), claim(), claim()]);
  const all = [...a, ...b, ...c];
  const uniq = new Set(all);
  console.log(`Claim results: A=${a.length} B=${b.length} C=${c.length} total=${all.length} uniq=${uniq.size}`);
  if (all.length !== uniq.size) {
    const dups = all.filter((x,i) => all.indexOf(x) !== i);
    console.error("FAILED: duplicate ids across concurrent claims:", dups);
    throw new Error("SQL claim safety assertion failed");
  }
  if (uniq.size !== 20) {
    console.error(`FAILED: expected 20 uniq claimed, got ${uniq.size}. All:`, all);
    throw new Error("SQL claim safety assertion failed");
  }
  // second round should claim 0
  const second = await claim();
  if (second.length !== 0) {
    console.error("FAILED: second round should claim 0, got", second);
    throw new Error("SQL claim safety assertion failed");
  }
  console.log("VERIFIED SQL lock probe: no duplicate queued claims; production route evidence requires the integration suite.");
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  try {
    await pool.query('DELETE FROM print_jobs WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM printers WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM agents WHERE tenant_id=$1', [tenantId]);
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
  } catch (error) { console.error("Fixture cleanup failed", error); process.exitCode = 1; }
  finally { await pool.end(); }
});
