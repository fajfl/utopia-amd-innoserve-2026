-- Amount reported by the person who completed the repair. This is evidence
-- for landlord settlement review, not a confirmed final settlement.
ALTER TABLE repair_tickets
  ADD COLUMN tenant_reported_cost_amount INTEGER;
