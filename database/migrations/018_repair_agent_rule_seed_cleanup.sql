UPDATE rental_unit_assets
SET asset_type = CASE
  WHEN asset_name LIKE '%冰箱%' OR asset_name LIKE '%冷氣%' OR asset_name LIKE '%洗衣機%' OR asset_name LIKE '%熱水器%' OR asset_name LIKE '%電視%' THEN 'appliance'
  WHEN asset_name LIKE '%床%' OR asset_name LIKE '%沙發%' OR asset_name LIKE '%桌%' OR asset_name LIKE '%椅%' OR asset_name LIKE '%衣櫃%' THEN 'furniture'
  WHEN asset_name LIKE '%瓦斯%' OR asset_name LIKE '%水管%' OR asset_name LIKE '%馬桶%' OR asset_name LIKE '%浴%' THEN 'plumbing'
  WHEN asset_name LIKE '%電%' OR asset_name LIKE '%插座%' THEN 'electrical'
  WHEN asset_name LIKE '%牆%' OR asset_name LIKE '%地板%' THEN 'surface'
  WHEN asset_name LIKE '%網路%' OR asset_name LIKE '%第四台%' OR asset_name LIKE '%車位%' THEN 'service'
  WHEN asset_name LIKE '%陽台%' OR asset_name LIKE '%電梯%' THEN 'fixture'
  ELSE asset_type
END
WHERE status = 'active';

INSERT OR IGNORE INTO lease_repair_rules (
  public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type,
  responsible_party, repair_executor, payer_party,
  source_clause_path, source_text, notes
)
SELECT
  'rule-legal-natural-' || le.id,
  le.id,
  le.rental_unit_id,
  NULL,
  'whole_unit',
  'natural_wear',
  'landlord',
  'landlord',
  'landlord',
  'system:legal-default:natural_wear',
  '自然損壞、正常使用造成的故障，原則由房東負擔；實際仍以租約明確約定優先。',
  '系統 MVP 預設規則：作為 AI 初判基礎，後續可由正式租約條款覆蓋。'
FROM leases le;

INSERT OR IGNORE INTO lease_repair_rules (
  public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type,
  responsible_party, repair_executor, payer_party,
  source_clause_path, source_text, notes
)
SELECT
  'rule-legal-tenant-fault-' || le.id,
  le.id,
  le.rental_unit_id,
  NULL,
  'whole_unit',
  'tenant_fault',
  'tenant',
  'review_required',
  'tenant',
  'system:legal-default:tenant_fault',
  '房客故意、過失或不當使用造成的損壞，原則由房客負擔；需以照片、使用情境與租約約定判斷。',
  '系統 MVP 預設規則：責任可初判，但誰執行修繕仍需依情境確認。'
FROM leases le;

INSERT OR IGNORE INTO lease_repair_rules (
  public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type,
  responsible_party, repair_executor, payer_party,
  source_clause_path, source_text, notes
)
SELECT
  'rule-review-unknown-' || le.id,
  le.id,
  le.rental_unit_id,
  NULL,
  'whole_unit',
  'unknown',
  'review_required',
  'review_required',
  'review_required',
  'system:review-required:unknown',
  '資訊不足或租約沒有明確對應條款時，不直接判定誰負責，需補齊證據並留下例外處理紀錄。',
  '這不是鼓勵協商，而是避免在資料不足時亂判；結案後應回補更細的修繕規則。'
FROM leases le;
