-- Guided pre-inspection: each session snapshots its own inspection checklist.
-- Existing free-form entries remain valid; new entries may optionally point at one item.
CREATE TABLE IF NOT EXISTS pre_inspection_items (
  id BIGINT NOT NULL AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  item_key VARCHAR(191) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'listing_reference',
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  note TEXT NULL,
  completed_at DATETIME NULL,
  skipped_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pre_inspection_items_session_key (session_id, item_key),
  KEY idx_pre_inspection_items_session_status (session_id, status, sort_order, id)
);

ALTER TABLE pre_inspection_entries
  ADD COLUMN inspection_item_id BIGINT NULL;

-- TiDB validates an index target before applying a sibling ADD COLUMN in the
-- same ALTER statement. Keep these DDL operations separate so a fresh schema
-- and a partially-created migration can both finish safely.
CREATE INDEX idx_pre_inspection_entries_item
  ON pre_inspection_entries (inspection_item_id, id);
