const crypto = require('node:crypto');

function iso(value) { return new Date(value || Date.now()).toISOString(); }
function plusMinutes(value, minutes) { return new Date(new Date(value).getTime() + minutes * 60000).toISOString(); }
function rowValue(row) {
  if (!row) return null;
  return { publicId: row.public_id, lineIdentityId: row.line_identity_id,
    listingId: row.listing_id, flowType: row.flow_type, stepCode: row.step_code,
    context: JSON.parse(row.context_json || '{}'), expiresAt: row.expires_at };
}

function startFlow(db, input) {
  const now = iso(input.now);
  return db.transaction(() => {
    db.prepare(`UPDATE line_flow_sessions SET finished_at=?, finish_reason='replaced', updated_at=?
      WHERE line_identity_id=? AND finished_at IS NULL`).run(now, now, input.lineIdentityId);
    const publicId = `line-flow-${crypto.randomUUID()}`;
    db.prepare(`INSERT INTO line_flow_sessions
      (public_id,line_identity_id,flow_type,listing_id,step_code,context_json,started_at,updated_at,expires_at)
      VALUES (?,?,'landlord_knowledge',?,?,?,?,?,?)`)
      .run(publicId, input.lineIdentityId, input.listingId || null, input.stepCode,
        JSON.stringify(input.context || {}), now, now, plusMinutes(now, 10));
    return rowValue(db.prepare('SELECT * FROM line_flow_sessions WHERE public_id=?').get(publicId));
  }).immediate();
}

function getActiveFlow(db, lineIdentityId, at = new Date()) {
  const now = iso(at);
  const row = db.prepare(`SELECT * FROM line_flow_sessions
    WHERE line_identity_id=? AND finished_at IS NULL`).get(lineIdentityId);
  if (!row) return null;
  if (row.expires_at <= now) {
    // finished_at IS NULL 是護欄:併發時另一個呼叫可能已經把它收掉,
    // 沒有這個條件會覆蓋掉別人寫的 finish_reason。
    db.prepare(`UPDATE line_flow_sessions SET finished_at=?,finish_reason='expired',updated_at=?
      WHERE id=? AND finished_at IS NULL`)
      .run(now, now, row.id);
    return null;
  }
  return rowValue(row);
}

function advanceFlow(db, input) {
  const now = iso(input.now);
  const result = db.prepare(`UPDATE line_flow_sessions SET step_code=?,context_json=?,listing_id=COALESCE(?,listing_id),
    updated_at=?,expires_at=? WHERE public_id=? AND finished_at IS NULL`)
    .run(input.stepCode, JSON.stringify(input.context || {}), input.listingId || null,
      now, plusMinutes(now, 10), input.publicId);
  if (!result.changes) throw new Error('active flow not found');
  return rowValue(db.prepare('SELECT * FROM line_flow_sessions WHERE public_id=?').get(input.publicId));
}

function finishFlow(db, publicId, reason = 'completed', at = new Date()) {
  const now = iso(at);
  return db.prepare(`UPDATE line_flow_sessions SET finished_at=?,finish_reason=?,updated_at=?
    WHERE public_id=? AND finished_at IS NULL`).run(now, reason, now, publicId).changes > 0;
}
function cancelFlow(db, lineIdentityId, at = new Date()) {
  const now = iso(at);
  return db.prepare(`UPDATE line_flow_sessions SET finished_at=?,finish_reason='cancelled',updated_at=?
    WHERE line_identity_id=? AND finished_at IS NULL`).run(now, now, lineIdentityId).changes > 0;
}

module.exports = { advanceFlow, cancelFlow, finishFlow, getActiveFlow, startFlow };
