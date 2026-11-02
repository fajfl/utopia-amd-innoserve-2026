CREATE TABLE rental_unit_assets (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id) ON DELETE CASCADE,
  asset_code TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'other' CHECK (asset_type IN ('appliance', 'furniture', 'fixture', 'plumbing', 'electrical', 'surface', 'service', 'other')),
  area_label TEXT,
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  installed_at TEXT,
  condition_at_move_in TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('listing_amenity', 'inspection_item', 'landlord_manual', 'contract_clause', 'system_seed')),
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'replaced', 'inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (rental_unit_id, asset_code)
);

CREATE TABLE lease_repair_rules (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  lease_id INTEGER NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  contract_version_id INTEGER REFERENCES contract_versions(id),
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id),
  asset_id INTEGER REFERENCES rental_unit_assets(id),
  rule_scope TEXT NOT NULL DEFAULT 'whole_unit' CHECK (rule_scope IN ('whole_unit', 'asset_type', 'asset', 'custom')),
  damage_type TEXT NOT NULL DEFAULT 'unknown' CHECK (damage_type IN ('natural_wear', 'normal_use', 'tenant_fault', 'malicious_damage', 'unknown')),
  responsible_party TEXT NOT NULL DEFAULT 'review_required' CHECK (responsible_party IN ('landlord', 'tenant', 'shared', 'review_required')),
  repair_executor TEXT NOT NULL DEFAULT 'review_required' CHECK (repair_executor IN ('landlord', 'tenant', 'vendor', 'review_required')),
  payer_party TEXT NOT NULL DEFAULT 'review_required' CHECK (payer_party IN ('landlord', 'tenant', 'shared', 'review_required')),
  cost_limit_amount INTEGER CHECK (cost_limit_amount IS NULL OR cost_limit_amount >= 0),
  receipt_required INTEGER NOT NULL DEFAULT 0 CHECK (receipt_required IN (0, 1)),
  tax_id_required INTEGER NOT NULL DEFAULT 0 CHECK (tax_id_required IN (0, 1)),
  source_clause_path TEXT,
  source_text TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'inactive')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repair_ai_assessments (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  repair_ticket_id INTEGER NOT NULL REFERENCES repair_tickets(id) ON DELETE CASCADE,
  lease_id INTEGER REFERENCES leases(id),
  contract_version_id INTEGER REFERENCES contract_versions(id),
  asset_id INTEGER REFERENCES rental_unit_assets(id),
  lease_repair_rule_id INTEGER REFERENCES lease_repair_rules(id),
  risk_level TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('low', 'normal', 'high', 'urgent')),
  responsibility_guess TEXT NOT NULL DEFAULT 'insufficient_info' CHECK (responsibility_guess IN ('landlord', 'tenant', 'shared', 'review_required', 'insufficient_info')),
  recommended_executor TEXT NOT NULL DEFAULT 'review_required' CHECK (recommended_executor IN ('landlord', 'tenant', 'vendor', 'review_required')),
  recommended_payer TEXT NOT NULL DEFAULT 'review_required' CHECK (recommended_payer IN ('landlord', 'tenant', 'shared', 'review_required')),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  legal_basis_summary TEXT,
  contract_basis_summary TEXT,
  missing_info_json TEXT NOT NULL DEFAULT '[]',
  rule_refs_json TEXT NOT NULL DEFAULT '[]',
  raw_result_json TEXT NOT NULL DEFAULT '{}',
  model_or_rule_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE repair_resolution_records (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  repair_ticket_id INTEGER NOT NULL REFERENCES repair_tickets(id) ON DELETE CASCADE,
  basis_type TEXT NOT NULL DEFAULT 'contract_rule' CHECK (basis_type IN ('contract_rule', 'exception_agreement', 'manual_review')),
  responsible_party TEXT NOT NULL DEFAULT 'review_required' CHECK (responsible_party IN ('landlord', 'tenant', 'shared', 'review_required')),
  repair_executor TEXT NOT NULL DEFAULT 'review_required' CHECK (repair_executor IN ('landlord', 'tenant', 'vendor', 'review_required')),
  payer_party TEXT NOT NULL DEFAULT 'review_required' CHECK (payer_party IN ('landlord', 'tenant', 'shared', 'review_required')),
  cost_limit_amount INTEGER CHECK (cost_limit_amount IS NULL OR cost_limit_amount >= 0),
  receipt_required INTEGER NOT NULL DEFAULT 0 CHECK (receipt_required IN (0, 1)),
  tax_id_required INTEGER NOT NULL DEFAULT 0 CHECK (tax_id_required IN (0, 1)),
  resolution_text TEXT NOT NULL,
  ai_summary TEXT,
  source_assessment_id INTEGER REFERENCES repair_ai_assessments(id),
  source_rule_refs_json TEXT NOT NULL DEFAULT '[]',
  tenant_acknowledged_at TEXT,
  landlord_acknowledged_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proposed', 'accepted', 'rejected', 'superseded', 'completed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE repair_tickets ADD COLUMN asset_id INTEGER REFERENCES rental_unit_assets(id);
ALTER TABLE repair_tickets ADD COLUMN damage_type TEXT DEFAULT 'unknown' CHECK (damage_type IN ('natural_wear', 'normal_use', 'tenant_fault', 'malicious_damage', 'unknown'));
ALTER TABLE repair_tickets ADD COLUMN tenant_preference TEXT DEFAULT 'no_preference' CHECK (tenant_preference IN ('tenant_self_repair', 'landlord_repair', 'no_preference'));
ALTER TABLE repair_tickets ADD COLUMN latest_assessment_id INTEGER REFERENCES repair_ai_assessments(id);
ALTER TABLE repair_tickets ADD COLUMN latest_resolution_id INTEGER REFERENCES repair_resolution_records(id);

CREATE INDEX idx_rental_unit_assets_unit_status ON rental_unit_assets(rental_unit_id, status, asset_type);
CREATE INDEX idx_lease_repair_rules_lease_asset ON lease_repair_rules(lease_id, asset_id, damage_type, status);
CREATE INDEX idx_repair_ai_assessments_ticket ON repair_ai_assessments(repair_ticket_id, created_at DESC);
CREATE INDEX idx_repair_resolution_records_ticket ON repair_resolution_records(repair_ticket_id, created_at DESC);

INSERT OR IGNORE INTO rental_unit_assets (
  public_id, rental_unit_id, asset_code, asset_name, asset_type, source_type, source_id
)
SELECT
  'asset-amenity-' || ua.id,
  ua.rental_unit_id,
  'amenity-' || ua.id,
  ua.label,
  CASE
    WHEN ua.label LIKE '%冰箱%' OR ua.label LIKE '%冷氣%' OR ua.label LIKE '%洗衣機%' OR ua.label LIKE '%熱水器%' OR ua.label LIKE '%電視%' THEN 'appliance'
    WHEN ua.label LIKE '%床%' OR ua.label LIKE '%沙發%' OR ua.label LIKE '%桌%' OR ua.label LIKE '%椅%' OR ua.label LIKE '%衣櫃%' THEN 'furniture'
    WHEN ua.label LIKE '%瓦斯%' OR ua.label LIKE '%水管%' OR ua.label LIKE '%馬桶%' OR ua.label LIKE '%浴%' THEN 'plumbing'
    WHEN ua.label LIKE '%網路%' OR ua.label LIKE '%第四台%' OR ua.label LIKE '%車位%' THEN 'service'
    WHEN ua.label LIKE '%陽台%' OR ua.label LIKE '%電梯%' THEN 'fixture'
    ELSE 'other'
  END,
  'listing_amenity',
  ua.id
FROM unit_amenities ua
WHERE ua.is_available = 1
  AND length(trim(ua.label)) BETWEEN 1 AND 20
  AND ua.label NOT LIKE '%不可%'
  AND ua.label NOT LIKE '%租金%'
  AND ua.label NOT LIKE '%最短租期%'
  AND ua.label NOT LIKE '%身份要求%'
  AND ua.label NOT IN ('養寵物', '開伙');

INSERT OR IGNORE INTO rental_unit_assets (
  public_id, rental_unit_id, asset_code, asset_name, asset_type, area_label,
  condition_at_move_in, source_type, source_id
)
SELECT
  'asset-inspection-' || ii.id,
  le.rental_unit_id,
  'inspection-' || ii.id,
  ii.item_label,
  CASE
    WHEN ii.item_label LIKE '%牆%' OR ii.item_label LIKE '%地板%' THEN 'surface'
    WHEN ii.item_label LIKE '%水%' OR ii.item_label LIKE '%馬桶%' THEN 'plumbing'
    WHEN ii.item_label LIKE '%電%' OR ii.item_label LIKE '%插座%' THEN 'electrical'
    ELSE 'other'
  END,
  ii.area_label,
  ii.condition_code,
  'inspection_item',
  ii.id
FROM inspection_items ii
JOIN inspection_checklists ic ON ic.id = ii.inspection_checklist_id
JOIN leases le ON le.id = ic.lease_id;
