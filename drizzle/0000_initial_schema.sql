CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"hashed_key" text NOT NULL,
	"odoo_enabled" boolean DEFAULT false NOT NULL,
	"odoo_enabled_revision" integer DEFAULT -1 NOT NULL,
	"odoo_enabled_updated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"read_only_until" timestamp,
	CONSTRAINT "api_keys_hashed_key_unique" UNIQUE("hashed_key"),
	CONSTRAINT "api_keys_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "api_keys_odoo_enabled_revision_check" CHECK ("api_keys"."odoo_enabled_revision" >= -1),
	CONSTRAINT "api_keys_read_only_until_check" CHECK ("api_keys"."read_only_until" IS NULL OR "api_keys"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" in ('user','odoo','agent','desktop','system','platform')),
	CONSTRAINT "audit_events_scope_check" CHECK ("audit_events"."tenant_id" IS NOT NULL OR "audit_events"."actor_type" = 'platform')
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp DEFAULT now() NOT NULL,
	"locked_until" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"invitation_id" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "gateway_metrics" (
	"name" text PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_metrics_value_check" CHECK ("gateway_metrics"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "manager_sessions" (
	"jti" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "manager_sessions_role_check" CHECK ("manager_sessions"."role" in ('owner','admin'))
);
--> statement-breakpoint
CREATE TABLE "odoo_installation_credentials" (
	"tenant_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"api_key_id" text NOT NULL,
	"created_at" timestamp DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "odoo_installation_credentials_tenant_id_installation_id_api_key_id_pk" PRIMARY KEY("tenant_id", "installation_id", "api_key_id")
);
--> statement-breakpoint
CREATE TABLE "odoo_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT clock_timestamp() NOT NULL,
	"disabled_at" timestamp,
	CONSTRAINT "odoo_installations_tenant_id_unique" UNIQUE("tenant_id", "id")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"entitlements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"price_minor_units" integer,
	"price_currency" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_unique" UNIQUE("name"),
	CONSTRAINT "plans_display_order_check" CHECK ("plans"."display_order" >= 0),
	CONSTRAINT "plans_price_configuration_check" CHECK (("plans"."price_minor_units" IS NULL AND "plans"."price_currency" IS NULL) OR ("plans"."price_minor_units" >= 0 AND "plans"."price_currency" IN ('USD','SAR')))
);
--> statement-breakpoint
CREATE TABLE "platform_session_security" (
	"family_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"password_version" text NOT NULL,
	"password_verified_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "platform_session_security_password_version_check" CHECK ("platform_session_security"."password_version" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"jti" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"kind" text NOT NULL,
	"tenant_id" text,
	"user_id" text,
	"role" text,
	"email" text,
	"token_hash" text NOT NULL,
	"issued_at" timestamp NOT NULL,
	"family_created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"revoked_reason" text,
	"replaced_by" text,
	"replaced_at" timestamp,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "refresh_tokens_kind_scope_check" CHECK (
    ("refresh_tokens"."kind" = 'platform' AND "refresh_tokens"."tenant_id" IS NULL AND "refresh_tokens"."user_id" IS NOT NULL AND "refresh_tokens"."role" IS NULL)
    OR
    ("refresh_tokens"."kind" IN ('manager', 'customer') AND "refresh_tokens"."tenant_id" IS NOT NULL AND "refresh_tokens"."role" IS NOT NULL)
  ),
	CONSTRAINT "refresh_tokens_time_order_check" CHECK ("refresh_tokens"."family_created_at" <= "refresh_tokens"."issued_at" AND "refresh_tokens"."issued_at" <= "refresh_tokens"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "subscription_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"requester_user_id" text NOT NULL,
	"requester_name" text NOT NULL,
	"requester_email" text NOT NULL,
	"requester_verified_at" timestamp NOT NULL,
	"plan_id" text NOT NULL,
	"term" text NOT NULL,
	"requested_monthly_quota" integer,
	"approved_plan_id" text,
	"approved_term" text,
	"approved_monthly_quota" integer,
	"approval_modified" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"last_action_by" text,
	"last_action_at" timestamp,
	"last_action_reason" text,
	"subscription_revision" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_requests_status_check" CHECK ("subscription_requests"."status" IN ('pending','approved','rejected')),
	CONSTRAINT "subscription_requests_term_check" CHECK ("subscription_requests"."term" IN ('monthly','yearly','custom')),
	CONSTRAINT "subscription_requests_requested_monthly_quota_check" CHECK ("subscription_requests"."requested_monthly_quota" IS NULL OR "subscription_requests"."requested_monthly_quota" > 0),
	CONSTRAINT "subscription_requests_approved_term_check" CHECK ("subscription_requests"."approved_term" IS NULL OR "subscription_requests"."approved_term" IN ('monthly','yearly','custom')),
	CONSTRAINT "subscription_requests_approved_monthly_quota_check" CHECK ("subscription_requests"."approved_monthly_quota" IS NULL OR "subscription_requests"."approved_monthly_quota" > 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"inviter_user_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "tenant_invitations_role_check" CHECK ("tenant_invitations"."role" = 'admin')
);
--> statement-breakpoint
CREATE TABLE "tenant_subscriptions" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"status" text DEFAULT 'awaiting_activation' NOT NULL,
	"subscription_type" text DEFAULT 'paid' NOT NULL,
	"monthly_quota" integer,
	"term" text DEFAULT 'monthly' NOT NULL,
	"internal_reference" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"current_period_start" timestamp DEFAULT now() NOT NULL,
	"current_period_end" timestamp,
	"print_cycle_anchor" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"entitlement_blocked" boolean DEFAULT false NOT NULL,
	"entitlement_blocked_reason" text,
	"revoked_at" timestamp,
	"revoked_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_subscriptions_status_check" CHECK ("tenant_subscriptions"."status" in ('awaiting_activation','active','expired','suspended')),
	CONSTRAINT "tenant_subscriptions_monthly_quota_check" CHECK ("tenant_subscriptions"."monthly_quota" IS NULL OR "tenant_subscriptions"."monthly_quota" > 0),
	CONSTRAINT "tenant_subscriptions_manual_type_check" CHECK ("tenant_subscriptions"."subscription_type" IN ('free','paid') AND "tenant_subscriptions"."term" IN ('monthly','yearly','custom'))
);
--> statement-breakpoint
CREATE TABLE "tenant_users" (
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_users_role_check" CHECK ("tenant_users"."role" in ('owner','admin'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp,
	"deleted_at" timestamp,
	"lifecycle_reason" text,
	"odoo_idempotency_mode" text DEFAULT 'strict_v2' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_lifecycle_check" CHECK ("tenants"."lifecycle" in ('active','suspended','deleted')),
	CONSTRAINT "tenants_odoo_idempotency_mode_check" CHECK ("tenants"."odoo_idempotency_mode" in ('legacy','strict_v2'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp,
	"is_platform_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_session_security" (
	"family_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text,
	"credential_version" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"password_verified_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "workspace_session_security_scope_check" CHECK (("workspace_session_security"."kind" = 'customer' AND "workspace_session_security"."user_id" IS NOT NULL) OR "workspace_session_security"."kind" = 'manager'),
	CONSTRAINT "workspace_session_security_proof_check" CHECK ("workspace_session_security"."credential_version" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_session_security_time_check" CHECK ("workspace_session_security"."created_at" <= "workspace_session_security"."password_verified_at" AND "workspace_session_security"."created_at" <= "workspace_session_security"."last_seen_at" AND "workspace_session_security"."password_verified_at" < "workspace_session_security"."expires_at" AND "workspace_session_security"."last_seen_at" < "workspace_session_security"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_invitation_id_tenant_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."tenant_invitations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "manager_sessions" ADD CONSTRAINT "manager_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "manager_sessions" ADD CONSTRAINT "manager_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "odoo_installation_credentials" ADD CONSTRAINT "odoo_installation_credentials_tenant_id_installation_id_odoo_installations_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "installation_id") REFERENCES "public"."odoo_installations"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "odoo_installation_credentials" ADD CONSTRAINT "odoo_installation_credentials_tenant_id_api_key_id_api_keys_tenant_id_id_fk" FOREIGN KEY ("tenant_id", "api_key_id") REFERENCES "public"."api_keys"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "odoo_installations" ADD CONSTRAINT "odoo_installations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_session_security" ADD CONSTRAINT "platform_session_security_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."refresh_tokens"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_changes" ADD CONSTRAINT "subscription_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_requests" ADD CONSTRAINT "subscription_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_requests" ADD CONSTRAINT "subscription_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_requests" ADD CONSTRAINT "subscription_requests_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_requests" ADD CONSTRAINT "subscription_requests_approved_plan_id_plans_id_fk" FOREIGN KEY ("approved_plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_requests" ADD CONSTRAINT "subscription_requests_last_action_by_users_id_fk" FOREIGN KEY ("last_action_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_session_security" ADD CONSTRAINT "workspace_session_security_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_session_security" ADD CONSTRAINT "workspace_session_security_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_type", "actor_id");
--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type", "resource_id");
--> statement-breakpoint
CREATE INDEX "auth_rate_limits_locked_until_idx" ON "auth_rate_limits" USING btree ("locked_until");
--> statement-breakpoint
CREATE INDEX "auth_rate_limits_updated_at_idx" ON "auth_rate_limits" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_idx" ON "email_verification_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "email_verification_tokens_invitation_id_idx" ON "email_verification_tokens" USING btree ("invitation_id") WHERE "email_verification_tokens"."invitation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "email_verification_tokens_expires_idx" ON "email_verification_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "manager_sessions_expires_idx" ON "manager_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "manager_sessions_tenant_idx" ON "manager_sessions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "manager_sessions_user_idx" ON "manager_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "odoo_installation_credentials_tenant_api_key_idx" ON "odoo_installation_credentials" USING btree ("tenant_id", "api_key_id");
--> statement-breakpoint
CREATE INDEX "odoo_installations_tenant_idx" ON "odoo_installations" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "plans_catalog_idx" ON "plans" USING btree ("is_active", "is_public", "display_order", "name");
--> statement-breakpoint
CREATE INDEX "platform_session_security_user_idx" ON "platform_session_security" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "platform_session_security_expires_idx" ON "platform_session_security" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "platform_sessions_expires_idx" ON "platform_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "platform_sessions_user_idx" ON "platform_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_tenant_idx" ON "refresh_tokens" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "refresh_tokens_replaced_by_idx" ON "refresh_tokens" USING btree ("replaced_by");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_changes_key_idx" ON "subscription_changes" USING btree ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "subscription_changes_history_idx" ON "subscription_changes" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_requests_key_idx" ON "subscription_requests" USING btree ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_requests_pending_idx" ON "subscription_requests" USING btree ("tenant_id") WHERE "subscription_requests"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "subscription_requests_tenant_created_idx" ON "subscription_requests" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX "tenant_invitations_tenant_idx" ON "tenant_invitations" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "tenant_invitations_inviter_user_idx" ON "tenant_invitations" USING btree ("inviter_user_id");
--> statement-breakpoint
CREATE INDEX "tenant_invitations_tenant_created_id_idx" ON "tenant_invitations" USING btree ("tenant_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "tenant_invitations_email_idx" ON "tenant_invitations" USING btree ("email");
--> statement-breakpoint
CREATE INDEX "tenant_invitations_expires_idx" ON "tenant_invitations" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_users_pk" ON "tenant_users" USING btree ("user_id", "tenant_id");
--> statement-breakpoint
CREATE INDEX "tenant_users_tenant_idx" ON "tenant_users" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "tenant_users_tenant_created_user_idx" ON "tenant_users" USING btree ("tenant_id", "created_at", "user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_users_single_owner_idx" ON "tenant_users" USING btree ("tenant_id") WHERE "tenant_users"."role" = 'owner';
--> statement-breakpoint
CREATE INDEX "tenants_lifecycle_idx" ON "tenants" USING btree ("lifecycle");
--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_platform_owner_idx" ON "users" USING btree ("is_platform_owner") WHERE "users"."is_platform_owner" = true;
--> statement-breakpoint
CREATE INDEX "workspace_session_security_user_idx" ON "workspace_session_security" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "workspace_session_security_tenant_idx" ON "workspace_session_security" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "workspace_session_security_expires_idx" ON "workspace_session_security" USING btree ("expires_at");
