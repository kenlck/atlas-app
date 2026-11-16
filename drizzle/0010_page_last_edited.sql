ALTER TABLE "page" ADD COLUMN "last_edited_by" text;
--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "last_edited_at" timestamp;
--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_last_edited_by_user_id_fk" FOREIGN KEY ("last_edited_by") REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
UPDATE "page" SET "last_edited_at" = "updated_at", "last_edited_by" = "updated_by";
