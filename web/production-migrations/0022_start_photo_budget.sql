-- Each reservation covers one provider request, including a possibly billed timeout.
-- Existing attempts have an unknown cost. Reconcile those rows before opening the pool.
ALTER TABLE rig_start_photo_attempts ADD COLUMN reserved_eur_cents INTEGER
  CHECK (reserved_eur_cents IS NULL OR
    (typeof(reserved_eur_cents) = 'integer' AND reserved_eur_cents BETWEEN 0 AND 16700));

CREATE VIEW rig_start_photo_budget AS
SELECT CASE WHEN COUNT(*) = COUNT(reserved_eur_cents)
  THEN MAX(0, 16700 - COALESCE(SUM(reserved_eur_cents), 0)) ELSE 0 END AS available_eur_cents
FROM rig_start_photo_attempts;

-- D1 evaluates this check and inserts the reservation in the same write.
-- Old Workers omit the cost and cannot submit an unpriced provider call during rollout.
CREATE TRIGGER rig_start_photo_budget_admission BEFORE INSERT ON rig_start_photo_attempts
WHEN NEW.reserved_eur_cents IS NULL OR NEW.reserved_eur_cents <= 0 OR
  NEW.reserved_eur_cents > (SELECT available_eur_cents FROM rig_start_photo_budget)
BEGIN
  SELECT RAISE(IGNORE);
END;
