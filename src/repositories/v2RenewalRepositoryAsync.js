// 續約 repository 的 driver 版本。跟 v2ContractRepositoryAsync 同樣的約定:
// `db` 收的是 sqlDriver 的 driver,不是原始 better-sqlite3 連線;交易中一律用
// 回呼給的 tx,不要用交易外的 driver 查——mysql2 會落到別的 session。
//
// 這支只碰 renewal_requests / renewal_proposals / renewal_decisions /
// contract_action_requests / contract_action_history,以及在續約完成時建立
// **新的** contracts / contract_versions / contract_parties / leases /
// lease_parties。它**不會**去動既有的電子簽署流程或 rental_unit 成交鎖——
// 那兩個邏輯全部留在 v2ContractSigningServiceAsync /
// ecsNeoRentalUnitClaimServiceAsync,續約完全不碰那兩支檔案。
//
// 已知的既有缺口(2026-09-21 確認,不是這支程式造成的,另外回報給團隊):
// 正式簽約完成(contracts.status -> executed)目前完全不會建立 leases 資料,
// 唯一會寫 leases 的地方是 demoSeed.js。這代表正式環境現在應該沒有真的
// active lease 可以續——這支續約程式只保證「有 lease 資料時邏輯是對的」,
// 不解決「一開始沒有 lease」這件事。

const crypto = require('node:crypto');

const publicId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function forbidden(message = 'forbidden') {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'authorization_denied';
  throw error;
}

function ambiguousRole(message = 'acting role is required') {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'ambiguous_role';
  throw error;
}

function notFound(message = 'not found') {
  const error = new Error(message);
  error.statusCode = 404;
  error.code = 'not_found';
  throw error;
}

function isDuplicateKeyError(error) {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (code === 'ER_DUP_ENTRY') return true;
  return Number(error.errno) === 1062;
}

// 這個人在這份租約上的身分(房東或房客)。跟 v2ContractRepositoryAsync 的
// requireContractParty 同樣形狀:回傳角色與 id,呼叫端自己判斷能不能做這個
// 動作,不要只信任「有找到就是本人可以做任何事」。
async function listLeasePartiesForViewer(db, { lineUserId, leasePublicId }) {
  return db.all(`
    SELECT lp.id AS lease_party_id, lp.contract_party_id, lp.party_role, lp.user_id,
           le.id AS lease_id, le.public_id AS lease_public_id, le.status AS lease_status,
           le.contract_id, le.rental_unit_id, le.start_date, le.end_date
    FROM line_identities li
    JOIN lease_parties lp ON lp.user_id = li.user_id AND lp.effective_until IS NULL
    JOIN leases le ON le.id = lp.lease_id
    WHERE li.line_user_id = ? AND le.public_id = ?
    ORDER BY CASE lp.party_role WHEN 'landlord' THEN 1 WHEN 'tenant' THEN 2 ELSE 3 END, lp.id
  `, [lineUserId, leasePublicId]);
}

async function requireLeaseParty(db, { lineUserId, leasePublicId, partyRole }) {
  const rows = await listLeasePartiesForViewer(db, { lineUserId, leasePublicId });
  if (!rows.length) return forbidden('這份租約跟這個 LINE 身分對不起來');
  if (partyRole) {
    const matched = rows.find((row) => row.party_role === partyRole);
    return matched || forbidden(`這個 LINE 身分不是這份租約的 ${partyRole}`);
  }
  if (rows.length > 1) {
    return ambiguousRole('這個 LINE 身分在同一份租約有多個角色，請指定要以房東或房客身分操作');
  }
  return rows[0];
}

async function requireLandlordUser(db, lineUserId) {
  const row = await db.get(`
    SELECT DISTINCT li.user_id
    FROM line_identities li
    JOIN lease_parties lp
      ON lp.user_id = li.user_id
     AND lp.party_role = 'landlord'
     AND lp.effective_until IS NULL
    WHERE li.line_user_id = ?
    LIMIT 1
  `, [lineUserId]);
  if (!row) return forbidden('這個 LINE 身分目前沒有房東租約');
  return row.user_id;
}

async function getLandlordRenewalPreferenceByUserId(db, landlordUserId) {
  const row = await db.get(`
    SELECT unchanged_terms_negotiable
    FROM landlord_renewal_preferences
    WHERE landlord_user_id = ?
  `, [landlordUserId]);
  return { unchangedTermsNegotiable: row ? Boolean(row.unchanged_terms_negotiable) : false };
}

async function getLandlordRenewalPreference(db, lineUserId) {
  const landlordUserId = await requireLandlordUser(db, lineUserId);
  return getLandlordRenewalPreferenceByUserId(db, landlordUserId);
}

async function setLandlordRenewalPreference(db, { lineUserId, unchangedTermsNegotiable }) {
  const landlordUserId = await requireLandlordUser(db, lineUserId);
  return db.transaction(async (tx) => {
    const existing = await tx.get(
      'SELECT id FROM landlord_renewal_preferences WHERE landlord_user_id = ?',
      [landlordUserId]
    );
    if (existing) {
      await tx.run(`
        UPDATE landlord_renewal_preferences
        SET unchanged_terms_negotiable = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [unchangedTermsNegotiable ? 1 : 0, existing.id]);
    } else {
      await tx.run(`
        INSERT INTO landlord_renewal_preferences
          (landlord_user_id, unchanged_terms_negotiable)
        VALUES (?, ?)
      `, [landlordUserId, unchangedTermsNegotiable ? 1 : 0]);
    }
    return { unchangedTermsNegotiable: Boolean(unchangedTermsNegotiable) };
  });
}

// LINE Rich Menu「續約租約」入口用:不用先知道 leasePublicId,直接找這個人
// 名下目前 active 的租約(多筆時選到期日最近的那筆)。
async function findActiveLeasesForViewer(db, lineUserId) {
  return db.all(`
    SELECT le.id AS lease_id, le.public_id AS lease_public_id, le.status AS lease_status,
           le.contract_id, le.rental_unit_id, le.start_date, le.end_date,
           lp.party_role, lp.user_id,
           p.building_name, p.address_text, ru.unit_label,
           (SELECT l.title FROM listings l
            WHERE l.rental_unit_id = ru.id
            ORDER BY l.id DESC LIMIT 1) AS listing_title,
           COALESCE(
             (SELECT NULLIF(up.legal_name, '')
              FROM lease_parties tenant_lp
              JOIN user_profiles up ON up.user_id = tenant_lp.user_id
              WHERE tenant_lp.lease_id = le.id
                AND tenant_lp.party_role = 'tenant'
                AND tenant_lp.effective_until IS NULL
              ORDER BY tenant_lp.id LIMIT 1),
             (SELECT NULLIF(up.display_name, '')
              FROM lease_parties tenant_lp
              JOIN user_profiles up ON up.user_id = tenant_lp.user_id
              WHERE tenant_lp.lease_id = le.id
                AND tenant_lp.party_role = 'tenant'
                AND tenant_lp.effective_until IS NULL
              ORDER BY tenant_lp.id LIMIT 1),
             (SELECT NULLIF(tenant_li.display_name_cache, '')
              FROM lease_parties tenant_lp
              JOIN line_identities tenant_li ON tenant_li.user_id = tenant_lp.user_id
              WHERE tenant_lp.lease_id = le.id
                AND tenant_lp.party_role = 'tenant'
                AND tenant_lp.effective_until IS NULL
              ORDER BY tenant_li.id DESC LIMIT 1),
             '房客'
           ) AS tenant_name,
           (SELECT cv.condition_snapshot_json
            FROM contract_versions cv
            WHERE cv.contract_id = le.contract_id AND cv.status IN ('issued', 'executed')
            ORDER BY cv.version_number DESC LIMIT 1) AS condition_snapshot_json
    FROM line_identities li
    JOIN lease_parties lp ON lp.user_id = li.user_id AND lp.effective_until IS NULL
    JOIN leases le ON le.id = lp.lease_id AND le.status = 'active'
    JOIN rental_units ru ON ru.id = le.rental_unit_id
    JOIN properties p ON p.id = ru.property_id
    WHERE li.line_user_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM renewal_requests completed_rr
        JOIN contract_action_requests completed_car
          ON completed_car.id = completed_rr.contract_action_request_id
        WHERE completed_rr.lease_id = le.id AND completed_car.status = 'completed'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM renewal_requests declined_rr
        JOIN contract_action_requests declined_car
          ON declined_car.id = declined_rr.contract_action_request_id
        WHERE declined_rr.lease_id = le.id
          AND declined_rr.landlord_willing = 0
          AND declined_car.status = 'rejected'
      )
    ORDER BY le.end_date ASC, le.id DESC,
             CASE lp.party_role WHEN 'landlord' THEN 1 WHEN 'tenant' THEN 2 ELSE 3 END
  `, [lineUserId]);
}

async function findActiveLeaseForViewer(db, lineUserId) {
  const rows = await findActiveLeasesForViewer(db, lineUserId);
  return rows[0] || null;
}

// 這份租約綁的已生效合約,最後一版正式條件快照——續約「沿用現有條件」
// 要複製的就是這一份。既有簽署流程完成後 contract 會是 executed,但 version
// 可能維持 issued；續約讀取端同時相容 issued/executed,不改動合約模組的狀態規則。
async function getExecutedConditionSnapshot(db, contractId) {
  const row = await db.get(`
    SELECT cv.condition_snapshot_json
    FROM contract_versions cv
    JOIN contracts c ON c.id = cv.contract_id AND c.status = 'executed'
    WHERE cv.contract_id = ? AND cv.status IN ('issued', 'executed')
    ORDER BY cv.version_number DESC
    LIMIT 1
  `, [contractId]);
  if (!row) return null;
  try {
    return JSON.parse(row.condition_snapshot_json || '{}');
  } catch {
    return {};
  }
}

async function getRenewalRequestSummary(db, renewalRequestPublicId) {
  const row = await db.get(`
    SELECT rr.public_id AS renewal_request_public_id,
           le.public_id AS lease_public_id,
           le.start_date, le.end_date,
           p.address_text, p.building_name, ru.unit_label,
           COALESCE(
             (SELECT NULLIF(up.legal_name, '')
              FROM lease_parties tenant_lp
              JOIN user_profiles up ON up.user_id = tenant_lp.user_id
              WHERE tenant_lp.lease_id = le.id
                AND tenant_lp.party_role = 'tenant'
                AND tenant_lp.effective_until IS NULL
              ORDER BY tenant_lp.id LIMIT 1),
             (SELECT NULLIF(up.display_name, '')
              FROM lease_parties tenant_lp
              JOIN user_profiles up ON up.user_id = tenant_lp.user_id
              WHERE tenant_lp.lease_id = le.id
                AND tenant_lp.party_role = 'tenant'
                AND tenant_lp.effective_until IS NULL
              ORDER BY tenant_lp.id LIMIT 1),
             (SELECT NULLIF(li.display_name_cache, '')
              FROM lease_parties tenant_lp
              JOIN line_identities li ON li.user_id = tenant_lp.user_id
              WHERE tenant_lp.lease_id = le.id
                AND tenant_lp.party_role = 'tenant'
                AND tenant_lp.effective_until IS NULL
              ORDER BY li.id DESC LIMIT 1),
             '房客'
           ) AS tenant_name,
           (SELECT cv.condition_snapshot_json
            FROM contract_versions cv
             WHERE cv.contract_id = le.contract_id AND cv.status IN ('issued', 'executed')
            ORDER BY cv.version_number DESC LIMIT 1) AS condition_snapshot_json
    FROM renewal_requests rr
    JOIN leases le ON le.id = rr.lease_id
    JOIN rental_units ru ON ru.id = le.rental_unit_id
    JOIN properties p ON p.id = ru.property_id
    WHERE rr.public_id = ?
  `, [renewalRequestPublicId]);
  if (!row) return notFound('找不到這筆續約申請');
  let snapshot = {};
  try {
    snapshot = JSON.parse(row.condition_snapshot_json || '{}');
  } catch {
    snapshot = {};
  }
  const propertyLabel = [row.building_name, row.address_text, row.unit_label]
    .filter(Boolean)
    .join(' ');
  return {
    renewalRequestPublicId: row.renewal_request_public_id,
    leasePublicId: row.lease_public_id,
    tenantName: row.tenant_name,
    propertyLabel,
    startDate: row.start_date,
    endDate: row.end_date,
    rentAmount: snapshot.rentAmount ?? null,
    depositAmount: snapshot.depositAmount ?? null
  };
}

// 這份租約目前有效的雙方(房東/房客) user id——通知對方用。
async function listLeasePartyUsers(db, leaseId) {
  return db.all(`
    SELECT user_id, party_role
    FROM lease_parties
    WHERE lease_id = ? AND effective_until IS NULL AND user_id IS NOT NULL
  `, [leaseId]);
}

// 同一份租約同時只能有一筆「進行中」的續約申請。accepted 代表條件已確認、
// 正等待合約模組接手,在正式完成前也必須視為進行中,避免重複發起。
// (不是靠 idempotency key——renewal_requests/contract_action_requests 這兩張表
// 本來就沒有那個欄位,schema 已經套用不能改,所以用「目前狀態」判斷,不新增欄位)。
async function findOpenRenewalRequestForLease(db, leaseId) {
  const row = await db.get(`
    SELECT rr.id, rr.public_id, rr.contract_action_request_id, rr.lease_id,
           rr.initiated_by, rr.landlord_willing, rr.current_terms_reusable, rr.created_at,
           car.public_id AS action_request_public_id, car.status AS action_status,
           car.contract_id
    FROM renewal_requests rr
    JOIN contract_action_requests car ON car.id = rr.contract_action_request_id
    WHERE rr.lease_id = ? AND car.status IN ('pending', 'accepted')
    ORDER BY rr.id DESC
    LIMIT 1
  `, [leaseId]);
  return row || null;
}

async function findCompletedRenewalRequestForLease(db, leaseId) {
  return db.get(`
    SELECT rr.id, rr.public_id
    FROM renewal_requests rr
    JOIN contract_action_requests car ON car.id = rr.contract_action_request_id
    WHERE rr.lease_id = ? AND car.status = 'completed'
    ORDER BY rr.id DESC
    LIMIT 1
  `, [leaseId]);
}

async function findLandlordDeclinedRenewalForLease(db, leaseId) {
  return db.get(`
    SELECT rr.id, rr.public_id
    FROM renewal_requests rr
    JOIN contract_action_requests car ON car.id = rr.contract_action_request_id
    WHERE rr.lease_id = ?
      AND rr.landlord_willing = 0
      AND car.status = 'rejected'
    ORDER BY rr.id DESC
    LIMIT 1
  `, [leaseId]);
}

async function getRenewalRequestByPublicId(db, renewalRequestPublicId) {
  const row = await db.get(`
    SELECT rr.id, rr.public_id, rr.contract_action_request_id, rr.lease_id,
           rr.initiated_by, rr.landlord_willing, rr.current_terms_reusable, rr.reminded_at,
           rr.created_at,
           car.public_id AS action_request_public_id, car.status AS action_status,
           car.contract_id, car.requested_by_contract_party_id,
           le.public_id AS lease_public_id, le.rental_unit_id,
           le.start_date AS lease_start_date, le.end_date AS lease_end_date
    FROM renewal_requests rr
    JOIN contract_action_requests car ON car.id = rr.contract_action_request_id
    JOIN leases le ON le.id = rr.lease_id
    WHERE rr.public_id = ?
  `, [renewalRequestPublicId]);
  return row || notFound('找不到這筆續約申請');
}

async function createRenewalRequest(tx, {
  leaseId, contractId, requestedByContractPartyId, actorUserId, initiatedBy,
  proposedEffectiveDate, reason, landlordWilling
}) {
  const actionRequestPublicId = publicId('contract-action-request');
  const inserted = await tx.run(`
    INSERT INTO contract_action_requests
      (public_id, contract_id, lease_id, request_type, requested_by_contract_party_id,
       proposed_effective_date, reason, status)
    VALUES (?, ?, ?, 'renewal', ?, ?, ?, 'pending')
  `, [actionRequestPublicId, contractId, leaseId, requestedByContractPartyId, proposedEffectiveDate || null, reason || null]);

  const renewalRequestPublicId = publicId('renewal-request');
  await tx.run(`
    INSERT INTO renewal_requests
      (public_id, contract_action_request_id, lease_id, initiated_by, landlord_willing)
    VALUES (?, ?, ?, ?, ?)
  `, [
    renewalRequestPublicId, inserted.insertId, leaseId, initiatedBy,
    landlordWilling === undefined || landlordWilling === null ? null : (landlordWilling ? 1 : 0)
  ]);

  await tx.run(`
    INSERT INTO contract_action_history (contract_action_request_id, action, actor_user_id, note)
    VALUES (?, 'created', ?, ?)
  `, [
    inserted.insertId, actorUserId || null,
    initiatedBy === 'system_reminder' ? '系統於續約提醒窗口自動建立' : '使用者主動提出續約'
  ]);

  return {
    actionRequestId: inserted.insertId,
    actionRequestPublicId,
    renewalRequestPublicId
  };
}

// Q1:房東願不願意續約。用「欄位目前是不是 NULL」當冪等邊界,不用額外的
// idempotency key 欄位(renewal_requests 沒有那個欄位)。已經回答過就回
// replayed:true 帶原本的答案,不當成錯誤。
async function setLandlordWilling(tx, { renewalRequestId, willing }) {
  const updated = await tx.run(
    'UPDATE renewal_requests SET landlord_willing = ? WHERE id = ? AND landlord_willing IS NULL',
    [willing ? 1 : 0, renewalRequestId]
  );
  return Boolean(updated.changes);
}

// Q2:是否沿用目前條件。同樣用 NULL 判斷冪等邊界。
async function setCurrentTermsReusable(tx, { renewalRequestId, reusable }) {
  const updated = await tx.run(
    'UPDATE renewal_requests SET current_terms_reusable = ? WHERE id = ? AND current_terms_reusable IS NULL',
    [reusable ? 1 : 0, renewalRequestId]
  );
  return Boolean(updated.changes);
}

// Q1/Q2 目前的答案(可能還是 NULL)。用來在交易內判斷「這題已經回答過,回放既有
// 答案」還是「還沒回答,可以繼續」——不看 contract_action_requests.status,因為
// 這兩題本身可能就是讓申請關閉的那一步,交易一開始查到的 status 不能拿來判斷
// 這一題自己有沒有被回過。
async function getRenewalAnswers(db, renewalRequestId) {
  const row = await db.get(
    'SELECT landlord_willing, current_terms_reusable FROM renewal_requests WHERE id = ?',
    [renewalRequestId]
  );
  return row || { landlord_willing: null, current_terms_reusable: null };
}

async function latestProposalForRequest(db, renewalRequestId) {
  const row = await db.get(`
    SELECT * FROM renewal_proposals
    WHERE renewal_request_id = ?
    ORDER BY version_number DESC
    LIMIT 1
  `, [renewalRequestId]);
  return row || null;
}

// 版號用 MAX+1 算,真正的去重靠 UNIQUE(renewal_request_id, version_number)。
// 撞到唯一鍵(同一次操作被重送)就當成「已經送過了」回放既有那一版,不是錯誤——
// 跟 ecsNeoRentalUnitClaimServiceAsync 對付重送成交鎖的作法同一個形狀。
async function insertRenewalProposal(tx, {
  renewalRequestId, proposedStartDate, proposedEndDate, rentAmount, depositAmount,
  termsJson, proposedByUserId
}) {
  const numberRow = await tx.get(
    'SELECT COALESCE(MAX(version_number), 0) + 1 AS number FROM renewal_proposals WHERE renewal_request_id = ?',
    [renewalRequestId]
  );
  const versionNumber = numberRow.number;
  const id = publicId('renewal-proposal');
  try {
    await tx.run(`
      INSERT INTO renewal_proposals
        (public_id, renewal_request_id, version_number, proposed_start_date, proposed_end_date,
         rent_amount, deposit_amount, terms_json, proposed_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, renewalRequestId, versionNumber, proposedStartDate, proposedEndDate,
      rentAmount, depositAmount ?? null, termsJson ? JSON.stringify(termsJson) : null, proposedByUserId
    ]);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    return { ...(await latestProposalForRequest(tx, renewalRequestId)), replayed: true };
  }
  return { ...(await tx.get('SELECT * FROM renewal_proposals WHERE public_id = ?', [id])), replayed: false };
}

async function findDecisionForProposal(db, renewalProposalId) {
  const row = await db.get(
    'SELECT * FROM renewal_decisions WHERE renewal_proposal_id = ? ORDER BY id DESC LIMIT 1',
    [renewalProposalId]
  );
  return row || null;
}

async function insertRenewalDecision(tx, { renewalRequestId, renewalProposalId, decidedByUserId, decision, reason }) {
  await tx.run(`
    INSERT INTO renewal_decisions (renewal_request_id, renewal_proposal_id, decided_by_user_id, decision, reason)
    VALUES (?, ?, ?, ?, ?)
  `, [renewalRequestId, renewalProposalId, decidedByUserId, decision, reason || null]);
}

async function transitionActionRequest(tx, { actionRequestId, fromStatuses, toStatus, actorUserId, note }) {
  const placeholders = fromStatuses.map(() => '?').join(',');
  const updated = await tx.run(
    `UPDATE contract_action_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (${placeholders})`,
    [toStatus, actionRequestId, ...fromStatuses]
  );
  if (!updated.changes) return false;
  await tx.run(`
    INSERT INTO contract_action_history (contract_action_request_id, action, actor_user_id, note)
    VALUES (?, ?, ?, ?)
  `, [actionRequestId, toStatus, actorUserId || null, note || null]);
  return true;
}

module.exports = {
  publicId,
  forbidden,
  ambiguousRole,
  notFound,
  isDuplicateKeyError,
  listLeasePartiesForViewer,
  requireLeaseParty,
  requireLandlordUser,
  getLandlordRenewalPreferenceByUserId,
  getLandlordRenewalPreference,
  setLandlordRenewalPreference,
  findActiveLeasesForViewer,
  findActiveLeaseForViewer,
  getRenewalAnswers,
  getExecutedConditionSnapshot,
  getRenewalRequestSummary,
  listLeasePartyUsers,
  findOpenRenewalRequestForLease,
  findCompletedRenewalRequestForLease,
  findLandlordDeclinedRenewalForLease,
  getRenewalRequestByPublicId,
  createRenewalRequest,
  setLandlordWilling,
  setCurrentTermsReusable,
  latestProposalForRequest,
  insertRenewalProposal,
  findDecisionForProposal,
  insertRenewalDecision,
  transitionActionRequest
};
