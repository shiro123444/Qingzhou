CREATE TABLE "channel_digest_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL REFERENCES "agent_bot_providers"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "thread_id" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "send_to_source" boolean DEFAULT false NOT NULL,
  "schedule_time" text DEFAULT '18:00' NOT NULL,
  "revision" uuid DEFAULT gen_random_uuid() NOT NULL,
  "cursor" bigint DEFAULT 0 NOT NULL,
  "next_run_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "channel_digest_time_check" CHECK ("schedule_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_digest_rule_scope_idx" ON "channel_digest_rules" ("provider_id", "thread_id");
CREATE INDEX "channel_digest_due_idx" ON "channel_digest_rules" ("next_run_at") WHERE "enabled" = true;
--> statement-breakpoint
CREATE TABLE "channel_digest_messages" (
  "id" bigserial PRIMARY KEY,
  "rule_id" uuid NOT NULL REFERENCES "channel_digest_rules"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "sender_id" text NOT NULL,
  "content" text NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "received_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "channel_digest_message_event_idx" ON "channel_digest_messages" ("rule_id", "event_id");
CREATE INDEX "channel_digest_message_cursor_idx" ON "channel_digest_messages" ("rule_id", "id");
CREATE INDEX "channel_digest_message_expiry_idx" ON "channel_digest_messages" ("expires_at");
--> statement-breakpoint
CREATE TABLE "channel_digest_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" uuid NOT NULL REFERENCES "channel_digest_rules"("id") ON DELETE CASCADE,
  "revision" uuid NOT NULL,
  "status" text NOT NULL,
  "scheduled_for" timestamptz NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "last_message_id" bigint DEFAULT 0 NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "has_more" boolean DEFAULT false NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "content" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "channel_digest_run_status_check" CHECK ("status" in ('running','completed','empty','failed','unknown','cancelled'))
);
CREATE UNIQUE INDEX "channel_digest_run_schedule_idx" ON "channel_digest_runs" ("rule_id", "scheduled_for");
CREATE INDEX "channel_digest_run_expiry_idx" ON "channel_digest_runs" ("created_at");
