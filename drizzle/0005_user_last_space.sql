ALTER TABLE "user" ADD COLUMN "last_space_id" text REFERENCES "space"("id") ON DELETE SET NULL;
