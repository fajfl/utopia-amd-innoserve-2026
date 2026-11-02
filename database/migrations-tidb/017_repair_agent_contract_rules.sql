-- TiDB / MySQL dialect counterpart of the SQLite repair-agent schema.
CREATE TABLE IF NOT EXISTS rental_unit_assets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id VARCHAR(191) NOT NULL UNIQUE,
  rental_unit_id BIGINT NOT NULL,
  asset_code VARCHAR(191) NOT NULL,
  asset_name VARCHAR(500) NOT NULL,
  asset_type VARCHAR(32) NOT NULL DEFAULT 'other',
  area_label VARCHAR(255), brand VARCHAR(255), model VARCHAR(255), serial_number VARCHAR(255),
  installed_at VARCHAR(64), condition_at_move_in VARCHAR(255),
  source_type VARCHAR(32) NOT NULL DEFAULT 'manual', source_id BIGINT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rental_unit_assets_code (rental_unit_id, asset_code),
  KEY idx_rental_unit_assets_unit_status (rental_unit_id, status, asset_type)
);

CREATE TABLE IF NOT EXISTS lease_repair_rules (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id VARCHAR(191) NOT NULL UNIQUE,
  lease_id BIGINT NOT NULL, contract_version_id BIGINT NULL, rental_unit_id BIGINT NOT NULL, asset_id BIGINT NULL,
  rule_scope VARCHAR(32) NOT NULL DEFAULT 'whole_unit', damage_type VARCHAR(32) NOT NULL DEFAULT 'unknown',
  responsible_party VARCHAR(32) NOT NULL DEFAULT 'review_required', repair_executor VARCHAR(32) NOT NULL DEFAULT 'review_required',
  payer_party VARCHAR(32) NOT NULL DEFAULT 'review_required', cost_limit_amount BIGINT NULL,
  receipt_required TINYINT NOT NULL DEFAULT 0, tax_id_required TINYINT NOT NULL DEFAULT 0,
  source_clause_path VARCHAR(500), source_text LONGTEXT, notes LONGTEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lease_repair_rules_lease_asset (lease_id, asset_id, damage_type, status)
);

CREATE TABLE IF NOT EXISTS repair_ai_assessments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id VARCHAR(191) NOT NULL UNIQUE, repair_ticket_id BIGINT NOT NULL, lease_id BIGINT NULL,
  contract_version_id BIGINT NULL, asset_id BIGINT NULL, lease_repair_rule_id BIGINT NULL,
  risk_level VARCHAR(32) NOT NULL DEFAULT 'normal', responsibility_guess VARCHAR(32) NOT NULL DEFAULT 'insufficient_info',
  recommended_executor VARCHAR(32) NOT NULL DEFAULT 'review_required', recommended_payer VARCHAR(32) NOT NULL DEFAULT 'review_required',
  confidence DECIMAL(6,5) NULL, legal_basis_summary LONGTEXT, contract_basis_summary LONGTEXT,
  missing_info_json LONGTEXT NOT NULL, rule_refs_json LONGTEXT NOT NULL, raw_result_json LONGTEXT NOT NULL,
  model_or_rule_version VARCHAR(191), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_repair_ai_assessments_ticket (repair_ticket_id, created_at)
);

CREATE TABLE IF NOT EXISTS repair_resolution_records (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id VARCHAR(191) NOT NULL UNIQUE, repair_ticket_id BIGINT NOT NULL,
  basis_type VARCHAR(32) NOT NULL DEFAULT 'contract_rule', responsible_party VARCHAR(32) NOT NULL DEFAULT 'review_required',
  repair_executor VARCHAR(32) NOT NULL DEFAULT 'review_required', payer_party VARCHAR(32) NOT NULL DEFAULT 'review_required',
  cost_limit_amount BIGINT NULL, receipt_required TINYINT NOT NULL DEFAULT 0, tax_id_required TINYINT NOT NULL DEFAULT 0,
  resolution_text LONGTEXT NOT NULL, ai_summary LONGTEXT, source_assessment_id BIGINT NULL,
  source_rule_refs_json LONGTEXT NOT NULL, tenant_acknowledged_at DATETIME NULL, landlord_acknowledged_at DATETIME NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_repair_resolution_records_ticket (repair_ticket_id, created_at)
);

ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS asset_id BIGINT NULL;
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS damage_type VARCHAR(32) DEFAULT 'unknown';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS tenant_preference VARCHAR(32) DEFAULT 'no_preference';
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS latest_assessment_id BIGINT NULL;
ALTER TABLE repair_tickets ADD COLUMN IF NOT EXISTS latest_resolution_id BIGINT NULL;

INSERT IGNORE INTO rental_unit_assets (public_id, rental_unit_id, asset_code, asset_name, asset_type, source_type, source_id)
SELECT CONCAT('asset-amenity-', ua.id), ua.rental_unit_id, CONCAT('amenity-', ua.id), ua.label,
  CASE WHEN ua.label LIKE '%冰箱%' OR ua.label LIKE '%冷氣%' OR ua.label LIKE '%洗衣機%' OR ua.label LIKE '%熱水器%' OR ua.label LIKE '%電視%' THEN 'appliance'
       WHEN ua.label LIKE '%床%' OR ua.label LIKE '%沙發%' OR ua.label LIKE '%桌%' OR ua.label LIKE '%椅%' OR ua.label LIKE '%衣櫃%' THEN 'furniture'
       WHEN ua.label LIKE '%瓦斯%' OR ua.label LIKE '%水管%' OR ua.label LIKE '%馬桶%' OR ua.label LIKE '%浴%' THEN 'plumbing'
       WHEN ua.label LIKE '%網路%' OR ua.label LIKE '%第四台%' OR ua.label LIKE '%車位%' THEN 'service'
       WHEN ua.label LIKE '%陽台%' OR ua.label LIKE '%電梯%' THEN 'fixture' ELSE 'other' END,
  'listing_amenity', ua.id
FROM unit_amenities ua
WHERE ua.is_available = 1 AND CHAR_LENGTH(TRIM(ua.label)) BETWEEN 1 AND 20
  AND ua.label NOT LIKE '%不可%' AND ua.label NOT LIKE '%租金%' AND ua.label NOT LIKE '%最短租期%'
  AND ua.label NOT LIKE '%身份要求%' AND ua.label NOT IN ('養寵物', '開伙');

INSERT IGNORE INTO rental_unit_assets (public_id, rental_unit_id, asset_code, asset_name, asset_type, area_label, condition_at_move_in, source_type, source_id)
SELECT CONCAT('asset-inspection-', ii.id), le.rental_unit_id, CONCAT('inspection-', ii.id), ii.item_label,
  CASE WHEN ii.item_label LIKE '%牆%' OR ii.item_label LIKE '%地板%' THEN 'surface'
       WHEN ii.item_label LIKE '%水%' OR ii.item_label LIKE '%馬桶%' THEN 'plumbing'
       WHEN ii.item_label LIKE '%電%' OR ii.item_label LIKE '%插座%' THEN 'electrical' ELSE 'other' END,
  ii.area_label, ii.condition_code, 'inspection_item', ii.id
FROM inspection_items ii JOIN inspection_checklists ic ON ic.id = ii.inspection_checklist_id
JOIN leases le ON le.id = ic.lease_id;
