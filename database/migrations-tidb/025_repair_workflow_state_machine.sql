ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS repair_status VARCHAR(32) NOT NULL DEFAULT 'reported';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS appointment_status VARCHAR(32) NOT NULL DEFAULT 'not_required';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS repair_verification_status VARCHAR(32) NOT NULL DEFAULT 'pending';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS safety_status VARCHAR(32) NOT NULL DEFAULT 'normal';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS action_owner VARCHAR(32) NOT NULL DEFAULT 'landlord';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS waiting_on VARCHAR(32) NOT NULL DEFAULT 'none';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS dispute_scope VARCHAR(32) NULL;
UPDATE repair_tickets SET repair_status = CASE
  WHEN status IN ('landlord_completed','repair_completed','tenant_confirmed') THEN 'completed'
  WHEN status IN ('accepted','in_progress','tenant_self_repair','tenant_pays','reopened') THEN 'awaiting_execution' ELSE 'reported' END,
  safety_status = CASE WHEN priority = 'urgent' THEN 'urgent_detected' ELSE 'normal' END,
  action_owner = CASE WHEN status IN ('need_info','tenant_pays','tenant_self_repair','vendor_judgement') THEN 'landlord' WHEN status IN ('tenant_confirmed','cancelled') THEN 'none' ELSE 'landlord' END,
  waiting_on = CASE WHEN status = 'need_info' THEN 'tenant' WHEN status = 'vendor_judgement' THEN 'vendor' WHEN status IN ('tenant_pays','tenant_self_repair') THEN 'tenant' ELSE 'none' END,
  repair_verification_status = CASE WHEN status = 'tenant_confirmed' THEN 'confirmed' WHEN status = 'cancelled' THEN 'not_required' ELSE 'pending' END;
