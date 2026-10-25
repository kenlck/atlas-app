CREATE OR REPLACE FUNCTION page_plain_text(node jsonb) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  kind text;
  child jsonb;
  parts text[] := ARRAY[]::text[];
  piece text;
  iso text;
  months text[] := ARRAY['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  year_n int;
  month_n int;
  day_n int;
  stored text;
BEGIN
  IF node IS NULL OR jsonb_typeof(node) <> 'object' THEN
    RETURN '';
  END IF;
  kind := node->>'type';
  IF kind = 'dateChip' THEN
    iso := coalesce(node#>>'{attrs,date}', '');
    IF iso ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      year_n := substring(iso, 1, 4)::int;
      month_n := substring(iso, 6, 2)::int;
      day_n := substring(iso, 9, 2)::int;
      IF month_n BETWEEN 1 AND 12 AND day_n BETWEEN 1 AND 31 THEN
        RETURN months[month_n] || ' ' || day_n::text || ', ' || year_n::text;
      END IF;
    END IF;
    RETURN iso;
  END IF;
  IF kind = 'mention' THEN
    stored := node#>>'{attrs,label}';
    IF stored IS NULL OR stored = '' THEN
      RETURN 'Unknown person';
    END IF;
    RETURN stored;
  END IF;
  IF kind = 'text' THEN
    RETURN coalesce(node->>'text', '');
  END IF;
  IF node ? 'content' AND jsonb_typeof(node->'content') = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(node->'content')
    LOOP
      piece := page_plain_text(child);
      IF piece <> '' THEN
        parts := array_append(parts, piece);
      END IF;
    END LOOP;
  END IF;
  RETURN array_to_string(parts, ' ');
END;
$fn$;
--> statement-breakpoint
UPDATE page SET body_text = page_plain_text(body);
