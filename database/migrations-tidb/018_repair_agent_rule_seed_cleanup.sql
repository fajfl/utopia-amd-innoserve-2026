UPDATE rental_unit_assets
SET asset_type = CASE
  WHEN asset_name LIKE '%冰箱%' OR asset_name LIKE '%冷氣%' OR asset_name LIKE '%洗衣機%' OR asset_name LIKE '%熱水器%' OR asset_name LIKE '%電視%' THEN 'appliance'
  WHEN asset_name LIKE '%床%' OR asset_name LIKE '%沙發%' OR asset_name LIKE '%桌%' OR asset_name LIKE '%椅%' OR asset_name LIKE '%衣櫃%' THEN 'furniture'
  WHEN asset_name LIKE '%瓦斯%' OR asset_name LIKE '%水管%' OR asset_name LIKE '%馬桶%' OR asset_name LIKE '%浴%' THEN 'plumbing'
  WHEN asset_name LIKE '%電%' OR asset_name LIKE '%插座%' THEN 'electrical'
  WHEN asset_name LIKE '%牆%' OR asset_name LIKE '%地板%' THEN 'surface'
  WHEN asset_name LIKE '%網路%' OR asset_name LIKE '%第四台%' OR asset_name LIKE '%車位%' THEN 'service'
  WHEN asset_name LIKE '%陽台%' OR asset_name LIKE '%電梯%' THEN 'fixture' ELSE asset_type END,
  updated_at = CURRENT_TIMESTAMP
WHERE status = 'active';

INSERT IGNORE INTO lease_repair_rules (public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes)
SELECT CONCAT('rule-legal-natural-', le.id), le.id, le.rental_unit_id, NULL, 'whole_unit', 'natural_wear', 'landlord', 'landlord', 'landlord',
  'system:legal-default:natural_wear', '自然損壞、正常使用造成的故障，原則由房東負擔；實際仍以有效租約明確約定處理。', 'MVP 預設規則：作為初判基礎。'
FROM leases le;
INSERT IGNORE INTO lease_repair_rules (public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes)
SELECT CONCAT('rule-legal-tenant-fault-', le.id), le.id, le.rental_unit_id, NULL, 'whole_unit', 'tenant_fault', 'tenant', 'review_required', 'tenant',
  'system:legal-default:tenant_fault', '房客故意、過失或不當使用造成的損壞，經證據確認後原則由房客負擔。', '責任初判仍需證據支持。'
FROM leases le;
INSERT IGNORE INTO lease_repair_rules (public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes)
SELECT CONCAT('rule-review-unknown-', le.id), le.id, le.rental_unit_id, NULL, 'whole_unit', 'unknown', 'review_required', 'review_required', 'review_required',
  'system:review-required:unknown', '資訊不足或無有效對應規則時，不直接判定責任，應補齊證據或進入本案例外處理。', '避免資料不足時硬判。'
FROM leases le;
