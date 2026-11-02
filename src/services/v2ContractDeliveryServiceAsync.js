const crypto = require('node:crypto');
const repository = require('../repositories/v2ContractRepositoryAsync');
const conditionService = require('./v2ContractConditionServiceAsync');
const { readStoredFile } = require('./fileStorage');

async function getCompletedContract({ db, lineUserId, contractPublicId }) {
  const party = await repository.requireContractParty(db, { lineUserId, contractPublicId });
  const contract = await db.get('SELECT status,executed_at FROM contracts WHERE id=?', [party.contract_id]);
  if (contract.status !== 'executed') {
    const error = new Error('合約尚未完成簽署'); error.statusCode = 409; throw error;
  }
  const signed = await repository.getSignedVersion(db, party.contract_id);
  const version = signed && await db.get('SELECT * FROM contract_versions WHERE id=?', [signed.version_id]);
  const file = version && await db.get("SELECT * FROM files WHERE id=? AND status='active'", [version.document_file_id]);
  if (!file || !version.document_hash) {
    const error = new Error('已簽署文件尚無可交付的保存檔案'); error.statusCode = 409; throw error;
  }
  const signatures = await db.all(`SELECT sr.public_id AS publicId,cp.party_role AS partyRole,
    sr.signed_at AS signedAt,sr.document_hash AS documentHash
    FROM signature_records sr JOIN contract_parties cp ON cp.id=sr.contract_party_id
    WHERE sr.contract_version_id=? ORDER BY sr.signed_at,sr.id`, [version.id]);
  let bytes;
  try {
    bytes = await readStoredFile(file);
  } catch (cause) {
    if (cause.code !== 'ENOENT' && cause.code !== 'NoSuchKey') throw cause;
    const error = new Error('已簽署文件保存檔案不存在'); error.statusCode = 404; throw error;
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== version.document_hash || digest !== file.sha256_hash || signatures.some((row) => row.documentHash !== digest)) {
    const error = new Error('已簽署文件完整性驗證失敗'); error.statusCode = 409; throw error;
  }
  return {
    contractPublicId, versionNumber: version.version_number, documentHash: digest,
    executedAt: contract.executed_at, signatures, bytes,
    attachments: await conditionService.attachmentsForVersion(db, version.id)
  };
}

async function canReadCompletedAttachment(db, { lineUserId, sessionPublicId, entryId }) {
  const attachments = await db.all(`SELECT cca.manifest_json
    FROM contract_condition_attachments cca
    JOIN contract_versions cv ON cv.id=cca.contract_version_id
    JOIN contracts c ON c.id=cv.contract_id AND c.status='executed'
    JOIN contract_parties cp ON cp.contract_id=c.id AND cp.status='active'
    JOIN line_identities li ON li.user_id=cp.user_id
    WHERE cca.session_public_id=? AND li.line_user_id=? AND cv.document_file_id IS NOT NULL
      AND cv.id=c.signed_version_id AND cv.document_hash=c.signed_document_hash`, [sessionPublicId, lineUserId]);
  const expectedUrl = `/tenant/pre-inspections/${encodeURIComponent(sessionPublicId)}/media/${encodeURIComponent(entryId)}`;
  return attachments.some((attachment) => {
    try {
      return (JSON.parse(attachment.manifest_json).entries || []).some((entry) =>
        (entry.kind === 'image' || entry.kind === 'video') && entry.url === expectedUrl);
    } catch { return false; }
  });
}

module.exports = { getCompletedContract, canReadCompletedAttachment };
