const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const repository = require('../repositories/v2ContractRepository');
const conditionRepository = require('../repositories/v2ContractConditionRepository');
const otpService = require('./v2ContractOtpService');
const { renderContractHtml, writeProtectedContractFile } = require('./v2ContractDocumentService');

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
const storageRoot = (db) => path.join(path.dirname(db.pragma('database_list')[0].file), 'contract-evidence');

function startTenantSigning({ db, lineUserId, versionPublicId }) {
  const version = repository.getVersionForViewer(db, { lineUserId, versionPublicId });
  const party = repository.requireVersionParty(db, { lineUserId, versionPublicId });
  if (party.party_role !== 'tenant' || version.status !== 'issued') throw new Error('contract is not ready for tenant signing');
  const request = db.prepare('SELECT public_id FROM signature_requests WHERE contract_version_id=? AND contract_party_id=?').get(version.id, party.party_id);
  return { version, signatureRequestPublicId: request?.public_id };
}

function recordReadingProgress(input) {
  return repository.updateReadingProgress(input.db, input);
}

function prepareTenantDocument({ db, lineUserId, signatureRequestPublicId, personalData }) {
  const request = repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (request.party_role !== 'tenant') throw new Error('tenant signature request required');
  const reading = db.prepare('SELECT reached_end_at FROM contract_reading_sessions WHERE signature_request_id=?').get(request.id);
  if (!reading?.reached_end_at) { const error = new Error('請先閱讀完整合約'); error.statusCode = 400; throw error; }
  const data = validatePersonalData(personalData);
  const version = db.prepare('SELECT * FROM contract_versions WHERE id=?').get(request.contract_version_id);
  // 屋況附件與租賃標的一併寫進正式文件，簽名涵蓋的 document_hash 才會蓋到附件一。
  const html = renderContractHtml({
    conditions: JSON.parse(version.condition_snapshot_json),
    parties: { tenant: data },
    attachments: conditionRepository.listAttachments(db, version.id),
    subject: repository.getContractSubject(db, request.contract_id)
  });
  const file = writeProtectedContractFile({ db, html, publicId: `${version.public_id}-tenant`, createdByUserId: request.user_id, storageDir: storageRoot(db) });
  db.transaction(() => {
    db.prepare(`INSERT INTO user_profiles (user_id,legal_name,phone,contact_address) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET legal_name=excluded.legal_name,phone=excluded.phone,contact_address=excluded.contact_address,updated_at=CURRENT_TIMESTAMP`).run(request.user_id, data.legalName, data.phone, data.householdAddress);
    repository.savePartySnapshot(db, { contractPartyId: request.contract_party_id, contractVersionId: request.contract_version_id, legalName: data.legalName, phone: data.phone, contactAddress: data.householdAddress, maskedIdentifier: maskNationalId(data.nationalId), partyRole: 'tenant', snapshotJson: JSON.stringify({ inputMethod: 'keyboard' }) });
    db.prepare('UPDATE contract_versions SET document_file_id=?,document_hash=? WHERE id=?').run(file.fileId, file.hash, request.contract_version_id);
    // 重按「建立正式預覽」時檔案會被重用,這條連結可能已經存在。
    db.prepare(`INSERT OR IGNORE INTO file_links (file_id,entity_type,entity_id,purpose) VALUES (?,'contract_version',?,'signed_preview')`).run(file.fileId, request.contract_version_id);
    db.prepare("UPDATE signature_requests SET status='viewed' WHERE id=? AND status IN ('pending','sent')").run(request.id);
  }).immediate();
  return { previewUrl: `/v2/files/${file.publicId}`, documentHash: file.hash, absolutePath: file.absolutePath };
}

const BASE64_MARKER = ';base64,';

// MediaRecorder 的 mimeType 會帶編碼參數（例如 video/webm;codecs=vp8,opus），
// 參數裡本身就有分號和逗號，無法用單一 regex 切；改成找 ";base64," 分界。
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

function writeEvidenceFiles(db, request, parts) {
  const directory = storageRoot(db);
  fs.mkdirSync(directory, { recursive: true });
  const specs = [
    ['signature', parts.signature.buffer, parts.signature.mimeType],
    ['strokes', parts.strokes, 'application/json'],
    ['video', parts.video.buffer, parts.video.mimeType]
  ];
  return specs.map(([purpose, buffer, mimeType]) => {
    const publicId = `file-${crypto.randomUUID()}`;
    const extension = purpose === 'signature' ? 'png' : purpose === 'strokes' ? 'json' : 'webm';
    const filename = `${publicId}.${extension}`;
    const absolutePath = path.join(directory, filename);
    fs.writeFileSync(absolutePath, buffer, { mode: 0o600 });
    return { purpose, buffer, mimeType, publicId, filename, absolutePath, storageKey: path.relative(process.cwd(), absolutePath).replace(/\\/g, '/') };
  });
}

function saveSignature({ db, request, evidence, requestMeta = {}, finalSigner = false, verificationChallengeId }) {
  const existing = db.prepare('SELECT * FROM signature_records WHERE signature_request_id=?').get(request.id);
  if (existing) return { record: existing, duplicate: true };
  const parts = evidenceParts(evidence);
  const files = writeEvidenceFiles(db, request, parts);
  try {
    const result = db.transaction(() => {
      for (const file of files) {
        const digest = hash(file.buffer);
        const existingFile = db.prepare(`SELECT id FROM files WHERE sha256_hash=? AND size_bytes=? AND security_classification='sensitive_contract'`).get(digest, file.buffer.length);
        if (existingFile) {
          file.id = existingFile.id;
          file.reused = true;
        } else {
          const inserted = db.prepare(`INSERT INTO files (public_id,storage_key,storage_provider,original_name,mime_type,size_bytes,sha256_hash,security_classification,created_by_user_id)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(file.publicId,file.storageKey,'local',file.filename,file.mimeType,file.buffer.length,digest,'sensitive_contract',request.user_id);
          file.id = Number(inserted.lastInsertRowid);
        }
      }
      const record = repository.recordSignature(db, { signatureRequestId: request.id, contractVersionId: request.contract_version_id, contractPartyId: request.contract_party_id, signatureFileId: files[0].id, strokesFileId: files[1].id, documentHash: request.document_hash, signatureHash: hash(parts.signature.buffer), verificationChallengeId, ipAddress: requestMeta.ipAddress, userAgent: requestMeta.userAgent });
      db.prepare(`INSERT INTO file_links (file_id,entity_type,entity_id,purpose) VALUES (?,'signature_record',?,'identity_video')`).run(files[2].id, record.id);
      if (finalSigner) db.prepare("UPDATE contracts SET status='executed',executed_at=CURRENT_TIMESTAMP WHERE id=?").run(request.contract_id);
      return { record, duplicate: false, executed: finalSigner, contractId: request.contract_id, contractVersionId: request.contract_version_id };
    }).immediate();
    for (const file of files) if (file.reused) fs.rmSync(file.absolutePath, { force: true });
    return result;
  } catch (error) {
    for (const file of files) fs.rmSync(file.absolutePath, { force: true });
    throw error;
  }
}

function submitTenantSignature({ db, lineUserId, signatureRequestPublicId, evidence, requestMeta }) {
  const request = repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (request.party_role !== 'tenant' || !request.document_hash) throw new Error('tenant document is not prepared');
  const challenge = otpService.requireVerifiedOtp({ db, lineUserId, signatureRequestPublicId });
  const saved = saveSignature({ db, request, evidence, requestMeta, verificationChallengeId: challenge.id });
  return { executed: false, waitingFor: 'landlord', duplicate: saved.duplicate, documentHash: request.document_hash, signatureRecordPublicId: saved.record.public_id };
}

function submitLandlordDecision({ db, lineUserId, signatureRequestPublicId, decision, evidence, requestMeta }) {
  const request = repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (request.party_role !== 'landlord') throw new Error('landlord signature request required');
  if (decision === 'reject') return repository.declineSignatureRequest(db, { signatureRequestId: request.id });
  if (decision !== 'sign') throw new Error('decision must be sign or reject');
  const challenge = otpService.requireVerifiedOtp({ db, lineUserId, signatureRequestPublicId });
  const tenantSigned = db.prepare(`SELECT 1 FROM signature_records sr JOIN contract_parties cp ON cp.id=sr.contract_party_id WHERE sr.contract_version_id=? AND cp.party_role='tenant'`).get(request.contract_version_id);
  if (!tenantSigned) throw new Error('tenant must sign first');
  if (evidence.documentHash && evidence.documentHash !== request.document_hash) throw new Error('document hash mismatch');
  const saved = saveSignature({ db, request, evidence, requestMeta, finalSigner: true, verificationChallengeId: challenge.id });
  return { executed: true, duplicate: saved.duplicate, documentHash: request.document_hash, contractId: saved.contractId, contractVersionId: saved.contractVersionId };
}

module.exports = { validatePersonalData, maskNationalId, startTenantSigning, recordReadingProgress, prepareTenantDocument, submitTenantSignature, submitLandlordDecision };
