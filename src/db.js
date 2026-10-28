const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const rootDir = path.resolve(__dirname, '..');
// 路徑可被環境變數覆寫,測試才不會在版控中的 data/app.sqlite 上留下改動。
// 沒設的話行為與過去完全相同。
const dbPath = process.env.APP_DATABASE_PATH || path.join(rootDir, 'data', 'app.sqlite');
const dataDir = path.dirname(dbPath);

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS line_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  event_type TEXT,
  source_type TEXT,
  group_id TEXT,
  room_id TEXT,
  user_id TEXT,
  timestamp INTEGER,
  raw_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  group_id TEXT,
  room_id TEXT,
  user_id TEXT,
  message_type TEXT,
  text_content TEXT,
  file_name TEXT,
  file_path TEXT,
  file_mime_type TEXT,
  file_size INTEGER,
  content_hash TEXT,
  line_timestamp INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  line_user_id TEXT NOT NULL UNIQUE,
  line_display_name TEXT,
  line_picture_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  household_address TEXT NOT NULL,
  national_id TEXT,
  email TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS line_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  line_user_id TEXT NOT NULL UNIQUE,
  line_display_name TEXT,
  line_picture_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  household_address TEXT NOT NULL,
  national_id TEXT,
  email TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS postbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT,
  room_id TEXT,
  user_id TEXT,
  postback_data TEXT NOT NULL,
  action TEXT,
  case_id TEXT,
  draft_id TEXT,
  line_timestamp INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT,
  room_id TEXT,
  user_id TEXT,
  source_message_id TEXT,
  command_type TEXT,
  command_text TEXT,
  ai_response TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS negotiation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT,
  requested_by_user_id TEXT,
  source_message_ids_json TEXT,
  summary_json TEXT NOT NULL,
  human_readable_summary TEXT,
  model_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rental_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  case_id TEXT,
  source_message_id INTEGER,
  group_id TEXT,
  room_id TEXT,
  user_id TEXT,
  source TEXT,
  url TEXT,
  price INTEGER,
  title TEXT,
  address TEXT,
  rooms TEXT,
  type TEXT,
  floor TEXT,
  amenities TEXT,
  description TEXT,
  raw_listing_json TEXT,
  detail_items_json TEXT,
  image_urls_json TEXT,
  contact_info_json TEXT,
  nearby_json TEXT,
  partner_metadata_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT UNIQUE NOT NULL,
  line_group_id TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'negotiating',
  title TEXT,
  source_listing_url TEXT,
  current_condition_snapshot_id INTEGER,
  current_draft_version_id INTEGER,
  executed_contract_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS case_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  user_id INTEGER,
  line_user_id TEXT,
  role TEXT NOT NULL,
  display_name_snapshot TEXT,
  legal_name_snapshot TEXT,
  phone_snapshot TEXT,
  household_address_snapshot TEXT,
  national_id_snapshot TEXT,
  email_snapshot TEXT,
  signing_required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS partner_entry_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_code TEXT UNIQUE NOT NULL,
  case_id TEXT NOT NULL,
  listing_row_id INTEGER,
  partner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  bound_line_user_id TEXT,
  bound_at TEXT
);

CREATE TABLE IF NOT EXISTS partner_entry_code_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_code TEXT NOT NULL,
  case_id TEXT NOT NULL,
  listing_row_id INTEGER,
  line_user_id TEXT NOT NULL,
  display_name_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  bound_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entry_code, line_user_id)
);

CREATE TABLE IF NOT EXISTS condition_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  previous_snapshot_id INTEGER,
  trigger_message_id INTEGER,
  group_id TEXT,
  created_by_line_user_id TEXT,
  source_message_ids_json TEXT,
  rental_listing_ids_json TEXT,
  raw_ai_json TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  condition_hash TEXT,
  missing_fields_json TEXT NOT NULL,
  monthly_rent_ntd INTEGER,
  deposit_amount_ntd INTEGER,
  deposit_months REAL,
  payment_due_day INTEGER,
  lease_start_date TEXT,
  lease_end_date TEXT,
  property_address TEXT,
  model_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (previous_snapshot_id) REFERENCES condition_snapshots(id)
);

CREATE TABLE IF NOT EXISTS condition_snapshot_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_snapshot_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  field_path TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(condition_snapshot_id, message_id, field_path),
  FOREIGN KEY (condition_snapshot_id) REFERENCES condition_snapshots(id),
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT,
  uploaded_by_user_id INTEGER,
  category TEXT NOT NULL,
  original_file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256_hash TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  purged_at TEXT,
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS message_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, file_id),
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS draft_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  condition_snapshot_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  contract_html TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  draft_file_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT,
  UNIQUE(case_id, version_number),
  UNIQUE(case_id, draft_id),
  FOREIGN KEY (condition_snapshot_id) REFERENCES condition_snapshots(id),
  FOREIGN KEY (draft_file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS executed_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL UNIQUE,
  source_draft_version_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'executed',
  signed_contract_file_id INTEGER,
  contract_hash TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_draft_version_id) REFERENCES draft_versions(id),
  FOREIGN KEY (signed_contract_file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS signature_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  executed_contract_id INTEGER,
  draft_version_id INTEGER NOT NULL,
  case_participant_id INTEGER NOT NULL,
  signature_image_file_id INTEGER,
  signature_video_file_id INTEGER,
  signature_strokes_file_id INTEGER,
  signature_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  signed_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(draft_version_id, case_participant_id),
  FOREIGN KEY (executed_contract_id) REFERENCES executed_contracts(id),
  FOREIGN KEY (draft_version_id) REFERENCES draft_versions(id),
  FOREIGN KEY (case_participant_id) REFERENCES case_participants(id),
  FOREIGN KEY (signature_image_file_id) REFERENCES files(id),
  FOREIGN KEY (signature_video_file_id) REFERENCES files(id),
  FOREIGN KEY (signature_strokes_file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT,
  executed_contract_id INTEGER,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
  status TEXT NOT NULL DEFAULT 'scheduled',
  recurrence_rule TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TEXT,
  FOREIGN KEY (executed_contract_id) REFERENCES executed_contracts(id)
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_event_id INTEGER NOT NULL,
  recipient_user_id INTEGER,
  recipient_line_user_id TEXT,
  channel TEXT NOT NULL DEFAULT 'line',
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id),
  FOREIGN KEY (recipient_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT,
  uploaded_by_user_id INTEGER,
  category TEXT NOT NULL,
  original_file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256_hash TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  purged_at TEXT,
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS message_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, file_id),
  FOREIGN KEY (message_id) REFERENCES messages(id),
  FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS draft_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  condition_snapshot_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  contract_html TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  draft_file_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  superseded_at TEXT,
  UNIQUE(case_id, version_number),
  UNIQUE(case_id, draft_id),
  FOREIGN KEY (condition_snapshot_id) REFERENCES condition_snapshots(id),
  FOREIGN KEY (draft_file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS executed_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL UNIQUE,
  source_draft_version_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'executed',
  signed_contract_file_id INTEGER,
  contract_hash TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_draft_version_id) REFERENCES draft_versions(id),
  FOREIGN KEY (signed_contract_file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS signature_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  executed_contract_id INTEGER,
  draft_version_id INTEGER NOT NULL,
  case_participant_id INTEGER NOT NULL,
  signature_image_file_id INTEGER,
  signature_video_file_id INTEGER,
  signature_strokes_file_id INTEGER,
  signature_hash TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  signed_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(draft_version_id, case_participant_id),
  FOREIGN KEY (executed_contract_id) REFERENCES executed_contracts(id),
  FOREIGN KEY (draft_version_id) REFERENCES draft_versions(id),
  FOREIGN KEY (case_participant_id) REFERENCES case_participants(id),
  FOREIGN KEY (signature_image_file_id) REFERENCES files(id),
  FOREIGN KEY (signature_video_file_id) REFERENCES files(id),
  FOREIGN KEY (signature_strokes_file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT,
  executed_contract_id INTEGER,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
  status TEXT NOT NULL DEFAULT 'scheduled',
  recurrence_rule TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  cancelled_at TEXT,
  FOREIGN KEY (executed_contract_id) REFERENCES executed_contracts(id)
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_event_id INTEGER NOT NULL,
  recipient_user_id INTEGER,
  recipient_line_user_id TEXT,
  channel TEXT NOT NULL DEFAULT 'line',
  scheduled_at TEXT NOT NULL,
  sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (calendar_event_id) REFERENCES calendar_events(id),
  FOREIGN KEY (recipient_user_id) REFERENCES users(id)
);
`);

function tableColumns(tableName) {
  return db.prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
    .all()
    .map((row) => row.name);
}

function tableExists(tableName) {
  return Boolean(db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = @tableName
  `).get({ tableName }));
}

function addColumnIfMissing(tableName, columnName, columnDefinition) {
  if (!tableExists(tableName)) return;
  if (!tableColumns(tableName).includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

addColumnIfMissing('line_events', 'case_id', 'case_id TEXT');
addColumnIfMissing('line_events', 'raw_json_hash', 'raw_json_hash TEXT');

addColumnIfMissing('messages', 'case_id', 'case_id TEXT');
addColumnIfMissing('messages', 'ai_referenced_count', 'ai_referenced_count INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('messages', 'deleted_at', 'deleted_at TEXT');

addColumnIfMissing('rental_listings', 'case_id', 'case_id TEXT');
addColumnIfMissing('rental_listings', 'source_message_id', 'source_message_id INTEGER');
addColumnIfMissing('rental_listings', 'amenities', 'amenities TEXT');
addColumnIfMissing('rental_listings', 'description', 'description TEXT');
addColumnIfMissing('rental_listings', 'price', 'price INTEGER');
addColumnIfMissing('rental_listings', 'raw_listing_json', 'raw_listing_json TEXT');
addColumnIfMissing('rental_listings', 'detail_items_json', 'detail_items_json TEXT');
addColumnIfMissing('rental_listings', 'image_urls_json', 'image_urls_json TEXT');
addColumnIfMissing('rental_listings', 'contact_info_json', 'contact_info_json TEXT');
addColumnIfMissing('rental_listings', 'nearby_json', 'nearby_json TEXT');
addColumnIfMissing('rental_listings', 'partner_metadata_json', 'partner_metadata_json TEXT');

addColumnIfMissing('partner_entry_codes', 'listing_row_id', 'listing_row_id INTEGER');
addColumnIfMissing('partner_entry_codes', 'expires_at', 'expires_at TEXT');
addColumnIfMissing('partner_entry_codes', 'bound_line_user_id', 'bound_line_user_id TEXT');
addColumnIfMissing('partner_entry_codes', 'bound_at', 'bound_at TEXT');

addColumnIfMissing('partner_entry_code_bindings', 'listing_row_id', 'listing_row_id INTEGER');
addColumnIfMissing('partner_entry_code_bindings', 'display_name_snapshot', 'display_name_snapshot TEXT');
addColumnIfMissing('partner_entry_code_bindings', 'status', "status TEXT NOT NULL DEFAULT 'active'");
addColumnIfMissing('partner_entry_code_bindings', 'bound_at', 'bound_at TEXT');

db.exec(`
UPDATE partner_entry_codes AS duplicate
SET status = 'superseded',
    expires_at = NULL
WHERE status = 'active'
  AND EXISTS (
    SELECT 1
    FROM partner_entry_codes AS canonical
    WHERE canonical.case_id = duplicate.case_id
      AND canonical.listing_row_id IS duplicate.listing_row_id
      AND canonical.partner = duplicate.partner
      AND canonical.status = 'active'
      AND canonical.id < duplicate.id
  );

UPDATE partner_entry_codes
SET expires_at = NULL
WHERE status = 'active';
`);

addColumnIfMissing('cases', 'current_condition_snapshot_id', 'current_condition_snapshot_id INTEGER');
addColumnIfMissing('cases', 'current_draft_version_id', 'current_draft_version_id INTEGER');
addColumnIfMissing('cases', 'executed_contract_id', 'executed_contract_id INTEGER');
addColumnIfMissing('cases', 'closed_at', 'closed_at TEXT');

addColumnIfMissing('condition_snapshots', 'previous_snapshot_id', 'previous_snapshot_id INTEGER');
addColumnIfMissing('condition_snapshots', 'trigger_message_id', 'trigger_message_id INTEGER');
addColumnIfMissing('condition_snapshots', 'condition_hash', 'condition_hash TEXT');
addColumnIfMissing('condition_snapshots', 'monthly_rent_ntd', 'monthly_rent_ntd INTEGER');
addColumnIfMissing('condition_snapshots', 'deposit_amount_ntd', 'deposit_amount_ntd INTEGER');
addColumnIfMissing('condition_snapshots', 'deposit_months', 'deposit_months REAL');
addColumnIfMissing('condition_snapshots', 'payment_due_day', 'payment_due_day INTEGER');
addColumnIfMissing('condition_snapshots', 'lease_start_date', 'lease_start_date TEXT');
addColumnIfMissing('condition_snapshots', 'lease_end_date', 'lease_end_date TEXT');
addColumnIfMissing('condition_snapshots', 'property_address', 'property_address TEXT');

db.exec(`
CREATE INDEX IF NOT EXISTS idx_line_events_case_id ON line_events(case_id);
CREATE INDEX IF NOT EXISTS idx_line_events_group_timestamp ON line_events(group_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_case_timestamp ON messages(case_id, line_timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_ai_referenced ON messages(case_id, ai_referenced_count);
CREATE INDEX IF NOT EXISTS idx_rental_listings_case_id ON rental_listings(case_id);
CREATE INDEX IF NOT EXISTS idx_partner_entry_codes_case_id ON partner_entry_codes(case_id);
CREATE INDEX IF NOT EXISTS idx_partner_entry_codes_bound_user ON partner_entry_codes(bound_line_user_id, bound_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_entry_codes_active_listing
  ON partner_entry_codes(case_id, COALESCE(listing_row_id, -1), partner)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_partner_entry_code_bindings_user ON partner_entry_code_bindings(line_user_id, bound_at);
CREATE INDEX IF NOT EXISTS idx_partner_entry_code_bindings_case ON partner_entry_code_bindings(case_id, listing_row_id);
CREATE INDEX IF NOT EXISTS idx_case_participants_case_role ON case_participants(case_id, role, status);
CREATE INDEX IF NOT EXISTS idx_condition_snapshots_case_id ON condition_snapshots(case_id);
CREATE INDEX IF NOT EXISTS idx_condition_snapshot_sources_message_id ON condition_snapshot_sources(message_id);
CREATE INDEX IF NOT EXISTS idx_condition_snapshot_sources_field ON condition_snapshot_sources(condition_snapshot_id, field_path);
CREATE INDEX IF NOT EXISTS idx_message_files_message_id ON message_files(message_id);
CREATE INDEX IF NOT EXISTS idx_message_files_file_id ON message_files(file_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_case_time ON calendar_events(case_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_contract_time ON calendar_events(executed_contract_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_notification_logs_event_status ON notification_logs(calendar_event_id, status);

UPDATE cases
SET status = 'negotiating'
WHERE status = 'active';

UPDATE messages
SET case_id = (
  SELECT cases.case_id
  FROM cases
  WHERE cases.line_group_id = messages.group_id
)
WHERE case_id IS NULL
  AND group_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM cases WHERE cases.line_group_id = messages.group_id
  );

UPDATE line_events
SET case_id = (
  SELECT cases.case_id
  FROM cases
  WHERE cases.line_group_id = line_events.group_id
)
WHERE case_id IS NULL
  AND group_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM cases WHERE cases.line_group_id = line_events.group_id
  );

UPDATE rental_listings
SET case_id = (
  SELECT cases.case_id
  FROM cases
  WHERE cases.line_group_id = rental_listings.group_id
)
WHERE case_id IS NULL
  AND group_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM cases WHERE cases.line_group_id = rental_listings.group_id
  );

INSERT OR IGNORE INTO files (
  case_id,
  category,
  original_file_name,
  mime_type,
  size_bytes,
  sha256_hash,
  storage_key,
  storage_provider,
  status,
  created_at
)
SELECT
  case_id,
  'draft_contract',
  draft_id || '.html',
  'text/html',
  LENGTH(CAST(contract_html AS BLOB)),
  contract_hash,
  'db://draft_versions/' || id || '/contract_html',
  'database',
  'active',
  created_at
FROM draft_versions
WHERE draft_file_id IS NULL
  AND contract_hash IS NOT NULL;

UPDATE draft_versions
SET draft_file_id = (
  SELECT files.id
  FROM files
  WHERE files.storage_key = 'db://draft_versions/' || draft_versions.id || '/contract_html'
)
WHERE draft_file_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM files
    WHERE files.storage_key = 'db://draft_versions/' || draft_versions.id || '/contract_html'
  );

INSERT OR IGNORE INTO files (
  case_id,
  category,
  original_file_name,
  mime_type,
  size_bytes,
  sha256_hash,
  storage_key,
  storage_provider,
  status,
  created_at
)
SELECT
  executed_contracts.case_id,
  'signed_contract',
  draft_versions.draft_id || '-signed.html',
  'text/html',
  LENGTH(CAST(draft_versions.contract_html AS BLOB)),
  executed_contracts.contract_hash,
  'db://executed_contracts/' || executed_contracts.id || '/contract_html',
  'database',
  'active',
  executed_contracts.created_at
FROM executed_contracts
JOIN draft_versions ON draft_versions.id = executed_contracts.source_draft_version_id
WHERE executed_contracts.signed_contract_file_id IS NULL
  AND executed_contracts.contract_hash IS NOT NULL;

UPDATE executed_contracts
SET signed_contract_file_id = (
  SELECT files.id
  FROM files
  WHERE files.storage_key = 'db://executed_contracts/' || executed_contracts.id || '/contract_html'
)
WHERE signed_contract_file_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM files
    WHERE files.storage_key = 'db://executed_contracts/' || executed_contracts.id || '/contract_html'
  );

INSERT OR IGNORE INTO files (
  case_id,
  category,
  original_file_name,
  mime_type,
  size_bytes,
  sha256_hash,
  storage_key,
  storage_provider,
  status,
  created_at
)
SELECT
  case_id,
  'message_attachment',
  file_name,
  file_mime_type,
  file_size,
  content_hash,
  file_path,
  'local',
  'active',
  created_at
FROM messages
WHERE file_path IS NOT NULL
  AND content_hash IS NOT NULL;

INSERT OR IGNORE INTO message_files (
  message_id,
  file_id
)
SELECT
  messages.id,
  files.id
FROM messages
JOIN files ON files.storage_key = messages.file_path
WHERE messages.file_path IS NOT NULL;
`);

if (tableExists('draft_contracts')) {
  addColumnIfMissing('draft_contracts', 'version_number', 'version_number INTEGER');
  addColumnIfMissing('draft_contracts', 'draft_file_id', 'draft_file_id INTEGER');
  addColumnIfMissing('draft_contracts', 'superseded_at', 'superseded_at TEXT');

  db.exec(`
  UPDATE draft_contracts
  SET version_number = CASE
    WHEN draft_id LIKE 'draft-v%' THEN CAST(SUBSTR(draft_id, 8) AS INTEGER)
    ELSE id
  END
  WHERE version_number IS NULL;

  INSERT OR IGNORE INTO draft_versions (
    case_id,
    draft_id,
    version_number,
    condition_snapshot_id,
    contract_html,
    contract_hash,
    status,
    created_at,
    superseded_at
  )
  SELECT
    case_id,
    draft_id,
    COALESCE(version_number, id),
    condition_snapshot_id,
    contract_html,
    contract_hash,
    COALESCE(status, 'draft'),
    created_at,
    superseded_at
  FROM draft_contracts
  WHERE condition_snapshot_id IS NOT NULL;

  INSERT OR IGNORE INTO files (
    case_id,
    category,
    original_file_name,
    mime_type,
    size_bytes,
    sha256_hash,
    storage_key,
    storage_provider,
    status,
    created_at
  )
  SELECT
    case_id,
    'draft_contract',
    draft_id || '.html',
    'text/html',
    LENGTH(CAST(contract_html AS BLOB)),
    contract_hash,
    'db://draft_versions/' || id || '/contract_html',
    'database',
    'active',
    created_at
  FROM draft_versions
  WHERE draft_file_id IS NULL
    AND contract_hash IS NOT NULL;

  UPDATE draft_versions
  SET draft_file_id = (
    SELECT files.id
    FROM files
    WHERE files.storage_key = 'db://draft_versions/' || draft_versions.id || '/contract_html'
  )
  WHERE draft_file_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM files
      WHERE files.storage_key = 'db://draft_versions/' || draft_versions.id || '/contract_html'
    );

  UPDATE draft_contracts
  SET draft_file_id = (
    SELECT draft_versions.draft_file_id
    FROM draft_versions
    WHERE draft_versions.case_id = draft_contracts.case_id
      AND draft_versions.draft_id = draft_contracts.draft_id
  )
  WHERE draft_file_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM draft_versions
      WHERE draft_versions.case_id = draft_contracts.case_id
        AND draft_versions.draft_id = draft_contracts.draft_id
        AND draft_versions.draft_file_id IS NOT NULL
    );
  `);
}

function addColumnIfMissing(tableName, columnName, columnDefinition) {
  if (!tableExists(tableName)) return;
  if (!tableColumns(tableName).includes(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

addColumnIfMissing('line_events', 'case_id', 'case_id TEXT');
addColumnIfMissing('line_events', 'raw_json_hash', 'raw_json_hash TEXT');

addColumnIfMissing('messages', 'case_id', 'case_id TEXT');
addColumnIfMissing('messages', 'ai_referenced_count', 'ai_referenced_count INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('messages', 'deleted_at', 'deleted_at TEXT');

addColumnIfMissing('rental_listings', 'case_id', 'case_id TEXT');
addColumnIfMissing('rental_listings', 'source_message_id', 'source_message_id INTEGER');
addColumnIfMissing('rental_listings', 'amenities', 'amenities TEXT');
addColumnIfMissing('rental_listings', 'description', 'description TEXT');
addColumnIfMissing('rental_listings', 'price', 'price INTEGER');

addColumnIfMissing('cases', 'current_condition_snapshot_id', 'current_condition_snapshot_id INTEGER');
addColumnIfMissing('cases', 'current_draft_version_id', 'current_draft_version_id INTEGER');
addColumnIfMissing('cases', 'executed_contract_id', 'executed_contract_id INTEGER');
addColumnIfMissing('cases', 'closed_at', 'closed_at TEXT');

addColumnIfMissing('condition_snapshots', 'previous_snapshot_id', 'previous_snapshot_id INTEGER');
addColumnIfMissing('condition_snapshots', 'trigger_message_id', 'trigger_message_id INTEGER');
addColumnIfMissing('condition_snapshots', 'condition_hash', 'condition_hash TEXT');
addColumnIfMissing('condition_snapshots', 'monthly_rent_ntd', 'monthly_rent_ntd INTEGER');
addColumnIfMissing('condition_snapshots', 'deposit_amount_ntd', 'deposit_amount_ntd INTEGER');
addColumnIfMissing('condition_snapshots', 'deposit_months', 'deposit_months REAL');
addColumnIfMissing('condition_snapshots', 'payment_due_day', 'payment_due_day INTEGER');
addColumnIfMissing('condition_snapshots', 'lease_start_date', 'lease_start_date TEXT');
addColumnIfMissing('condition_snapshots', 'lease_end_date', 'lease_end_date TEXT');
addColumnIfMissing('condition_snapshots', 'property_address', 'property_address TEXT');

addColumnIfMissing('draft_contracts', 'version_number', 'version_number INTEGER');
addColumnIfMissing('draft_contracts', 'draft_file_id', 'draft_file_id INTEGER');
addColumnIfMissing('draft_contracts', 'superseded_at', 'superseded_at TEXT');

db.exec(`
CREATE INDEX IF NOT EXISTS idx_line_events_case_id ON line_events(case_id);
CREATE INDEX IF NOT EXISTS idx_line_events_group_timestamp ON line_events(group_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_case_timestamp ON messages(case_id, line_timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_ai_referenced ON messages(case_id, ai_referenced_count);
CREATE INDEX IF NOT EXISTS idx_rental_listings_case_id ON rental_listings(case_id);
CREATE INDEX IF NOT EXISTS idx_case_participants_case_role ON case_participants(case_id, role, status);
CREATE INDEX IF NOT EXISTS idx_condition_snapshots_case_id ON condition_snapshots(case_id);
CREATE INDEX IF NOT EXISTS idx_condition_snapshot_sources_message_id ON condition_snapshot_sources(message_id);
CREATE INDEX IF NOT EXISTS idx_condition_snapshot_sources_field ON condition_snapshot_sources(condition_snapshot_id, field_path);
CREATE INDEX IF NOT EXISTS idx_message_files_message_id ON message_files(message_id);
CREATE INDEX IF NOT EXISTS idx_message_files_file_id ON message_files(file_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_case_time ON calendar_events(case_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_contract_time ON calendar_events(executed_contract_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_notification_logs_event_status ON notification_logs(calendar_event_id, status);

UPDATE cases
SET status = 'negotiating'
WHERE status = 'active';

UPDATE messages
SET case_id = (
  SELECT cases.case_id
  FROM cases
  WHERE cases.line_group_id = messages.group_id
)
WHERE case_id IS NULL
  AND group_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM cases WHERE cases.line_group_id = messages.group_id
  );

UPDATE line_events
SET case_id = (
  SELECT cases.case_id
  FROM cases
  WHERE cases.line_group_id = line_events.group_id
)
WHERE case_id IS NULL
  AND group_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM cases WHERE cases.line_group_id = line_events.group_id
  );

UPDATE rental_listings
SET case_id = (
  SELECT cases.case_id
  FROM cases
  WHERE cases.line_group_id = rental_listings.group_id
)
WHERE case_id IS NULL
  AND group_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM cases WHERE cases.line_group_id = rental_listings.group_id
  );
`);

if (tableExists('draft_contracts')) {
  db.exec(`
  UPDATE draft_contracts
  SET version_number = CASE
    WHEN draft_id LIKE 'draft-v%' THEN CAST(SUBSTR(draft_id, 8) AS INTEGER)
    ELSE id
  END
  WHERE version_number IS NULL;

  INSERT OR IGNORE INTO draft_versions (
    case_id,
    draft_id,
    version_number,
    condition_snapshot_id,
    contract_html,
    contract_hash,
    status,
    created_at,
    superseded_at
  )
  SELECT
    case_id,
    draft_id,
    COALESCE(version_number, id),
    condition_snapshot_id,
    contract_html,
    contract_hash,
    COALESCE(status, 'draft'),
    created_at,
    superseded_at
  FROM draft_contracts
  WHERE condition_snapshot_id IS NOT NULL;

  INSERT OR IGNORE INTO files (
    case_id,
    category,
    original_file_name,
    mime_type,
    size_bytes,
    sha256_hash,
    storage_key,
    storage_provider,
    status,
    created_at
  )
  SELECT
    case_id,
    'draft_contract',
    draft_id || '.html',
    'text/html',
    LENGTH(CAST(contract_html AS BLOB)),
    contract_hash,
    'db://draft_versions/' || id || '/contract_html',
    'database',
    'active',
    created_at
  FROM draft_versions
  WHERE draft_file_id IS NULL
    AND contract_hash IS NOT NULL;

  UPDATE draft_versions
  SET draft_file_id = (
    SELECT files.id
    FROM files
    WHERE files.storage_key = 'db://draft_versions/' || draft_versions.id || '/contract_html'
  )
  WHERE draft_file_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM files
      WHERE files.storage_key = 'db://draft_versions/' || draft_versions.id || '/contract_html'
    );

  UPDATE draft_contracts
  SET draft_file_id = (
    SELECT draft_versions.draft_file_id
    FROM draft_versions
    WHERE draft_versions.case_id = draft_contracts.case_id
      AND draft_versions.draft_id = draft_contracts.draft_id
  )
  WHERE draft_file_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM draft_versions
      WHERE draft_versions.case_id = draft_contracts.case_id
        AND draft_versions.draft_id = draft_contracts.draft_id
        AND draft_versions.draft_file_id IS NOT NULL
    );
  `);
}

db.exec(`
INSERT OR IGNORE INTO files (
  case_id,
  category,
  original_file_name,
  mime_type,
  size_bytes,
  sha256_hash,
  storage_key,
  storage_provider,
  status,
  created_at
)
SELECT
  executed_contracts.case_id,
  'signed_contract',
  draft_versions.draft_id || '-signed.html',
  'text/html',
  LENGTH(CAST(draft_versions.contract_html AS BLOB)),
  executed_contracts.contract_hash,
  'db://executed_contracts/' || executed_contracts.id || '/contract_html',
  'database',
  'active',
  executed_contracts.created_at
FROM executed_contracts
JOIN draft_versions ON draft_versions.id = executed_contracts.source_draft_version_id
WHERE executed_contracts.signed_contract_file_id IS NULL
  AND executed_contracts.contract_hash IS NOT NULL;

UPDATE executed_contracts
SET signed_contract_file_id = (
  SELECT files.id
  FROM files
  WHERE files.storage_key = 'db://executed_contracts/' || executed_contracts.id || '/contract_html'
)
WHERE signed_contract_file_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM files
    WHERE files.storage_key = 'db://executed_contracts/' || executed_contracts.id || '/contract_html'
  );

INSERT OR IGNORE INTO files (
  case_id,
  category,
  original_file_name,
  mime_type,
  size_bytes,
  sha256_hash,
  storage_key,
  storage_provider,
  status,
  created_at
)
SELECT
  case_id,
  'message_attachment',
  file_name,
  file_mime_type,
  file_size,
  content_hash,
  file_path,
  'local',
  'active',
  created_at
FROM messages
WHERE file_path IS NOT NULL
  AND content_hash IS NOT NULL;

INSERT OR IGNORE INTO message_files (
  message_id,
  file_id
)
SELECT
  messages.id,
  files.id
FROM messages
JOIN files ON files.storage_key = messages.file_path
WHERE messages.file_path IS NOT NULL;
`);

module.exports = db;
