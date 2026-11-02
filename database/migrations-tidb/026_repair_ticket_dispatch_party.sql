-- The selected execution party is case state, not an AI recommendation.
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS dispatch_party VARCHAR(32) NOT NULL DEFAULT 'review_required';

UPDATE repair_tickets
SET dispatch_party = CASE
  WHEN status IN ('tenant_self_repair') THEN 'tenant'
  WHEN status IN ('landlord_repair', 'landlord_completed', 'repair_completed') THEN 'landlord'
  ELSE 'review_required'
END
WHERE dispatch_party = 'review_required';
