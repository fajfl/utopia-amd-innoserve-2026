-- Pre-signing rules belong to a rental unit, not a fabricated lease.
CREATE TABLE IF NOT EXISTS rental_unit_repair_rule_defaults (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_id VARCHAR(191) NOT NULL UNIQUE,
  rental_unit_id BIGINT NOT NULL,
  asset_id BIGINT NULL,
  rule_scope VARCHAR(32) NOT NULL DEFAULT 'whole_unit',
  damage_type VARCHAR(32) NOT NULL DEFAULT 'unknown',
  responsible_party VARCHAR(32) NOT NULL DEFAULT 'review_required',
  repair_executor VARCHAR(32) NOT NULL DEFAULT 'review_required',
  payer_party VARCHAR(32) NOT NULL DEFAULT 'review_required',
  source_clause_path VARCHAR(500) NULL,
  source_text LONGTEXT NOT NULL,
  notes LONGTEXT NULL,
  cause_classification VARCHAR(32) NOT NULL DEFAULT 'unknown',
  liability_party VARCHAR(32) NOT NULL DEFAULT 'review_required',
  dispatch_party VARCHAR(32) NOT NULL DEFAULT 'review_required',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_unit_repair_defaults_lookup (rental_unit_id, asset_id, cause_classification, status)
);

-- The current listing fixture is loaded after migrations. When this SQL is
-- replayed by the seed/import flow, hydrate Room 1's repair assets from the
-- normalized amenity list before generating its rule defaults.
INSERT IGNORE INTO rental_unit_assets (
  public_id, rental_unit_id, asset_code, asset_name, asset_type, source_type, source_id
)
SELECT
  CONCAT('asset-amenity-', ua.id),
  ua.rental_unit_id,
  CONCAT('amenity-', ua.id),
  CASE WHEN ua.label LIKE '%陽台%' THEN '陽台' ELSE TRIM(ua.label) END,
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
JOIN rental_units ru ON ru.id = ua.rental_unit_id
WHERE ru.public_id = 'demo-591-unit-90000001'
  AND ua.is_available = 1
  AND CHAR_LENGTH(TRIM(ua.label)) BETWEEN 1 AND 20
  AND ua.label NOT LIKE '%不可%'
  AND ua.label NOT LIKE '%租金%'
  AND ua.label NOT LIKE '%最短租期%'
  AND ua.label NOT LIKE '%身份要求%'
  AND ua.label NOT IN ('養寵物', '開伙');

-- Same 36 rule matrix as the SQLite migration: 3 unit-level + 3 per active asset.
INSERT IGNORE INTO rental_unit_repair_rule_defaults (public_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes, cause_classification, liability_party, dispatch_party)
SELECT CONCAT('unit-default-whole-', ru.id, '-', kind.rule_key), ru.id, NULL, 'whole_unit', kind.damage_type, kind.responsible_party, kind.repair_executor, kind.payer_party,
  CONCAT('unit-default:whole_unit:', kind.rule_key), kind.source_text,
  '房源預設修繕規則；尚未簽約，須在簽約時由雙方確認或轉入租約。', kind.cause_classification, kind.liability_party, kind.dispatch_party
FROM rental_units ru
JOIN (
  SELECT 'normal' AS rule_key, 'normal_use' AS damage_type, 'landlord' AS responsible_party, 'landlord' AS repair_executor, 'landlord' AS payer_party,
    '房屋與附屬設備因正常使用、自然老化或非可歸責於房客之原因而需修繕時，原則由房東安排修繕並負擔費用。' AS source_text,
    'normal_failure' AS cause_classification, 'none' AS liability_party, 'landlord' AS dispatch_party
  UNION ALL SELECT 'tenant-fault', 'tenant_fault', 'tenant', 'review_required', 'tenant',
    '房客、共同居住人或房客允許進入住宅之人因故意、過失、不當使用或未盡合理保管義務造成損壞，經證據確認後由房客負擔合理修繕費。',
    'tenant_negligence', 'tenant', 'review_required'
  UNION ALL SELECT 'unknown', 'unknown', 'review_required', 'review_required', 'review_required',
    '原因不明、資料不足或無法單憑照片判斷時，不直接判定責任；應補充證據或由專業人員確認後再處理。',
    'unknown', 'review_required', 'review_required'
) kind
WHERE ru.public_id = 'demo-591-unit-90000001';

INSERT IGNORE INTO rental_unit_repair_rule_defaults (public_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes, cause_classification, liability_party, dispatch_party)
SELECT CONCAT('unit-default-asset-', rua.id, '-', kind.rule_key), rua.rental_unit_id, rua.id, 'asset', kind.damage_type, kind.responsible_party,
  IF(kind.rule_key = 'normal' AND (rua.asset_type IN ('plumbing', 'electrical', 'service') OR rua.asset_name LIKE '%熱水器%' OR rua.asset_name LIKE '%瓦斯%'), 'vendor', kind.repair_executor), kind.payer_party,
  CONCAT('unit-default:asset:', rua.asset_code, ':', kind.rule_key), CONCAT(rua.asset_name, kind.suffix),
  '房源預設修繕規則；尚未簽約，須在簽約時逐項確認。', kind.cause_classification, kind.liability_party,
  IF(kind.rule_key = 'normal' AND (rua.asset_type IN ('plumbing', 'electrical', 'service') OR rua.asset_name LIKE '%熱水器%' OR rua.asset_name LIKE '%瓦斯%'), 'vendor', kind.dispatch_party)
FROM rental_unit_assets rua
JOIN rental_units ru ON ru.id = rua.rental_unit_id
JOIN (
  SELECT 'normal' AS rule_key, 'normal_use' AS damage_type, 'landlord' AS responsible_party, 'landlord' AS repair_executor, 'landlord' AS payer_party,
    '因正常使用、自然老化或非可歸責於房客之原因而需修繕者，原則由房東安排修繕並負擔費用。' AS suffix,
    'normal_failure' AS cause_classification, 'none' AS liability_party, 'landlord' AS dispatch_party
  UNION ALL SELECT 'tenant-fault', 'tenant_fault', 'tenant', 'review_required', 'tenant',
    '若因房客故意、過失、不當使用、拆裝不當、寵物或外力破壞造成損壞，經證據確認後由房客負擔合理修繕費。',
    'tenant_negligence', 'tenant', 'review_required'
  UNION ALL SELECT 'unknown', 'unknown', 'review_required', 'review_required', 'review_required',
    '原因不明、資料不足或無法單憑照片判斷時，不直接判定責任；應補充證據或由專業人員確認後再處理。',
    'unknown', 'review_required', 'review_required'
) kind
WHERE ru.public_id = 'demo-591-unit-90000001' AND rua.status = 'active';
