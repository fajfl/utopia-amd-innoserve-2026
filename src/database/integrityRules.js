// SQLite 觸發器在 TiDB 沒有對應品(TiDB 不支援 CREATE TRIGGER),
// 因此原本由 database/migrations/*.sql 內 9 個 trigger 保護的完整性規則
// 改由應用層強制執行。
//
// 規則本身寫在這裡、只寫一次;better-sqlite3(同步)與 mysql2(非同步)
// 各自只是薄薄的執行層。遷移期間兩條路徑並存,規則放兩份必然會分岔。
//
// 錯誤訊息與原 RAISE(ABORT, ...) 保持一致,讓既有呼叫端與測試行為不變。

function violation(message) {
  const error = new Error(message);
  error.code = 'INTEGRITY_VIOLATION';
  error.statusCode = 409;
  throw error;
}

// violateWhen:
//   'found'   查詢有結果就違規
//   'missing' 查詢沒結果就違規
const RULES = {
  // 對應 trg_contract_version_immutable_update / _delete
  // 已有簽章紀錄,或合約已 executed 的版本不得再更動。
  assertContractVersionMutable: {
    message: 'signed contract version is immutable',
    violateWhen: 'found',
    sql: `
      SELECT 1
      FROM contract_versions cv
      WHERE cv.id = ?
        AND (
          EXISTS (SELECT 1 FROM signature_records WHERE contract_version_id = cv.id)
          OR EXISTS (SELECT 1 FROM contracts WHERE id = cv.contract_id AND status = 'executed')
        )
      LIMIT 1
    `,
    params: (contractVersionId) => [contractVersionId]
  },

  // 對應 trg_condition_attachment_immutable_insert / _update / _delete
  // 版本一旦有簽章紀錄,其屋況附件不得新增、修改或移除。
  assertConditionAttachmentMutable: {
    message: 'signed contract version cannot change condition attachments',
    violateWhen: 'found',
    sql: 'SELECT 1 FROM signature_records WHERE contract_version_id = ? LIMIT 1',
    params: (contractVersionId) => [contractVersionId]
  },

  // 對應 trg_knowledge_source_landlord_answer_reuse
  // 房東回答必須勾選 reuse_approved 才能被引用為知識來源。
  // 其他 source type(例如 landlord_manual_input)不受此規則約束。
  assertLandlordAnswerReusable: {
    message: 'landlord answer is not approved for reuse',
    violateWhen: 'missing',
    skip: ({ sourceType }) => sourceType !== 'landlord_answer',
    sql: 'SELECT 1 FROM landlord_answers WHERE id = ? AND reuse_approved = 1 LIMIT 1',
    params: ({ sourceId }) => [sourceId]
  },

  // 對應 trg_lease_requires_executed_contract
  // 租約必須對應到同一個租賃單位、且狀態為 executed 的合約。
  assertLeaseHasExecutedContract: {
    message: 'lease requires an executed contract',
    violateWhen: 'missing',
    sql: `
      SELECT 1 FROM contracts
      WHERE id = ? AND rental_unit_id = ? AND status = 'executed'
      LIMIT 1
    `,
    params: ({ contractId, rentalUnitId }) => [contractId, rentalUnitId]
  },

  // 對應 trg_signature_document_hash
  // 簽章當下的文件雜湊必須與合約版本紀錄的雜湊相符。
  assertSignatureDocumentHash: {
    message: 'signature document hash does not match contract version',
    violateWhen: 'missing',
    sql: 'SELECT 1 FROM contract_versions WHERE id = ? AND document_hash = ? LIMIT 1',
    params: ({ contractVersionId, documentHash }) => [contractVersionId, documentHash]
  },

  // 對應 trg_signature_request_same_contract
  // 簽署人必須隸屬於該合約版本所屬的合約。
  assertSignatureRequestSameContract: {
    message: 'signature party does not belong to contract',
    violateWhen: 'missing',
    sql: `
      SELECT 1
      FROM contract_versions cv
      JOIN contract_parties cp ON cp.contract_id = cv.contract_id
      WHERE cv.id = ? AND cp.id = ?
      LIMIT 1
    `,
    params: ({ contractVersionId, contractPartyId }) => [contractVersionId, contractPartyId]
  }
};

function decide(rule, hasRow) {
  if (rule.violateWhen === 'found' ? hasRow : !hasRow) violation(rule.message);
}

module.exports = { RULES, decide, violation };
