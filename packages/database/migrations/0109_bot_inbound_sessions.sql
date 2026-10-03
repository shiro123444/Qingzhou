CREATE TABLE IF NOT EXISTS "bot_inbound_events" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "application_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "event_id" text NOT NULL,
  "payload" text,
  "payload_hash" text NOT NULL,
  "is_control" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  "dispatch_started_at" timestamptz,
  "error_code" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "bot_inbound_status_check" CHECK ("status" in ('pending','running','processed','unknown','dead'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_inbound_ready_idx" ON "bot_inbound_events" ("status", "next_attempt_at", "created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_inbound_owner_idx" ON "bot_inbound_events" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_inbound_thread_idx" ON "bot_inbound_events" ("user_id", "platform", "application_id", "thread_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_execution_sessions" (
  "scope_key" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "owner" text NOT NULL,
  "operation_id" text,
  "stop_requested" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_polling_cursors" (
  "scope_key" text PRIMARY KEY NOT NULL,
  "cursor" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
