import { describe, expect, it } from "vitest";
import { hasTestDatabase, applyMigrations, seedFixture, pool, closePool, type Fixture } from "./helpers/pg";

/**
 * CI tripwire: PostgreSQL-backed suites are gated on DATABASE_URL presence.
 * A missing or typo'd DATABASE_URL used to produce a fully green CI run in
 * which EVERY database test was silently skipped. This file is NOT gated:
 * it fails loudly when the CI environment lost its database, and asserts
 * the runtime contract artifacts exist after migrations.
 */
describe("CI PostgreSQL tripwire", () => {
  it("refuses to run without a real PostgreSQL database", () => {
    expect(
      hasTestDatabase,
      "DATABASE_URL is not set - the CI run has NO database coverage. Every DB suite would be silently skipped."
    ).toBe(true);
  });

  it("migration applied the runtime contract artifacts", async () => {
    await applyMigrations();
    const f: Fixture = await seedFixture();
    const client = await pool().connect();
    try {
      const artifacts = await client.query(`
        SELECT
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='print_jobs' AND column_name='claim_token') AS claim_token,
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='agents' AND column_name='lifecycle_revision') AS lifecycle_revision,
          (SELECT count(*) FROM pg_constraint c
            JOIN pg_class t ON t.oid=c.conrelid
            JOIN pg_namespace n ON n.oid=t.relnamespace
            WHERE c.conname='print_jobs_payload_contract_check' AND n.nspname=current_schema()) AS payload_check,
          (SELECT count(*) FROM pg_indexes
            WHERE schemaname=current_schema() AND tablename='print_jobs' AND indexname='print_jobs_tenant_idempotency_unique') AS tenant_idem,
          (SELECT count(*) FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='discovered_devices' AND column_name='identity_key') AS discovered_identity_key,
          (SELECT count(*) FROM pg_indexes
            WHERE schemaname=current_schema() AND tablename='discovered_devices' AND indexname='discovered_devices_tenant_agent_identity_unique') AS discovered_identity_unique
      `);
      // pg returns COUNT(*) as string; normalize before comparing.
      const counts = Object.fromEntries(
        Object.entries(artifacts.rows[0] as Record<string, unknown>).map(([k, v]) => [k, Number(v)])
      );
      expect(counts).toMatchObject({
        claim_token: 1,
        lifecycle_revision: 1,
        payload_check: 1,
        tenant_idem: 1,
        discovered_identity_key: 1,
        discovered_identity_unique: 1,
      });
      // DB-enforced payload protocol contract: a raw payload without an
      // explicit protocol must be rejected by PostgreSQL itself. tenant_id
      // is included so the rejection provably comes from the contract
      // CHECK (23514), not from a NOT NULL violation (23502).
      await expect(
        client.query(
          `INSERT INTO print_jobs (id, tenant_id, agent_id, printer_id, status, payload, expires_at)
           VALUES ('tripwire_bad_payload', $1, $2, $3, 'queued',
                   '{"type":"raw","encoding":"base64","data":"aA=="}'::jsonb, now() + interval '1 hour')`,
          [f.tenantId, f.agentId, f.printerId]
        )
      ).rejects.toThrow(/contract|check/i);
    } finally {
      client.release();
      await closePool();
    }
  });
});
