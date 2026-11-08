CREATE TABLE "music_accounts" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "revision" text NOT NULL,
  "encrypted_state" text NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
