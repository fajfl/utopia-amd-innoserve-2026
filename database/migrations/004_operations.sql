CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL UNIQUE,
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local', 's3', 'gcs', 'azure', 'other')),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256_hash TEXT NOT NULL,
  security_classification TEXT NOT NULL CHECK (security_classification IN ('public', 'internal', 'private', 'sensitive_contract')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'quarantined', 'deleted', 'purged')),
  deleted_at TEXT,
  purged_at TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sha256_hash, size_bytes, security_classification)
);

CREATE TABLE file_links (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'message', 'listing_snapshot', 'listing_media', 'contract_version',
    'signature_record', 'receipt', 'repair_update', 'inspection_evidence',
    'contract_review_run', 'support_message'
  )),
  entity_id INTEGER NOT NULL,
  purpose TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (file_id, entity_type, entity_id, purpose)
);

CREATE TABLE billing_charges (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  lease_id INTEGER NOT NULL REFERENCES leases(id),
  charge_type TEXT NOT NULL CHECK (charge_type IN ('rent', 'management_fee', 'water', 'electricity', 'gas', 'parking', 'repair', 'other')),
  billing_period_start TEXT NOT NULL,
  billing_period_end TEXT NOT NULL,
  due_date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partially_paid', 'paid', 'overdue', 'waived', 'cancelled')),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (billing_period_end >= billing_period_start)
);

CREATE TABLE payment_records (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  billing_charge_id INTEGER NOT NULL REFERENCES billing_charges(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_at TEXT NOT NULL,
  method_label TEXT NOT NULL,
  reference TEXT,
  recorded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'confirmed', 'reversed')),
  reversed_payment_id INTEGER REFERENCES payment_records(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  payment_record_id INTEGER NOT NULL UNIQUE REFERENCES payment_records(id),
  receipt_number TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  issued_by_user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE utility_meters (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id),
  meter_type TEXT NOT NULL CHECK (meter_type IN ('water', 'electricity', 'gas', 'other')),
  label TEXT NOT NULL,
  unit_of_measure TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'replaced')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (rental_unit_id, meter_type, label)
);

CREATE TABLE utility_readings (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  utility_meter_id INTEGER NOT NULL REFERENCES utility_meters(id),
  reading_value REAL NOT NULL CHECK (reading_value >= 0),
  reading_at TEXT NOT NULL,
  recorded_by_user_id INTEGER REFERENCES users(id),
  photo_file_id INTEGER REFERENCES files(id),
  correction_of_reading_id INTEGER REFERENCES utility_readings(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (utility_meter_id, reading_at, correction_of_reading_id)
);

CREATE TABLE utility_allocations (
  id INTEGER PRIMARY KEY,
  utility_reading_from_id INTEGER REFERENCES utility_readings(id),
  utility_reading_to_id INTEGER NOT NULL REFERENCES utility_readings(id),
  lease_id INTEGER NOT NULL REFERENCES leases(id),
  billing_charge_id INTEGER REFERENCES billing_charges(id),
  usage_amount REAL NOT NULL CHECK (usage_amount >= 0),
  allocated_amount INTEGER CHECK (allocated_amount IS NULL OR allocated_amount >= 0),
  allocation_method TEXT NOT NULL CHECK (allocation_method IN ('direct', 'ratio', 'manual')),
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repair_tickets (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  lease_id INTEGER NOT NULL REFERENCES leases(id),
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'accepted', 'rejected', 'in_progress', 'landlord_completed', 'tenant_confirmed', 'reopened', 'cancelled')),
  reported_by_user_id INTEGER NOT NULL REFERENCES users(id),
  assigned_owner_user_id INTEGER REFERENCES users(id),
  reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repair_updates (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  repair_ticket_id INTEGER NOT NULL REFERENCES repair_tickets(id),
  update_type TEXT NOT NULL CHECK (update_type IN ('message', 'status_change', 'photo', 'appointment', 'completion_note')),
  from_status TEXT,
  to_status TEXT,
  message_text TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repair_confirmations (
  id INTEGER PRIMARY KEY,
  repair_ticket_id INTEGER NOT NULL REFERENCES repair_tickets(id),
  confirmed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('resolved', 'still_has_problem')),
  note TEXT,
  confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE inspection_checklists (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  lease_id INTEGER NOT NULL REFERENCES leases(id),
  checklist_type TEXT NOT NULL CHECK (checklist_type IN ('move_in', 'move_out')),
  scheduled_at TEXT,
  performed_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_progress', 'awaiting_confirmation', 'confirmed', 'cancelled')),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (lease_id, checklist_type)
);

CREATE TABLE inspection_items (
  id INTEGER PRIMARY KEY,
  inspection_checklist_id INTEGER NOT NULL REFERENCES inspection_checklists(id) ON DELETE CASCADE,
  area_label TEXT NOT NULL,
  item_label TEXT NOT NULL,
  condition_code TEXT NOT NULL CHECK (condition_code IN ('new', 'good', 'used', 'damaged', 'missing', 'not_applicable')),
  note TEXT,
  comparison_result TEXT CHECK (comparison_result IS NULL OR comparison_result IN ('same', 'improved', 'normal_wear', 'damaged', 'missing')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE inspection_evidence (
  id INTEGER PRIMARY KEY,
  inspection_item_id INTEGER NOT NULL REFERENCES inspection_items(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id),
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('photo', 'video', 'document')),
  captured_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (inspection_item_id, file_id)
);

CREATE TABLE inspection_confirmations (
  id INTEGER PRIMARY KEY,
  inspection_checklist_id INTEGER NOT NULL REFERENCES inspection_checklists(id),
  contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  result TEXT NOT NULL CHECK (result IN ('confirmed', 'disputed')),
  note TEXT,
  confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (inspection_checklist_id, contract_party_id)
);

CREATE TABLE deposit_settlements (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  lease_id INTEGER NOT NULL UNIQUE REFERENCES leases(id),
  deposit_amount INTEGER NOT NULL CHECK (deposit_amount >= 0),
  proposed_return_amount INTEGER CHECK (proposed_return_amount IS NULL OR proposed_return_amount >= 0),
  actual_return_amount INTEGER CHECK (actual_return_amount IS NULL OR actual_return_amount >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proposed', 'disputed', 'agreed', 'returned', 'closed')),
  proposed_at TEXT,
  returned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE deposit_deductions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  deposit_settlement_id INTEGER NOT NULL REFERENCES deposit_settlements(id) ON DELETE CASCADE,
  deduction_type TEXT NOT NULL CHECK (deduction_type IN ('damage', 'unpaid_charge', 'cleaning', 'missing_item', 'other')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  evidence_summary TEXT,
  proposed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'disputed', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE deduction_assessments (
  id INTEGER PRIMARY KEY,
  deposit_deduction_id INTEGER NOT NULL REFERENCES deposit_deductions(id),
  assessor_type TEXT NOT NULL CHECK (assessor_type IN ('ai', 'rules', 'manual')),
  assessment_result TEXT NOT NULL CHECK (assessment_result IN ('insufficient_information', 'possibly_reasonable', 'needs_review', 'not_assessed')),
  reasoning TEXT,
  rule_references_json TEXT,
  reviewed_by_user_id INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  template_code TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE notification_deliveries (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  notification_id INTEGER NOT NULL REFERENCES notifications(id),
  recipient_user_id INTEGER REFERENCES users(id),
  recipient_line_identity_id INTEGER REFERENCES line_identities(id),
  channel TEXT NOT NULL CHECK (channel IN ('line', 'sms', 'email', 'dashboard')),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (recipient_user_id IS NOT NULL OR recipient_line_identity_id IS NOT NULL)
);

CREATE TABLE notification_delivery_attempts (
  id INTEGER PRIMARY KEY,
  notification_delivery_id INTEGER NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  provider_response_json TEXT,
  error_summary TEXT,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (notification_delivery_id, attempt_number)
);

CREATE TABLE calendar_events (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('showing', 'rent_due', 'contract_expiry', 'renewal_reminder', 'repair_appointment', 'inspection')),
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  listing_id INTEGER REFERENCES listings(id),
  inquiry_id INTEGER REFERENCES inquiries(id),
  contract_id INTEGER REFERENCES contracts(id),
  lease_id INTEGER REFERENCES leases(id),
  repair_ticket_id INTEGER REFERENCES repair_tickets(id),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

CREATE TABLE retention_policies (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  retention_years INTEGER NOT NULL CHECK (retention_years BETWEEN 1 AND 15),
  policy_type TEXT NOT NULL CHECK (policy_type IN ('default', 'paid_extension', 'legal_hold')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE retention_assignments (
  id INTEGER PRIMARY KEY,
  retention_policy_id INTEGER NOT NULL REFERENCES retention_policies(id),
  contract_id INTEGER REFERENCES contracts(id),
  lease_id INTEGER REFERENCES leases(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('contract', 'lease', 'evidence_package')),
  entity_id INTEGER NOT NULL,
  retention_until TEXT NOT NULL,
  legal_hold INTEGER NOT NULL DEFAULT 0 CHECK (legal_hold IN (0, 1)),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_type, entity_id)
);

CREATE TABLE data_purge_jobs (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  retention_assignment_id INTEGER NOT NULL REFERENCES retention_assignments(id),
  action TEXT NOT NULL CHECK (action IN ('preview', 'archive', 'purge')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'review_required', 'approved', 'running', 'completed', 'failed', 'cancelled')),
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE support_requests (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  requester_user_id INTEGER NOT NULL REFERENCES users(id),
  assigned_user_id INTEGER REFERENCES users(id),
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_requester', 'resolved', 'closed')),
  listing_id INTEGER REFERENCES listings(id),
  inquiry_id INTEGER REFERENCES inquiries(id),
  contract_id INTEGER REFERENCES contracts(id),
  lease_id INTEGER REFERENCES leases(id),
  billing_charge_id INTEGER REFERENCES billing_charges(id),
  repair_ticket_id INTEGER REFERENCES repair_tickets(id),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE support_messages (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  support_request_id INTEGER NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  sender_user_id INTEGER NOT NULL REFERENCES users(id),
  message_text TEXT NOT NULL,
  is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE help_articles (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  published_at TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (slug, version_number)
);

CREATE INDEX idx_billing_charges_lease_due ON billing_charges(lease_id, due_date, status);
CREATE INDEX idx_payments_charge_paid ON payment_records(billing_charge_id, paid_at);
CREATE INDEX idx_utility_readings_meter_time ON utility_readings(utility_meter_id, reading_at DESC);
CREATE INDEX idx_repairs_unit_status ON repair_tickets(rental_unit_id, status, reported_at);
CREATE INDEX idx_inspections_lease_type ON inspection_checklists(lease_id, checklist_type);
CREATE INDEX idx_deliveries_status_schedule ON notification_deliveries(status, scheduled_at);
CREATE INDEX idx_calendar_event_start ON calendar_events(event_type, starts_at);
CREATE INDEX idx_support_status_priority ON support_requests(status, priority, created_at);
