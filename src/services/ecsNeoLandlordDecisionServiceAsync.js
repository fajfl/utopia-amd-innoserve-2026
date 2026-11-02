// 房東在簽署頁上的兩個非簽署決定,對應到承租意向的狀態。
//
// 這兩件事在合約層與意向層的意思不一樣,分開寫是刻意的:
//
//   要求修改 request_changes
//     合約層:這一版作廢,合約退回 drafting。
//     意向層:**回到協調**。意向退回 draft,房客可以繼續跟 Agent 談、產生新版本、
//             重新確認。原本確認的指標清掉 —— 留著它等於「房客確認過一個已經被
//             房東退回的版本」,下游 materializer 會拿它繼續產草稿。
//
//   拒絕 reject
//     合約層:簽署請求作廢。
//     意向層:**終止這一筆意向**。房客要重談會是新的一筆意向,不是把這筆退回 draft。
//     詢問層:留著。房客可以在同一段對話裡繼續談,不必重新找房 —— 見下面
//             applyLandlordIntentionDecision 裡的說明。
//
// 兩者都在同一個交易內寫 intention_decisions(綁 exact version)與
// intention_status_history,並用 idempotency key 讓重送不會產生第二筆決定。
// 通知走 outbox,不在交易內推播。

const crypto = require('node:crypto');

const { enqueueNotification } = require('./ecsNeoOutboxAsync');
const contractRepository = require('../repositories/v2ContractRepositoryAsync');

const DECISION_BY_ACTION = Object.freeze({
  request_changes: 'changes_requested',
  reject: 'rejected'
});

// 已經結束的意向不再被決定影響。accepted/contracting 也不行:那時候成交鎖已經
// 存在,退回協調會讓一間房同時有「鎖」與「還在談」兩種狀態。
const DECIDABLE_INTENTION_STATUSES = Object.freeze(['draft', 'submitted', 'under_review']);

function fail(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * 在**呼叫端已開啟的交易內**記錄房東決定並推進意向狀態。
 *
 * @param {object} tx      交易內的 driver
 * @param {object} input
 * @param {string} input.action          'request_changes' | 'reject'
 * @param {number|string} input.contractId
 * @param {number|string} input.landlordUserId
 * @param {string} input.idempotencyKey
 * @param {string} [input.reason]
 * @returns {Promise<{applied:boolean, replayed:boolean, decision:(string|null),
 *                    intentionStatus:(string|null), intentionPublicId:(string|null)}>}
 */
async function applyLandlordIntentionDecision(tx, input = {}) {
  const decision = DECISION_BY_ACTION[input.action];
  if (!decision) throw fail(`未知的房東決定 ${input.action}`, 'invalid_input', 400);
  if (!input.idempotencyKey) throw fail('idempotencyKey is required', 'invalid_input', 400);

  const row = await tx.get(`
    SELECT ri.id, ri.public_id, ri.status, ri.inquiry_id, ri.tenant_user_id,
           ri.confirmed_intention_version_id
    FROM contracts c
    JOIN rental_intentions ri ON ri.id = c.selected_intention_id
    WHERE c.id = ?
  `, [input.contractId]);
  // 030 之前的 legacy 合約沒有 selected_intention。合約層的處理照舊,
  // 意向層沒有東西可以推進,這不是錯誤。
  if (!row) return { applied: false, replayed: false, decision: null, intentionStatus: null, intentionPublicId: null };

  const existing = await tx.get(
    'SELECT id, decision FROM intention_decisions WHERE idempotency_key = ?',
    [input.idempotencyKey]
  );
  if (existing) {
    return {
      applied: false,
      replayed: true,
      decision: existing.decision,
      intentionStatus: row.status,
      intentionPublicId: row.public_id
    };
  }

  if (!DECIDABLE_INTENTION_STATUSES.includes(row.status)) {
    throw fail(`承租意向目前是 ${row.status},不能再做這個決定`, 'stale_version');
  }

  // 決定綁的是**房客確認的那一個 exact version**,不是「最新版」。
  const versionId = row.confirmed_intention_version_id;
  if (versionId === null || versionId === undefined) {
    throw fail('這筆意向沒有房客確認過的版本,無法記錄房東決定', 'stale_version');
  }

  await tx.run(`
    INSERT INTO intention_decisions
      (public_id, rental_intention_id, intention_version_id, decision,
       decided_by_user_id, reason, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    `intention-decision-${crypto.randomUUID()}`,
    row.id, versionId, decision, input.landlordUserId,
    input.reason || null, input.idempotencyKey
  ]);

  const nextStatus = decision === 'rejected' ? 'rejected' : 'draft';
  const placeholders = DECIDABLE_INTENTION_STATUSES.map(() => '?').join(',');
  // 要求修改要把 confirmed 指標清掉;拒絕不用清,因為意向已經終止,
  // 而且保留指標讓稽核看得出房東拒的是哪一版。
  const updated = decision === 'changes_requested'
    ? await tx.run(`
        UPDATE rental_intentions
        SET status = 'draft', confirmed_intention_version_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN (${placeholders})
      `, [row.id, ...DECIDABLE_INTENTION_STATUSES])
    : await tx.run(`
        UPDATE rental_intentions
        SET status = 'rejected', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN (${placeholders})
      `, [row.id, ...DECIDABLE_INTENTION_STATUSES]);
  if (!updated.changes) throw fail('承租意向剛剛被其他操作改變', 'stale_version');

  await tx.run(`
    INSERT INTO intention_status_history
      (rental_intention_id, from_status, to_status, actor_user_id, reason)
    VALUES (?, ?, ?, ?, ?)
  `, [
    row.id, row.status, nextStatus, input.landlordUserId,
    decision === 'rejected' ? '房東拒絕這一筆承租意向' : '房東要求修改,退回 AI 協調'
  ]);

  // 兩個決定都讓**詢問**回到協調中。終止的是這一筆承租意向,不是這段對話。
  //
  // 拒絕原本會把 inquiry 一起 ended。那等於房客連在原地重談都不行:gateway 看到
  // 綁定的詢問已結束就只會回「請重新選一筆房源」,房客得從找房紀錄開一筆新的詢問,
  // 之前談的條件、對話全部不見。房東按拒絕的意思是「這一版我不接受」,不是
  // 「我不想再跟你講話」;要真的斷線是房客自己退出或詢問逾期,不是這裡。
  //
  // 意向仍然是 rejected(上面已經寫了),所以房客重談時 ensureIntention 會開一筆
  // 新的承租意向 —— 被拒的那一筆連同它的版本原樣留著供稽核。
  const inquiry = await tx.get('SELECT status FROM inquiries WHERE id = ?', [row.inquiry_id]);
  if (inquiry && inquiry.status === 'intention_confirming') {
    await tx.run(`
      UPDATE inquiries
      SET status = 'inquiring', last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'intention_confirming'
    `, [row.inquiry_id]);
    await tx.run(`
      INSERT INTO inquiry_status_history
        (inquiry_id, from_status, to_status, actor_user_id, reason)
      VALUES (?, 'intention_confirming', 'inquiring', ?, ?)
    `, [
      row.inquiry_id, input.landlordUserId,
      decision === 'rejected' ? '房東拒絕這一版承租意向,詢問保留給房客重談' : '房東要求修改承租條件'
    ]);
  }

  await enqueueNotification(tx, {
    eventType: decision === 'rejected' ? 'intention_rejected' : 'intention_changes_requested',
    entityType: 'rental_intention',
    entityId: row.public_id,
    payload: { intentionPublicId: row.public_id, decision },
    recipients: [{ role: 'tenant', userId: row.tenant_user_id }],
    idempotencyKey: `intention-decision:${input.idempotencyKey}`
  });

  return {
    applied: true,
    replayed: false,
    decision,
    intentionStatus: nextStatus,
    intentionPublicId: row.public_id
  };
}

// ---------------------------------------------------------------------------
// 房東對草稿條件的確認
//
// 送簽有兩道關卡,兩道都是房東的:
//   1. 屋況附件一(pre_inspection_sessions.confirmation_status)—— 確認的是照片與屋況
//   2. 這裡的條件確認(contract_versions.landlord_terms_confirmed_at)—— 確認的是
//      租金、押金、租期與責任條款本身
//
// 沒有第 2 道的話,房客會在房東對條件表態之前就交出身分證資料、錄影與簽名;
// 房東第一次對條件說話的時機變成最後那一次簽署,而已簽版本不能再退回修改
// (見 v2ContractSigningServiceAsync 的 contract_version_signed),房東只剩簽或拒。
//
// 確認綁在**版本**上。房東要求修改後房客重新協調產生的新版本,欄位天生是 NULL,
// 必須重新確認 —— 確認不跨版本繼承。
// ---------------------------------------------------------------------------

async function loadDraftVersion(tx, versionId) {
  return tx.get(`
    SELECT cv.id, cv.public_id, cv.contract_id, cv.version_number, cv.status,
           cv.landlord_terms_confirmed_at, c.public_id AS contract_public_id,
           c.status AS contract_status
    FROM contract_versions cv
    JOIN contracts c ON c.id = cv.contract_id
    WHERE cv.id = ?
  `, [versionId]);
}

// 合約從 drafting 推進到「等房東確認」。這個狀態 003 就有、頁面早有「待確認」標籤,
// 只是一直沒有人設定它;房東的待辦儀表板本來就會數它。
async function markAwaitingConfirmation(tx, { contractId, actorUserId, reason }) {
  const updated = await tx.run(
    "UPDATE contracts SET status='awaiting_confirmation', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='drafting'",
    [contractId]
  );
  if (updated.changes) {
    await tx.run(`
      INSERT INTO contract_status_history (contract_id, from_status, to_status, actor_user_id, reason)
      VALUES (?, 'drafting', 'awaiting_confirmation', ?, ?)
    `, [contractId, actorUserId, reason]);
  }
  return Boolean(updated.changes);
}

/**
 * 房客送簽時呼叫。房東還沒確認條件就不放行,並把合約推進到等房東確認。
 *
 * 與屋況附件那一關同一個形狀:不是丟一句錯誤,而是真的把請求交出去,
 * 再告訴房客在等什麼。
 */
async function requestLandlordTermsConfirmation({ db, lineUserId, versionPublicId, notify }) {
  const party = await contractRepository.requireVersionParty(db, { lineUserId, versionPublicId });
  if (party.party_role !== 'tenant') throw fail('只有房客可以送出簽署', 'authorization_denied', 403);

  const outcome = await db.transaction(async (tx) => {
    const version = await loadDraftVersion(tx, party.version_id);
    if (!version) throw fail('找不到這個版本', 'not_found', 404);
    if (version.landlord_terms_confirmed_at) {
      return { confirmed: true, requested: false, versionNumber: version.version_number };
    }
    const requested = await markAwaitingConfirmation(tx, {
      contractId: version.contract_id,
      actorUserId: party.user_id,
      reason: '房客送出簽署,等房東確認條件'
    });
    return { confirmed: false, requested, versionNumber: version.version_number };
  });

  if (outcome.confirmed) return { confirmed: true, requested: false, message: null };
  // 推播失敗不能讓這一關的狀態回捲:房東在自己的合約頁一樣看得到待確認。
  if (typeof notify === 'function') {
    try {
      await notify({
        versionPublicId,
        contractPublicId: party.contract_public_id,
        versionNumber: outcome.versionNumber
      });
    } catch {
      // 推播是通知手段,不是這一關的真相來源。
    }
  }
  return {
    confirmed: false,
    requested: outcome.requested,
    message: `第 ${outcome.versionNumber} 版的條件要房東確認過才能開始簽署，已經通知房東；`
      + '房東確認後回到這一頁就可以送簽。'
  };
}

/**
 * 房東在草稿頁上對條件表態。
 *
 * `confirm`         這一版的條件可以進簽署。冪等。
 * `request_changes` 退回協調 —— 沿用既有的意向決定 command,房客可以繼續跟 Agent
 *                   談出新版本。
 */
async function decideDraftTerms({ db, lineUserId, versionPublicId, decision, reason, idempotencyKey }) {
  if (!['confirm', 'request_changes'].includes(decision)) {
    throw fail(`未知的決定 ${decision}`, 'invalid_input', 400);
  }
  const party = await contractRepository.requireVersionParty(db, { lineUserId, versionPublicId });
  if (party.party_role !== 'landlord') throw fail('只有房東可以確認條件', 'authorization_denied', 403);

  return db.transaction(async (tx) => {
    const version = await loadDraftVersion(tx, party.version_id);
    if (!version) throw fail('找不到這個版本', 'not_found', 404);
    if (version.status !== 'draft') throw fail('這個版本已經送出，無法在草稿階段決定', 'stale_version');
    const latest = await tx.get(
      'SELECT id FROM contract_versions WHERE contract_id=? ORDER BY version_number DESC, id DESC LIMIT 1',
      [version.contract_id]
    );
    if (!latest || String(latest.id) !== String(version.id)) throw fail('只能對最新版本做決定', 'stale_version');

    if (decision === 'request_changes') {
      const intention = await applyLandlordIntentionDecision(tx, {
        action: 'request_changes',
        contractId: version.contract_id,
        landlordUserId: party.user_id,
        reason,
        idempotencyKey: idempotencyKey || `draft-terms-changes:${version.public_id}`
      });
      // 回到協調:合約退回 drafting。這一版留著,但它的 landlord_terms_confirmed_at
      // 仍是 NULL,所以不會被送簽。
      await tx.run(
        "UPDATE contracts SET status='drafting', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_confirmation'",
        [version.contract_id]
      );
      return {
        decision: 'request_changes',
        replayed: Boolean(intention.replayed),
        versionPublicId: version.public_id,
        contractPublicId: version.contract_public_id,
        intention
      };
    }

    if (version.landlord_terms_confirmed_at) {
      return {
        decision: 'confirm', replayed: true, confirmed: true,
        versionPublicId: version.public_id, contractPublicId: version.contract_public_id
      };
    }
    await tx.run(`
      UPDATE contract_versions
      SET landlord_terms_confirmed_at = CURRENT_TIMESTAMP, landlord_terms_confirmed_by_user_id = ?
      WHERE id = ? AND landlord_terms_confirmed_at IS NULL
    `, [party.user_id, version.id]);
    await markAwaitingConfirmation(tx, {
      contractId: version.contract_id,
      actorUserId: party.user_id,
      reason: '房東確認草稿條件'
    });
    return {
      decision: 'confirm', replayed: false, confirmed: true,
      versionPublicId: version.public_id, contractPublicId: version.contract_public_id
    };
  });
}

/**
 * 這份合約最後一次房東決定,給草稿頁顯示用。
 *
 * 理由是房東自己輸入的自由文字,只回給這筆合約的當事人;沒寫就是 null,
 * 頁面那邊不編一個出來。
 */
async function latestLandlordDecision(db, contractId) {
  const row = await db.get(`
    SELECT id.decision, id.reason, id.decided_at
    FROM intention_decisions id
    JOIN contracts c ON c.selected_intention_id = id.rental_intention_id
    WHERE c.id = ? AND id.decision IN ('rejected', 'changes_requested')
    ORDER BY id.id DESC LIMIT 1
  `, [contractId]);
  if (!row) return null;
  const reason = String(row.reason || '').trim();
  return { decision: row.decision, reason: reason || null, decidedAt: row.decided_at || null };
}

/** 給草稿頁用的唯讀狀態。 */
async function landlordTermsStatus(db, versionId) {
  const row = await db.get(
    'SELECT landlord_terms_confirmed_at FROM contract_versions WHERE id = ?',
    [versionId]
  );
  return {
    confirmed: Boolean(row && row.landlord_terms_confirmed_at),
    confirmedAt: (row && row.landlord_terms_confirmed_at) || null
  };
}

module.exports = {
  DECIDABLE_INTENTION_STATUSES,
  DECISION_BY_ACTION,
  applyLandlordIntentionDecision,
  decideDraftTerms,
  landlordTermsStatus,
  latestLandlordDecision,
  requestLandlordTermsConfirmation
};
