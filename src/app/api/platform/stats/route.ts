import { NextResponse } from "next/server";
import { requirePlatformOwner, PlatformUnauthorizedError } from "../../../../lib/platform-auth";
import { db } from "../../../../db";
import { queryWithTimeout } from "../../../../db/client";
import { tenants, tenantSubscriptions, users, agents, printers, printJobs } from "../../../../db/schema";
import { sql, eq } from "drizzle-orm";
import { agentStaleThresholdSeconds } from "../../../../lib/agent-availability";

export async function GET(req: Request) {
  try {
    await requirePlatformOwner(req);
  } catch (error) {
    if (error instanceof PlatformUnauthorizedError) {
      return NextResponse.json({ error: "Platform Owner authentication required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Platform authentication temporarily unavailable" }, { status: 503 });
  }

  const [
    tenantStats,
    subscriptionStats,
    userStats,
    agentStats,
    printerStats,
    jobStats24h,
  ] = await queryWithTimeout(
    Promise.all([
      db.select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${tenants.lifecycle} = 'active')::int`,
        suspended: sql<number>`count(*) filter (where ${tenants.lifecycle} = 'suspended')::int`,
        deleted: sql<number>`count(*) filter (where ${tenants.lifecycle} = 'deleted')::int`,
      }).from(tenants),

      db.select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${tenantSubscriptions.status} = 'active')::int`,
        trialing: sql<number>`count(*) filter (where ${tenantSubscriptions.status} = 'trialing')::int`,
        pastDue: sql<number>`count(*) filter (where ${tenantSubscriptions.status} = 'past_due')::int`,
        cancelled: sql<number>`count(*) filter (where ${tenantSubscriptions.status} = 'cancelled')::int`,
      }).from(tenantSubscriptions),

      db.select({
        total: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) filter (where ${users.emailVerifiedAt} is not null)::int`,
      }).from(users),

      db.select({
        total: sql<number>`count(*)::int`,
        online: sql<number>`count(*) filter (
          where ${agents.lifecycle} = 'active'
            and ${agents.status} = 'online'
            and ${agents.lastSeenAt} is not null
            and ${agents.lastSeenAt} > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        )::int`,
        offline: sql<number>`count(*) filter (
          where not (
            ${agents.lifecycle} = 'active'
            and ${agents.status} = 'online'
            and ${agents.lastSeenAt} is not null
            and ${agents.lastSeenAt} > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          )
        )::int`,
      }).from(agents),

      db.select({
        total: sql<number>`count(*)::int`,
        online: sql<number>`count(*) filter (
          where ${printers.lifecycle} = 'active'
            and ${printers.status} = 'online'
            and ${agents.lifecycle} = 'active'
            and ${agents.status} = 'online'
            and ${agents.lastSeenAt} is not null
            and ${agents.lastSeenAt} > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
        )::int`,
        offline: sql<number>`count(*) filter (
          where not (
            ${printers.lifecycle} = 'active'
            and ${printers.status} = 'online'
            and ${agents.lifecycle} = 'active'
            and ${agents.status} = 'online'
            and ${agents.lastSeenAt} is not null
            and ${agents.lastSeenAt} > now() - make_interval(secs => ${agentStaleThresholdSeconds()})
          )
        )::int`,
      })
        .from(printers)
        .leftJoin(agents, eq(printers.agentId, agents.id)),

      db.select({
        total: sql<number>`count(*)::int`,
        success: sql<number>`count(*) filter (where ${printJobs.status} = 'success')::int`,
        failed: sql<number>`count(*) filter (where ${printJobs.status} = 'failed')::int`,
        queued: sql<number>`count(*) filter (where ${printJobs.status} = 'queued')::int`,
        inFlight: sql<number>`count(*) filter (where ${printJobs.status} in ('claimed','printing'))::int`,
        expired: sql<number>`count(*) filter (where ${printJobs.status} = 'expired')::int`,
      }).from(printJobs).where(
        sql`${printJobs.createdAt} >= clock_timestamp() - interval '24 hours'`,
      ),
    ]),
    8_000,
    "platformStatsAggregate",
  );

  return NextResponse.json({
    tenants: tenantStats[0] ?? { total: 0, active: 0, suspended: 0, deleted: 0 },
    subscriptions: subscriptionStats[0] ?? { total: 0, active: 0, trialing: 0, pastDue: 0, cancelled: 0 },
    users: userStats[0] ?? { total: 0, verified: 0 },
    agents: agentStats[0] ?? { total: 0, online: 0, offline: 0 },
    printers: printerStats[0] ?? { total: 0, online: 0, offline: 0 },
    jobs24h: jobStats24h[0] ?? { total: 0, success: 0, failed: 0, queued: 0, inFlight: 0, expired: 0 },
  });
}
