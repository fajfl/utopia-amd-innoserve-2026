const crypto = require('node:crypto');
const {
  assertContractVersionMutable,
  assertSignatureDocumentHash,
  assertSignatureRequestSameContract
} = require('../database/integrityGuards');

const publicId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function forbidden() {
  const error = new Error('forbidden');
  error.statusCode = 403;
  throw error;
}

function findViewer(db, lineUserId) {
  return db.prepare(`
    SELECT u.id AS user_id, li.id AS line_identity_id
    FROM line_identities li JOIN users u ON u.id = li.user_id
    WHERE li.line_user_id = ? AND u.status = 'active'
  `).get(String(lineUserId || '').trim()) || null;
}

function findCurrentContractForViewer(db, lineUserId) {
  return db.prepare(`SELECT c.public_id AS contractPublicId FROM line_identities li JOIN contract_parties cp ON cp.user_id=li.user_id AND cp.status='active' JOIN contracts c ON c.id=cp.contract_id AND c.status IN ('drafting','awaiting_confirmation','signing') WHERE li.line_user_id=? ORDER BY CASE c.status WHEN 'signing' THEN 0 WHEN 'awaiting_confirmation' THEN 1 ELSE 2 END,c.updated_at DESC,c.id DESC LIMIT 1`).get(lineUserId) || null;
}

function findPendingSignatureRequestForViewer(db, lineUserId) {
  return db.prepare(`SELECT sr.public_id AS signatureRequestPublicId FROM line_identities li JOIN contract_parties cp ON cp.user_id=li.user_id AND cp.status='active' JOIN signature_requests sr ON sr.contract_party_id=cp.id AND sr.status IN ('pending','sent','viewed') JOIN contract_versions cv ON cv.id=sr.contract_version_id AND cv.status='issued' JOIN contracts c ON c.id=cv.contract_id AND c.status='signing' WHERE li.line_user_id=? ORDER BY cv.version_number DESC,sr.created_at DESC,sr.id DESC LIMIT 1`).get(lineUserId) || null;
}

// 同一個人可能在同一份合約上有兩個角色。沒有 ORDER BY 的話回哪一列不確定,
// 而 party_role 會變成 viewerRole,直接決定畫面給不給「送出簽署」。
// 排序讓它穩定;判斷權限請用 viewerRoles,不要用被壓成一個的 viewerRole。
function requireContractParty(db, { lineUserId, contractPublicId }) {
  return db.prepare(`
    SELECT cp.id AS party_id, cp.party_role, cp.user_id, c.id AS contract_id
    FROM line_identities li
    JOIN contract_parties cp ON cp.user_id = li.user_id AND cp.status = 'active'
    JOIN contracts c ON c.id = cp.contract_id
    WHERE li.line_user_id = ? AND c.public_id = ?
    ORDER BY COALESCE(cp.signing_order, 99), cp.id
    LIMIT 1
  `).get(lineUserId, contractPublicId) || forbidden();
}

/** 這個人在這份合約上的所有角色。判斷「能不能做某件事」要用這個。 */
function viewerPartyRoles(db, { lineUserId, contractId }) {
  return db.prepare(`
    SELECT DISTINCT cp.party_role
    FROM line_identities li
    JOIN contract_parties cp ON cp.user_id = li.user_id AND cp.status = 'active'
    WHERE li.line_user_id = ? AND cp.contract_id = ?
  `).all(lineUserId, contractId).map((row) => row.party_role);
}

function requireVersionParty(db, { lineUserId, versionPublicId }) {
  return db.prepare(`
    SELECT cp.id AS party_id, cp.party_role, cp.user_id, c.id AS contract_id,
           c.public_id AS contract_public_id, cv.id AS version_id
    FROM line_identities li
    JOIN contract_parties cp ON cp.user_id = li.user_id AND cp.status = 'active'
    JOIN contracts c ON c.id = cp.contract_id
    JOIN contract_versions cv ON cv.contract_id = c.id
    WHERE li.line_user_id = ? AND cv.public_id = ?
    ORDER BY COALESCE(cp.signing_order, 99), cp.id
    LIMIT 1
  `).get(lineUserId, versionPublicId) || forbidden();
}

function requireSignatureRequest(db, { lineUserId, signatureRequestPublicId }) {
  return db.prepare(`
    SELECT sr.*, cp.party_role, cp.user_id, cv.document_hash, cv.contract_id
    FROM signature_requests sr
    JOIN contract_parties cp ON cp.id = sr.contract_party_id AND cp.status = 'active'
    JOIN line_identities li ON li.user_id = cp.user_id
    JOIN contract_versions cv ON cv.id = sr.contract_version_id AND cv.status = 'issued'
    JOIN contracts c ON c.id = cv.contract_id AND c.status IN ('drafting','awaiting_confirmation','signing')
    WHERE li.line_user_id = ? AND sr.public_id = ?
      AND sr.status IN ('pending','sent','viewed','signed')
  `).get(lineUserId, signatureRequestPublicId) || forbidden();
}

function listVersionsForViewer(db, input) {
  const party = requireContractParty(db, input);
  return db.prepare(`
    SELECT id, public_id AS publicId, version_number AS versionNumber, status,
           condition_snapshot_json AS conditionSnapshotJson, document_hash AS documentHash, created_at AS createdAt
    FROM contract_versions WHERE contract_id = ? ORDER BY version_number DESC
  `).all(party.contract_id);
}

function getContractSubject(db, contractId) {
  return db.prepare(`
    SELECT p.address_text AS addressText, p.building_name AS buildingName,
           ru.unit_label AS unitLabel, ru.rental_type AS rentalType, ru.area_ping AS areaPing,
           l.title AS listingTitle, ls.normalized_address AS normalizedAddress
    FROM contracts c
    JOIN rental_units ru ON ru.id = c.rental_unit_id
    JOIN properties p ON p.id = ru.property_id
    LEFT JOIN listings l ON l.rental_unit_id = ru.id
    LEFT JOIN listing_snapshots ls ON ls.id = l.latest_valid_snapshot_id
    WHERE c.id = ?
    ORDER BY l.id DESC
    LIMIT 1
  `).get(contractId) || {};
}

function getContractOverviewForViewer(db, { lineUserId, contractPublicId }) {
  const party = requireContractParty(db, { lineUserId, contractPublicId });
  const contract = db.prepare('SELECT id, public_id, status, executed_at, updated_at FROM contracts WHERE id=?').get(party.contract_id);
  const parties = db.prepare(`
    SELECT cp.party_role AS partyRole, cp.status, cp.required_signer AS requiredSigner,
           COALESCE(NULLIF(up.legal_name,''), NULLIF(up.display_name,'')) AS name,
           (SELECT COUNT(*) FROM signature_records sr WHERE sr.contract_party_id = cp.id) AS signedCount
    FROM contract_parties cp
    LEFT JOIN user_profiles up ON up.user_id = cp.user_id
    WHERE cp.contract_id = ? AND cp.status <> 'removed'
    ORDER BY COALESCE(cp.signing_order, 99), cp.id
  `).all(party.contract_id);
  return {
    contractPublicId: contract.public_id,
    status: contract.status,
    executedAt: contract.executed_at,
    updatedAt: contract.updated_at,
    viewerRole: party.party_role,
    viewerRoles: viewerPartyRoles(db, { lineUserId, contractId: party.contract_id }),
    subject: getContractSubject(db, party.contract_id),
    parties
  };
}

function getVersionForViewer(db, input) {
  const party = requireVersionParty(db, input);
  return db.prepare(`SELECT *, public_id AS publicId, version_number AS versionNumber FROM contract_versions WHERE id=?`).get(party.version_id);
}

// 全新合約的當事人要自己建。房客取 rental_intentions.tenant_user_id,房東取這個
// rental_unit 目前有效的擁有者(property_owners.rental_unit_id 為 NULL 代表整棟)。
// 少了這兩列,findCurrentContractForViewer / requireContractParty 都查不到合約
// (房客與房東都看不到),issueVersion 也產不出任何 signature_requests。
// 單位層級的擁有者優先於整棟層級。
// 只有**目前生效**的那一列算數:property_owners 有 effective_from 與 effective_until,
// 少了 effective_from 的比較,一筆未來才生效(例如 effective_from=2030)的單位擁有者
// 會因為單位層級優先而壓過現在有效的整棟擁有者,立刻變成合約房東與必要簽署人。
const LANDLORD_OWNER_SQL = (dateExpr) => `
SELECT po.owner_user_id
FROM rental_units ru
JOIN property_owners po
  ON po.property_id = ru.property_id
 AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
WHERE ru.id = @rentalUnitId
  AND po.effective_from <= ${dateExpr}
  AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
ORDER BY CASE WHEN po.rental_unit_id IS NULL THEN 1 ELSE 0 END, po.id
LIMIT 1
`;

function createVersionFromIntention(db, input) {
  return db.transaction(() => {
    const intention = db.prepare(`
      SELECT ri.id, ri.tenant_user_id, i.id AS inquiry_id, i.listing_id, l.rental_unit_id
      FROM rental_intentions ri JOIN inquiries i ON i.id=ri.inquiry_id JOIN listings l ON l.id=i.listing_id
      WHERE ri.public_id=?
    `).get(input.rentalIntentionPublicId);
    if (!intention) throw new Error('rental intention not found');
    const contracts = db.prepare('SELECT * FROM contracts WHERE selected_intention_id=? ORDER BY id DESC').all(intention.id);
    const signedContractIds = new Set(db.prepare(`SELECT DISTINCT cv.contract_id FROM signature_records sr JOIN contract_versions cv ON cv.id=sr.contract_version_id WHERE cv.contract_id IN (SELECT id FROM contracts WHERE selected_intention_id=?)`).all(intention.id).map((row) => row.contract_id));
    let contract = contracts.find((candidate) => ['drafting', 'awaiting_confirmation', 'signing'].includes(candidate.status) && !signedContractIds.has(candidate.id));
    let reusable = contract;
    if (!reusable) {
      const parent = contracts.find((candidate) => signedContractIds.has(candidate.id)) || null;
      const id = publicId('contract');
      db.prepare(`INSERT INTO contracts (public_id,rental_unit_id,selected_intention_id,source_inquiry_id,renewed_from_contract_id) VALUES (?,?,?,?,?)`)
        .run(id, intention.rental_unit_id, intention.id, intention.inquiry_id, parent?.id || null);
      reusable = db.prepare('SELECT * FROM contracts WHERE public_id=?').get(id);
      // contract_parties 有 UNIQUE(contract_id, party_role, user_id, organization_id),
      // 但 organization_id 為 NULL 時 UNIQUE 不會擋重複(NULL 互不相等),所以自己先查。
      const addParty = (userId, partyRole, signingOrder) => {
        const existing = db.prepare('SELECT id FROM contract_parties WHERE contract_id=? AND party_role=? AND user_id=?')
          .get(reusable.id, partyRole, userId);
        if (existing) return;
        db.prepare(`INSERT INTO contract_parties (public_id,contract_id,user_id,organization_id,party_role,required_signer,signing_order,status) VALUES (?,?,?,NULL,?,1,?,'active')`)
          .run(publicId('contract-party'), reusable.id, userId, partyRole, signingOrder);
      };
      if (parent) {
        // lifecycle metadata may advance to superseded; the signed versions and their snapshots remain untouched.
        if (parent.status === 'signing') {
          db.prepare(`UPDATE signature_requests SET status='cancelled',completed_at=CURRENT_TIMESTAMP
            WHERE contract_version_id IN (SELECT id FROM contract_versions WHERE contract_id=?)
              AND status IN ('pending','sent','viewed')`).run(parent.id);
          db.prepare("UPDATE contracts SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parent.id);
        }
        const parties = db.prepare("SELECT * FROM contract_parties WHERE contract_id=? AND status='active'").all(parent.id);
        for (const party of parties) {
          db.prepare(`INSERT INTO contract_parties (public_id,contract_id,user_id,organization_id,party_role,required_signer,signing_order,status) VALUES (?,?,?,?,?,?,?,'active')`)
            .run(publicId('contract-party'), reusable.id, party.user_id, party.organization_id, party.party_role, party.required_signer, party.signing_order);
        }
      } else {
        if (!intention.tenant_user_id) throw new Error('rental intention tenant not found');
        const owner = db.prepare(LANDLORD_OWNER_SQL("date('now')")).get({ rentalUnitId: intention.rental_unit_id });
        // 找不到房東就明確失敗:寧可回報錯誤,也不要靜默建立一份誰都看不到、
        // 也送不出簽署請求的合約。
        if (!owner) throw new Error('rental unit landlord owner not found');
        addParty(intention.tenant_user_id, 'tenant', 1);
        addParty(owner.owner_user_id, 'landlord', 2);
      }
    }
    contract = reusable;
    const latest = db.prepare('SELECT * FROM intention_versions WHERE rental_intention_id=? ORDER BY version_number DESC LIMIT 1').get(intention.id);
    if (!latest) throw new Error('intention version not found');
    const number = db.prepare('SELECT COALESCE(MAX(version_number),0)+1 number FROM contract_versions WHERE contract_id=?').get(contract.id).number;
    const conditions = { rentAmount: latest.rent_amount, depositAmount: latest.deposit_amount, leaseStartDate: latest.lease_start_date, leaseEndDate: latest.lease_end_date, petRequest: latest.pet_request_text, equipmentRequest: latest.equipment_request_text, specialRequest: latest.special_request_text, ...(JSON.parse(latest.condition_json || '{}')) };
    const id = publicId('contract-version');
    const inserted = db.prepare(`INSERT INTO contract_versions (public_id,contract_id,version_number,condition_snapshot_json,created_by_user_id) VALUES (?,?,?,?,?)`).run(id, contract.id, number, JSON.stringify(conditions), input.actorUserId || null);
    return { publicId: id, versionNumber: number, status: 'draft', contractPublicId: contract.public_id, contractId: contract.id, versionId: Number(inserted.lastInsertRowid) };
  }).immediate();
}

function issueVersion(db, { versionPublicId }) {
  return db.transaction(() => {
    const version = db.prepare('SELECT * FROM contract_versions WHERE public_id=?').get(versionPublicId);
    if (!version) throw new Error('contract version not found');
    db.prepare(`UPDATE signature_requests SET status='cancelled',completed_at=CURRENT_TIMESTAMP
      WHERE contract_version_id IN (
        SELECT id FROM contract_versions WHERE contract_id=? AND status='issued' AND id<>?
      ) AND status IN ('pending','sent','viewed')`).run(version.contract_id, version.id);
    // 只檢查真的會被更新到的列,維持與原 trigger 相同的觸發範圍
    for (const row of db.prepare("SELECT id FROM contract_versions WHERE contract_id=? AND status='issued' AND id<>?").all(version.contract_id, version.id)) {
      assertContractVersionMutable(db, row.id);
    }
    db.prepare("UPDATE contract_versions SET status='superseded' WHERE contract_id=? AND status='issued' AND id<>?").run(version.contract_id, version.id);
    if (db.prepare("SELECT 1 FROM contract_versions WHERE id=? AND status='draft'").get(version.id)) {
      assertContractVersionMutable(db, version.id);
    }
    db.prepare("UPDATE contract_versions SET status='issued' WHERE id=? AND status='draft'").run(version.id);
    db.prepare("UPDATE contracts SET status='signing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'executed'").run(version.contract_id);
    const parties = db.prepare("SELECT * FROM contract_parties WHERE contract_id=? AND required_signer=1 AND party_role IN ('tenant','landlord') AND status='active'").all(version.contract_id);
    for (const party of parties) {
      assertSignatureRequestSameContract(db, { contractVersionId: version.id, contractPartyId: party.id });
      db.prepare(`INSERT OR IGNORE INTO signature_requests (public_id,contract_version_id,contract_party_id) VALUES (?,?,?)`).run(publicId(`signature-request-${party.party_role}`), version.id, party.id);
    }
    const requests = db.prepare(`SELECT sr.public_id, cp.party_role FROM signature_requests sr JOIN contract_parties cp ON cp.id=sr.contract_party_id WHERE sr.contract_version_id=?`).all(version.id);
    return {
      versionPublicId,
      tenantRequestPublicId: requests.find((row) => row.party_role === 'tenant')?.public_id,
      landlordRequestPublicId: requests.find((row) => row.party_role === 'landlord')?.public_id
    };
  }).immediate();
}

function issueLatestVersionForViewer(db, lineUserId) {
  const viewer = findViewer(db, lineUserId);
  if (!viewer) return forbidden();
  const latest = db.prepare(`
    SELECT cv.public_id, cv.status
    FROM contract_parties cp
    JOIN contracts c ON c.id=cp.contract_id AND c.status IN ('drafting','awaiting_confirmation','signing')
    JOIN contract_versions cv ON cv.contract_id=c.id
    WHERE cp.user_id=? AND cp.status='active'
    ORDER BY cv.version_number DESC,cv.id DESC LIMIT 1
  `).get(viewer.user_id);
  if (!latest) throw new Error('contract version not found');
  if (!['draft', 'issued'].includes(latest.status)) throw new Error('latest contract version is not signable');
  return issueVersion(db, { versionPublicId: latest.public_id });
}

function updateReadingProgress(db, input) {
  const request = requireSignatureRequest(db, input);
  const progress = Number(input.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new Error('invalid progress');
  const reached = progress === 100 ? 'CURRENT_TIMESTAMP' : 'NULL';
  db.prepare(`INSERT INTO contract_reading_sessions (public_id,signature_request_id,contract_version_id,contract_party_id,last_progress,reached_end_at)
    VALUES (?,?,?,?,?,${reached}) ON CONFLICT(signature_request_id) DO UPDATE SET last_progress=MAX(last_progress,excluded.last_progress), reached_end_at=COALESCE(reached_end_at,excluded.reached_end_at), last_seen_at=CURRENT_TIMESTAMP`)
    .run(publicId('reading'), request.id, request.contract_version_id, request.contract_party_id, progress);
  return { progress };
}

function savePartySnapshot(db, input) {
  db.prepare(`INSERT INTO contract_party_snapshots (contract_party_id,contract_version_id,legal_name,display_name,phone,email,contact_address,masked_identifier,party_role,snapshot_json)
    VALUES (@contractPartyId,@contractVersionId,@legalName,@displayName,@phone,@email,@contactAddress,@maskedIdentifier,@partyRole,@snapshotJson)
    ON CONFLICT(contract_party_id,contract_version_id) DO UPDATE SET legal_name=excluded.legal_name,display_name=excluded.display_name,phone=excluded.phone,email=excluded.email,contact_address=excluded.contact_address,masked_identifier=excluded.masked_identifier,snapshot_json=excluded.snapshot_json`).run({ displayName: null, phone: null, email: null, contactAddress: null, maskedIdentifier: null, snapshotJson: null, ...input });
}

function recordSignature(db, input) {
  const existing = db.prepare('SELECT * FROM signature_records WHERE signature_request_id=?').get(input.signatureRequestId);
  if (existing) return existing;
  assertSignatureDocumentHash(db, { contractVersionId: input.contractVersionId, documentHash: input.documentHash });
  const id = publicId('signature-record');
  db.prepare(`INSERT INTO signature_records (public_id,signature_request_id,contract_version_id,contract_party_id,signature_file_id,strokes_file_id,document_hash,signature_hash,verification_challenge_id,signed_at,ip_address,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?)`).run(id,input.signatureRequestId,input.contractVersionId,input.contractPartyId,input.signatureFileId||null,input.strokesFileId||null,input.documentHash,input.signatureHash,input.verificationChallengeId||null,input.ipAddress||null,input.userAgent||null);
  db.prepare("UPDATE signature_requests SET status='signed',completed_at=CURRENT_TIMESTAMP WHERE id=?").run(input.signatureRequestId);
  return db.prepare('SELECT * FROM signature_records WHERE public_id=?').get(id);
}

function declineSignatureRequest(db, { signatureRequestId }) {
  const request = db.prepare('SELECT * FROM signature_requests WHERE id=?').get(signatureRequestId);
  if (!request) throw new Error('signature request not found');
  // 已履行的合約不能再拒絕；contracts 的 CHECK 會擋，但這個動作本身就不該被允許。
  const contract = db.prepare('SELECT c.status FROM contracts c JOIN contract_versions cv ON cv.contract_id=c.id WHERE cv.id=?').get(request.contract_version_id);
  if (contract && contract.status === 'executed') {
    const error = new Error('合約已完成簽署，無法再拒絕');
    error.statusCode = 409;
    throw error;
  }
  db.transaction(() => {
    db.prepare("UPDATE signature_requests SET status='declined',completed_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'signed'").run(request.id);
    db.prepare("UPDATE contract_parties SET status='declined' WHERE id=?").run(request.contract_party_id);
    db.prepare("UPDATE contracts SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE id=(SELECT contract_id FROM contract_versions WHERE id=?) AND status<>'executed'").run(request.contract_version_id);
  }).immediate();
  return { declined: true };
}

function executeIfComplete(db, { contractVersionId }) {
  const contract = db.prepare('SELECT c.* FROM contracts c JOIN contract_versions cv ON cv.contract_id=c.id WHERE cv.id=?').get(contractVersionId);
  if (!contract || contract.status !== 'signing') return { executed: false };
  const counts = db.prepare(`SELECT COUNT(*) required, SUM(CASE WHEN sr.id IS NOT NULL THEN 1 ELSE 0 END) signed
    FROM contract_parties cp JOIN contract_versions cv ON cv.contract_id=cp.contract_id
    LEFT JOIN signature_records sr ON sr.contract_version_id=cv.id AND sr.contract_party_id=cp.id
    WHERE cv.id=? AND cp.required_signer=1 AND cp.status='active'`).get(contractVersionId);
  if (!counts.required || counts.required !== counts.signed) return { executed: false };
  db.prepare("UPDATE contracts SET status='executed',executed_at=CURRENT_TIMESTAMP WHERE id=?").run(contract.id);
  return { executed: true };
}

module.exports = { findViewer, findCurrentContractForViewer, findPendingSignatureRequestForViewer, listVersionsForViewer, getVersionForViewer, getContractSubject, getContractOverviewForViewer, createVersionFromIntention, issueVersion, issueLatestVersionForViewer, updateReadingProgress, savePartySnapshot, recordSignature, declineSignatureRequest, executeIfComplete, requireSignatureRequest, requireContractParty, requireVersionParty };
