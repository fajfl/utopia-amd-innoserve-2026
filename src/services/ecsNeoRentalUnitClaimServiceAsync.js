// The only place a rental unit is claimed.  Call this from the same database
// transaction that records the landlord's final signature; never from draft
// creation, issuing, or tenant signing.
const crypto = require('node:crypto');

const { enqueueNotification } = require('./ecsNeoOutboxAsync');

const TERMINAL =['rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'];
function conflict(cause) {
  const error = new Error('這個出租單位已由其他合約完成簽署');
  error.code = 'unit_claim_conflict';
  error.statusCode = 409;
  error.cause = cause;
  return error;
}
function duplicate(error) {
  return error?.code === 'ER_DUP_ENTRY' || Number(error?.errno) === 1062 ||
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

async function claimRentalUnitOnLandlordSignature(tx, { request }) {
  const row = await tx.get(`SELECT c.id contract_id,c.rental_unit_id,c.selected_intention_id,ri.confirmed_intention_version_id,
      cp.user_id landlord_user_id
    FROM contracts c LEFT JOIN rental_intentions ri ON ri.id=c.selected_intention_id
    JOIN contract_parties cp ON cp.id=? AND cp.contract_id=c.id AND cp.party_role='landlord' AND cp.status='active'
    WHERE c.id=? AND c.status='signing'`, [request.contract_party_id, request.contract_id]);
  if (!row) {
    const error = new Error('目前合約不允許房東完成簽署'); error.statusCode = 409; throw error;
  }
  // 030 以前建立的 legacy contract 沒有 selected intention，沒有足夠資料建立
  // claim。保留既有簽署相容性；所有新 ECS 草稿都必須有 exact intention。
  if (!row.selected_intention_id) return { legacy: true };
  // 舊版 createVersionFromIntention 可能有 selected intention，但建立當時尚無
  // confirmed_intention_version_id。新 materializer 不會產生這種資料。
  if (!row.confirmed_intention_version_id) return { legacy: true };
  try {
    await tx.run(`INSERT INTO rental_unit_contracting_claims
      (public_id,rental_unit_id,rental_intention_id,intention_version_id,contract_id,claimed_by_user_id,idempotency_key)
      VALUES (?,?,?,?,?,?,?)`, [
      `claim-${crypto.randomUUID()}`, row.rental_unit_id, row.selected_intention_id,
      row.confirmed_intention_version_id, row.contract_id, row.landlord_user_id,
      `landlord-signature:${request.id}`
    ]);
  } catch (error) {
    if (!duplicate(error)) throw error;
    // A retry after a successful commit is idempotent.  A different contract is
    // a real competition loss and must abort the signature transaction.
    const existing = await tx.get('SELECT contract_id FROM rental_unit_contracting_claims WHERE rental_unit_id=?', [row.rental_unit_id]);
    if (existing && String(existing.contract_id) === String(row.contract_id)) return { replayed: true };
    throw conflict(error);
  }
  // --- 勝方:submitted/under_review -> accepted -> contracting -------------
  //
  // spec invariant 6:accepted 只在這個交易內存在,交易外可見狀態必為 contracting,
  // 但 status history 必須留下**兩列**。少寫其中一列,稽核就看不出房東確實接受過
  // 哪一個 exact version。
  const winner = await tx.get('SELECT status FROM rental_intentions WHERE id=?', [row.selected_intention_id]);
  if (winner && !TERMINAL.includes(winner.status) && winner.status !== 'contracting') {
    await tx.run(`INSERT INTO intention_decisions
      (public_id,rental_intention_id,intention_version_id,decision,decided_by_user_id,reason,idempotency_key)
      VALUES (?,?,?, 'accepted', ?, '房東完成簽署,接受此意向', ?)`, [
      `intention-decision-${crypto.randomUUID()}`, row.selected_intention_id,
      row.confirmed_intention_version_id, row.landlord_user_id,
      `landlord-signature-accept:${request.id}`
    ]);
    await tx.run(`INSERT INTO intention_status_history (rental_intention_id,from_status,to_status,actor_user_id,reason)
      VALUES (?,?,'accepted',?,'房東簽署,接受房客確認的精確版本')`, [row.selected_intention_id, winner.status, row.landlord_user_id]);
    await tx.run("UPDATE rental_intentions SET status='contracting',updated_at=CURRENT_TIMESTAMP WHERE id=?", [row.selected_intention_id]);
    await tx.run(`INSERT INTO intention_status_history (rental_intention_id,from_status,to_status,actor_user_id,reason)
      VALUES (?,'accepted','contracting',?,'成交鎖取得,進入簽約')`, [row.selected_intention_id, row.landlord_user_id]);
    const inquiry = await tx.get('SELECT id,status FROM inquiries WHERE id=(SELECT inquiry_id FROM rental_intentions WHERE id=?)', [row.selected_intention_id]);
    if (inquiry && !['contracting', 'ended'].includes(inquiry.status)) {
      await tx.run("UPDATE inquiries SET status='contracting',last_activity_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", [inquiry.id]);
      await tx.run(`INSERT INTO inquiry_status_history (inquiry_id,from_status,to_status,actor_user_id,reason)
        VALUES (?,?,'contracting',?,'成交鎖取得')`, [inquiry.id, inquiry.status, row.landlord_user_id]);
    }
  }

  // --- 落敗方:轉 leased_to_another_tenant,取消待簽,通知 ------------------
  const losers = await tx.all(`SELECT ri.id,ri.public_id,ri.status,ri.tenant_user_id FROM rental_intentions ri JOIN listings l ON l.id=ri.listing_id
    WHERE l.rental_unit_id=? AND ri.id<>? AND ri.status NOT IN (${TERMINAL.map(() => '?').join(',')})`,
  [row.rental_unit_id, row.selected_intention_id, ...TERMINAL]);
  for (const loser of losers) {
    await tx.run("UPDATE rental_intentions SET status='leased_to_another_tenant',updated_at=CURRENT_TIMESTAMP WHERE id=?", [loser.id]);
    await tx.run(`INSERT INTO intention_status_history (rental_intention_id,from_status,to_status,actor_user_id,reason)
      VALUES (?,?,'leased_to_another_tenant',?,'此出租單位已由其他房客成交')`, [loser.id, loser.status, row.landlord_user_id]);
    // 通知內容只有「這間房已被承租」,沒有得標者是誰、條件多少、何時成交。
    await enqueueNotification(tx, {
      eventType: 'intention_leased_to_another_tenant',
      entityType: 'rental_intention',
      entityId: loser.public_id,
      payload: { intentionPublicId: loser.public_id },
      recipients: [{ role: 'tenant', userId: loser.tenant_user_id }],
      idempotencyKey: `leased-to-another:${loser.public_id}`
    });
  }
  await tx.run(`UPDATE signature_requests SET status='cancelled',completed_at=CURRENT_TIMESTAMP
    WHERE contract_version_id IN (SELECT cv.id FROM contract_versions cv JOIN contracts c ON c.id=cv.contract_id WHERE c.rental_unit_id=? AND c.id<>?)
      AND status IN ('pending','sent','viewed')`, [row.rental_unit_id, row.contract_id]);
  return { replayed: false, losers: losers.length };
}

module.exports = { claimRentalUnitOnLandlordSignature };
