-- The workflow state belongs to the repair ticket.  AI recommendations live
-- on repair_ai_assessments, while this column stores the dispatch party that
-- the landlord and tenant actually selected for this case.
ALTER TABLE repair_tickets ADD COLUMN dispatch_party TEXT NOT NULL DEFAULT 'review_required';

UPDATE repair_tickets
SET dispatch_party = CASE
  WHEN status IN ('tenant_self_repair') THEN 'tenant'
  WHEN status IN ('landlord_repair', 'landlord_completed', 'repair_completed') THEN 'landlord'
  ELSE 'review_required'
END
WHERE dispatch_party = 'review_required';
