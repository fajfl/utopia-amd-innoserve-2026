-- Seed asset-level repair rules for the current MVP leases.
--
-- 015 only creates whole-unit fallback rules. This migration turns the
-- existing rental_unit_assets list into concrete lease_repair_rules so the
-- repair agent can match rules by the selected furniture/equipment.
--
-- Semantics:
-- - liability_party = who is attributable for causing the damage.
-- - dispatch_party  = who should arrange/perform repair.
-- - payer_party     = who should pay/reimburse.
--
-- Normal failure / natural wear is not "landlord caused damage"; it is a
-- repair obligation, so liability_party stays "none".

INSERT OR IGNORE INTO lease_repair_rules (
  public_id,
  lease_id,
  rental_unit_id,
  asset_id,
  rule_scope,
  damage_type,
  responsible_party,
  repair_executor,
  payer_party,
  source_clause_path,
  source_text,
  notes,
  cause_classification,
  liability_party,
  dispatch_party
)
SELECT
  'rule-asset-normal-' || le.id || '-' || rua.id,
  le.id,
  le.rental_unit_id,
  rua.id,
  'asset',
  CASE
    WHEN rua.asset_type IN ('furniture', 'surface') THEN 'natural_wear'
    ELSE 'normal_use'
  END,
  'landlord',
  CASE
    WHEN rua.asset_type IN ('plumbing', 'electrical', 'service') OR rua.asset_name LIKE '%熱水器%' OR rua.asset_name LIKE '%瓦斯%' THEN 'vendor'
    ELSE 'landlord'
  END,
  'landlord',
  'system:asset-default:' || rua.asset_code || ':normal',
  CASE
    WHEN rua.asset_name LIKE '%冷氣%' THEN '冷氣因正常使用、自然老化、冷媒、壓縮機或排水零件故障而需修繕者，原則由房東負責修繕與費用；若涉及安全或專業拆裝，應由房東或合格廠商處理。'
    WHEN rua.asset_name LIKE '%熱水器%' THEN '熱水器屬安全設備，正常故障、自然老化或非可歸責於房客之情形，原則由房東或合格廠商處理並由房東負擔費用。'
    WHEN rua.asset_name LIKE '%天然瓦斯%' OR rua.asset_name LIKE '%瓦斯%' THEN '天然瓦斯或瓦斯相關設備有異常時，正常故障或管線/供應問題原則由房東或合格廠商處理；疑似外洩應優先安全分流。'
    WHEN rua.asset_name LIKE '%洗衣機%' THEN '洗衣機因正常使用造成馬達、排水、漏水或自然老化故障，原則由房東負責修繕與費用。'
    WHEN rua.asset_name LIKE '%冰箱%' THEN '冰箱因正常使用造成不冷、漏水、異音、門膠條或零件自然故障，原則由房東負責修繕與費用。'
    WHEN rua.asset_name LIKE '%電視%' THEN '電視因正常使用造成無畫面、無聲音、訊號或零件故障，原則由房東負責修繕與費用。'
    WHEN rua.asset_name LIKE '%床%' THEN '床架、床板或床墊因正常使用自然耗損而需修繕者，原則由房東負責合理修繕與費用。'
    WHEN rua.asset_name LIKE '%沙發%' THEN '沙發正常磨耗、彈性老化或非可歸責於房客之損壞，原則由房東負責合理修繕與費用。'
    WHEN rua.asset_name LIKE '%衣櫃%' THEN '衣櫃五金老化、滑軌或鉸鏈自然故障、板材自然變形，原則由房東負責合理修繕與費用。'
    WHEN rua.asset_name LIKE '%陽台%' THEN '陽台固定設備、排水、地面或欄杆因自然老化、結構或非可歸責於房客之問題，原則由房東處理與負擔費用。'
    WHEN rua.asset_name LIKE '%網路%' THEN '網路服務、線路或設備非因房客破壞而異常時，原則由房東協調服務商或廠商處理，費用由房東或依服務契約處理。'
    WHEN rua.asset_name LIKE '%第四台%' THEN '第四台服務、線路或設備非因房客破壞而異常時，原則由房東協調服務商處理，費用由房東或依服務契約處理。'
    WHEN rua.asset_name LIKE '%牆%' OR rua.asset_name LIKE '%地板%' THEN '牆面與地板正常磨耗或非可歸責於房客之滲水、隆起、自然劣化，原則由房東負責處理與費用。'
    ELSE rua.asset_name || '因正常使用、自然老化或非可歸責於房客之原因而需修繕者，原則由房東負責修繕與費用。'
  END,
  'MVP asset-level rule：依該房源既有家具/設備清單建立。仍須結合原始物況、照片、使用情境與維修紀錄判斷。',
  CASE
    WHEN rua.asset_type IN ('furniture', 'surface') THEN 'natural_wear'
    ELSE 'normal_failure'
  END,
  'none',
  CASE
    WHEN rua.asset_type IN ('plumbing', 'electrical', 'service') OR rua.asset_name LIKE '%熱水器%' OR rua.asset_name LIKE '%瓦斯%' THEN 'vendor'
    ELSE 'landlord'
  END
FROM leases le
JOIN rental_unit_assets rua
  ON rua.rental_unit_id = le.rental_unit_id
 AND rua.status = 'active';

INSERT OR IGNORE INTO lease_repair_rules (
  public_id,
  lease_id,
  rental_unit_id,
  asset_id,
  rule_scope,
  damage_type,
  responsible_party,
  repair_executor,
  payer_party,
  source_clause_path,
  source_text,
  notes,
  cause_classification,
  liability_party,
  dispatch_party
)
SELECT
  'rule-asset-tenant-fault-' || le.id || '-' || rua.id,
  le.id,
  le.rental_unit_id,
  rua.id,
  'asset',
  'tenant_fault',
  'tenant',
  'review_required',
  'tenant',
  'system:asset-default:' || rua.asset_code || ':tenant_fault',
  CASE
    WHEN rua.asset_name LIKE '%冷氣%' THEN '冷氣若因房客未盡合理使用或保管義務，例如長期未清濾網導致嚴重漏水、私自拆機、外力破壞或不當使用造成損壞，經證據確認後由房客負擔合理修繕費。'
    WHEN rua.asset_name LIKE '%熱水器%' THEN '熱水器若因房客拆改、違規或不當使用造成損壞，經證據確認後由房客負擔合理修繕費；安全設備仍應由合格人員處理。'
    WHEN rua.asset_name LIKE '%天然瓦斯%' OR rua.asset_name LIKE '%瓦斯%' THEN '天然瓦斯設備若因房客拆改、破壞或不當使用造成損壞，經證據確認後由房客負擔合理修繕費；疑似外洩應先安全處理。'
    WHEN rua.asset_name LIKE '%洗衣機%' THEN '洗衣機若因投入異物、超載、私自拆裝或不當使用造成損壞，經照片、影片或維修判斷確認後由房客負擔合理修繕費。'
    WHEN rua.asset_name LIKE '%冰箱%' THEN '冰箱若因搬動撞擊、進水、私自拆修或不當使用造成損壞，經證據確認後由房客負擔合理修繕費。'
    WHEN rua.asset_name LIKE '%電視%' THEN '電視若因撞擊、摔落、進水、螢幕破裂或不當使用造成損壞，經證據確認後由房客負擔合理修繕費或折舊後損失。'
    WHEN rua.asset_name LIKE '%床%' THEN '床若因跳床、拆裝不當、超出正常使用、寵物或外力破壞造成損壞，經證據確認後由房客負擔合理修繕費。'
    WHEN rua.asset_name LIKE '%沙發%' THEN '沙發若因破洞、菸燙、寵物抓咬、飲料滲污或其他不當使用造成損壞，經證據確認後由房客負擔合理修繕費或折舊後損失。'
    WHEN rua.asset_name LIKE '%衣櫃%' THEN '衣櫃若因撞擊、拉扯、拆裝不當或超出正常使用造成門片、鉸鏈、滑軌損壞，經證據確認後由房客負擔合理修繕費。'
    WHEN rua.asset_name LIKE '%陽台%' THEN '陽台若因房客堵塞排水、放置重物、破壞欄杆或不當使用造成損壞，經證據確認後由房客負擔合理修繕費。'
    WHEN rua.asset_name LIKE '%網路%' THEN '網路若因房客破壞線路、遺失路由器/數據機或私自拆改造成損壞，經證據確認後由房客負擔合理修繕費或設備賠償。'
    WHEN rua.asset_name LIKE '%第四台%' THEN '第四台若因房客剪線、拆設備、遺失機上盒或不當使用造成損壞，經證據確認後由房客負擔合理修繕費或設備賠償。'
    WHEN rua.asset_name LIKE '%牆%' OR rua.asset_name LIKE '%地板%' THEN '牆面與地板若因打洞、刮傷、泡水、寵物破壞或其他可歸責於房客之原因造成損壞，經入住點交、照片或維修判斷確認後由房客負擔合理修繕費。'
    ELSE rua.asset_name || '若因房客故意、過失、不當使用或未盡合理保管義務造成損壞，經證據確認後由房客負擔合理修繕費。'
  END,
  'MVP asset-level rule：房客責任仍需證據支持，不得只因房客通報即認定房客負擔。',
  'tenant_negligence',
  'tenant',
  'review_required'
FROM leases le
JOIN rental_unit_assets rua
  ON rua.rental_unit_id = le.rental_unit_id
 AND rua.status = 'active';

INSERT OR IGNORE INTO lease_repair_rules (
  public_id,
  lease_id,
  rental_unit_id,
  asset_id,
  rule_scope,
  damage_type,
  responsible_party,
  repair_executor,
  payer_party,
  source_clause_path,
  source_text,
  notes,
  cause_classification,
  liability_party,
  dispatch_party
)
SELECT
  'rule-asset-review-' || le.id || '-' || rua.id,
  le.id,
  le.rental_unit_id,
  rua.id,
  'asset',
  'unknown',
  'review_required',
  'review_required',
  'review_required',
  'system:asset-default:' || rua.asset_code || ':unknown',
  rua.asset_name || '報修資訊不足、損壞原因不明、缺少原始物況對照、照片或使用情境時，不直接判定責任；應請房客補充資料或由房東/維修人員確認後再套用規則。',
  'MVP asset-level rule：這是證據不足時的保護規則，避免 AI 硬判誰負責。',
  'unknown',
  'review_required',
  'review_required'
FROM leases le
JOIN rental_unit_assets rua
  ON rua.rental_unit_id = le.rental_unit_id
 AND rua.status = 'active';
