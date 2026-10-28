-- Keep repair completion, settlement and final case closure as separate states.
-- A repair can be physically complete while the cost or reimbursement remains open.

ALTER TABLE repair_tickets ADD COLUMN liability_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE repair_tickets ADD COLUMN settlement_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE repair_tickets ADD COLUMN case_status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE repair_tickets ADD COLUMN actual_cost_amount INTEGER;
ALTER TABLE repair_tickets ADD COLUMN tenant_liability_amount INTEGER;
ALTER TABLE repair_tickets ADD COLUMN payment_settlement_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE repair_tickets ADD COLUMN settlement_note TEXT;

UPDATE repair_tickets
SET case_status = CASE
  WHEN status IN ('tenant_confirmed', 'cancelled') THEN 'closed'
  ELSE 'open'
END,
settlement_status = CASE
  WHEN status = 'tenant_confirmed' THEN 'not_required'
  ELSE settlement_status
END
WHERE case_status = 'open'
   OR settlement_status = 'pending';
