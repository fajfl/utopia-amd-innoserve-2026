ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS tenant_reported_cost_amount BIGINT NULL;
