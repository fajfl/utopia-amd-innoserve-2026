// 簽署主流程的 driver 版本。參數 `db` 收的是 sqlDriver 的 driver。
//
// 這支是整個叢集最需要小心的一份:它同時處理檔案寫入、雜湊比對與交易,
// 而且順序有法律意義 —— 文件雜湊必須在寫入 signature_records 之前比對過。

const crypto = require('node:crypto');
const repository = require('../repositories/v2ContractRepositoryAsync');
const conditionRepository = require('../repositories/v2ContractConditionRepositoryAsync');
const otpService = require('./v2ContractOtpServiceAsync');
const { renderContractHtml, writeProtectedContractFileAsync } = require('./v2ContractDocumentService');
const { resolveEvidenceDir } = require('./contractEvidenceStorage');
const { createFileStorage, storageKey: storageKeyForStored } = require('./fileStorage');
const { claimRentalUnitOnLandlordSignature } = require('./ecsNeoRentalUnitClaimServiceAsync');
const { applyLandlordIntentionDecision } = require('./ecsNeoLandlordDecisionServiceAsync');

function validatePersonalData(input = {}) {
  const data = {
    legalName: String(input.legalName || '').trim(),
    phone: String(input.phone || '').replace(/\s+/g, ''),
    nationalId: String(input.nationalId || '').trim().toUpperCase(),
    householdAddress: String(input.householdAddress || '').trim()
  };
  if (!data.legalName || !/^09\d{8}$/.test(data.phone) || !/^[A-Z][12]\d{8}$/.test(data.nationalId) || !data.householdAddress) {
    const error = new Error('簽約資料不完整或格式不正確'); error.statusCode = 400; throw error;
  }
  return data;
}

const maskNationalId = (value) => `${value.slice(0, 2)}******${value.slice(-2)}`;
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function startTenantSigning({ db, lineUserId, versionPublicId }) {
  const version = await repository.getVersionForViewer(db, { lineUserId, versionPublicId });
  const party = await repository.requireVersionParty(db, { lineUserId, versionPublicId });
  if (party.party_role !== 'tenant' || version.status !== 'issued') throw new Error('contract is not ready for tenant signing');
  const request = await db.get('SELECT public_id FROM signature_requests WHERE contract_version_id=? AND contract_party_id=?', [version.id, party.party_id]);
  return { version, signatureRequestPublicId: request?.public_id };
}

async function recordReadingProgress(input) {
  return repository.updateReadingProgress(input.db, input);
}

async function prepareTenantDocument({ db, lineUserId, signatureRequestPublicId, personalData, storageDir }) {
  const request = await repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (request.party_role !== 'tenant') throw new Error('tenant signature request required');
  if (await db.get('SELECT 1 FROM signature_records WHERE contract_version_id=? LIMIT 1', [request.contract_version_id])) throw new Error('signed contract version is immutable');
  const reading = await db.get('SELECT reached_end_at FROM contract_reading_sessions WHERE signature_request_id=?', [request.id]);
  if (!reading?.reached_end_at) { const error = new Error('請先閱讀完整合約'); error.statusCode = 400; throw error; }
  const data = validatePersonalData(personalData);
  const landlord = await db.get(`SELECT cp.id AS partyId, up.legal_name AS legalName FROM contract_parties cp
    LEFT JOIN user_profiles up ON up.user_id=cp.user_id
    WHERE cp.contract_id=? AND cp.party_role='landlord' AND cp.status='active' ORDER BY cp.id LIMIT 1`, [request.contract_id]);
  if (!landlord?.legalName?.trim()) {
    const error = new Error('請房東先至「個人資料」補齊「真實姓名」，再重新建立正式預覽'); error.statusCode = 400; throw error;
  }
  const version = await db.get('SELECT * FROM contract_versions WHERE id=?', [request.contract_version_id]);
  // 屋況附件與租賃標的一併寫進正式文件，簽名涵蓋的 document_hash 才會蓋到附件一。
  const html = renderContractHtml({
    conditions: JSON.parse(version.condition_snapshot_json),
    parties: { tenant: data, landlord: { legalName: landlord.legalName.trim() } },
    attachments: await conditionRepository.listAttachments(db, version.id),
    subject: await repository.getContractSubject(db, request.contract_id)
  });
  const file = await writeProtectedContractFileAsync({ db, html, publicId: `${version.public_id}-tenant`, createdByUserId: request.user_id, storageDir: resolveEvidenceDir(db, storageDir) });
  await db.transaction(async (tx) => {
    if (tx.dialect.name === 'mysql') await tx.get('SELECT id FROM contract_versions WHERE id=? FOR UPDATE', [request.contract_version_id]);
    if (await tx.get('SELECT 1 FROM signature_records WHERE contract_version_id=? LIMIT 1', [request.contract_version_id])) throw new Error('signed contract version is immutable');
    const d = tx.dialect;
    await tx.run(`INSERT INTO user_profiles (user_id,legal_name,phone,contact_address) VALUES (?,?,?,?)
      ${d.onConflict('user_id')} legal_name=${d.incoming('legal_name')},phone=${d.incoming('phone')},contact_address=${d.incoming('contact_address')},updated_at=CURRENT_TIMESTAMP`,
    [request.user_id, data.legalName, data.phone, data.householdAddress]);
    await repository.savePartySnapshot(tx, { contractPartyId: request.contract_party_id, contractVersionId: request.contract_version_id, legalName: data.legalName, phone: data.phone, contactAddress: data.householdAddress, maskedIdentifier: maskNationalId(data.nationalId), partyRole: 'tenant', snapshotJson: JSON.stringify({ inputMethod: 'keyboard' }) });
    await repository.savePartySnapshot(tx, { contractPartyId: landlord.partyId, contractVersionId: request.contract_version_id, legalName: landlord.legalName.trim(), partyRole: 'landlord', snapshotJson: JSON.stringify({ inputMethod: 'profile' }) });
    await tx.run('UPDATE contract_versions SET document_file_id=?,document_hash=? WHERE id=?', [file.fileId, file.hash, request.contract_version_id]);
    // 重按「建立正式預覽」時檔案會被重用,這條連結可能已經存在。
    await tx.run(`${d.insertIgnore} INTO file_links (file_id,entity_type,entity_id,purpose) VALUES (?,'contract_version',?,'signed_preview')`, [file.fileId, request.contract_version_id]);
    await tx.run("UPDATE signature_requests SET status='viewed' WHERE id=? AND status IN ('pending','sent')", [request.id]);
  });
  return { previewUrl: `/v2/files/${file.publicId}`, documentHash: file.hash, absolutePath: file.absolutePath };
}

const BASE64_MARKER = ';base64,';

// MediaRecorder 的 mimeType 會帶編碼參數,例如 "video/webm;codecs=vp8,opus",
// 所以 data URL 是 `data:video/webm;codecs=vp8,opus;base64,...`。
// 不能用單一 regex 切 —— 參數裡本身就有分號和逗號。改成找 ";base64," 這個分界。
function decodeDataUrl(value, expectedPrefix, maxBytes) {
  const raw = String(value || '');
  const index = raw.indexOf(BASE64_MARKER);
  if (!raw.startsWith('data:') || index < 0) throw new Error(`invalid ${expectedPrefix} evidence`);
  const header = raw.slice('data:'.length, index);
  const mimeType = header.split(';')[0].trim().toLowerCase();
  const payload = raw.slice(index + BASE64_MARKER.length);
  if (!mimeType.startsWith(expectedPrefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error(`invalid ${expectedPrefix} evidence`);
  }
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length || buffer.length > maxBytes) throw new Error(`${expectedPrefix} evidence size is invalid`);
  return { buffer, mimeType: header || mimeType };
}

function evidenceParts(evidence = {}) {
  const signature = decodeDataUrl(evidence.signatureDataUrl, 'image/', 5 * 1024 * 1024);
  const video = decodeDataUrl(evidence.videoDataUrl, 'video/', 100 * 1024 * 1024);
  const strokes = Buffer.from(String(evidence.strokesJson || ''), 'utf8');
  if (!strokes.length || strokes.length > 1024 * 1024) throw new Error('invalid signature strokes');
  return { signature, video, strokes };
}

async function writeEvidenceFiles(directory, parts) {
  const { provider, storage } = createFileStorage({ localRoot: directory, prefix: 'sensitive-contract' });
  const specs = [
    ['signature', parts.signature.buffer, parts.signature.mimeType],
    ['strokes', parts.strokes, 'application/json'],
    ['video', parts.video.buffer, parts.video.mimeType]
  ];
  return Promise.all(specs.map(async ([purpose, buffer, mimeType]) => {
    const publicId = `file-${crypto.randomUUID()}`;
    const extension = purpose === 'signature' ? 'png' : purpose === 'strokes' ? 'json' : 'webm';
    const filename = `${publicId}.${extension}`;
    const stored = await storage.put(filename, buffer, { contentType: mimeType });
    return { purpose, buffer, mimeType, publicId, filename, provider, absolutePath: stored.absolutePath, storageKey: storageKeyForStored(stored, provider), storage };
  }));
}

async function saveSignature({ db, request, evidence, requestMeta = {}, finalSigner = false, verificationChallengeId, storageDir }) {
  const existing = await db.get('SELECT * FROM signature_records WHERE signature_request_id=?', [request.id]);
  if (existing) return { record: existing, duplicate: true };
  if (!evidence?.documentHash || evidence.documentHash !== request.document_hash) throw new Error('document hash mismatch');
  const parts = evidenceParts(evidence);
  // 檔案先落地再開交易:交易期間不做 I/O。失敗時下面會逐一刪除。
  const files = await writeEvidenceFiles(resolveEvidenceDir(db, storageDir), parts);
  try {
    const result = await db.transaction(async (tx) => {
      const version = await tx.get(`SELECT document_hash FROM contract_versions WHERE id=?${tx.dialect.name === 'mysql' ? ' FOR UPDATE' : ''}`, [request.contract_version_id]);
      if (!version || version.document_hash !== evidence.documentHash) throw new Error('document hash mismatch');
      const state = await tx.get(`SELECT sr.status AS request_status, c.status AS contract_status FROM signature_requests sr JOIN contract_versions cv ON cv.id=sr.contract_version_id JOIN contracts c ON c.id=cv.contract_id WHERE sr.id=?${tx.dialect.name === 'mysql' ? ' FOR UPDATE' : ''}`, [request.id]);
      if (!state || !['pending', 'sent', 'viewed'].includes(state.request_status) || state.contract_status !== 'signing') throw new Error('簽署請求已失效');
      for (const file of files) {
        const digest = hash(file.buffer);
        const existingFile = await tx.get("SELECT id FROM files WHERE sha256_hash=? AND size_bytes=? AND security_classification='sensitive_contract'", [digest, file.buffer.length]);
        if (existingFile) {
          file.id = existingFile.id;
          file.reused = true;
        } else {
          const inserted = await tx.run(`INSERT INTO files (public_id,storage_key,storage_provider,original_name,mime_type,size_bytes,sha256_hash,security_classification,created_by_user_id)
            VALUES (?,?,?,?,?,?,?,?,?)`, [file.publicId, file.storageKey, file.provider, file.filename, file.mimeType, file.buffer.length, digest, 'sensitive_contract', request.user_id]);
          file.id = inserted.insertId;
        }
      }
      // 房東是唯一會取得成交鎖的簽署人。claim 與簽章、executed 必須同一交易；
      // 任何併發落敗都會讓下面新落地的證據檔案由 catch 清掉。
      if (finalSigner) await claimRentalUnitOnLandlordSignature(tx, { request });
      // recordSignature 內部會先比對 document hash 才寫入,順序不可調換。
      const record = await repository.recordSignature(tx, { signatureRequestId: request.id, contractVersionId: request.contract_version_id, contractPartyId: request.contract_party_id, signatureFileId: files[0].id, strokesFileId: files[1].id, documentHash: evidence.documentHash, signatureHash: hash(parts.signature.buffer), verificationChallengeId, ipAddress: requestMeta.ipAddress, userAgent: requestMeta.userAgent });
      await tx.run("INSERT INTO file_links (file_id,entity_type,entity_id,purpose) VALUES (?,'signature_record',?,'identity_video')", [files[2].id, record.id]);
      if (finalSigner) {
        const candidates = await tx.all(require('../repositories/v2ContractRepository').signedVersionCandidateSql, [request.contract_id]);
        if (candidates.length !== 1 || String(candidates[0].version_id) !== String(request.contract_version_id) || candidates[0].document_hash !== evidence.documentHash) throw new Error('signed contract version cannot be verified');
        await tx.run("UPDATE contracts SET status='executed',executed_at=CURRENT_TIMESTAMP,signed_version_id=?,signed_document_hash=? WHERE id=?", [request.contract_version_id, evidence.documentHash, request.contract_id]);
        await require('./signedContractLeaseService').createAsync(tx, request.contract_id, request.contract_version_id);
      }
      return { record, duplicate: false, executed: finalSigner, contractId: request.contract_id, contractVersionId: request.contract_version_id };
    });
    for (const file of files) if (file.reused) await file.storage.delete(file.filename);
    return result;
  } catch (error) {
    for (const file of files) await file.storage.delete(file.filename);
    throw error;
  }
}

async function submitTenantSignature({ db, lineUserId, signatureRequestPublicId, evidence, requestMeta, storageDir }) {
  const request = await repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (request.party_role !== 'tenant' || !request.document_hash) throw new Error('tenant document is not prepared');
  const challenge = await otpService.requireVerifiedOtp({ db, lineUserId, signatureRequestPublicId });
  const saved = await saveSignature({ db, request, evidence, requestMeta, verificationChallengeId: challenge.id, storageDir });
  return { executed: false, waitingFor: 'landlord', duplicate: saved.duplicate, documentHash: request.document_hash, signatureRecordPublicId: saved.record.public_id };
}

async function submitLandlordDecision({ db, lineUserId, signatureRequestPublicId, decision, evidence, reason, requestMeta, storageDir }) {
  const request = await repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (request.party_role !== 'landlord') throw new Error('landlord signature request required');
  if (decision === 'request_changes') {
    return db.transaction(async (tx) => {
      const version = await tx.get(`SELECT id, status FROM contract_versions WHERE id=?${tx.dialect.name === 'mysql' ? ' FOR UPDATE' : ''}`, [request.contract_version_id]);
      const signed = await tx.get('SELECT 1 FROM signature_records WHERE contract_version_id=? LIMIT 1', [request.contract_version_id]);
      if (signed) {
        const error = new Error('房客已經完成簽署，這一版不能再退回修改；要終止請選擇拒絕');
        error.code = 'contract_version_signed'; error.statusCode = 409; throw error;
      }
      const state = await tx.get(`SELECT sr.status AS request_status, c.status AS contract_status FROM signature_requests sr JOIN contracts c ON c.id=? WHERE sr.id=?${tx.dialect.name === 'mysql' ? ' FOR UPDATE' : ''}`, [request.contract_id, request.id]);
      if (!version || version.status !== 'issued' || !state || !['pending', 'sent', 'viewed'].includes(state.request_status) || state.contract_status !== 'signing') throw new Error('簽署請求已失效');
      const landlord = await tx.get('SELECT user_id FROM contract_parties WHERE id=?', [request.contract_party_id]);
      const confirmed = await tx.get(`SELECT ri.confirmed_intention_version_id FROM contracts c JOIN rental_intentions ri ON ri.id=c.selected_intention_id WHERE c.id=?`, [request.contract_id]);
      const intention = confirmed?.confirmed_intention_version_id != null
        ? await applyLandlordIntentionDecision(tx, {
          action: decision, contractId: request.contract_id, landlordUserId: landlord ? landlord.user_id : null,
          reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
          idempotencyKey: `landlord-signature-decision:${decision}:${request.id}`
        }) : null;
      await tx.run("UPDATE signature_requests SET status='cancelled',completed_at=CURRENT_TIMESTAMP WHERE contract_version_id=? AND status IN ('pending','sent','viewed')", [request.contract_version_id]);
      await tx.run("UPDATE contract_versions SET status='superseded' WHERE id=? AND status='issued'", [request.contract_version_id]);
      await tx.run("UPDATE contracts SET status='drafting',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='signing'", [request.contract_id]);
      return { requestedChanges: true, intention };
    });
  }
  if (decision === 'reject') {
    return db.transaction(async (tx) => {
      const version = await tx.get(`SELECT id FROM contract_versions WHERE id=?${tx.dialect.name === 'mysql' ? ' FOR UPDATE' : ''}`, [request.contract_version_id]);
      const state = await tx.get(`SELECT sr.status AS request_status, c.status AS contract_status FROM signature_requests sr JOIN contracts c ON c.id=? WHERE sr.id=?${tx.dialect.name === 'mysql' ? ' FOR UPDATE' : ''}`, [request.contract_id, request.id]);
      if (!version || !state || !['pending', 'sent', 'viewed'].includes(state.request_status) || state.contract_status !== 'signing') throw new Error('簽署請求已失效');
      const landlord = await tx.get('SELECT user_id FROM contract_parties WHERE id=?', [request.contract_party_id]);
      const confirmed = await tx.get(`SELECT ri.confirmed_intention_version_id FROM contracts c JOIN rental_intentions ri ON ri.id=c.selected_intention_id WHERE c.id=?`, [request.contract_id]);
      const intention = confirmed?.confirmed_intention_version_id != null
        ? await applyLandlordIntentionDecision(tx, {
          action: decision, contractId: request.contract_id, landlordUserId: landlord ? landlord.user_id : null,
          reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
          idempotencyKey: `landlord-signature-decision:${decision}:${request.id}`
        }) : null;
      const declined = await repository.declineSignatureRequest(tx, { signatureRequestId: request.id });
      return intention ? { ...declined, intention } : declined;
    });
  }
  if (decision !== 'sign') throw new Error('decision must be sign, request_changes or reject');
  const challenge = await otpService.requireVerifiedOtp({ db, lineUserId, signatureRequestPublicId });
  const tenantSigned = await db.get("SELECT 1 FROM signature_records sr JOIN contract_parties cp ON cp.id=sr.contract_party_id WHERE sr.contract_version_id=? AND cp.party_role='tenant'", [request.contract_version_id]);
  if (!tenantSigned) throw new Error('tenant must sign first');
  if (!evidence?.documentHash || evidence.documentHash !== request.document_hash) throw new Error('document hash mismatch');
  const saved = await saveSignature({ db, request, evidence, requestMeta, finalSigner: true, verificationChallengeId: challenge.id, storageDir });
  return { executed: true, duplicate: saved.duplicate, documentHash: request.document_hash, contractId: saved.contractId, contractVersionId: saved.contractVersionId };
}

module.exports = { validatePersonalData, maskNationalId, startTenantSigning, recordReadingProgress, prepareTenantDocument, submitTenantSignature, submitLandlordDecision };
