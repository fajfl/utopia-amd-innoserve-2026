ALTER TABLE pre_inspection_sessions ADD COLUMN confirmation_status TEXT DEFAULT 'not_sent';
ALTER TABLE pre_inspection_sessions ADD COLUMN submitted_to_landlord_at TEXT;
ALTER TABLE pre_inspection_sessions ADD COLUMN landlord_confirmed_at TEXT;
