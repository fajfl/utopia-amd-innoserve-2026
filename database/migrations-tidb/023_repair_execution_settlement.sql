ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS liability_status VARCHAR(32) NOT NULL DEFAULT 'pending';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(32) NOT NULL DEFAULT 'pending';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS case_status VARCHAR(32) NOT NULL DEFAULT 'open';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS actual_cost_amount BIGINT NULL;
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS tenant_liability_amount BIGINT NULL;
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS payment_settlement_method VARCHAR(32) NOT NULL DEFAULT 'none';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS settlement_note LONGTEXT NULL;
UPDATE repair_tickets SET case_status = CASE WHEN status IN ('tenant_confirmed','cancelled') THEN 'closed' ELSE 'open' END,
  settlement_status = CASE WHEN status = 'tenant_confirmed' THEN 'not_required' ELSE settlement_status END
WHERE case_status = 'open' OR settlement_status = 'pending';
