DROP INDEX "drawing_page_unique";
--> statement-breakpoint
CREATE INDEX "drawing_page_idx" ON "drawing" ("page_id");
--> statement-breakpoint
ALTER TABLE "drawing" ADD COLUMN "preview_svg" text;
--> statement-breakpoint
ALTER TABLE "drawing" ADD COLUMN "updated_at" timestamp;
