CREATE TABLE "agent_activity_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category" text NOT NULL CHECK ("category" IN ('agent','wake')),
  "activity_id" text NOT NULL,
  "incident_token" text NOT NULL,
  "decision" text NOT NULL CHECK ("decision" IN ('effect_confirmed','no_effect','closed')),
  "evidence" text NOT NULL CHECK (char_length("evidence") BETWEEN 10 AND 2000),
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_activity_review_incident_idx" ON "agent_activity_reviews" ("user_id", "category", "activity_id", "incident_token");
--> statement-breakpoint
CREATE TABLE "agent_worker_heartbeats" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('agent','wake')),
  "phase" text NOT NULL CHECK ("phase" IN ('idle','busy','degraded','stopping','stopped')),
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "heartbeat_at" timestamptz DEFAULT now() NOT NULL,
  "last_poll_at" timestamptz,
  "last_success_at" timestamptz,
  "last_failure_at" timestamptz,
  "consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_worker_heartbeat_kind_idx" ON "agent_worker_heartbeats" ("kind", "heartbeat_at");
