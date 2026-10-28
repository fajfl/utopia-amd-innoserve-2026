-- TiDB / MySQL dialect migration for Entry-Condition Inspection (屋況點交)
CREATE TABLE IF NOT EXISTS pre_inspection_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id VARCHAR(100) NOT NULL UNIQUE,
  listing_id BIGINT,
  inquiry_id BIGINT,
  line_user_id VARCHAR(128) NOT NULL,
  record_type VARCHAR(32) NOT NULL,
  parent_session_id BIGINT,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  title VARCHAR(255),
  confirmation_status VARCHAR(32) DEFAULT 'not_sent',
  started_at DATETIME,
  sealed_at DATETIME,
  submitted_to_landlord_at DATETIME,
  landlord_confirmed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pre_insp_parent FOREIGN KEY (parent_session_id) REFERENCES pre_inspection_sessions(id) ON DELETE SET NULL,
  INDEX idx_pre_inspection_sessions_line_user (line_user_id, status)
);

CREATE TABLE IF NOT EXISTS pre_inspection_entries (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  entry_type VARCHAR(32) NOT NULL,
  message_text TEXT,
  file_id BIGINT,
  line_message_id VARCHAR(128),
  storage_path VARCHAR(512),
  public_url VARCHAR(512),
  mime_type VARCHAR(128),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pre_insp_entries_session FOREIGN KEY (session_id) REFERENCES pre_inspection_sessions(id) ON DELETE CASCADE,
  INDEX idx_pre_inspection_entries_session (session_id)
);
