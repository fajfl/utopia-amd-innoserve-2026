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
  const reading = await db.get('SELECT reached_end_at FROM contract_reading_sessions WHERE signature_request_id=?', [request.id]);
  if (!reading?.reached_end_at) { const error = new Error('請先閱讀完整合約'); error.statusCode = 400; throw error; }
  const data = validatePersonalData(personalData);
  const version = await db.get('SELECT * FROM contract_versions WHERE id=?', [request.contract_version_id]);
  // 屋況附件與租賃標的一併寫進正式文件，簽名涵蓋的 document_hash 才會蓋到附件一。
  const html = renderContractHtml({
    conditions: JSON.parse(version.condition_snapshot_json),
    parties: { tenant: data },
    attachments: await conditionRepository.listAttachments(db, version.id),
    subject: await repository.getContractSubject(db, request.contract_id)
  });
  const file = await writeProtectedContractFileAsync({ db, html, publicId: `${version.public_id}-tenant`, createdByUserId: request.user_id, storageDir: resolveEvidenceDir(db, storageDir) });
  await db.transaction(async (tx) => {
    const d = tx.dialect;
    await tx.run(`INSERT INTO user_profiles (user_id,legal_name,phone,contact_address) VALUES (?,?,?,?)
      ${d.onConflict('user_id')} legal_name=${d.incoming('legal_name')},phone=${d.incoming('phone')},contact_address=${d.incoming('contact_address')},updated_at=CURRENT_TIMESTAMP`,
    [request.user_id, data.legalName, data.phone, data.householdAddress]);
    await repository.savePartySnapshot(tx, { contractPartyId: request.contract_party_id, contractVersionId: request.contract_version_id, legalName: data.legalName, phone: data.phone, contactAddress: data.householdAddress, maskedIdentifier: maskNationalId(data.nationalId), partyRole: 'tenant', snapshotJson: JSON.stringify({ inputMethod: 'keyboard' }) });
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
  const parts = evidenceParts(evidence);
  // 檔案先落地再開交易:交易期間不做 I/O。失敗時下面會逐一刪除。
  const files = await writeEvidenceFiles(resolveEvidenceDir(db, storageDir), parts);
  try {
    const result = await db.transaction(async (tx) => {
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
      const record = await repository.recordSignature(tx, { signatureRequestId: request.id, contractVersionId: request.contract_version_id, contractPartyId: request.contract_party_id, signatureFileId: files[0].id, strokesFileId: files[1].id, documentHash: request.document_hash, signatureHash: hash(parts.signature.buffer), verificationChallengeId, ipAddress: requestMeta.ipAddress, userAgent: requestMeta.userAgent });
      await tx.run("INSERT INTO file_links (file_id,entity_type,entity_id,purpose) VALUES (?,'signature_record',?,'identity_video')", [files[2].id, record.id]);
      if (finalSigner) await tx.run("UPDATE contracts SET status='executed',executed_at=CURRENT_TIMESTAMP WHERE id=?", [request.contract_id]);
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
  // 意向層的決定**先**做,而且冪等。順序反過來的話,合約已經退回／作廢但意向
  // 仍停在 submitted,重試又會被合約層的條件式 UPDATE 擋掉,那筆意向就永遠卡住。
  if (decision === 'reject' || decision === 'request_changes') {
    // 有人簽過名的版本是凍結的:SQLite 用 trg_contract_version_immutable_update 擋,
    // TiDB 沒有 trigger,所以這裡必須自己擋 —— 少了這一段,同一個動作在兩個方言
    // 會有完全不同的結果(一個 500、一個默默把已簽版本改成 superseded)。
    //
    // 而且必須擋在 applyLandlordIntentionDecision **之前**。意向決定是獨立交易,
    // 先跑再讓合約層炸掉的話,意向已經退回 draft、確認指標也清了,合約卻還停在
    // signing:那筆意向會永遠卡住,重試也只會再炸一次。
    //
    // 房客已經簽名之後,房東要的不是「改一版」而是「不接受這一版」:請走 reject。
    if (decision === 'request_changes') {
      const signed = await db.get('SELECT 1 FROM signature_records WHERE contract_version_id=? LIMIT 1', [request.contract_version_id]);
      if (signed) {
        const error = new Error('房客已經完成簽署，這一版不能再退回修改；要終止請選擇拒絕');
        error.code = 'contract_version_signed';
        error.statusCode = 409;
        throw error;
      }
    }
    const landlord = await db.get('SELECT user_id FROM contract_parties WHERE id=?', [request.contract_party_id]);
    // 030 前的既有合約也可能已經掛了 selected_intention_id，但沒有
    // confirmed_intention_version_id。它們不是 Agent materialized draft，保留舊有
    // 「直接取消合約」行為；只有由 exact confirmed version 建立的主線才寫意向決定。
    // 不能把這個相容性判斷塞進 applyLandlordIntentionDecision：該 command 對真正
    // Agent 合約必須繼續嚴格要求 exact version。
    const confirmed = await db.get(`
      SELECT ri.confirmed_intention_version_id
      FROM contracts c
      JOIN rental_intentions ri ON ri.id = c.selected_intention_id
      WHERE c.id = ?
    `, [request.contract_id]);
    const intentionOutcome = confirmed && confirmed.confirmed_intention_version_id !== null
      && confirmed.confirmed_intention_version_id !== undefined
      ? await db.transaction((tx) => applyLandlordIntentionDecision(tx, {
          action: decision,
          contractId: request.contract_id,
          landlordUserId: landlord ? landlord.user_id : null,
          // 房東自己輸入的理由。可選;沒寫就是 null,不編也不猜。
          reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
          idempotencyKey: `landlord-signature-decision:${decision}:${request.id}`
        }))
      : null;

    if (decision === 'reject') {
      const declined = await repository.declineSignatureRequest(db, { signatureRequestId: request.id });
      // 拒絕終止的是**這一筆承租意向**,不是「回去改一版」。
      return intentionOutcome ? { ...declined, intention: intentionOutcome } : declined;
    }

    await db.transaction(async (tx) => {
      await tx.run("UPDATE signature_requests SET status='cancelled',completed_at=CURRENT_TIMESTAMP WHERE contract_version_id=? AND status IN ('pending','sent','viewed')", [request.contract_version_id]);
      await tx.run("UPDATE contract_versions SET status='superseded' WHERE id=? AND status='issued'", [request.contract_version_id]);
      await tx.run("UPDATE contracts SET status='drafting',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='signing'", [request.contract_id]);
    });
    // 意向已回到 draft:房客可以繼續跟 Agent 協調並產生新版本,舊版本原樣保留。
    return { requestedChanges: true, intention: intentionOutcome };
  }
  if (decision !== 'sign') throw new Error('decision must be sign, request_changes or reject');
  const challenge = await otpService.requireVerifiedOtp({ db, lineUserId, signatureRequestPublicId });
  const tenantSigned = await db.get("SELECT 1 FROM signature_records sr JOIN contract_parties cp ON cp.id=sr.contract_party_id WHERE sr.contract_version_id=? AND cp.party_role='tenant'", [request.contract_version_id]);
  if (!tenantSigned) throw new Error('tenant must sign first');
  if (evidence.documentHash && evidence.documentHash !== request.document_hash) throw new Error('document hash mismatch');
  const saved = await saveSignature({ db, request, evidence, requestMeta, finalSigner: true, verificationChallengeId: challenge.id, storageDir });
  return { executed: true, duplicate: saved.duplicate, documentHash: request.document_hash, contractId: saved.contractId, contractVersionId: saved.contractVersionId };
}

module.exports = { validatePersonalData, maskNationalId, startTenantSigning, recordReadingProgress, prepareTenantDocument, submitTenantSignature, submitLandlordDecision };
