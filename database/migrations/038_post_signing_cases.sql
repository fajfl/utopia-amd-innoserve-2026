CREATE TABLE post_signing_previews (
  public_id TEXT PRIMARY KEY, contract_id INTEGER NOT NULL REFERENCES contracts(id), user_id INTEGER NOT NULL REFERENCES users(id), role TEXT NOT NULL,
  lease_id INTEGER NOT NULL REFERENCES leases(id), version_id INTEGER REFERENCES contract_versions(id), document_hash TEXT,
  summary TEXT NOT NULL, occurred_on TEXT NOT NULL, urgent INTEGER NOT NULL, photo_ids_json TEXT NOT NULL, citations_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE post_signing_cases (
  id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, preview_id TEXT NOT NULL UNIQUE REFERENCES post_signing_previews(public_id),
  contract_id INTEGER NOT NULL REFERENCES contracts(id), lease_id INTEGER NOT NULL REFERENCES leases(id),
  version_id INTEGER REFERENCES contract_versions(id), document_hash TEXT, ticket_id INTEGER NOT NULL UNIQUE REFERENCES repair_tickets(id),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, notification_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(contract_id, created_by_user_id, idempotency_key)
);
CREATE TABLE post_signing_case_events (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL REFERENCES post_signing_cases(id), user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL, event_type TEXT NOT NULL, message TEXT, proposal_id INTEGER, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  notification_status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(case_id, user_id, idempotency_key)
);
CREATE TABLE post_signing_photos (
  file_id INTEGER NOT NULL REFERENCES files(id), contract_id INTEGER NOT NULL REFERENCES contracts(id), user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY(file_id, contract_id, user_id)
);
