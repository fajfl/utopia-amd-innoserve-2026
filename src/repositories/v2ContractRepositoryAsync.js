// 合約 repository 的 driver 版本:同一份實作,底下可掛 better-sqlite3 或 mysql2。
//
// 參數 `db` 收的是 sqlDriver 的 driver,不是原始的 better-sqlite3 連線。
// 傳錯的話第一次呼叫 db.get(...) 就會炸(Database 沒有 .get 方法),不會靜默出錯。
//
// 交易中一律使用回呼給的 tx。用交易外的 driver 查詢,在 mysql2 會落到別的
// session,讀到交易外的狀態。

const crypto = require('node:crypto');
const {
  assertContractVersionMutable,
  assertSignatureDocumentHash,
  assertSignatureRequestSameContract
} = require('../database/integrityGuardsAsync');

const publicId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function forbidden() {
  const error = new Error('forbidden');
  error.statusCode = 403;
  throw error;
}

async function findViewer(db, lineUserId) {
  const row = await db.get(`
    SELECT u.id AS user_id, li.id AS line_identity_id
    FROM line_identities li JOIN users u ON u.id = li.user_id
    WHERE li.line_user_id = ? AND u.status = 'active'
  `, [String(lineUserId || '').trim()]);
  return row || null;
}

async function findCurrentContractForViewer(db, lineUserId) {
  const row = await db.get(`SELECT c.public_id AS contractPublicId FROM line_identities li JOIN contract_parties cp ON cp.user_id=li.user_id AND cp.status='active' JOIN contracts c ON c.id=cp.contract_id AND c.status IN ('drafting','awaiting_confirmation','signing') WHERE li.line_user_id=? ORDER BY CASE c.status WHEN 'signing' THEN 0 WHEN 'awaiting_confirmation' THEN 1 ELSE 2 END,c.updated_at DESC,c.id DESC LIMIT 1`, [lineUserId]);
  return row || null;
}

async function findPendingSignatureRequestForViewer(db, lineUserId) {
  const row = await db.get(`SELECT sr.public_id AS signatureRequestPublicId FROM line_identities li JOIN contract_parties cp ON cp.user_id=li.user_id AND cp.status='active' JOIN signature_requests sr ON sr.contract_party_id=cp.id AND sr.status IN ('pending','sent','viewed') JOIN contract_versions cv ON cv.id=sr.contract_version_id AND cv.status='issued' JOIN contracts c ON c.id=cv.contract_id AND c.status='signing' WHERE li.line_user_id=? ORDER BY cv.version_number DESC,sr.created_at DESC,sr.id DESC LIMIT 1`, [lineUserId]);
  return row || null;
}

// 同一個人可能在同一份合約上有兩個角色(房東自己也是房客的 demo、代理人同時是保證人)。
// 原本這兩支查詢沒有 ORDER BY,回哪一列由 SQLite/TiDB 當下的計畫決定 —— 而回傳的
// party_role 會變成 viewerRole,直接決定畫面給不給「送出簽署」。同一個人重新整理
// 兩次可能拿到不同角色。加上排序讓它至少是穩定的;真的要判斷「能不能做某件事」,
// 用 viewerRoles(這個人在這份合約上的所有角色),不要用被壓成一個的 viewerRole。
async function requireContractParty(db, { lineUserId, contractPublicId }) {
  const row = await db.get(`
    SELECT cp.id AS party_id, cp.party_role, cp.user_id, c.id AS contract_id
    FROM line_identities li
    JOIN contract_parties cp ON cp.user_id = li.user_id AND cp.status = 'active'
    JOIN contracts c ON c.id = cp.contract_id
    WHERE li.line_user_id = ? AND c.public_id = ?
    ORDER BY COALESCE(cp.signing_order, 99), cp.id
    LIMIT 1
  `, [lineUserId, contractPublicId]);
  return row || forbidden();
}

/** 這個人在這份合約上的所有角色。判斷「能不能做某件事」要用這個。 */
async function viewerPartyRoles(db, { lineUserId, contractId }) {
  const rows = await db.all(`
    SELECT DISTINCT cp.party_role
    FROM line_identities li
    JOIN contract_parties cp ON cp.user_id = li.user_id AND cp.status = 'active'
    WHERE li.line_user_id = ? AND cp.contract_id = ?
  `, [lineUserId, contractId]);
  return rows.map((row) => row.party_role);
}

async function requireVersionParty(db, { lineUserId, versionPublicId }) {
  const row = await db.get(`
    SELECT cp.id AS party_id, cp.party_role, cp.user_id, c.id AS contract_id,
           c.public_id AS contract_public_id, cv.id AS version_id
    FROM line_identities li
    JOIN contract_parties cp ON cp.user_id = li.user_id AND cp.status = 'active'
    JOIN contracts c ON c.id = cp.contract_id
    JOIN contract_versions cv ON cv.contract_id = c.id
    WHERE li.line_user_id = ? AND cv.public_id = ?
    ORDER BY COALESCE(cp.signing_order, 99), cp.id
    LIMIT 1
  `, [lineUserId, versionPublicId]);
  return row || forbidden();
}

async function requireSignatureRequest(db, { lineUserId, signatureRequestPublicId }) {
  const row = await db.get(`
    SELECT sr.*, cp.party_role, cp.user_id, cv.document_hash, cv.contract_id
    FROM signature_requests sr
    JOIN contract_parties cp ON cp.id = sr.contract_party_id AND cp.status = 'active'
    JOIN line_identities li ON li.user_id = cp.user_id
    JOIN contract_versions cv ON cv.id = sr.contract_version_id AND cv.status = 'issued'
    JOIN contracts c ON c.id = cv.contract_id AND c.status IN ('drafting','awaiting_confirmation','signing')
    WHERE li.line_user_id = ? AND sr.public_id = ?
      AND sr.status IN ('pending','sent','viewed','signed')
  `, [lineUserId, signatureRequestPublicId]);
  return row || forbidden();
}

async function listVersionsForViewer(db, input) {
  const party = await requireContractParty(db, input);
  return db.all(`
    SELECT id, public_id AS publicId, version_number AS versionNumber, status,
           condition_snapshot_json AS conditionSnapshotJson, document_hash AS documentHash, created_at AS createdAt
    FROM contract_versions WHERE contract_id = ? ORDER BY version_number DESC
  `, [party.contract_id]);
}

async function getContractSubject(db, contractId) {
  const row = await db.get(`
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
  `, [contractId]);
  return row || {};
}

async function getContractOverviewForViewer(db, { lineUserId, contractPublicId }) {
  const party = await requireContractParty(db, { lineUserId, contractPublicId });
  const contract = await db.get('SELECT id, public_id, status, executed_at, updated_at FROM contracts WHERE id=?', [party.contract_id]);
  const parties = await db.all(`
    SELECT cp.party_role AS partyRole, cp.status, cp.required_signer AS requiredSigner,
           COALESCE(NULLIF(up.legal_name,''), NULLIF(up.display_name,'')) AS name,
           (SELECT COUNT(*) FROM signature_records sr WHERE sr.contract_party_id = cp.id) AS signedCount
    FROM contract_parties cp
    LEFT JOIN user_profiles up ON up.user_id = cp.user_id
    WHERE cp.contract_id = ? AND cp.status <> 'removed'
    ORDER BY COALESCE(cp.signing_order, 99), cp.id
  `, [party.contract_id]);
  return {
    contractPublicId: contract.public_id,
    status: contract.status,
    executedAt: contract.executed_at,
    updatedAt: contract.updated_at,
    viewerRole: party.party_role,
    viewerRoles: await viewerPartyRoles(db, { lineUserId, contractId: party.contract_id }),
    subject: await getContractSubject(db, party.contract_id),
    parties
  };
}

async function getVersionForViewer(db, input) {
  const party = await requireVersionParty(db, input);
  return db.get('SELECT *, public_id AS publicId, version_number AS versionNumber FROM contract_versions WHERE id=?', [party.version_id]);
}

// 全新合約的當事人要自己建。房客取 rental_intentions.tenant_user_id,房東取這個
// rental_unit 目前有效的擁有者(property_owners.rental_unit_id 為 NULL 代表整棟)。
// 少了這兩列,findCurrentContractForViewer / requireContractParty 都查不到合約
// (房客與房東都看不到),issueVersion 也產不出任何 signature_requests。
// 單位層級的擁有者優先於整棟層級。JOIN 的 ON 裡沒有子查詢(TiDB 不支援)。
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

// MySQL/TiDB 沒有 date();它不報錯,直接回 NULL,比較結果恆為 NULL,整批資料被靜默濾掉。
const currentDateSql = (db) => (db && db.dialect && db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')");

async function createVersionFromIntention(db, input) {
  return db.transaction(async (tx) => {
    const intention = await tx.get(`
      SELECT ri.id, ri.tenant_user_id, i.id AS inquiry_id, i.listing_id, l.rental_unit_id
      FROM rental_intentions ri JOIN inquiries i ON i.id=ri.inquiry_id JOIN listings l ON l.id=i.listing_id
      WHERE ri.public_id=?
    `, [input.rentalIntentionPublicId]);
    if (!intention) throw new Error('rental intention not found');
    const contracts = await tx.all('SELECT * FROM contracts WHERE selected_intention_id=? ORDER BY id DESC', [intention.id]);
    const signedContracts = await tx.all(`SELECT DISTINCT cv.contract_id FROM signature_records sr JOIN contract_versions cv ON cv.id=sr.contract_version_id WHERE cv.contract_id IN (SELECT id FROM contracts WHERE selected_intention_id=?)`, [intention.id]);
    const signedContractIds = new Set(signedContracts.map((row) => row.contract_id));
    let contract = contracts.find((candidate) => ['drafting', 'awaiting_confirmation', 'signing'].includes(candidate.status) && !signedContractIds.has(candidate.id));
    if (!contract) {
      const parent = contracts.find((candidate) => signedContractIds.has(candidate.id)) || null;
      const id = publicId('contract');
      await tx.run('INSERT INTO contracts (public_id,rental_unit_id,selected_intention_id,source_inquiry_id,renewed_from_contract_id) VALUES (?,?,?,?,?)', [id, intention.rental_unit_id, intention.id, intention.inquiry_id, parent?.id || null]);
      contract = await tx.get('SELECT * FROM contracts WHERE public_id=?', [id]);
      // contract_parties 有 UNIQUE(contract_id, party_role, user_id, organization_id),
      // 但 organization_id 為 NULL 時 UNIQUE 不會擋重複(NULL 互不相等),所以自己先查。
      const addParty = async (userId, partyRole, signingOrder) => {
        const existing = await tx.get('SELECT id FROM contract_parties WHERE contract_id=? AND party_role=? AND user_id=?', [contract.id, partyRole, userId]);
        if (existing) return;
        await tx.run(`INSERT INTO contract_parties (public_id,contract_id,user_id,organization_id,party_role,required_signer,signing_order,status) VALUES (?,?,?,NULL,?,1,?,'active')`, [publicId('contract-party'), contract.id, userId, partyRole, signingOrder]);
      };
      if (parent) {
        // lifecycle metadata may advance to superseded; the signed versions and their snapshots remain untouched.
        if (parent.status === 'signing') {
          await tx.run(`UPDATE signature_requests SET status='cancelled',completed_at=CURRENT_TIMESTAMP
            WHERE contract_version_id IN (SELECT id FROM contract_versions WHERE contract_id=?)
              AND status IN ('pending','sent','viewed')`, [parent.id]);
          await tx.run("UPDATE contracts SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE id=?", [parent.id]);
        }
        const parties = await tx.all("SELECT * FROM contract_parties WHERE contract_id=? AND status='active'", [parent.id]);
        for (const party of parties) {
          await tx.run('INSERT INTO contract_parties (public_id,contract_id,user_id,organization_id,party_role,required_signer,signing_order,status) VALUES (?,?,?,?,?,?,?,\'active\')', [publicId('contract-party'), contract.id, party.user_id, party.organization_id, party.party_role, party.required_signer, party.signing_order]);
        }
      } else {
        if (!intention.tenant_user_id) throw new Error('rental intention tenant not found');
        const owner = await tx.get(LANDLORD_OWNER_SQL(currentDateSql(tx)), { rentalUnitId: intention.rental_unit_id });
        // 找不到房東就明確失敗:寧可回報錯誤,也不要靜默建立一份誰都看不到、
        // 也送不出簽署請求的合約。
        if (!owner) throw new Error('rental unit landlord owner not found');
        await addParty(intention.tenant_user_id, 'tenant', 1);
        await addParty(owner.owner_user_id, 'landlord', 2);
      }
    }
    const latest = await tx.get('SELECT * FROM intention_versions WHERE rental_intention_id=? ORDER BY version_number DESC LIMIT 1', [intention.id]);
    if (!latest) throw new Error('intention version not found');
    const number = (await tx.get('SELECT COALESCE(MAX(version_number),0)+1 number FROM contract_versions WHERE contract_id=?', [contract.id])).number;
    const conditions = { rentAmount: latest.rent_amount, depositAmount: latest.deposit_amount, leaseStartDate: latest.lease_start_date, leaseEndDate: latest.lease_end_date, petRequest: latest.pet_request_text, equipmentRequest: latest.equipment_request_text, specialRequest: latest.special_request_text, ...(JSON.parse(latest.condition_json || '{}')) };
    const id = publicId('contract-version');
    const inserted = await tx.run('INSERT INTO contract_versions (public_id,contract_id,version_number,condition_snapshot_json,created_by_user_id) VALUES (?,?,?,?,?)', [id, contract.id, number, JSON.stringify(conditions), input.actorUserId || null]);
    return { publicId: id, versionNumber: number, status: 'draft', contractPublicId: contract.public_id, contractId: contract.id, versionId: inserted.insertId };
  });
}

async function issueVersion(db, { versionPublicId }) {
  return db.transaction(async (tx) => {
    const version = await tx.get('SELECT * FROM contract_versions WHERE public_id=?', [versionPublicId]);
    if (!version) throw new Error('contract version not found');
    // MySQL 的 error 1093 只在子查詢讀到「正在被 UPDATE 的那張表」時發生。
    // 這裡 UPDATE 的是 signature_requests、子查詢讀 contract_versions,不同表,
    // 不需要包一層 derived table。
    await tx.run(`UPDATE signature_requests SET status='cancelled',completed_at=CURRENT_TIMESTAMP
      WHERE contract_version_id IN (
        SELECT id FROM contract_versions WHERE contract_id=? AND status='issued' AND id<>?
      ) AND status IN ('pending','sent','viewed')`, [version.contract_id, version.id]);
    // 只檢查真的會被更新到的列,維持與原 trigger 相同的觸發範圍
    for (const row of await tx.all("SELECT id FROM contract_versions WHERE contract_id=? AND status='issued' AND id<>?", [version.contract_id, version.id])) {
      await assertContractVersionMutable(tx, row.id);
    }
    await tx.run("UPDATE contract_versions SET status='superseded' WHERE contract_id=? AND status='issued' AND id<>?", [version.contract_id, version.id]);
    if (await tx.get("SELECT 1 FROM contract_versions WHERE id=? AND status='draft'", [version.id])) {
      await assertContractVersionMutable(tx, version.id);
    }
    await tx.run("UPDATE contract_versions SET status='issued' WHERE id=? AND status='draft'", [version.id]);
    await tx.run("UPDATE contracts SET status='signing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'executed'", [version.contract_id]);
    const parties = await tx.all("SELECT * FROM contract_parties WHERE contract_id=? AND required_signer=1 AND party_role IN ('tenant','landlord') AND status='active'", [version.contract_id]);
    for (const party of parties) {
      await assertSignatureRequestSameContract(tx, { contractVersionId: version.id, contractPartyId: party.id });
      await tx.run(`${tx.dialect.insertIgnore} INTO signature_requests (public_id,contract_version_id,contract_party_id) VALUES (?,?,?)`, [publicId(`signature-request-${party.party_role}`), version.id, party.id]);
    }
    const requests = await tx.all('SELECT sr.public_id, cp.party_role FROM signature_requests sr JOIN contract_parties cp ON cp.id=sr.contract_party_id WHERE sr.contract_version_id=?', [version.id]);
    return {
      versionPublicId,
      tenantRequestPublicId: requests.find((row) => row.party_role === 'tenant')?.public_id,
      landlordRequestPublicId: requests.find((row) => row.party_role === 'landlord')?.public_id
    };
  });
}

async function issueLatestVersionForViewer(db, lineUserId) {
  const viewer = await findViewer(db, lineUserId);
  if (!viewer) return forbidden();
  const latest = await db.get(`
    SELECT cv.public_id, cv.status
    FROM contract_parties cp
    JOIN contracts c ON c.id=cp.contract_id AND c.status IN ('drafting','awaiting_confirmation','signing')
    JOIN contract_versions cv ON cv.contract_id=c.id
    WHERE cp.user_id=? AND cp.status='active'
    ORDER BY cv.version_number DESC,cv.id DESC LIMIT 1
  `, [viewer.user_id]);
  if (!latest) throw new Error('contract version not found');
  if (!['draft', 'issued'].includes(latest.status)) throw new Error('latest contract version is not signable');
  return issueVersion(db, { versionPublicId: latest.public_id });
}

async function updateReadingProgress(db, input) {
  const request = await requireSignatureRequest(db, input);
  const progress = Number(input.progress);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new Error('invalid progress');
  const reached = progress === 100 ? 'CURRENT_TIMESTAMP' : 'NULL';
  // 閱讀進度不可被倒退覆蓋。SQLite 的 MAX(a,b) 是純量函數,MySQL 的 MAX() 是聚合
  // 函數只吃一個參數,必須改用 GREATEST —— 方言差異由 driver 提供。
  //
  // MySQL 的 ON DUPLICATE KEY 會對**任何**唯一索引觸發,不像 SQLite 只認指定的
  // 欄位。這裡另一個唯一欄位 public_id 每次都是新產生的 UUID,不會誤觸。
  await db.run(`INSERT INTO contract_reading_sessions (public_id,signature_request_id,contract_version_id,contract_party_id,last_progress,reached_end_at)
    VALUES (?,?,?,?,?,${reached})
    ${db.dialect.onConflict('signature_request_id')}
      last_progress=${db.dialect.greatest('last_progress', db.dialect.incoming('last_progress'))},
      reached_end_at=COALESCE(reached_end_at,${db.dialect.incoming('reached_end_at')}),
      last_seen_at=CURRENT_TIMESTAMP`,
  [publicId('reading'), request.id, request.contract_version_id, request.contract_party_id, progress]);
  return { progress };
}

async function savePartySnapshot(db, input) {
  const d = db.dialect;
  await db.run(`INSERT INTO contract_party_snapshots (contract_party_id,contract_version_id,legal_name,display_name,phone,email,contact_address,masked_identifier,party_role,snapshot_json)
    VALUES (@contractPartyId,@contractVersionId,@legalName,@displayName,@phone,@email,@contactAddress,@maskedIdentifier,@partyRole,@snapshotJson)
    ${d.onConflict('contract_party_id,contract_version_id')}
      legal_name=${d.incoming('legal_name')},display_name=${d.incoming('display_name')},phone=${d.incoming('phone')},email=${d.incoming('email')},contact_address=${d.incoming('contact_address')},masked_identifier=${d.incoming('masked_identifier')},snapshot_json=${d.incoming('snapshot_json')}`,
  { displayName: null, phone: null, email: null, contactAddress: null, maskedIdentifier: null, snapshotJson: null, ...input });
}

async function recordSignature(db, input) {
  const existing = await db.get('SELECT * FROM signature_records WHERE signature_request_id=?', [input.signatureRequestId]);
  if (existing) return existing;
  await assertSignatureDocumentHash(db, { contractVersionId: input.contractVersionId, documentHash: input.documentHash });
  const id = publicId('signature-record');
  await db.run(`INSERT INTO signature_records (public_id,signature_request_id,contract_version_id,contract_party_id,signature_file_id,strokes_file_id,document_hash,signature_hash,verification_challenge_id,signed_at,ip_address,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?)`,
  [id, input.signatureRequestId, input.contractVersionId, input.contractPartyId, input.signatureFileId || null, input.strokesFileId || null, input.documentHash, input.signatureHash, input.verificationChallengeId || null, input.ipAddress || null, input.userAgent || null]);
  await db.run("UPDATE signature_requests SET status='signed',completed_at=CURRENT_TIMESTAMP WHERE id=?", [input.signatureRequestId]);
  return db.get('SELECT * FROM signature_records WHERE public_id=?', [id]);
}

async function declineSignatureRequest(db, { signatureRequestId }) {
  const request = await db.get('SELECT * FROM signature_requests WHERE id=?', [signatureRequestId]);
  if (!request) throw new Error('signature request not found');
  // 已履行的合約不能再拒絕。contracts 有 CHECK((status='executed')=(executed_at IS NOT NULL)),
  // 硬改成 cancelled 會留下 executed_at 而違反該約束 —— 但真正的問題是這個動作
  // 本身不該被允許,不是 SQL 寫法。
  const contract = await db.get(
    'SELECT c.status FROM contracts c JOIN contract_versions cv ON cv.contract_id=c.id WHERE cv.id=?',
    [request.contract_version_id]
  );
  if (contract && contract.status === 'executed') {
    const error = new Error('合約已完成簽署，無法再拒絕');
    error.statusCode = 409;
    throw error;
  }
  await db.transaction(async (tx) => {
    await tx.run("UPDATE signature_requests SET status='declined',completed_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'signed'", [request.id]);
    await tx.run("UPDATE contract_parties SET status='declined' WHERE id=?", [request.contract_party_id]);
    // MySQL 不允許在 UPDATE 的子查詢裡直接讀同一張目標表以外的相關表時走 derived
    // table,這裡目標是 contracts、子查詢讀 contract_versions,兩邊不同表,可直接用。
    await tx.run("UPDATE contracts SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE id=(SELECT contract_id FROM contract_versions WHERE id=?) AND status<>'executed'", [request.contract_version_id]);
  });
  return { declined: true };
}

async function executeIfComplete(db, { contractVersionId }) {
  const contract = await db.get('SELECT c.* FROM contracts c JOIN contract_versions cv ON cv.contract_id=c.id WHERE cv.id=?', [contractVersionId]);
  if (!contract || contract.status !== 'signing') return { executed: false };
  const counts = await db.get(`SELECT COUNT(*) required, SUM(CASE WHEN sr.id IS NOT NULL THEN 1 ELSE 0 END) signed
    FROM contract_parties cp JOIN contract_versions cv ON cv.contract_id=cp.contract_id
    LEFT JOIN signature_records sr ON sr.contract_version_id=cv.id AND sr.contract_party_id=cp.id
    WHERE cv.id=? AND cp.required_signer=1 AND cp.status='active'`, [contractVersionId]);
  // mysql2 的 SUM() 可能回傳字串(DECIMAL),不能直接用 !== 比較。
  if (!counts.required || Number(counts.required) !== Number(counts.signed)) return { executed: false };
  await db.run("UPDATE contracts SET status='executed',executed_at=CURRENT_TIMESTAMP WHERE id=?", [contract.id]);
  return { executed: true };
}

module.exports = {
  findViewer,
  findCurrentContractForViewer,
  findPendingSignatureRequestForViewer,
  listVersionsForViewer,
  getVersionForViewer,
  getContractSubject,
  getContractOverviewForViewer,
  createVersionFromIntention,
  issueVersion,
  issueLatestVersionForViewer,
  updateReadingProgress,
  savePartySnapshot,
  recordSignature,
  declineSignatureRequest,
  executeIfComplete,
  requireSignatureRequest,
  requireContractParty,
  requireVersionParty
};
