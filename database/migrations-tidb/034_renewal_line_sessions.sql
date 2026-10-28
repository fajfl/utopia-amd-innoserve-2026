CREATE TABLE IF NOT EXISTS renewal_line_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(191) NOT NULL,
  line_identity_id BIGINT NOT NULL,
  renewal_request_id BIGINT NOT NULL,
  step_code VARCHAR(32) NOT NULL,
  input_text TEXT NULL,
  draft_json JSON NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  finish_reason VARCHAR(32) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_renewal_line_sessions_public_id (public_id),
  KEY idx_renewal_line_sessions_identity_active (line_identity_id, finished_at, id)
);
