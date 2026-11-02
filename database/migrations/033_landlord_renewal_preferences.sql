CREATE TABLE IF NOT EXISTS landlord_renewal_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  landlord_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  unchanged_terms_negotiable INTEGER NOT NULL DEFAULT 0
    CHECK (unchanged_terms_negotiable IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
