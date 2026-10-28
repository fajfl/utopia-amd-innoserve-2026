-- Clarify asset-level unknown repair rules.
-- The previous wording sounded like the tenant failed to provide evidence even when
-- photos/options were already submitted. This copy makes the distinction explicit:
-- unknown responsibility means the case needs landlord/vendor confirmation, not
-- necessarily that the tenant must upload more.

UPDATE lease_repair_rules
SET
  source_text = replace(
    source_text,
    '報修資訊不足、損壞原因不明、缺少原始物況對照、照片或使用情境時，不直接判定責任；應請房客補充資料或由房東/維修人員確認後再套用規則。',
    '報修原因不明或無法單憑照片判斷責任時，不由 AI 直接裁判；即使房客已提供描述、照片與選項，仍應由房東或維修人員確認原因後再套用責任規則。'
  ),
  notes = replace(
    coalesce(notes, ''),
    '這是證據不足時的保護規則，避免 AI 硬判誰負責。',
    '這是責任不明時的保守處理規則，避免 AI 在照片不足以判斷成因時硬判誰負責。'
  )
WHERE damage_type = 'unknown'
  AND source_clause_path LIKE 'asset:%:unknown';
