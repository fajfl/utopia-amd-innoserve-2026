CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  actor_user_id INTEGER REFERENCES users(id),
  actor_line_identity_id INTEGER REFERENCES line_identities(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'line_identity', 'system')),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  change_json TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE line_identities (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  line_user_id TEXT NOT NULL UNIQUE,
  display_name_cache TEXT,
  picture_url_cache TEXT,
  profile_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_profiles (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  display_name TEXT,
  legal_name TEXT,
  phone TEXT,
  email TEXT,
  contact_address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE verification_challenges (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'line', 'email', 'mock')),
  destination_masked TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'mock',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'locked', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE verification_events (
  id INTEGER PRIMARY KEY,
  challenge_id INTEGER NOT NULL REFERENCES verification_challenges(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('sent', 'failed_attempt', 'verified', 'expired', 'locked', 'cancelled')),
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE channel_events (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  line_identity_id INTEGER REFERENCES line_identities(id),
  user_id INTEGER REFERENCES users(id),
  inquiry_id INTEGER,
  correlation_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  raw_payload_json TEXT NOT NULL,
  raw_hash TEXT NOT NULL,
  error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE organizations (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  organization_type TEXT NOT NULL CHECK (organization_type IN ('brokerage', 'property_management', 'landlord_company', 'other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deleted')),
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE organization_memberships (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role_code TEXT NOT NULL CHECK (role_code IN ('owner', 'admin', 'agent', 'finance', 'maintenance', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'ended')),
  starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, user_id, role_code, starts_at)
);

CREATE TABLE role_permissions (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id),
  role_code TEXT NOT NULL,
  permission_code TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1 CHECK (allowed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (organization_id, role_code, permission_code)
);

CREATE TABLE properties (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  organization_id INTEGER REFERENCES organizations(id),
  building_name TEXT,
  address_text TEXT NOT NULL,
  normalized_address TEXT,
  latitude REAL,
  longitude REAL,
  management_notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rental_units (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  unit_label TEXT NOT NULL,
  rental_type TEXT NOT NULL CHECK (rental_type IN ('whole_home', 'whole_floor', 'suite', 'room', 'other')),
  floor_label TEXT,
  room_count INTEGER CHECK (room_count IS NULL OR room_count >= 0),
  bathroom_count INTEGER CHECK (bathroom_count IS NULL OR bathroom_count >= 0),
  area_ping REAL CHECK (area_ping IS NULL OR area_ping >= 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'marketing', 'signing', 'leased', 'maintenance', 'inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (property_id, unit_label)
);

CREATE TABLE property_owners (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  rental_unit_id INTEGER REFERENCES rental_units(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  ownership_role TEXT NOT NULL DEFAULT 'owner' CHECK (ownership_role IN ('owner', 'co_owner', 'authorized_landlord', 'manager')),
  effective_from TEXT NOT NULL,
  effective_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  UNIQUE (property_id, rental_unit_id, owner_user_id, effective_from)
);

CREATE TABLE property_assignments (
  id INTEGER PRIMARY KEY,
  organization_membership_id INTEGER NOT NULL REFERENCES organization_memberships(id),
  property_id INTEGER REFERENCES properties(id),
  rental_unit_id INTEGER REFERENCES rental_units(id),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  CHECK ((property_id IS NOT NULL) != (rental_unit_id IS NOT NULL))
);

CREATE TABLE unit_amenities (
  id INTEGER PRIMARY KEY,
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id) ON DELETE CASCADE,
  amenity_code TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL DEFAULT 'landlord' CHECK (source IN ('landlord', 'manager', 'inspection', 'other')),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (rental_unit_id, amenity_code)
);

CREATE TABLE listings (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id),
  source TEXT NOT NULL,
  source_listing_id TEXT,
  source_url TEXT,
  title TEXT,
  current_rent_amount INTEGER CHECK (current_rent_amount IS NULL OR current_rent_amount >= 0),
  current_deposit_amount INTEGER CHECK (current_deposit_amount IS NULL OR current_deposit_amount >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'closed', 'leased', 'removed')),
  published_at TEXT,
  closed_at TEXT,
  latest_valid_snapshot_id INTEGER REFERENCES listing_snapshots(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source, source_listing_id)
);

CREATE TABLE listing_snapshots (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  previous_snapshot_id INTEGER REFERENCES listing_snapshots(id),
  source TEXT NOT NULL,
  source_listing_id TEXT,
  source_url TEXT,
  captured_at TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('valid', 'partial', 'invalid', 'error')),
  raw_payload_json TEXT,
  raw_hash TEXT NOT NULL,
  warning_json TEXT,
  error_summary TEXT,
  normalized_title TEXT,
  normalized_address TEXT,
  rent_amount INTEGER CHECK (rent_amount IS NULL OR rent_amount >= 0),
  deposit_amount INTEGER CHECK (deposit_amount IS NULL OR deposit_amount >= 0),
  management_fee_amount INTEGER CHECK (management_fee_amount IS NULL OR management_fee_amount >= 0),
  pet_policy_text TEXT,
  amenity_json TEXT,
  is_latest_valid INTEGER NOT NULL DEFAULT 0 CHECK (is_latest_valid IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (listing_id, raw_hash)
);

CREATE UNIQUE INDEX uq_listing_snapshots_latest_valid
ON listing_snapshots(listing_id)
WHERE is_latest_valid = 1 AND parse_status = 'valid';

CREATE TABLE listing_media (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  listing_snapshot_id INTEGER REFERENCES listing_snapshots(id),
  file_id INTEGER,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'floor_plan', 'video', 'document')),
  source_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE listing_entry_tokens (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  token TEXT NOT NULL UNIQUE,
  source_platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'expired', 'superseded')),
  expires_at TEXT,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE listing_entry_events (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  entry_token_id INTEGER REFERENCES listing_entry_tokens(id),
  line_identity_id INTEGER REFERENCES line_identities(id),
  provider_event_id TEXT,
  source_platform TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('opened', 'bound', 'restored', 'created', 'rejected', 'failed')),
  correlation_id TEXT,
  occurred_at TEXT NOT NULL,
  detail_json TEXT,
  UNIQUE (source_platform, provider_event_id)
);

CREATE TABLE listing_status_history (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_properties_organization ON properties(organization_id);
CREATE INDEX idx_rental_units_property ON rental_units(property_id);
CREATE INDEX idx_listings_unit_status ON listings(rental_unit_id, status);
CREATE INDEX idx_listing_snapshots_listing_captured ON listing_snapshots(listing_id, captured_at DESC);
CREATE INDEX idx_entry_events_listing_time ON listing_entry_events(listing_id, occurred_at DESC);
