ALTER TABLE lease_repair_rules ADD COLUMN IF NOT EXISTS cause_classification VARCHAR(32) NULL;
ALTER TABLE lease_repair_rules ADD COLUMN IF NOT EXISTS liability_party VARCHAR(32) NULL;
ALTER TABLE lease_repair_rules ADD COLUMN IF NOT EXISTS dispatch_party VARCHAR(32) NULL;
ALTER TABLE repair_ai_assessments ADD COLUMN IF NOT EXISTS rule_match_status VARCHAR(32) DEFAULT 'not_evaluated';
ALTER TABLE repair_ai_assessments ADD COLUMN IF NOT EXISTS evidence_status VARCHAR(32) DEFAULT 'insufficient';
ALTER TABLE repair_ai_assessments ADD COLUMN IF NOT EXISTS cause_classification VARCHAR(32) DEFAULT 'unknown';
ALTER TABLE repair_ai_assessments ADD COLUMN IF NOT EXISTS liability_party VARCHAR(32) DEFAULT 'pending';
ALTER TABLE repair_ai_assessments ADD COLUMN IF NOT EXISTS recommended_dispatch_party VARCHAR(32) DEFAULT 'review_required';
ALTER TABLE repair_ai_assessments ADD COLUMN IF NOT EXISTS recommended_payer_party VARCHAR(32) DEFAULT 'review_required';
ALTER TABLE repair_resolution_records ADD COLUMN IF NOT EXISTS liability_party VARCHAR(32) DEFAULT 'pending';
ALTER TABLE repair_resolution_records ADD COLUMN IF NOT EXISTS dispatch_party VARCHAR(32) DEFAULT 'pending';
ALTER TABLE repair_resolution_records ADD COLUMN IF NOT EXISTS settlement_basis VARCHAR(32) DEFAULT 'manual';
ALTER TABLE repair_resolution_records ADD COLUMN IF NOT EXISTS payment_settlement_method VARCHAR(32) DEFAULT 'none';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS cause_classification VARCHAR(32) DEFAULT 'unknown';

UPDATE lease_repair_rules SET cause_classification = CASE damage_type WHEN 'natural_wear' THEN 'natural_wear' WHEN 'normal_use' THEN 'normal_failure' WHEN 'tenant_fault' THEN 'tenant_negligence' WHEN 'malicious_damage' THEN 'intentional_damage' ELSE 'unknown' END,
  liability_party = CASE WHEN damage_type IN ('natural_wear','normal_use') THEN 'none' WHEN responsible_party = 'landlord' THEN 'landlord' WHEN responsible_party = 'tenant' THEN 'tenant' WHEN responsible_party = 'shared' THEN 'shared' ELSE 'review_required' END,
  dispatch_party = CASE repair_executor WHEN 'landlord' THEN 'landlord' WHEN 'tenant' THEN 'tenant' WHEN 'vendor' THEN 'vendor' ELSE 'review_required' END
WHERE cause_classification IS NULL OR liability_party IS NULL OR dispatch_party IS NULL;
UPDATE repair_tickets SET cause_classification = CASE damage_type WHEN 'natural_wear' THEN 'natural_wear' WHEN 'normal_use' THEN 'normal_failure' WHEN 'tenant_fault' THEN 'tenant_negligence' WHEN 'malicious_damage' THEN 'intentional_damage' ELSE 'unknown' END
WHERE cause_classification IS NULL OR cause_classification = 'unknown';
CREATE INDEX idx_lease_repair_rules_semantic ON lease_repair_rules(lease_id, rental_unit_id, asset_id, cause_classification, status);
CREATE INDEX idx_repair_ai_assessments_semantic ON repair_ai_assessments(repair_ticket_id, cause_classification, liability_party, created_at);
