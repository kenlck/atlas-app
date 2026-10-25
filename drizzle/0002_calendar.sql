CREATE TABLE "calendar_event" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "all_day" boolean NOT NULL,
  "start_at" timestamp with time zone,
  "end_at" timestamp with time zone,
  "start_date" date,
  "end_date" date,
  "note" text,
  "created_by" text NOT NULL REFERENCES "user"("id"),
  "updated_by" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL,
  CONSTRAINT "calendar_event_shape" CHECK (
    (
      all_day = true
      AND start_date IS NOT NULL
      AND end_date IS NOT NULL
      AND start_at IS NULL
      AND end_at IS NULL
      AND end_date >= start_date
    )
    OR
    (
      all_day = false
      AND start_at IS NOT NULL
      AND end_at IS NOT NULL
      AND start_date IS NULL
      AND end_date IS NULL
      AND end_at >= start_at
    )
  )
);
--> statement-breakpoint
CREATE INDEX "calendar_event_team_start_at_idx" ON "calendar_event" ("team_id", "start_at");
--> statement-breakpoint
CREATE INDEX "calendar_event_team_start_date_idx" ON "calendar_event" ("team_id", "start_date");
