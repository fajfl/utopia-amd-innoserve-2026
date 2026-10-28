-- Guided pre-inspection: each session snapshots its own inspection checklist.
-- Existing free-form entries remain valid; new entries may optionally point at one item.
CREATE TABLE IF NOT EXISTS pre_inspection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  item_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'listing_reference'
    CHECK (source IN ('unit_amenity', 'listing_reference', 'tenant_added')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'skipped', 'not_present')),
  note TEXT,
  completed_at TEXT,
  skipped_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, item_key),
  FOREIGN KEY (session_id) REFERENCES pre_inspection_sessions(id)
);

ALTER TABLE pre_inspection_entries ADD COLUMN inspection_item_id INTEGER
  REFERENCES pre_inspection_items(id);

CREATE INDEX IF NOT EXISTS idx_pre_inspection_items_session_status
  ON pre_inspection_items(session_id, status, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_pre_inspection_entries_item
  ON pre_inspection_entries(inspection_item_id, id);
