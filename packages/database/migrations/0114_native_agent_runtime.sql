CREATE TABLE "agent_runtime_checkpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "state" jsonb,
  "metadata" jsonb NOT NULL,
  "history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "lease_owner" text,
  "lease_step" integer,
  "lease_until" timestamp with time zone,
  "accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_runtime_checkpoint_owner_idx" ON "agent_runtime_checkpoints" ("user_id");
--> statement-breakpoint
CREATE TABLE "agent_runtime_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL REFERENCES "agent_runtime_checkpoints"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL CHECK ("step_index" >= 0),
  "message" jsonb NOT NULL,
  "intent_hash" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL CHECK ("status" IN ('queued', 'claimed', 'dispatched', 'done', 'unknown', 'failed', 'cancelled')),
  "priority" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_until" timestamp with time zone,
  "error_code" text,
  "notified_at" timestamp with time zone,
  "accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runtime_job_step_unique" ON "agent_runtime_jobs" ("operation_id", "step_index");
--> statement-breakpoint
CREATE INDEX "agent_runtime_job_ready_idx" ON "agent_runtime_jobs" ("status", "available_at", "priority");
--> statement-breakpoint
CREATE INDEX "agent_runtime_job_lease_idx" ON "agent_runtime_jobs" ("status", "lease_until");
--> statement-breakpoint
CREATE INDEX "agent_runtime_job_notice_idx" ON "agent_runtime_jobs" ("status", "notified_at");
--> statement-breakpoint
CREATE INDEX "agent_runtime_job_owner_idx" ON "agent_runtime_jobs" ("user_id");
