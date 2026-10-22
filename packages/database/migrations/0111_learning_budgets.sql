CREATE TABLE "learning_budget_roots" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "root_id" text NOT NULL,
  "state" jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "root_id")
);
