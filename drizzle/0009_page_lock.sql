ALTER TABLE "page" ADD COLUMN "locked_by" text;
--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "locked_at" timestamp;
--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_locked_by_user_id_fk" FOREIGN KEY ("locked_by") REFERENCES "user"("id") ON DELETE SET NULL;
