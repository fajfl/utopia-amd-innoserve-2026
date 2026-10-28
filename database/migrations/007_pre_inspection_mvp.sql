CREATE TABLE IF NOT EXISTS pre_inspection_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT UNIQUE NOT NULL,
  listing_id INTEGER,
  inquiry_id INTEGER,
  line_user_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  parent_session_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'sealed', 'cancelled')),
  title TEXT,
  started_at TEXT,
  sealed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_session_id) REFERENCES pre_inspection_sessions(id)
);

CREATE TABLE IF NOT EXISTS pre_inspection_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('text', 'image', 'video', 'audio', 'file')),
  message_text TEXT,
  file_id INTEGER,
  line_message_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES pre_inspection_sessions(id)
);

CREATE INDEX idx_pre_inspection_sessions_line_user ON pre_inspection_sessions(line_user_id, status);
CREATE INDEX idx_pre_inspection_entries_session ON pre_inspection_entries(session_id);
