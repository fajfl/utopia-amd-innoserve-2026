-- Materialise the same three deterministic rules for every actual unit asset.
-- The application presents detailed asset-specific wording; these records are the
-- contractual/rule resolver inputs and retain each asset name in source_text.
INSERT IGNORE INTO lease_repair_rules (public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes, cause_classification, liability_party, dispatch_party)
SELECT CONCAT('rule-asset-normal-', le.id, '-', rua.id), le.id, le.rental_unit_id, rua.id, 'asset',
  CASE WHEN rua.asset_type IN ('furniture','surface') THEN 'natural_wear' ELSE 'normal_use' END,
  'landlord', CASE WHEN rua.asset_type IN ('plumbing','electrical','service') OR rua.asset_name LIKE '%熱水器%' OR rua.asset_name LIKE '%瓦斯%' THEN 'vendor' ELSE 'landlord' END, 'landlord',
  CONCAT('system:asset-default:', rua.asset_code, ':normal'),
  CONCAT(rua.asset_name, '因正常使用、自然老化或非可歸責於房客之原因而需修繕者，原則由房東負責修繕與費用。'),
  '依該房源家具／設備清單建立，仍須結合原始物況、照片、使用情境與維修紀錄。',
  CASE WHEN rua.asset_type IN ('furniture','surface') THEN 'natural_wear' ELSE 'normal_failure' END, 'none',
  CASE WHEN rua.asset_type IN ('plumbing','electrical','service') OR rua.asset_name LIKE '%熱水器%' OR rua.asset_name LIKE '%瓦斯%' THEN 'vendor' ELSE 'landlord' END
FROM leases le JOIN rental_unit_assets rua ON rua.rental_unit_id = le.rental_unit_id AND rua.status = 'active';

INSERT IGNORE INTO lease_repair_rules (public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes, cause_classification, liability_party, dispatch_party)
SELECT CONCAT('rule-asset-tenant-fault-', le.id, '-', rua.id), le.id, le.rental_unit_id, rua.id, 'asset', 'tenant_fault', 'tenant', 'review_required', 'tenant',
  CONCAT('system:asset-default:', rua.asset_code, ':tenant_fault'),
  CONCAT(rua.asset_name, '若因房客故意、過失、不當使用或未盡合理保管義務造成損壞，經證據確認後由房客負擔合理修繕費。'),
  '不得只因房客通報即認定房客負擔。', 'tenant_negligence', 'tenant', 'review_required'
FROM leases le JOIN rental_unit_assets rua ON rua.rental_unit_id = le.rental_unit_id AND rua.status = 'active';

INSERT IGNORE INTO lease_repair_rules (public_id, lease_id, rental_unit_id, asset_id, rule_scope, damage_type, responsible_party, repair_executor, payer_party, source_clause_path, source_text, notes, cause_classification, liability_party, dispatch_party)
SELECT CONCAT('rule-asset-review-', le.id, '-', rua.id), le.id, le.rental_unit_id, rua.id, 'asset', 'unknown', 'review_required', 'review_required', 'review_required',
  CONCAT('system:asset-default:', rua.asset_code, ':unknown'),
  CONCAT(rua.asset_name, '原因不明或無法單憑照片判斷責任時，不由系統直接裁判；應由房東或維修人員確認原因後再套用規則。'),
  '責任不明時的保守處理規則。', 'unknown', 'review_required', 'review_required'
FROM leases le JOIN rental_unit_assets rua ON rua.rental_unit_id = le.rental_unit_id AND rua.status = 'active';
