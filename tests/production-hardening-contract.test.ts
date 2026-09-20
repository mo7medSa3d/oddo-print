    expect(schema).toContain("print_jobs_tenant_idempotency_unique");
    expect(schema).toContain("tenant_users_single_owner_idx");

    const printService = read("src/lib/print-job-service.ts");
    expect(printService).toContain("print_jobs:idempotency:");
    expect(printService).toContain("WHERE tenant_id = ${tenantId}");
    expect(printService).toContain("idempotency_key = ${effectiveIdempotencyKey}");
    expect(printService).toContain("status IN ('queued', 'claimed', 'printing')");
    expect(printService).toContain("gw-reprint:${reprintOfJobId}:%");

    const printRoute = read("src/app/api/print/jobs/route.ts");
    expect(printRoute).not.toContain("eq(printJobs.apiKeyId, odoo.id), eq(printJobs.idempotencyKey");
    expect(printRoute).toContain("eq(printJobs.tenantId, odoo.tenantId), eq(printJobs.idempotencyKey");
    expect(printRoute).not.toContain("eq(printJobs.id, id), eq(printJobs.tenantId, odoo.tenantId), eq(printJobs.apiKeyId, odoo.id)");