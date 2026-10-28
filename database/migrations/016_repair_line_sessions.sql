CREATE TABLE repair_line_sessions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  line_identity_id INTEGER NOT NULL REFERENCES line_identities(id),
  repair_ticket_id INTEGER REFERENCES repair_tickets(id),
  lease_id INTEGER REFERENCES leases(id),
  rental_unit_id INTEGER REFERENCES rental_units(id),
  flow_type TEXT NOT NULL CHECK (flow_type IN ('repair_report', 'repair_close')),
  step_code TEXT NOT NULL CHECK (step_code IN ('await_description', 'collecting_photos', 'await_completion_photo', 'await_tenant_confirmation')),
  context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  finished_at TEXT,
  finish_reason TEXT,
  CHECK (expires_at > started_at),
  CHECK ((finished_at IS NULL) = (finish_reason IS NULL))
);

CREATE UNIQUE INDEX uq_repair_line_sessions_active_identity
ON repair_line_sessions(line_identity_id)
WHERE finished_at IS NULL;

CREATE INDEX idx_repair_line_sessions_ticket
ON repair_line_sessions(repair_ticket_id)
WHERE repair_ticket_id IS NOT NULL;

CREATE INDEX idx_repair_line_sessions_expiry
ON repair_line_sessions(expires_at)
WHERE finished_at IS NULL;
