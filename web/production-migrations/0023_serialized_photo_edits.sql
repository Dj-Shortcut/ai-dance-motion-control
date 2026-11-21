-- Preserve all earlier campaign charges and refuse dispatch by an older Worker.
CREATE TRIGGER rig_start_photo_legacy_closed BEFORE INSERT ON rig_start_photo_attempts
BEGIN
  SELECT RAISE(IGNORE);
END;

-- A row without a charge holds the only provider slot until its outcome is accounted for.
-- The request identifier is also sent to OpenAI for reconciliation after an unknown outcome.
CREATE TABLE rig_start_photo_edits (
  request_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  provider_request_id TEXT,
  text_input_tokens INTEGER,
  image_input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd_micros INTEGER,
  cost_eur_cents INTEGER,
  CHECK (
    (text_input_tokens IS NULL AND image_input_tokens IS NULL AND output_tokens IS NULL
      AND cost_usd_micros IS NULL AND cost_eur_cents IS NULL)
    OR (typeof(text_input_tokens)='integer' AND text_input_tokens>=0
      AND typeof(image_input_tokens)='integer' AND image_input_tokens>=0
      AND typeof(output_tokens)='integer' AND output_tokens>=0
      AND typeof(cost_usd_micros)='integer' AND cost_usd_micros>=0
      AND typeof(cost_eur_cents)='integer' AND cost_eur_cents>=0)
  )
);

CREATE UNIQUE INDEX rig_start_photo_one_pending ON rig_start_photo_edits ((1)) WHERE cost_eur_cents IS NULL;

DROP VIEW rig_start_photo_budget;
CREATE VIEW rig_start_photo_budget AS
WITH legacy AS (
  SELECT COALESCE(SUM(reserved_eur_cents),0) AS cents, COUNT(*)-COUNT(reserved_eur_cents) AS pending FROM rig_start_photo_attempts
), edits AS (
  SELECT COALESCE(SUM(cost_eur_cents),0) AS cents, COUNT(*)-COUNT(cost_eur_cents) AS pending FROM rig_start_photo_edits
)
SELECT legacy.cents+edits.cents AS accounted_eur_cents,
       legacy.pending+edits.pending AS unpriced_count,
       CASE WHEN legacy.pending+edits.pending=0 THEN MAX(0,16700-legacy.cents-edits.cents) ELSE 0 END AS available_eur_cents,
       (legacy.pending+edits.pending=0 AND legacy.cents+edits.cents<15000) AS may_start
FROM legacy,edits;

CREATE TRIGGER rig_start_photo_edit_admission BEFORE INSERT ON rig_start_photo_edits
WHEN NEW.cost_eur_cents IS NOT NULL OR (SELECT may_start FROM rig_start_photo_budget)<>1
  OR EXISTS (SELECT 1 FROM rig_start_photo_attempts WHERE request_id=NEW.request_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
