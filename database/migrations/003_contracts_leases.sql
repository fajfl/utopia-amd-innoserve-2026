CREATE TABLE contracts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id),
  selected_intention_id INTEGER REFERENCES rental_intentions(id),
  source_inquiry_id INTEGER REFERENCES inquiries(id),
  renewed_from_contract_id INTEGER REFERENCES contracts(id),
  status TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting', 'awaiting_confirmation', 'signing', 'executed', 'cancelled', 'superseded')),
  executed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'executed') = (executed_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_contracts_active_signing_unit
ON contracts(rental_unit_id)
WHERE status = 'signing';

CREATE TABLE contract_versions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  condition_snapshot_json TEXT NOT NULL,
  document_file_id INTEGER,
  document_hash TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'superseded', 'executed')),
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contract_id, version_number)
);

CREATE TABLE contract_version_sources (
  id INTEGER PRIMARY KEY,
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('intention_version', 'message', 'listing_snapshot', 'knowledge_version', 'manual_input')),
  source_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contract_version_id, field_path, source_type, source_id)
);

CREATE TABLE contract_parties (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  user_id INTEGER REFERENCES users(id),
  organization_id INTEGER REFERENCES organizations(id),
  party_role TEXT NOT NULL CHECK (party_role IN ('landlord', 'tenant', 'guarantor', 'agent', 'witness')),
  required_signer INTEGER NOT NULL DEFAULT 1 CHECK (required_signer IN (0, 1)),
  signing_order INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'declined')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL),
  UNIQUE (contract_id, party_role, user_id, organization_id)
);

CREATE TABLE contract_party_snapshots (
  id INTEGER PRIMARY KEY,
  contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  legal_name TEXT NOT NULL,
  display_name TEXT,
  phone TEXT,
  email TEXT,
  contact_address TEXT,
  masked_identifier TEXT,
  party_role TEXT NOT NULL,
  snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contract_party_id, contract_version_id)
);

CREATE TABLE signature_requests (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'expired', 'cancelled', 'declined')),
  verification_required INTEGER NOT NULL DEFAULT 1 CHECK (verification_required IN (0, 1)),
  expires_at TEXT,
  sent_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contract_version_id, contract_party_id)
);

CREATE TABLE signature_records (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  signature_request_id INTEGER NOT NULL UNIQUE REFERENCES signature_requests(id),
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  signature_file_id INTEGER,
  strokes_file_id INTEGER,
  document_hash TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  verification_challenge_id INTEGER REFERENCES verification_challenges(id),
  signed_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contract_version_id, contract_party_id)
);

CREATE TABLE contract_status_history (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contract_review_runs (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('ai', 'rules', 'manual')),
  model_or_rule_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  raw_result_file_id INTEGER,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contract_review_findings (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_review_run_id INTEGER NOT NULL REFERENCES contract_review_runs(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL CHECK (finding_type IN ('missing', 'risk', 'inconsistency', 'notice')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high')),
  clause_path TEXT,
  description TEXT NOT NULL,
  human_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (human_status IN ('unreviewed', 'acknowledged', 'resolved', 'dismissed')),
  reviewed_by_user_id INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE review_finding_sources (
  id INTEGER PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES contract_review_findings(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('contract_clause', 'rule_version', 'legal_reference', 'manual_note')),
  source_reference TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (finding_id, source_type, source_reference)
);

CREATE TABLE leases (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_id INTEGER NOT NULL UNIQUE REFERENCES contracts(id),
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id),
  previous_lease_id INTEGER REFERENCES leases(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  rent_due_day INTEGER CHECK (rent_due_day IS NULL OR rent_due_day BETWEEN 1 AND 31),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'ended', 'terminated', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_date >= start_date)
);

CREATE TABLE lease_parties (
  id INTEGER PRIMARY KEY,
  lease_id INTEGER NOT NULL REFERENCES leases(id),
  contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  user_id INTEGER REFERENCES users(id),
  party_role TEXT NOT NULL CHECK (party_role IN ('landlord', 'tenant', 'guarantor', 'agent', 'witness')),
  effective_from TEXT NOT NULL,
  effective_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  UNIQUE (lease_id, contract_party_id)
);

CREATE TABLE contract_action_requests (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  lease_id INTEGER REFERENCES leases(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('renewal', 'termination', 'amendment')),
  requested_by_contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  proposed_effective_date TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn', 'completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE contract_action_history (
  id INTEGER PRIMARY KEY,
  contract_action_request_id INTEGER NOT NULL REFERENCES contract_action_requests(id),
  action TEXT NOT NULL CHECK (action IN ('created', 'accepted', 'rejected', 'withdrawn', 'completed')),
  actor_user_id INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE renewal_requests (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_action_request_id INTEGER NOT NULL UNIQUE REFERENCES contract_action_requests(id),
  lease_id INTEGER NOT NULL REFERENCES leases(id),
  initiated_by TEXT NOT NULL CHECK (initiated_by IN ('tenant', 'landlord', 'system_reminder')),
  landlord_willing INTEGER CHECK (landlord_willing IS NULL OR landlord_willing IN (0, 1)),
  current_terms_reusable INTEGER CHECK (current_terms_reusable IS NULL OR current_terms_reusable IN (0, 1)),
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE renewal_proposals (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  renewal_request_id INTEGER NOT NULL REFERENCES renewal_requests(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  proposed_start_date TEXT NOT NULL,
  proposed_end_date TEXT NOT NULL,
  rent_amount INTEGER NOT NULL CHECK (rent_amount >= 0),
  deposit_amount INTEGER CHECK (deposit_amount IS NULL OR deposit_amount >= 0),
  terms_json TEXT,
  proposed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (proposed_end_date >= proposed_start_date),
  UNIQUE (renewal_request_id, version_number)
);

CREATE TABLE renewal_decisions (
  id INTEGER PRIMARY KEY,
  renewal_request_id INTEGER NOT NULL REFERENCES renewal_requests(id),
  renewal_proposal_id INTEGER REFERENCES renewal_proposals(id),
  decided_by_user_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'changes_requested')),
  reason TEXT,
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_signature_request_same_contract
BEFORE INSERT ON signature_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM contract_versions cv
  JOIN contract_parties cp ON cp.contract_id = cv.contract_id
  WHERE cv.id = NEW.contract_version_id AND cp.id = NEW.contract_party_id
)
BEGIN
  SELECT RAISE(ABORT, 'signature party does not belong to contract');
END;

CREATE TRIGGER trg_signature_document_hash
BEFORE INSERT ON signature_records
WHEN NOT EXISTS (
  SELECT 1
  FROM contract_versions
  WHERE id = NEW.contract_version_id AND document_hash = NEW.document_hash
)
BEGIN
  SELECT RAISE(ABORT, 'signature document hash does not match contract version');
END;

CREATE TRIGGER trg_contract_version_immutable_update
BEFORE UPDATE ON contract_versions
WHEN EXISTS (SELECT 1 FROM signature_records WHERE contract_version_id = OLD.id)
  OR EXISTS (SELECT 1 FROM contracts WHERE id = OLD.contract_id AND status = 'executed')
BEGIN
  SELECT RAISE(ABORT, 'signed contract version is immutable');
END;

CREATE TRIGGER trg_contract_version_immutable_delete
BEFORE DELETE ON contract_versions
WHEN EXISTS (SELECT 1 FROM signature_records WHERE contract_version_id = OLD.id)
  OR EXISTS (SELECT 1 FROM contracts WHERE id = OLD.contract_id AND status = 'executed')
BEGIN
  SELECT RAISE(ABORT, 'signed contract version is immutable');
END;

CREATE TRIGGER trg_lease_requires_executed_contract
BEFORE INSERT ON leases
WHEN NOT EXISTS (
  SELECT 1
  FROM contracts
  WHERE id = NEW.contract_id
    AND rental_unit_id = NEW.rental_unit_id
    AND status = 'executed'
)
BEGIN
  SELECT RAISE(ABORT, 'lease requires an executed contract');
END;

CREATE INDEX idx_contracts_unit_status ON contracts(rental_unit_id, status);
CREATE INDEX idx_contract_versions_contract ON contract_versions(contract_id, version_number DESC);
CREATE INDEX idx_signature_requests_status ON signature_requests(status, expires_at);
CREATE INDEX idx_leases_unit_status ON leases(rental_unit_id, status);
CREATE INDEX idx_contract_actions_status ON contract_action_requests(status, request_type);
