// 競爭揭露:「這間房目前不只你一個人在談」。
//
// 為什麼要揭露:同一個 rental unit 只有一條 contracting 路徑(030 的全域 claim)。
// 房客花時間把條件談完、確認版本、看完草稿,最後才發現房子被別人簽走,那是
// 產品層級的欺瞞。所以在房客投入之前就要讓他知道有競爭。
//
// 為什麼揭露內容只有數字:另一位房客的姓名、條件、進度、出價都是別人的隱私,
// spec invariant 明文禁止外洩。這裡的輸出**只有計數與布林**,連「對方談到哪一步」
// 都不給 —— 進度本身就能反推對方的行為。
//
// 冪等:idempotency key 綁 (inquiry, 競爭狀態)。同一個狀態重算幾次都只通知一次;
// 狀態真的變了(從沒有競爭變成有競爭、從未成交變成已成交)才會有新的一則。

const { enqueueNotification } = require('./ecsNeoOutboxAsync');

const EVENT_TYPE = 'competition_disclosure';

// 已終止的意向不算競爭者。
const TERMINAL_INTENTION_STATUSES = Object.freeze([
  'rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'
]);

/**
 * 統計同一 rental unit 上的競爭狀況。
 *
 * **回傳值不含任何身分、金額或時間點。** 只有計數與布林。
 */
async function summarizeCompetition(db, { rentalUnitId, excludeIntentionId = null } = {}) {
  if (!db || typeof db.get !== 'function') throw new Error('db driver is required');
  if (rentalUnitId === null || rentalUnitId === undefined) {
    return { otherActiveIntentionCount: 0, unitClaimed: false, claimedByThisIntention: false };
  }

  const placeholders = TERMINAL_INTENTION_STATUSES.map(() => '?').join(',');
  const counted = await db.get(`
    SELECT COUNT(*) AS competitor_count
    FROM rental_intentions ri
    JOIN listings l ON l.id = ri.listing_id
    WHERE l.rental_unit_id = ?
      AND ri.ended_at IS NULL
      AND ri.status NOT IN (${placeholders})
      AND (? IS NULL OR ri.id <> ?)
  `, [rentalUnitId, ...TERMINAL_INTENTION_STATUSES, excludeIntentionId, excludeIntentionId]);

  const claim = await db.get(
    'SELECT rental_intention_id FROM rental_unit_contracting_claims WHERE rental_unit_id = ?',
    [rentalUnitId]
  );

  return {
    otherActiveIntentionCount: Number((counted && counted.competitor_count) || 0),
    unitClaimed: Boolean(claim),
    claimedByThisIntention: Boolean(claim)
      && excludeIntentionId !== null
      && excludeIntentionId !== undefined
      && String(claim.rental_intention_id) === String(excludeIntentionId)
  };
}

// 競爭狀態的指紋。只用「有沒有競爭」與「有沒有被成交」兩個位元,不用實際人數 ——
// 人數每多一個就推播一次是騷擾,而且人數本身洩漏得比需要的多。
function competitionState(summary) {
  const contested = summary.otherActiveIntentionCount > 0 ? 'contested' : 'sole';
  if (summary.claimedByThisIntention) return `${contested}:won`;
  if (summary.unitClaimed) return `${contested}:lost`;
  return `${contested}:open`;
}

// 給房客看的文字。刻意不寫「有 2 位房客」以外的任何細節,也不寫對方的進度。
function disclosureText(summary) {
  if (summary.claimedByThisIntention) {
    return '這間房源的簽約流程已經由你這一份合約完成鎖定，其他承租意向不會再往下走。';
  }
  if (summary.unitClaimed) {
    return '這間房源已經由另一份合約完成簽署，無法再往下走。你可以回「找房紀錄」換一間房源繼續。';
  }
  if (summary.otherActiveIntentionCount > 0) {
    return `提醒你：這間房源目前還有其他 ${summary.otherActiveIntentionCount} 筆承租意向在進行中。`
      + '房東最後簽署的那一份才會鎖定房源，先談完不代表先成交。'
      + '（依規定我不會透露其他房客是誰、開什麼條件或談到哪一步。）';
  }
  return null;
}

/**
 * 在主交易內建立一則競爭揭露通知。同一個競爭狀態只會有一則。
 *
 * @returns {Promise<{disclosed:boolean, state:string, text:(string|null)}>}
 */
async function discloseCompetition(tx, {
  inquiryId, inquiryPublicId, tenantUserId, rentalUnitId, summary
} = {}) {
  const state = competitionState(summary);
  const text = disclosureText(summary);
  if (!text) return { disclosed: false, state, text: null };

  const result = await enqueueNotification(tx, {
    eventType: EVENT_TYPE,
    entityType: 'inquiry',
    entityId: inquiryId,
    // payload 只有計數與狀態。dispatcher 用它重建文字,不需要也拿不到任何身分。
    payload: {
      inquiryPublicId,
      rentalUnitId: String(rentalUnitId),
      state,
      otherActiveIntentionCount: summary.otherActiveIntentionCount,
      unitClaimed: summary.unitClaimed
    },
    recipients: [{ role: 'tenant', userId: tenantUserId }],
    idempotencyKey: `${EVENT_TYPE}:${inquiryPublicId}:${state}`
  });

  return { disclosed: result.enqueued > 0, state, text };
}

module.exports = {
  EVENT_TYPE,
  TERMINAL_INTENTION_STATUSES,
  competitionState,
  disclosureText,
  discloseCompetition,
  summarizeCompetition
};
