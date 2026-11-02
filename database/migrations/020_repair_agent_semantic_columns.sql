-- Repair Agent semantic alignment.
--
-- 014/015 were built with early names:
--   damage_type / responsible_party / repair_executor
-- This migration keeps those legacy columns for compatibility, but adds the
-- contract-spec terms used by the current MVP:
--   cause_classification / liability_party / dispatch_party / payer_party.
--
-- Important semantic split:
--   liability_party = the party legally/factually attributable for causing damage.
--   dispatch_party  = who arranges or performs the repair.
--   payer_party     = who pays or reimburses the repair cost.
--
-- Natural wear / normal failure therefore maps to:
--   liability_party = none, dispatch_party = landlord, payer_party = landlord.

ALTER TABLE lease_repair_rules ADD COLUMN cause_classification TEXT;
ALTER TABLE lease_repair_rules ADD COLUMN liability_party TEXT;
ALTER TABLE lease_repair_rules ADD COLUMN dispatch_party TEXT;

ALTER TABLE repair_ai_assessments ADD COLUMN rule_match_status TEXT DEFAULT 'not_evaluated';
ALTER TABLE repair_ai_assessments ADD COLUMN evidence_status TEXT DEFAULT 'insufficient';
ALTER TABLE repair_ai_assessments ADD COLUMN cause_classification TEXT DEFAULT 'unknown';
ALTER TABLE repair_ai_assessments ADD COLUMN liability_party TEXT DEFAULT 'pending';
ALTER TABLE repair_ai_assessments ADD COLUMN recommended_dispatch_party TEXT DEFAULT 'review_required';
ALTER TABLE repair_ai_assessments ADD COLUMN recommended_payer_party TEXT DEFAULT 'review_required';

ALTER TABLE repair_resolution_records ADD COLUMN liability_party TEXT DEFAULT 'pending';
ALTER TABLE repair_resolution_records ADD COLUMN dispatch_party TEXT DEFAULT 'pending';
ALTER TABLE repair_resolution_records ADD COLUMN settlement_basis TEXT DEFAULT 'manual';
ALTER TABLE repair_resolution_records ADD COLUMN payment_settlement_method TEXT DEFAULT 'none';

ALTER TABLE repair_tickets ADD COLUMN cause_classification TEXT DEFAULT 'unknown';

UPDATE lease_repair_rules
SET
  cause_classification = CASE damage_type
    WHEN 'natural_wear' THEN 'natural_wear'
    WHEN 'normal_use' THEN 'normal_failure'
    WHEN 'tenant_fault' THEN 'tenant_negligence'
    WHEN 'malicious_damage' THEN 'intentional_damage'
    ELSE 'unknown'
  END,
  liability_party = CASE
    WHEN damage_type IN ('natural_wear', 'normal_use') THEN 'none'
    WHEN responsible_party = 'landlord' THEN 'landlord'
    WHEN responsible_party = 'tenant' THEN 'tenant'
    WHEN responsible_party = 'shared' THEN 'shared'
    ELSE 'review_required'
  END,
  dispatch_party = CASE repair_executor
    WHEN 'landlord' THEN 'landlord'
    WHEN 'tenant' THEN 'tenant'
    WHEN 'vendor' THEN 'vendor'
    ELSE 'review_required'
  END
WHERE cause_classification IS NULL
   OR liability_party IS NULL
   OR dispatch_party IS NULL;

UPDATE repair_tickets
SET cause_classification = CASE damage_type
  WHEN 'natural_wear' THEN 'natural_wear'
  WHEN 'normal_use' THEN 'normal_failure'
  WHEN 'tenant_fault' THEN 'tenant_negligence'
  WHEN 'malicious_damage' THEN 'intentional_damage'
  ELSE 'unknown'
END
WHERE cause_classification IS NULL
   OR cause_classification = 'unknown';

UPDATE repair_ai_assessments
SET
  cause_classification = COALESCE(cause_classification, 'unknown'),
  liability_party = CASE
    WHEN responsibility_guess = 'landlord' AND recommended_payer = 'landlord' THEN 'none'
    WHEN responsibility_guess = 'landlord' THEN 'landlord'
    WHEN responsibility_guess = 'tenant' THEN 'tenant'
    WHEN responsibility_guess = 'shared' THEN 'shared'
    ELSE 'pending'
  END,
  recommended_dispatch_party = COALESCE(NULLIF(recommended_executor, ''), 'review_required'),
  recommended_payer_party = COALESCE(NULLIF(recommended_payer, ''), 'review_required')
WHERE liability_party IS NULL
   OR liability_party = 'pending'
   OR recommended_dispatch_party IS NULL
   OR recommended_payer_party IS NULL;

CREATE INDEX idx_lease_repair_rules_semantic
  ON lease_repair_rules(lease_id, rental_unit_id, asset_id, cause_classification, status);

CREATE INDEX idx_repair_ai_assessments_semantic
  ON repair_ai_assessments(repair_ticket_id, cause_classification, liability_party, created_at DESC);
