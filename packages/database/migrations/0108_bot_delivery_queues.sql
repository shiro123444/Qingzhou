CREATE TABLE IF NOT EXISTS "bot_delivery_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "role" text NOT NULL,
  "event_key" text NOT NULL,
  "scope_key" text NOT NULL,
  "user_id" text NOT NULL CONSTRAINT "bot_delivery_jobs_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "operation_id" text NOT NULL,
  "payload" text,
  "intent_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "error_code" text,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bot_delivery_role_check" CHECK ("role" in ('outbox', 'inbox')),
  CONSTRAINT "bot_delivery_payload_check" CHECK ("payload" is null or json_typeof("payload"::json) = 'object'),
  CONSTRAINT "bot_delivery_status_check" CHECK ("status" in ('pending', 'running', 'transferred', 'delivered', 'unknown', 'dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_delivery_event_role_unique" ON "bot_delivery_jobs" ("role", "event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_delivery_ready_idx" ON "bot_delivery_jobs" ("role", "priority" DESC, "next_attempt_at", "id") WHERE "status" in ('pending', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_delivery_owner_idx" ON "bot_delivery_jobs" ("user_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_delivery_scope_idx" ON "bot_delivery_jobs" ("scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_delivery_expired_idx" ON "bot_delivery_jobs" ("lease_expires_at") WHERE "status" = 'running';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_delivery_ledgers" (
  "scope_key" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL CONSTRAINT "bot_delivery_ledgers_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "state" jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_delivery_ledger_owner_idx" ON "bot_delivery_ledgers" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_delivery_audits" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL CONSTRAINT "bot_delivery_audits_user_id_users_id_fk" REFERENCES "users"("id") ON DELETE CASCADE,
  "actor_id" text NOT NULL,
  "scope_key" text NOT NULL,
  "job_id" text,
  "effect_id" text,
  "action" text NOT NULL,
  "note" text NOT NULL,
  "evidence" text NOT NULL,
  "before_revision" integer,
  "after_revision" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_delivery_audit_owner_idx" ON "bot_delivery_audits" ("user_id", "created_at");
