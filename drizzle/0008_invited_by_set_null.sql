ALTER TABLE "team_invite" ALTER COLUMN "invited_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_invite" DROP CONSTRAINT IF EXISTS "team_invite_invited_by_fkey";
--> statement-breakpoint
ALTER TABLE "team_invite" DROP CONSTRAINT IF EXISTS "team_invite_invited_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "team_invite" ADD CONSTRAINT "team_invite_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "user"("id") ON DELETE SET NULL;
