CREATE TYPE "team_role" AS ENUM ('owner', 'member');
--> statement-breakpoint
CREATE TYPE "invite_status" AS ENUM ('pending', 'accepted', 'declined');
--> statement-breakpoint
CREATE TABLE "team" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_member" (
  "team_id" text NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" "team_role" NOT NULL,
  "created_at" timestamp NOT NULL,
  PRIMARY KEY ("team_id", "user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "team_one_owner" ON "team_member" ("team_id") WHERE role = 'owner';
--> statement-breakpoint
CREATE INDEX "team_member_user_idx" ON "team_member" ("user_id");
--> statement-breakpoint
CREATE TABLE "team_invite" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
  "invitee_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "invited_by" text NOT NULL REFERENCES "user"("id"),
  "status" "invite_status" NOT NULL DEFAULT 'pending',
  "created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "team_invite_one_pending" ON "team_invite" ("team_id", "invitee_user_id") WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX "team_invite_invitee_idx" ON "team_invite" ("invitee_user_id");
--> statement-breakpoint
ALTER TABLE "space" ADD CONSTRAINT "space_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "space_one_per_team" ON "space" ("team_id") WHERE team_id IS NOT NULL;
