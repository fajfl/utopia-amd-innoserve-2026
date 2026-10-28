CREATE TABLE line_flow_sessions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  line_identity_id INTEGER NOT NULL REFERENCES line_identities(id),
  flow_type TEXT NOT NULL CHECK (flow_type IN ('landlord_knowledge')),
  listing_id INTEGER REFERENCES listings(id),
  step_code TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT,
  finish_reason TEXT,
  CHECK (expires_at > started_at),
  CHECK ((finished_at IS NULL) = (finish_reason IS NULL))
);

CREATE UNIQUE INDEX uq_line_flow_sessions_active_identity
ON line_flow_sessions(line_identity_id)
WHERE finished_at IS NULL;

CREATE INDEX idx_line_flow_sessions_expiry
ON line_flow_sessions(expires_at)
WHERE finished_at IS NULL;
