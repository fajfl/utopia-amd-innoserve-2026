-- TiDB counterpart of the repair LINE session store.
-- Active-session uniqueness is enforced by the application for this MVP;
-- TiDB does not support SQLite's partial unique-index syntax.
CREATE TABLE IF NOT EXISTS repair_line_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id VARCHAR(191) NOT NULL UNIQUE,
  line_identity_id BIGINT NOT NULL,
  repair_ticket_id BIGINT NULL,
  lease_id BIGINT NULL,
  rental_unit_id BIGINT NULL,
  flow_type VARCHAR(32) NOT NULL,
  step_code VARCHAR(64) NOT NULL,
  context_json LONGTEXT NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  finish_reason VARCHAR(255) NULL,
  KEY idx_repair_line_sessions_identity (line_identity_id, finished_at),
  KEY idx_repair_line_sessions_ticket (repair_ticket_id),
  KEY idx_repair_line_sessions_expiry (expires_at, finished_at)
);
