CREATE TABLE "api_token" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "prefix" text NOT NULL,
  "last_used_at" timestamp,
  "revoked_at" timestamp,
  "created_at" timestamp NOT NULL
);

CREATE UNIQUE INDEX "api_token_hash_unique" ON "api_token" ("token_hash");
CREATE INDEX "api_token_user_idx" ON "api_token" ("user_id");

ALTER TABLE "page" ADD COLUMN "updated_via_token_id" text REFERENCES "api_token"("id") ON DELETE SET NULL;
