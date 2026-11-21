CREATE TABLE "agent_computer_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "provider_binding" text NOT NULL,
  "resource_id" text,
  "state" text DEFAULT 'new' NOT NULL CHECK ("state" IN ('new','ready','sleeping','unknown')),
  "control" text DEFAULT 'agent' NOT NULL CHECK ("control" IN ('agent','human')),
  "revision" integer DEFAULT 0 NOT NULL,
  "lease_owner" text,
  "lease_until" timestamptz,
  "lease_command_id" text,
  "accessed_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_computer_scope_idx" ON "agent_computer_sessions" ("user_id","agent_id");
--> statement-breakpoint
CREATE TABLE "agent_computer_commands" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL REFERENCES "agent_computer_sessions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "request_key" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor" text NOT NULL CHECK ("actor" IN ('agent','human')),
  "kind" text NOT NULL CHECK ("kind" IN ('ensure','wake','sleep','control','shell')),
  "status" text DEFAULT 'prepared' NOT NULL CHECK ("status" IN ('prepared','dispatched','done','unknown','cancelled')),
  "revision" integer NOT NULL,
  "receipt" jsonb,
  "completed_at" timestamptz,
  "accessed_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_computer_request_idx" ON "agent_computer_commands" ("session_id","request_key");
--> statement-breakpoint
CREATE INDEX "agent_computer_command_owner_idx" ON "agent_computer_commands" ("user_id","created_at");
