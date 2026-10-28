ALTER TABLE repair_ai_assessments
  ADD COLUMN IF NOT EXISTS rental_unit_repair_rule_default_id BIGINT NULL;

CREATE INDEX idx_repair_ai_assessments_unit_default
  ON repair_ai_assessments(rental_unit_repair_rule_default_id);
