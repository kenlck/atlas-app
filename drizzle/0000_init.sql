CREATE TYPE "space_kind" AS ENUM ('personal', 'team');
--> statement-breakpoint
CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean NOT NULL,
  "image" text,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  "must_change_password" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "user" ("email");
--> statement-breakpoint
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_unique" ON "session" ("token");
--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp,
  "refresh_token_expires_at" timestamp,
  "scope" text,
  "password" text,
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp,
  "updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "space" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" "space_kind" NOT NULL,
  "team_id" text,
  "owner_user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_at" timestamp NOT NULL,
  CONSTRAINT "space_kind_owner" CHECK (
    (kind = 'personal' AND owner_user_id IS NOT NULL AND team_id IS NULL)
    OR
    (kind = 'team' AND team_id IS NOT NULL AND owner_user_id IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "space_one_personal_per_owner" ON "space" ("owner_user_id") WHERE kind = 'personal';
--> statement-breakpoint
CREATE TABLE "page" (
  "id" text PRIMARY KEY NOT NULL,
  "space_id" text NOT NULL REFERENCES "space"("id") ON DELETE CASCADE,
  "parent_id" text REFERENCES "page"("id") ON DELETE RESTRICT,
  "title" text NOT NULL,
  "body" jsonb NOT NULL,
  "body_text" text NOT NULL DEFAULT '',
  "position" integer NOT NULL,
  "created_by" text NOT NULL REFERENCES "user"("id"),
  "updated_by" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  "archived_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "page_space_id_idx" ON "page" ("space_id");
--> statement-breakpoint
CREATE TABLE "admin_audit" (
  "id" text PRIMARY KEY NOT NULL,
  "action" text NOT NULL,
  "target_user_id" text NOT NULL REFERENCES "user"("id"),
  "caller_ip" text,
  "created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION create_personal_space() RETURNS trigger AS $$
BEGIN
  INSERT INTO space (id, kind, owner_user_id, name, created_at)
  VALUES (gen_random_uuid()::text, 'personal', NEW.id, NEW.name, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_user_personal_space
  AFTER INSERT ON "user"
  FOR EACH ROW
  EXECUTE FUNCTION create_personal_space();
