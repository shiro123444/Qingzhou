CREATE TABLE "agent_wake_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "scope_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "intent_hash" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL CHECK ("status" IN ('queued','claimed','dispatched','done','unknown','cancelled')),
  "available_at" timestamptz DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_until" timestamptz,
  "attempts" integer DEFAULT 0 NOT NULL,
  "receipt" jsonb,
  "error_code" text,
  "accessed_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_wake_ready_idx" ON "agent_wake_jobs" ("status", "available_at");
--> statement-breakpoint
CREATE INDEX "agent_wake_lease_idx" ON "agent_wake_jobs" ("status", "lease_until");
--> statement-breakpoint
CREATE INDEX "agent_wake_scope_idx" ON "agent_wake_jobs" ("scope_key", "status");
--> statement-breakpoint
CREATE INDEX "agent_wake_owner_idx" ON "agent_wake_jobs" ("user_id");
