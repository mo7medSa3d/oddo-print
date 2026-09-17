import { pgTable, text, timestamp, jsonb, integer, bigint, boolean, index, uniqueIndex, check, foreignKey, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lifecycle: text("lifecycle").notNull().default("active"),
  suspendedAt: timestamp("suspended_at"),
  deletedAt: timestamp("deleted_at"),
  lifecycleReason: text("lifecycle_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  lifecycleIdx: index("tenants_lifecycle_idx").on(table.lifecycle),
  lifecycleCheck: check("tenants_lifecycle_check", sql`${table.lifecycle} in ('active','suspended','deleted')`),
}));

export const tenantDomains = pgTable("tenant_domains", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  domain: text("domain").notNull().unique(),
  verifiedAt: timestamp("verified_at"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("tenant_domains_tenant_idx").on(table.tenantId),
  verifiedIdx: index("tenant_domains_verified_idx").on(table.verifiedAt),
}));

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at"),
  isPlatformOwner: boolean("is_platform_owner").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  singlePlatformOwnerIdx: uniqueIndex("users_single_platform_owner_idx").on(table.isPlatformOwner).where(sql`${table.isPlatformOwner} = true`),
}));

export const platformSessions = pgTable("platform_sessions", {
  jti: text("jti").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  expiresIdx: index("platform_sessions_expires_idx").on(table.expiresAt),
  userIdx: index("platform_sessions_user_idx").on(table.userId),
}));

export const tenantUsers = pgTable("tenant_users", {
  userId: text("user_id").references(() => users.id).notNull(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  role: text("role").notNull().default("viewer"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  pk: uniqueIndex("tenant_users_pk").on(table.userId, table.tenantId),
  tenantIdx: index("tenant_users_tenant_idx").on(table.tenantId),
  roleCheck: check("tenant_users_role_check", sql`${table.role} in ('owner','admin','operator','viewer','integration_admin','billing_admin')`),
}));

export const applications = pgTable("applications", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  type: text("type").notNull().default("odoo"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  pairingCodeHash: text("pairing_code_hash"),
  pairingCodeExpiresAt: timestamp("pairing_code_expires_at"),
  secret: text("secret"),
  status: text("status").notNull().default("offline"),
  lifecycle: text("lifecycle").notNull().default("active"),
  metadata: jsonb("metadata").$type<{ hostname?: string; os?: string; osVersion?: string; version?: string; }>(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdUnique: unique("agents_tenant_id_unique").on(table.tenantId, table.id),
  lastSeenIdx: index("agents_last_seen_idx").on(table.lastSeenAt),
  // 0032: only one agent may hold a pending (non-consumed) pairing code at
  // a time. Register looks codes up globally (no tenant is provable before
  // authentication), so the database enforces collision-freedom; consumed
  // (NULLed) rows are excluded by the partial predicate.
  pairingCodeHashPendingUnique: uniqueIndex("agents_pairing_code_hash_pending_unique").on(table.pairingCodeHash).where(sql`pairing_code_hash IS NOT NULL`),
  lifecycleCheck: check("agents_lifecycle_check", sql`${table.lifecycle} in ('active','disabled','retired')`),
  statusCheck: check("agents_status_check", sql`${table.status} in ('online','offline')`),
}));

export const printers = pgTable("printers", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  agentId: text("agent_id").notNull(),
  name: text("name").notNull(),
  printerType: text("printer_type").notNull().default("physical"),
  deviceClass: text("device_class").notNull().default("unknown"),
  connectionType: text("connection_type").notNull().default("network"),
  protocol: text("protocol").notNull().default("unknown"),
  status: text("status").notNull().default("unknown"),
  lifecycle: text("lifecycle").notNull().default("active"),
  managementSource: text("management_source").notNull().default("agent"),
  desiredRevision: bigint("desired_revision", { mode: "number" }).notNull().default(0),
  appliedDesiredRevision: bigint("applied_desired_revision", { mode: "number" }).notNull().default(0),
  observedDesiredRevision: bigint("observed_desired_revision", { mode: "number" }).notNull().default(0),
  observedDeviceClass: text("observed_device_class"),
  config: jsonb("config").$type<{ ip?: string; port?: number; vid?: number; pid?: number; serial?: string; address?: string; spooler_name?: string; paper_widths?: number[]; color_capable?: boolean; duplex_capable?: boolean; }>(),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>(),
  lastSeenAt: timestamp("last_seen_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdUnique: unique("printers_tenant_id_unique").on(table.tenantId, table.id),
  agentFk: foreignKey({ columns: [table.tenantId, table.agentId], foreignColumns: [agents.tenantId, agents.id] }),
  agentIdx: index("printers_agent_id_idx").on(table.agentId),
  printerTypeIdx: index("printers_printer_type_idx").on(table.printerType),
  statusIdx: index("printers_status_idx").on(table.status),
  managementSourceCheck: check("printers_management_source_check", sql`${table.managementSource} in ('agent','manager')`),
  desiredRevisionCheck: check("printers_desired_revision_check", sql`${table.desiredRevision} >= 0 AND ${table.appliedDesiredRevision} >= 0 AND ${table.observedDesiredRevision} >= 0 AND ${table.appliedDesiredRevision} <= ${table.desiredRevision} AND ${table.observedDesiredRevision} <= ${table.appliedDesiredRevision}`),
  observedDeviceClassCheck: check("printers_observed_device_class_check", sql`${table.observedDeviceClass} IS NULL OR ${table.observedDeviceClass} in ('thermal','laser','inkjet','label','other','unknown')`),
  desiredAgentIdx: index("printers_agent_lifecycle_desired_idx").on(table.tenantId, table.agentId, table.lifecycle, table.managementSource),
  lifecycleCheck: check("printers_lifecycle_check", sql`${table.lifecycle} in ('active','disabled','retired')`),
  printerTypeCheck: check("printers_type_check", sql`${table.printerType} in ('physical','virtual','redirected')`),
  deviceClassCheck: check("printers_device_class_check", sql`${table.deviceClass} in ('thermal','laser','inkjet','label','other','unknown')`),
  connectionTypeCheck: check("printers_connection_type_check", sql`${table.connectionType} in ('network','usb','spooler','ipp','ipps')`),
  protocolCheck: check("printers_protocol_check", sql`${table.protocol} in ('raw','escpos','zpl','tspl','ipp','ipps','spooler','windows_spooler','unknown')`),
  statusCheck: check("printers_status_check", sql`${table.status} in ('online','offline','busy','error','unknown')`),
}));

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  scope: text("scope").notNull().default("standard"),
  name: text("name").notNull(),
  description: text("description"),
  hashedKey: text("hashed_key").notNull().unique(),
  allowedDocumentTypes: jsonb("allowed_document_types").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  tenantIdUnique: unique("api_keys_tenant_id_unique").on(table.tenantId, table.id),
}));

export const managerSessions = pgTable("manager_sessions", {
  jti: text("jti").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  userId: text("user_id").references(() => users.id),
  role: text("role").notNull().default("owner"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  expiresIdx: index("manager_sessions_expires_idx").on(table.expiresAt),
  tenantIdx: index("manager_sessions_tenant_idx").on(table.tenantId),
  userIdx: index("manager_sessions_user_idx").on(table.userId),
  roleCheck: check("manager_sessions_role_check", sql`${table.role} in ('owner','admin','operator','viewer','integration_admin','billing_admin')`),
}));

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("email_verification_tokens_user_idx").on(table.userId),
  expiresIdx: index("email_verification_tokens_expires_idx").on(table.expiresAt),
}));

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("password_reset_tokens_user_idx").on(table.userId),
  expiresIdx: index("password_reset_tokens_expires_idx").on(table.expiresAt),
}));

export const tenantInvitations = pgTable("tenant_invitations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  inviterUserId: text("inviter_user_id").references(() => users.id).notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("tenant_invitations_tenant_idx").on(table.tenantId),
  emailIdx: index("tenant_invitations_email_idx").on(table.email),
  expiresIdx: index("tenant_invitations_expires_idx").on(table.expiresAt),
  roleCheck: check("tenant_invitations_role_check", sql`${table.role} in ('admin','operator','viewer','integration_admin','billing_admin')`),
}));

export const billingEvents = pgTable("billing_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  tenantId: text("tenant_id").references(() => tenants.id),
  payload: jsonb("payload").default({}).notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
}, (table) => ({
  tenantIdx: index("billing_events_tenant_idx").on(table.tenantId, table.receivedAt),
  typeIdx: index("billing_events_type_idx").on(table.eventType),
}));

export const authRateLimits = pgTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at").defaultNow().notNull(),
  lockedUntil: timestamp("locked_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  lockedUntilIdx: index("auth_rate_limits_locked_until_idx").on(table.lockedUntil),
  updatedAtIdx: index("auth_rate_limits_updated_at_idx").on(table.updatedAt),
}));

export const discoverySessions = pgTable("discovery_sessions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  agentId: text("agent_id").notNull(),
  status: text("status").notNull().default("running"),
  config: jsonb("config").$type<{ cidr?: string; protocols?: string[]; timeoutMs?: number; concurrency?: number; }>().default({}).notNull(),
  stats: jsonb("stats").$type<{ candidates?: number; verified?: number; errors?: number; durationMs?: number; }>().default({}).notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdUnique: unique("discovery_sessions_tenant_id_unique").on(table.tenantId, table.id),
  agentFk: foreignKey({ columns: [table.tenantId, table.agentId], foreignColumns: [agents.tenantId, agents.id] }),
  agentIdIdx: index("discovery_sessions_agent_id_idx").on(table.agentId),
  statusIdx: index("discovery_sessions_status_idx").on(table.status),
}));

export const discoveredDevices = pgTable("discovered_devices", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  discoveryId: text("discovery_id").notNull(),
  agentId: text("agent_id").notNull(),
  source: text("source").array().notNull().default(sql`ARRAY[]::text[]`),
  protocol: text("protocol").notNull().default("unknown"),
  ipAddress: text("ip_address"),
  hostname: text("hostname"),
  port: integer("port"),
  macAddress: text("mac_address"),
  deviceName: text("device_name"),
  manufacturer: text("manufacturer"),
  model: text("model"),
  serialNumber: text("serial_number"),
  firmwareVersion: text("firmware_version"),
  printerState: text("printer_state"),
  uri: text("uri"),
  transport: text("transport"),
  confidence: text("confidence").notNull().default("low"),
  verification: text("verification").notNull().default("candidate"),
  deviceClass: text("device_class").notNull().default("unknown"),
  capabilities: jsonb("capabilities").$type<Record<string, unknown>>(),
  rawMetadata: jsonb("raw_metadata").$type<Record<string, unknown>>(),
  provisionedPrinterId: text("provisioned_printer_id"),
  candidateStatus: text("candidate_status").notNull().default("discovered"),
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdUnique: unique("discovered_devices_tenant_id_unique").on(table.tenantId, table.id),
  discoveryFk: foreignKey({ columns: [table.tenantId, table.discoveryId], foreignColumns: [discoverySessions.tenantId, discoverySessions.id] }),
  agentFk: foreignKey({ columns: [table.tenantId, table.agentId], foreignColumns: [agents.tenantId, agents.id] }),
  provisionedPrinterFk: foreignKey({ columns: [table.tenantId, table.provisionedPrinterId], foreignColumns: [printers.tenantId, printers.id] }),
  discoveryIdIdx: index("discovered_devices_discovery_id_idx").on(table.discoveryId),
  agentIdIdx: index("discovered_devices_agent_id_idx").on(table.agentId),
  candidateStatusIdx: index("discovered_devices_candidate_status_idx").on(table.candidateStatus),
  confidenceIdx: index("discovered_devices_confidence_idx").on(table.confidence),
}));

export const printJobs = pgTable("print_jobs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  apiKeyId: text("api_key_id"),
  destination: text("destination"),
  documentType: text("document_type"),
  agentId: text("agent_id").notNull(),
  printerId: text("printer_id").notNull(),
  status: text("status").notNull().default("queued"),
  payload: jsonb("payload").notNull(),
  error: text("error"),
  requestedBy: text("requested_by"),
  requestId: text("request_id"),
  idempotencyKey: text("idempotency_key"),
  retries: integer("retries").notNull().default(0),
  claimedAt: timestamp("claimed_at"),
  claimToken: text("claim_token"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  deliveredAt: timestamp("delivered_at"),
  ackedAt: timestamp("acked_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  agentFk: foreignKey({ columns: [table.tenantId, table.agentId], foreignColumns: [agents.tenantId, agents.id] }),
  printerFk: foreignKey({ columns: [table.tenantId, table.printerId], foreignColumns: [printers.tenantId, printers.id] }),
  apiKeyTenantFk: foreignKey({ columns: [table.tenantId, table.apiKeyId], foreignColumns: [apiKeys.tenantId, apiKeys.id] }),
  tenantIdUnique: unique("print_jobs_tenant_id_unique").on(table.tenantId, table.id),
  tenantStatusIdx: index("print_jobs_tenant_status_idx").on(table.tenantId, table.status),
  tenantCreatedIdx: index("print_jobs_tenant_created_idx").on(table.tenantId, table.createdAt),
  tenantAgentStatusExpiryIdx: index("print_jobs_tenant_agent_status_expiry_idx").on(table.tenantId, table.agentId, table.status, table.expiresAt),
  agentStatusIdx: index("print_jobs_agent_status_idx").on(table.agentId, table.status),
  printerStatusIdx: index("print_jobs_printer_status_idx").on(table.printerId, table.status),
  statusExpiresIdx: index("print_jobs_status_expires_idx").on(table.status, table.expiresAt),
  claimedAtIdx: index("print_jobs_claimed_at_idx").on(table.status, table.claimedAt),
  apiKeyIdIdx: index("print_jobs_api_key_id_idx").on(table.apiKeyId),
  requestIdIdx: index("print_jobs_request_id_idx").on(table.requestId),
  idempotencyUnique: uniqueIndex("print_jobs_idempotency_unique").on(table.apiKeyId, table.idempotencyKey).where(sql`idempotency_key IS NOT NULL AND api_key_id IS NOT NULL`),
  internalIdempotencyUnique: uniqueIndex("print_jobs_internal_idempotency_unique").on(table.tenantId, table.idempotencyKey).where(sql`idempotency_key IS NOT NULL AND api_key_id IS NULL`),
  statusCheck: check("print_jobs_status_check", sql`${table.status} in ('queued','claimed','printing','success','failed','expired')`),
  retriesCheck: check("print_jobs_retries_check", sql`${table.retries} >= 0`),
  deliveryAttemptsCheck: check("print_jobs_delivery_attempts_check", sql`${table.deliveryAttempts} >= 0`),
  // Mirrors validatePrintJobPayload: the type/protocol contract is enforced at
  // the database boundary too (0024, NOT VALID so pre-existing rows are kept).
  // COALESCE keeps this predicate two-valued: an absent/NULL protocol must
  // FAIL raw/escpos rows, never evaluate to UNKNOWN (CHECKs accept UNKNOWN).
  payloadContractCheck: check("print_jobs_payload_contract_check", sql`jsonb_typeof(${table.payload}) = 'object' AND (
    (${table.payload}->>'type' = 'raw' AND COALESCE(${table.payload}->>'protocol', '') in ('raw','escpos','zpl','tspl'))
    OR (${table.payload}->>'type' = 'escpos' AND COALESCE(${table.payload}->>'protocol', '') = 'escpos')
    OR (${table.payload}->>'type' = 'pdf' AND COALESCE(${table.payload}->>'protocol', '') = '')
    OR (${table.payload}->>'type' = 'image' AND COALESCE(${table.payload}->>'protocol', '') = '')
  )`),
}));

// Operational Prometheus counter store. Created by migration 0015 and written
// exclusively via raw SQL in `src/lib/metrics.ts` (metrics must never break a
// print/auth request, so the write path intentionally bypasses the ORM). It is
// declared here so the Drizzle schema is the complete source of truth for every
// table that exists in the database.
export const gatewayMetrics = pgTable("gateway_metrics", {
  name: text("name").primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  valueCheck: check("gateway_metrics_value_check", sql`${table.value} >= 0`),
}));


export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  requestId: text("request_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tenantCreatedIdx: index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt),
  actorIdx: index("audit_events_actor_idx").on(table.actorType, table.actorId),
  resourceIdx: index("audit_events_resource_idx").on(table.resourceType, table.resourceId),
  actionCheck: check("audit_events_actor_type_check", sql`${table.actorType} in ('user','odoo','agent','desktop','system','platform')`),
  scopeCheck: check("audit_events_scope_check", sql`${table.tenantId} IS NOT NULL OR ${table.actorType} = 'platform'`),
}));

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  entitlements: jsonb("entitlements").$type<Record<string, number | boolean | string>>().default({}).notNull(),
  stripePriceId: text("stripe_price_id").unique(),
  currency: text("currency"),
  interval: text("interval"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const tenantSubscriptions = pgTable("tenant_subscriptions", {
  tenantId: text("tenant_id").references(() => tenants.id).primaryKey(),
  planId: text("plan_id").references(() => plans.id).notNull(),
  stripeCustomerId: text("stripe_customer_id").unique(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  status: text("status").notNull().default("active"),
  currentPeriodEnd: timestamp("current_period_end"),
  trialStartedAt: timestamp("trial_started_at"),
  stripeLastEventCreatedAt: timestamp("stripe_last_event_created_at"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  statusCheck: check("tenant_subscriptions_status_check", sql`${table.status} in ('trialing','active','past_due','paused','cancelled')`),
}));


export const printJobRateLimits = pgTable("print_job_rate_limits", {
  apiKeyId: text("api_key_id").references(() => apiKeys.id).primaryKey(),
  minuteWindowStartedAt: timestamp("minute_window_started_at").notNull(),
  minuteCount: integer("minute_count").notNull().default(0),
  hourWindowStartedAt: timestamp("hour_window_started_at").notNull(),
  hourCount: integer("hour_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});