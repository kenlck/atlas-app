CREATE TYPE "page_kind" AS ENUM ('doc', 'whiteboard');
--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "kind" "page_kind" NOT NULL DEFAULT 'doc';
--> statement-breakpoint
CREATE TABLE "drawing" (
  "id" text PRIMARY KEY NOT NULL,
  "page_id" text NOT NULL REFERENCES "page"("id") ON DELETE CASCADE,
  "scene" jsonb NOT NULL,
  "version" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_page_unique" ON "drawing" ("page_id");
