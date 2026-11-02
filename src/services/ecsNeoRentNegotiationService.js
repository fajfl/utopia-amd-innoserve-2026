// 房客出價低於刊登價時,由 Node 決定接受、還價、婉拒或轉問房東。
//
// 模型只負責把房客說的租金整理成 rent_amount 候選;它看不到底價,也不決定價格。
// 還價只還一次:每次都還的話,房客報幾次價就能把底價夾出來。
const crypto = require('crypto');
const { loadRentNegotiationPolicy } = require('./ecsNeoFloorPricePolicyService');

const COUNTER_STEP = 500;

/**
 * 純判斷,不碰資料庫。回 null 表示不介入(出價不低於刊登價)。
 * @returns {null | {outcome:'accepted'|'countered'|'declined'|'escalated', counter?:number}}
 */
function decideRentOffer({ offered, listed, policy, alreadyCountered }) {
  if (!(offered > 0) || !(listed > 0) || offered >= listed) return null;
  if (!policy || !policy.hasPolicy || policy.unreadable) return { outcome: 'escalated' };
  if (!policy.bargainAllowed) return { outcome: 'declined' };
  if (policy.floor === null) return { outcome: 'escalated' };
  if (offered < policy.floor) return { outcome: 'declined' };
  if (alreadyCountered) return { outcome: 'accepted' };
  // 取出價與刊登價的中間再往上取整;一定大於出價,所以不會剛好報出底價。
  const counter = Math.min(listed, Math.ceil((offered + listed) / 2 / COUNTER_STEP) * COUNTER_STEP);
  return { outcome: 'countered', counter };
}

function money(amount) {
  return Number(amount).toLocaleString('en-US');
}

// 給房客看的那一句。房客端自動判斷與房東端回答之後用同一套說法。
function tenantReplyFor(decision, { offered, listed }) {
  if (decision.outcome === 'countered') return `房東這邊目前可以算到每月 ${money(decision.counter)} 元。可以接受的話直接跟我說，我再幫你整理成條件。`;
  if (decision.outcome === 'declined') return `每月 ${money(offered)} 元房東這邊沒辦法接受，刊登租金是每月 ${money(listed)} 元。`;
  if (decision.outcome === 'accepted') return `房東同意每月 ${money(offered)} 元。要用這個價格的話跟我說一聲，我幫你整理成條件。`;
  return null;
}

async function recordNegotiation(db, { inquiryId, sourceMessageId, listed, offered, decision }) {
  await db.run(`
    INSERT INTO rent_negotiations
      (public_id, inquiry_id, source_message_id, listed_rent_amount, offered_rent_amount, outcome, counter_rent_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [`rent-negotiation-${crypto.randomUUID()}`, inquiryId, sourceMessageId ?? null,
    listed, offered, decision.outcome, decision.counter ?? null]);
}

// 房東回答出價題時,找回當時轉問的那一筆出價。
async function loadEscalatedOffer(db, questionPublicId) {
  const row = await db.get(`
    SELECT rn.inquiry_id, rn.source_message_id, rn.listed_rent_amount, rn.offered_rent_amount
    FROM landlord_questions q
    JOIN rent_negotiations rn ON rn.source_message_id = q.source_message_id AND rn.outcome = 'escalated'
    WHERE q.public_id = ? AND q.escalation_reason = 'rent_offer'
    ORDER BY rn.id DESC LIMIT 1
  `, [questionPublicId]);
  return row && {
    inquiryId: row.inquiry_id, sourceMessageId: row.source_message_id,
    listed: Number(row.listed_rent_amount), offered: Number(row.offered_rent_amount)
  };
}

// 只採用房客原話裡真的有的數字;模型自己編的金額不能觸發還價或婉拒。
function offeredRentFrom(action, tenantText) {
  const candidate = (action.conditionCandidates || []).find((entry) => entry.fieldPath === 'rent_amount');
  const amount = candidate ? Number(candidate.value) : NaN;
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return String(tenantText || '').replace(/[,，\s]/g, '').includes(String(amount)) ? amount : null;
}

/**
 * 回傳實際要執行的 action。沒有低於刊登價的出價就原樣回傳。
 */
async function applyRentNegotiation(db, { action, scope, tenantText, sourceMessageId }) {
  const offered = offeredRentFrom(action, tenantText);
  if (offered === null) return action;
  const listing = await db.get('SELECT current_rent_amount FROM listings WHERE id = ?', [scope.listing_id]);
  const listed = listing ? Number(listing.current_rent_amount) : 0;
  if (!(listed > offered)) return action;

  const policy = await loadRentNegotiationPolicy(db, {
    rentalUnitId: scope.rental_unit_id, propertyId: scope.property_id, organizationId: scope.organization_id
  });
  const countered = await db.get(
    "SELECT id FROM rent_negotiations WHERE inquiry_id = ? AND outcome = 'countered' LIMIT 1", [scope.inquiry_id]);
  // 房東在轉問卡上按過「接受這個價」:同一筆詢問不低於那個價就直接接受。
  const approved = await db.get(
    "SELECT MIN(offered_rent_amount) AS amount FROM rent_negotiations WHERE inquiry_id = ? AND outcome = 'accepted'", [scope.inquiry_id]);
  const decision = approved && approved.amount && offered >= Number(approved.amount)
    ? { outcome: 'accepted' }
    : decideRentOffer({ offered, listed, policy, alreadyCountered: Boolean(countered) });
  await recordNegotiation(db, { inquiryId: scope.inquiry_id, sourceMessageId, listed, offered, decision });

  if (decision.outcome === 'accepted') return action;
  if (decision.outcome === 'escalated') {
    return {
      ...action, type: 'escalate_to_landlord', rentOffer: true,
      responseText: `出價：每月 ${money(offered)} 元（刊登 ${money(listed)} 元）`,
      conditionCandidates: [], groundingRefs: [], forcedEscalation: true
    };
  }
  // ponytail: 還價/婉拒時,同一句話裡的其他條件(日期等)這輪不整理,房客談定價格後再說一次。
  return {
    ...action, type: 'ask_clarification', responseText: tenantReplyFor(decision, { offered, listed }),
    conditionCandidates: [], conflicts: [], missingFields: [], groundingRefs: [], offerEscalation: false
  };
}

module.exports = {
  applyRentNegotiation, decideRentOffer, loadEscalatedOffer, offeredRentFrom, recordNegotiation, tenantReplyFor
};
