CREATE TABLE IF NOT EXISTS inquiry_pending_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  source_message_id INTEGER NOT NULL REFERENCES messages(id),
  original_text TEXT NOT NULL,
  source_field TEXT NOT NULL,
  original_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','included','withdrawn')),
  resolution_message_id INTEGER REFERENCES messages(id),
  resolved_version_id INTEGER REFERENCES intention_versions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  UNIQUE (inquiry_id, source_message_id, source_field, original_hash),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK ((status = 'withdrawn') = (resolution_message_id IS NOT NULL)),
  CHECK ((status = 'included') = (resolved_version_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_inquiry_pending_items_status ON inquiry_pending_items(inquiry_id,status);
