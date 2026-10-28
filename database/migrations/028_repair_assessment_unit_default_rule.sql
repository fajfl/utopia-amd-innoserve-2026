-- Preserve whether an assessment used a pre-signing unit default rather than a signed lease rule.
ALTER TABLE repair_ai_assessments
  ADD COLUMN rental_unit_repair_rule_default_id INTEGER REFERENCES rental_unit_repair_rule_defaults(id);

CREATE INDEX idx_repair_ai_assessments_unit_default
  ON repair_ai_assessments(rental_unit_repair_rule_default_id);
