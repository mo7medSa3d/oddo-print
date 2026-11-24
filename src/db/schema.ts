import { pgTable, text, timestamp, jsonb, integer, bigint, boolean, index, uniqueIndex, check, foreignKey, unique, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lifecycle: text("lifecycle").notNull().default("active"),
  suspendedAt: timestamp("suspended_at"),
  deletedAt: timestamp("deleted_at"),
  lifecycleReason: text("lifecycle_reason"),
  // New tenants require proof-bound v2 identity. Existing legacy tenants keep
  // their recorded mode until the explicit reconciliation/cutover procedure.
  odooIdempotencyMode: text("odoo_idempotency_mode").notNull().default("strict_v2"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  lifecycleIdx: index("tenants_lifecycle_idx").on(table.lifecycle),
  lifecycleCheck: check("tenants_lifecycle_check", sql`${table.lifecycle} in ('active','suspended','deleted')`),
  odooIdempotencyModeCheck: check("tenants_odoo_idempotency_mode_check", sql`${table.odooIdempotencyMode} in ('legacy','strict_v2')`),
}));

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
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

export const platformSessionSecurity = pgTable("platform_session_security", {
  familyId: text("family_id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  passwordVersion: text("password_version").notNull(),
  passwordVerifiedAt: timestamp("password_verified_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  userIdx: index("platform_session_security_user_idx").on(table.userId),
  expiresIdx: index("platform_session_security_expires_idx").on(table.expiresAt),
  passwordVersionCheck: check("platform_session_security_password_version_check", sql`${table.passwordVersion} ~ '^[0-9a-f]{64}$'`),
}));

export const refreshTokens = pgTable("refresh_tokens", {
  id: text("id").primaryKey(),
  familyId: text("family_id").notNull(),
  kind: text("kind").notNull(),
  tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  role: text("role"),
  email: text("email"),
  tokenHash: text("token_hash").notNull().unique(),
  issuedAt: timestamp("issued_at").notNull(),
  familyCreatedAt: timestamp("family_created_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  revokedReason: text("revoked_reason"),
  replacedBy: text("replaced_by"),
  replacedAt: timestamp("replaced_at"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
}, (table) => ({
  familyIdx: index("refresh_tokens_family_idx").on(table.familyId),
  tenantIdx: index("refresh_tokens_tenant_idx").on(table.tenantId),
  expiresIdx: index("refresh_tokens_expires_idx").on(table.expiresAt),
  userIdx: index("refresh_tokens_user_idx").on(table.userId),
  replacedByIdx: index("refresh_tokens_replaced_by_idx").on(table.replacedBy),
  replacedByFk: foreignKey({
    name: "refresh_tokens_replaced_by_fk",
    columns: [table.replacedBy],
    foreignColumns: [table.id],
  }).onDelete("set null"),
  kindScopeCheck: check("refresh_tokens_kind_scope_check", sql`
    (${table.kind} = 'platform' AND ${table.tenantId} IS NULL AND ${table.userId} IS NOT NULL AND ${table.role} IS NULL)
    OR
    (${table.kind} IN ('manager', 'customer') AND ${table.tenantId} IS NOT NULL AND ${table.role} IS NOT NULL)
  `),
  timeOrderCheck: check("refresh_tokens_time_order_check", sql`${table.familyCreatedAt} <= ${table.issuedAt} AND ${table.issuedAt} <= ${table.expiresAt}`),
}));

export const workspaceSessionSecurity = pgTable("workspace_session_security", {
  familyId: text("family_id").primaryKey(),
  kind: text("kind").notNull(),
  tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  credentialVersion: text("credential_version").notNull(),
  createdAt: timestamp("created_at").notNull(),
  passwordVerifiedAt: timestamp("password_verified_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => ({
  userIdx: index("workspace_session_security_user_idx").on(table.userId),
  tenantIdx: index("workspace_session_security_tenant_idx").on(table.tenantId),
  expiresIdx: index("workspace_session_security_expires_idx").on(table.expiresAt),
  scopeCheck: check("workspace_session_security_scope_check", sql`(${table.kind} = 'customer' AND ${table.userId} IS NOT NULL) OR ${table.kind} = 'manager'`),
  proofCheck: check("workspace_session_security_proof_check", sql`${table.credentialVersion} ~ '^[0-9a-f]{64}$'`),
  timeCheck: check("workspace_session_security_time_check", sql`${table.createdAt} <= ${table.passwordVerifiedAt} AND ${table.createdAt} <= ${table.lastSeenAt} AND ${table.passwordVerifiedAt} < ${table.expiresAt} AND ${table.lastSeenAt} < ${table.expiresAt}`),
}));

export const tenantUsers = pgTable("tenant_users", {
  userId: text("user_id").references(() => users.id).notNull(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  role: text("role").notNull().default("admin"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Deliberately a UNIQUE index, not a composite PRIMARY KEY: tenant_users
  // rows are addressed via (userId, tenantId) lookups and the single-owner
  // partial unique below, and no ORM/replication path requires a formal PK.
  pk: uniqueIndex("tenant_users_pk").on(table.userId, table.tenantId),
  tenantIdx: index("tenant_users_tenant_idx").on(table.tenantId),
  tenantCreatedUserIdx: index("tenant_users_tenant_created_user_idx").on(table.tenantId, table.createdAt, table.userId),
  ownerUnique: uniqueIndex("tenant_users_single_owner_idx").on(table.tenantId).where(sql`${table.role} = 'owner'`),
  roleCheck: check("tenant_users_role_check", sql`${table.role} in ('owner','admin')`),
}));

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  hashedKey: text("hashed_key").notNull().unique(),
  // Odoo activation is an integration-credential state, not a tenant-wide switch.
  odooEnabled: boolean("odoo_enabled").notNull().default(false),
  odooEnabledRevision: integer("odoo_enabled_revision").notNull().default(-1),
  odooEnabledUpdatedAt: timestamp("odoo_enabled_updated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  readOnlyUntil: timestamp("read_only_until"),
}, (table) => ({
  tenantIdUnique: unique("api_keys_tenant_id_unique").on(table.tenantId, table.id),
  odooEnabledRevisionCheck: check("api_keys_odoo_enabled_revision_check", sql`${table.odooEnabledRevision} >= -1`),
  readOnlyUntilCheck: check("api_keys_read_only_until_check", sql`${table.readOnlyUntil} IS NULL OR ${table.revokedAt} IS NOT NULL`),
}));

// S06-006 Odoo deployments: independent identities are generated on the
// Odoo host and registered with the Gateway; a copied DB UUID is not a proof.
export const odooInstallations = pgTable("odoo_installations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").references(() => tenants.id).notNull(),
  name: text("name").notNull(),
  secretHash: text("secret_hash").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").default(sql`clock_timestamp()`).notNull(),
  disabledAt: timestamp("disabled_at"),
}, table => ({
  tenantUnique: unique("odoo_installations_tenant_id_unique").on(table.tenantId, table.id),
  tenantIdx: index("odoo_installations_tenant_idx").on(table.tenantId),
}));

export const odooInstallationCredentials = pgTable("odoo_installation_credentials", {
  tenantId: text("tenant_id").notNull(),
  installationId: text("installation_id").notNull(),
  apiKeyId: text("api_key_id").notNull(),
  createdAt: timestamp("created_at").default(sql`clock_timestamp()`).notNull(),
}, table => ({
  pk: primaryKey({ columns: [table.tenantId, table.installationId, table.apiKeyId] }),
  tenantKeyIdx: index("odoo_installation_credentials_tenant_api_key_idx").on(table.tenantId, table.apiKeyId),
  installationFk: foreignKey({ columns: [table.tenantId, table.installationId], foreignColumns: [odooInstallations.tenantId, odooInstallations.id] }),
  apiKeyFk: foreignKey({ columns: [table.tenantId, table.apiKeyId], foreignColumns: [apiKeys.tenantId, apiKeys.id] }),
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
  roleCheck: check("manager_sessions_role_check", sql`${table.role} in ('owner','admin')`),
}));

export const emailVerificationTokens = pgTable("email_verification_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  // Server-side binding: stripping invite= from a verification URL must NOT
  // silently turn an invited employee into the owner of a new workspace.
  invitationId: text("invitation_id").references(() => tenantInvitations.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdx: index("email_verification_tokens_user_idx").on(table.userId),
  invitationIdx: index("email_verification_tokens_invitation_id_idx").on(table.invitationId).where(sql`${table.invitationId} IS NOT NULL`),
  expiresIdx: index("email_verification_tokens_expires_idx").on(table.expiresAt),
}));

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
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
  tenantId: text("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  inviterUserId: text("inviter_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tenantIdx: index("tenant_invitations_tenant_idx").on(table.tenantId),
  inviterUserIdx: index("tenant_invitations_inviter_user_idx").on(table.inviterUserId),
  tenantCreatedIdIdx: index("tenant_invitations_tenant_created_id_idx").on(table.tenantId, table.createdAt, table.id),
  emailIdx: index("tenant_invitations_email_idx").on(table.email),
  expiresIdx: index("tenant_invitations_expires_idx").on(table.expiresAt),
  roleCheck: check("tenant_invitations_role_check", sql`${table.role} = 'admin'`),
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
  createdAtIdx: index("audit_events_created_at_idx").on(table.createdAt),
  actorIdx: index("audit_events_actor_idx").on(table.actorType, table.actorId),
  resourceIdx: index("audit_events_resource_idx").on(table.resourceType, table.resourceId),
  actionCheck: check("audit_events_actor_type_check", sql`${table.actorType} in ('user','odoo','agent','desktop','system','platform')`),
  scopeCheck: check("audit_events_scope_check", sql`${table.tenantId} IS NOT NULL OR ${table.actorType} = 'platform'`),
}));

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  entitlements: jsonb("entitlements").$type<Record<string, number | boolean | string>>().default({}).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  isPublic: boolean("is_public").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  // Catalog prices are informational; contract payments remain manual.
  // Integer minor units avoid floating-point rounding for SAR/USD.
  priceMinorUnits: integer("price_minor_units"),
  priceCurrency: text("price_currency"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  displayOrderCheck: check("plans_display_order_check", sql`${table.displayOrder} >= 0`),
  priceCheck: check("plans_price_configuration_check", sql`(${table.priceMinorUnits} IS NULL AND ${table.priceCurrency} IS NULL) OR (${table.priceMinorUnits} >= 0 AND ${table.priceCurrency} IN ('USD','SAR'))`),
  catalogIdx: index("plans_catalog_idx").on(table.isActive, table.isPublic, table.displayOrder, table.name),
}));

export const tenantSubscriptions = pgTable("tenant_subscriptions", {
  tenantId: text("tenant_id").references(() => tenants.id).primaryKey(),
  planId: text("plan_id").references(() => plans.id).notNull(),
  status: text("status").notNull().default("awaiting_activation"),
  subscriptionType: text("subscription_type").notNull().default("paid"),
  monthlyQuota: integer("monthly_quota"),
  term: text("term").notNull().default("monthly"),
  internalReference: text("internal_reference"),
  revision: integer("revision").notNull().default(0),
  currentPeriodStart: timestamp("current_period_start").notNull().defaultNow(),
  currentPeriodEnd: timestamp("current_period_end"),
  /** Retained 0101 rolling-cycle activation anchor for history; calendar-month admission no longer reads it. */
  printCycleAnchor: timestamp("print_cycle_anchor"),
  // v3: informational only. The live entitlement predicate is
  // current_period_end > clock_timestamp(); no code path gates access on
  // this flag, so a future reader must not trust it instead of the time
  // predicate. Renew clears it.
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  entitlementBlocked: boolean("entitlement_blocked").notNull().default(false),
  entitlementBlockedReason: text("entitlement_blocked_reason"),
  // v3 (0108): a revoke is terminal for the current contract, unlike suspend.
  // Rows revoked before 0108 have NULL here and keep the old behaviour
  // (reactivatable while suspended); only revokes after 0108 set it.
  revokedAt: timestamp("revoked_at"),
  revokedReason: text("revoked_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  statusCheck: check("tenant_subscriptions_status_check", sql`${table.status} in ('awaiting_activation','active','expired','suspended')`),
  monthlyQuotaCheck: check("tenant_subscriptions_monthly_quota_check", sql`${table.monthlyQuota} IS NULL OR ${table.monthlyQuota} > 0`),
  manualTypeCheck: check("tenant_subscriptions_manual_type_check", sql`${table.subscriptionType} IN ('free','paid') AND ${table.term} IN ('monthly','yearly','custom')`),
}));

/** Authenticated owner requests; snapshots preserve who actually requested access. */
export const subscriptionRequests = pgTable("subscription_requests", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  requesterUserId: text("requester_user_id").notNull().references(() => users.id),
  requesterName: text("requester_name").notNull(),
  requesterEmail: text("requester_email").notNull(),
  requesterVerifiedAt: timestamp("requester_verified_at").notNull(),
  planId: text("plan_id").notNull().references(() => plans.id),
  term: text("term").notNull(),
  requestedMonthlyQuota: integer("requested_monthly_quota"),
  // Preserve the immutable customer request AND the actual approved terms.
  approvedPlanId: text("approved_plan_id").references(() => plans.id),
  approvedTerm: text("approved_term"),
  approvedMonthlyQuota: integer("approved_monthly_quota"),
  approvalModified: boolean("approval_modified").notNull().default(false),
  status: text("status").notNull().default("pending"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  lastActionBy: text("last_action_by").references(() => users.id),
  lastActionAt: timestamp("last_action_at"),
  lastActionReason: text("last_action_reason"),
  subscriptionRevision: integer("subscription_revision"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => ({
  requestKey: uniqueIndex("subscription_requests_key_idx").on(table.tenantId, table.idempotencyKey),
  pendingUnique: uniqueIndex("subscription_requests_pending_idx").on(table.tenantId).where(sql`${table.status} = 'pending'`),
  tenantCreatedIdx: index("subscription_requests_tenant_created_idx").on(table.tenantId, table.createdAt),
  statusCheck: check("subscription_requests_status_check", sql`${table.status} IN ('pending','approved','rejected')`),
  termCheck: check("subscription_requests_term_check", sql`${table.term} IN ('monthly','yearly','custom')`),
  quotaCheck: check("subscription_requests_requested_monthly_quota_check", sql`${table.requestedMonthlyQuota} IS NULL OR ${table.requestedMonthlyQuota} > 0`),
  approvedTermCheck: check("subscription_requests_approved_term_check", sql`${table.approvedTerm} IS NULL OR ${table.approvedTerm} IN ('monthly','yearly','custom')`),
  approvedQuotaCheck: check("subscription_requests_approved_monthly_quota_check", sql`${table.approvedMonthlyQuota} IS NULL OR ${table.approvedMonthlyQuota} > 0`),
}));

export const subscriptionChanges = pgTable("subscription_changes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  actorId: text("actor_id").references(() => users.id),
  action: text("action").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestDigest: text("request_digest").notNull(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => ({
  keyUnique: uniqueIndex("subscription_changes_key_idx").on(table.tenantId, table.idempotencyKey),
  historyIdx: index("subscription_changes_history_idx").on(table.tenantId, table.createdAt),
}));

