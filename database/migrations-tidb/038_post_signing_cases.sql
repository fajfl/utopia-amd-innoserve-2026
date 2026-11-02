CREATE TABLE post_signing_previews (
  public_id VARCHAR(80) PRIMARY KEY, contract_id BIGINT NOT NULL, user_id BIGINT NOT NULL, role VARCHAR(20) NOT NULL,
  lease_id BIGINT NOT NULL, version_id BIGINT NULL, document_hash CHAR(64) NULL,
  summary TEXT NOT NULL, occurred_on DATE NOT NULL, urgent INTEGER NOT NULL, photo_ids_json TEXT NOT NULL, citations_json TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE post_signing_cases (
  id BIGINT PRIMARY KEY AUTO_INCREMENT, public_id VARCHAR(80) NOT NULL UNIQUE, preview_id VARCHAR(80) NOT NULL UNIQUE,
  contract_id BIGINT NOT NULL, lease_id BIGINT NOT NULL, version_id BIGINT NULL, document_hash CHAR(64) NULL,
  ticket_id BIGINT NOT NULL UNIQUE, created_by_user_id BIGINT NOT NULL, idempotency_key VARCHAR(100) NOT NULL,
  notification_status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY post_signing_case_key(contract_id, created_by_user_id, idempotency_key)
);
CREATE TABLE post_signing_case_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT, case_id BIGINT NOT NULL, user_id BIGINT NOT NULL, role VARCHAR(20) NOT NULL,
  event_type VARCHAR(30) NOT NULL, message TEXT, proposal_id BIGINT NULL, idempotency_key VARCHAR(100) NOT NULL, payload_hash CHAR(64) NOT NULL,
  notification_status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY post_signing_event_key(case_id, user_id, idempotency_key)
);
CREATE TABLE post_signing_photos (
  file_id BIGINT NOT NULL, contract_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
  PRIMARY KEY(file_id, contract_id, user_id)
);
