CREATE TABLE knowledge_items (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  knowledge_type TEXT NOT NULL CHECK (knowledge_type IN ('listing_fact', 'landlord_public_rule', 'landlord_internal_rule', 'approved_qa')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE knowledge_versions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  knowledge_item_id INTEGER NOT NULL REFERENCES knowledge_items(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  normalized_question TEXT,
  topic_text TEXT NOT NULL,
  content_text TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  use_policy TEXT NOT NULL CHECK (use_policy IN ('answer_directly', 'negotiate_within_rule', 'must_escalate')),
  effective_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_until TEXT,
  approved_by_user_id INTEGER REFERENCES users(id),
  approved_at TEXT,
  superseded_by_version_id INTEGER REFERENCES knowledge_versions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL)),
  UNIQUE (knowledge_item_id, version_number)
);

CREATE TABLE knowledge_sources (
  id INTEGER PRIMARY KEY,
  knowledge_version_id INTEGER NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('listing_snapshot', 'landlord_answer', 'landlord_manual_input', 'derived_normalization')),
  source_id INTEGER NOT NULL,
  source_detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (knowledge_version_id, source_type, source_id)
);

CREATE TABLE knowledge_scope_links (
  id INTEGER PRIMARY KEY,
  knowledge_version_id INTEGER NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  rental_unit_id INTEGER REFERENCES rental_units(id),
  property_id INTEGER REFERENCES properties(id),
  organization_id INTEGER REFERENCES organizations(id),
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (rental_unit_id IS NOT NULL) +
    (property_id IS NOT NULL) +
    (organization_id IS NOT NULL) = 1
  )
);

CREATE TABLE landlord_rules (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  knowledge_item_id INTEGER NOT NULL REFERENCES knowledge_items(id),
  rental_unit_id INTEGER REFERENCES rental_units(id),
  property_id INTEGER REFERENCES properties(id),
  organization_id INTEGER REFERENCES organizations(id),
  rule_type TEXT NOT NULL CHECK (rule_type IN ('negotiation', 'pet', 'equipment', 'safety', 'usage', 'other')),
  rule_value_json TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'superseded')),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (rental_unit_id IS NOT NULL) +
    (property_id IS NOT NULL) +
    (organization_id IS NOT NULL) = 1
  )
);

CREATE TABLE inquiries (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  status TEXT NOT NULL DEFAULT 'inquiring' CHECK (status IN ('inquiring', 'waiting_landlord', 'intention_confirming', 'contracting', 'ended')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_inquiries_active_user_listing
ON inquiries(user_id, listing_id)
WHERE ended_at IS NULL;

CREATE TABLE active_inquiry_contexts (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  line_identity_id INTEGER NOT NULL REFERENCES line_identities(id),
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_at TEXT,
  clear_reason TEXT
);

CREATE UNIQUE INDEX uq_active_inquiry_context_line_identity
ON active_inquiry_contexts(line_identity_id)
WHERE cleared_at IS NULL;

CREATE TABLE inquiry_activity_sessions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (expires_at >= started_at)
);

CREATE TABLE inquiry_status_history (
  id INTEGER PRIMARY KEY,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  sender_user_id INTEGER REFERENCES users(id),
  sender_line_identity_id INTEGER REFERENCES line_identities(id),
  direction TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound', 'internal')),
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'video', 'audio', 'file', 'location', 'postback', 'system')),
  text_content TEXT,
  content_hash TEXT,
  sent_at TEXT NOT NULL,
  received_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_message_id)
);

CREATE TABLE landlord_questions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  source_message_id INTEGER REFERENCES messages(id),
  question_text TEXT NOT NULL,
  escalation_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'answered', 'cancelled', 'expired')),
  asked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE landlord_answers (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  landlord_question_id INTEGER NOT NULL REFERENCES landlord_questions(id),
  landlord_user_id INTEGER NOT NULL REFERENCES users(id),
  answer_text TEXT NOT NULL,
  reuse_approved INTEGER NOT NULL DEFAULT 0 CHECK (reuse_approved IN (0, 1)),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
  answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rental_intentions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  tenant_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'accepted', 'rejected', 'withdrawn', 'contracting', 'leased_to_another_tenant', 'ended')),
  submitted_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX uq_rental_intentions_active_inquiry
ON rental_intentions(inquiry_id)
WHERE ended_at IS NULL AND status NOT IN ('rejected', 'withdrawn', 'leased_to_another_tenant', 'ended');

CREATE TABLE intention_versions (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  rental_intention_id INTEGER NOT NULL REFERENCES rental_intentions(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  rent_amount INTEGER CHECK (rent_amount IS NULL OR rent_amount >= 0),
  deposit_amount INTEGER CHECK (deposit_amount IS NULL OR deposit_amount >= 0),
  lease_start_date TEXT,
  lease_end_date TEXT,
  move_in_date TEXT,
  pet_request_text TEXT,
  equipment_request_text TEXT,
  viewing_request_text TEXT,
  special_request_text TEXT,
  condition_json TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (lease_end_date IS NULL OR lease_start_date IS NULL OR lease_end_date >= lease_start_date),
  UNIQUE (rental_intention_id, version_number)
);

CREATE TABLE intention_version_sources (
  id INTEGER PRIMARY KEY,
  intention_version_id INTEGER NOT NULL REFERENCES intention_versions(id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('message', 'listing_snapshot', 'knowledge_version', 'manual_input')),
  source_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (intention_version_id, field_path, source_type, source_id)
);

CREATE TABLE intention_decisions (
  id INTEGER PRIMARY KEY,
  rental_intention_id INTEGER NOT NULL REFERENCES rental_intentions(id),
  intention_version_id INTEGER NOT NULL REFERENCES intention_versions(id),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'changes_requested')),
  decided_by_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE intention_status_history (
  id INTEGER PRIMARY KEY,
  rental_intention_id INTEGER NOT NULL REFERENCES rental_intentions(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE listing_demand_events (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  inquiry_id INTEGER REFERENCES inquiries(id),
  rental_intention_id INTEGER REFERENCES rental_intentions(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('inquiry_active', 'intention_submitted', 'contracting_started', 'listing_leased')),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER trg_knowledge_source_landlord_answer_reuse
BEFORE INSERT ON knowledge_sources
WHEN NEW.source_type = 'landlord_answer'
  AND NOT EXISTS (
    SELECT 1
    FROM landlord_answers
    WHERE id = NEW.source_id AND reuse_approved = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'landlord answer is not approved for reuse');
END;

CREATE INDEX idx_knowledge_versions_item ON knowledge_versions(knowledge_item_id, version_number DESC);
CREATE INDEX idx_knowledge_scope_unit ON knowledge_scope_links(rental_unit_id);
CREATE INDEX idx_inquiries_listing_status ON inquiries(listing_id, status);
CREATE INDEX idx_inquiry_sessions_listing_expiry ON inquiry_activity_sessions(listing_id, expires_at);
CREATE INDEX idx_messages_inquiry_sent ON messages(inquiry_id, sent_at);
CREATE INDEX idx_landlord_questions_status ON landlord_questions(status, asked_at);
CREATE INDEX idx_intentions_listing_status ON rental_intentions(listing_id, status);
CREATE INDEX idx_demand_events_listing_time ON listing_demand_events(listing_id, occurred_at DESC);
