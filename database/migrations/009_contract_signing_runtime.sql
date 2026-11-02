CREATE TABLE contract_reading_sessions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  signature_request_id INTEGER NOT NULL UNIQUE REFERENCES signature_requests(id) ON DELETE CASCADE,
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reached_end_at TEXT,
  last_progress INTEGER NOT NULL DEFAULT 0 CHECK (last_progress BETWEEN 0 AND 100),
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contract_reading_sessions_party
ON contract_reading_sessions(contract_party_id, last_seen_at DESC);

DROP TRIGGER trg_signature_document_hash;
DROP TRIGGER trg_contract_version_immutable_update;
DROP TRIGGER trg_contract_version_immutable_delete;

ALTER TABLE signature_records RENAME TO signature_records_legacy_009;

CREATE TABLE signature_records (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  signature_request_id INTEGER NOT NULL UNIQUE REFERENCES signature_requests(id),
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  contract_party_id INTEGER NOT NULL REFERENCES contract_parties(id),
  signature_file_id INTEGER REFERENCES files(id),
  strokes_file_id INTEGER REFERENCES files(id),
  document_hash TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  verification_challenge_id INTEGER REFERENCES verification_challenges(id),
  signed_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contract_version_id, contract_party_id)
);

INSERT INTO signature_records (
  id, public_id, signature_request_id, contract_version_id, contract_party_id,
  signature_file_id, strokes_file_id, document_hash, signature_hash,
  verification_challenge_id, signed_at, ip_address, user_agent, created_at
)
SELECT
  id, public_id, signature_request_id, contract_version_id, contract_party_id,
  signature_file_id, strokes_file_id, document_hash, signature_hash,
  verification_challenge_id, signed_at, ip_address, user_agent, created_at
FROM signature_records_legacy_009;

DROP TABLE signature_records_legacy_009;

CREATE TRIGGER trg_signature_document_hash
BEFORE INSERT ON signature_records
WHEN NOT EXISTS (
  SELECT 1 FROM contract_versions
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
