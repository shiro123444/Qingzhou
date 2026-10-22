ALTER TABLE "agents" ADD COLUMN "generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "agent_documents" ADD COLUMN "generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "generation" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE FUNCTION "qingzhou_advance_resource_generation"() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'generation' - 'created_at' - 'updated_at' - 'accessed_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'generation' - 'created_at' - 'updated_at' - 'accessed_at') THEN
    NEW.generation := OLD.generation + 1;
  ELSE
    NEW.generation := OLD.generation;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "agents_advance_generation" BEFORE UPDATE ON "agents"
FOR EACH ROW EXECUTE FUNCTION "qingzhou_advance_resource_generation"();
--> statement-breakpoint
CREATE TRIGGER "documents_advance_generation" BEFORE UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "qingzhou_advance_resource_generation"();
--> statement-breakpoint
CREATE TRIGGER "agent_documents_advance_generation" BEFORE UPDATE ON "agent_documents"
FOR EACH ROW EXECUTE FUNCTION "qingzhou_advance_resource_generation"();
--> statement-breakpoint
CREATE TRIGGER "agent_skills_advance_generation" BEFORE UPDATE ON "agent_skills"
FOR EACH ROW EXECUTE FUNCTION "qingzhou_advance_resource_generation"();
--> statement-breakpoint
CREATE TABLE "agent_harness_heads" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "generation" integer DEFAULT 0 NOT NULL,
  "decision_id" text,
  "cancelled_experiments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_revision_id" text,
  "active_revision_id" text,
  "source_revision" jsonb,
  "active_revision" jsonb,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "agent_id")
);
--> statement-breakpoint
CREATE TABLE "agent_harness_decisions" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL,
  "command_hash" text NOT NULL,
  "decision" jsonb NOT NULL,
  "proof" jsonb,
  "event" jsonb NOT NULL,
  "delivered_at" timestamptz,
  "delivery_attempts" integer DEFAULT 0 NOT NULL,
  "delivery_error" text,
  "lease_token" text,
  "lease_until" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "agent_id", "request_id")
);
--> statement-breakpoint
CREATE INDEX "agent_harness_outbox_idx" ON "agent_harness_decisions" ("delivered_at", "lease_until");
