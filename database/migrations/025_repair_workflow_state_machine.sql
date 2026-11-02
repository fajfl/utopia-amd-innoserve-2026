-- Explicit workflow dimensions for repair execution.  These values are kept
-- separate from the legacy repair_tickets.status column during the MVP so
-- old LINE flows remain compatible.

ALTER TABLE repair_tickets ADD COLUMN repair_status TEXT NOT NULL DEFAULT 'reported';
ALTER TABLE repair_tickets ADD COLUMN appointment_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE repair_tickets ADD COLUMN repair_verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE repair_tickets ADD COLUMN safety_status TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE repair_tickets ADD COLUMN action_owner TEXT NOT NULL DEFAULT 'landlord';
ALTER TABLE repair_tickets ADD COLUMN waiting_on TEXT NOT NULL DEFAULT 'none';
ALTER TABLE repair_tickets ADD COLUMN dispute_scope TEXT;

UPDATE repair_tickets
SET repair_status = CASE
  WHEN status IN ('landlord_completed', 'repair_completed', 'tenant_confirmed') THEN 'completed'
  WHEN status IN ('accepted', 'in_progress', 'tenant_self_repair', 'tenant_pays', 'reopened') THEN 'awaiting_execution'
  ELSE 'reported'
END,
safety_status = CASE
  WHEN priority = 'urgent' THEN 'urgent_detected'
  ELSE 'normal'
END,
action_owner = CASE
  WHEN status IN ('need_info', 'tenant_pays', 'tenant_self_repair') THEN 'tenant'
  WHEN status IN ('vendor_judgement') THEN 'landlord'
  WHEN status IN ('tenant_confirmed', 'cancelled') THEN 'none'
  ELSE 'landlord'
END,
waiting_on = CASE
  WHEN status = 'need_info' THEN 'tenant'
  WHEN status = 'vendor_judgement' THEN 'vendor'
  WHEN status IN ('tenant_pays', 'tenant_self_repair') THEN 'tenant'
  ELSE 'none'
END,
repair_verification_status = CASE
  WHEN status = 'tenant_confirmed' THEN 'confirmed'
  WHEN status = 'cancelled' THEN 'not_required'
  ELSE 'pending'
END;
