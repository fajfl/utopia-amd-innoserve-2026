CREATE TABLE IF NOT EXISTS renewal_line_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  line_identity_id INTEGER NOT NULL REFERENCES line_identities(id),
  renewal_request_id INTEGER NOT NULL REFERENCES renewal_requests(id),
  step_code TEXT NOT NULL CHECK (step_code IN ('awaiting_input', 'awaiting_confirmation')),
  input_text TEXT,
  draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  finished_at TEXT,
  finish_reason TEXT,
  CHECK ((finished_at IS NULL) = (finish_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_renewal_line_sessions_identity_active
  ON renewal_line_sessions(line_identity_id, finished_at, id);
