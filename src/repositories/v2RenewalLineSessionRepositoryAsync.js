const crypto = require('node:crypto');

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function map(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    lineIdentityId: row.line_identity_id,
    renewalRequestId: row.renewal_request_id,
    renewalRequestPublicId: row.renewal_request_public_id,
    stepCode: row.step_code,
    inputText: row.input_text,
    draft: parseJson(row.draft_json),
    expiresAt: row.expires_at,
    finishedAt: row.finished_at
  };
}

async function lineIdentity(db, lineUserId) {
  return db.get('SELECT id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
}

const PURPOSE_MARKER_PREFIX = '__renewal_purpose:';

function purposeMarker(purpose) {
  return purpose ? `${PURPOSE_MARKER_PREFIX}${purpose}` : null;
}

function purposeFrom(session) {
  if (session && session.draft && session.draft._purpose) return session.draft._purpose;
  if (session && typeof session.inputText === 'string' && session.inputText.startsWith(PURPOSE_MARKER_PREFIX)) {
    return session.inputText.slice(PURPOSE_MARKER_PREFIX.length);
  }
  return 'landlord_proposal';
}

async function start(db, { lineUserId, renewalRequestId, purpose = 'landlord_proposal' }) {
  const identity = await lineIdentity(db, lineUserId);
  if (!identity) return null;
  return db.transaction(async (tx) => {
    await tx.run(`
      UPDATE renewal_line_sessions
      SET finished_at = CURRENT_TIMESTAMP, finish_reason = 'replaced', updated_at = CURRENT_TIMESTAMP
      WHERE line_identity_id = ? AND finished_at IS NULL
    `, [identity.id]);
    const publicId = `renewal-line-session-${crypto.randomUUID()}`;
    await tx.run(`
      INSERT INTO renewal_line_sessions
        (public_id, line_identity_id, renewal_request_id, step_code, input_text, expires_at)
      VALUES (?, ?, ?, 'awaiting_input', ?, ?)
    `, [publicId, identity.id, renewalRequestId, purposeMarker(purpose), new Date(Date.now() + 30 * 60 * 1000).toISOString()]);
    return getByPublicId(tx, { lineUserId, publicId });
  });
}

async function getByPublicId(db, { lineUserId, publicId }) {
  const row = await db.get(`
    SELECT rs.*, rr.public_id AS renewal_request_public_id
    FROM renewal_line_sessions rs
    JOIN line_identities li ON li.id = rs.line_identity_id
    JOIN renewal_requests rr ON rr.id = rs.renewal_request_id
    WHERE rs.public_id = ? AND li.line_user_id = ?
  `, [publicId, lineUserId]);
  return map(row);
}

async function getActive(db, lineUserId) {
  const row = await db.get(`
    SELECT rs.*, rr.public_id AS renewal_request_public_id
    FROM renewal_line_sessions rs
    JOIN line_identities li ON li.id = rs.line_identity_id
    JOIN renewal_requests rr ON rr.id = rs.renewal_request_id
    WHERE li.line_user_id = ? AND rs.finished_at IS NULL
    ORDER BY rs.id DESC LIMIT 1
  `, [lineUserId]);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await db.run(`
      UPDATE renewal_line_sessions
      SET finished_at = CURRENT_TIMESTAMP, finish_reason = 'expired', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND finished_at IS NULL
    `, [row.id]);
    return null;
  }
  return map(row);
}

async function saveDraft(db, { publicId, inputText, draft }) {
  await db.run(`
    UPDATE renewal_line_sessions
    SET step_code = 'awaiting_confirmation', input_text = ?, draft_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE public_id = ? AND finished_at IS NULL
  `, [inputText, JSON.stringify(draft), publicId]);
}

async function restart(db, publicId, purpose = 'landlord_proposal') {
  await db.run(`
    UPDATE renewal_line_sessions
    SET step_code = 'awaiting_input', input_text = ?, draft_json = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE public_id = ? AND finished_at IS NULL
  `, [purposeMarker(purpose), publicId]);
}

async function finish(db, { publicId, reason }) {
  await db.run(`
    UPDATE renewal_line_sessions
    SET finished_at = CURRENT_TIMESTAMP, finish_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE public_id = ? AND finished_at IS NULL
  `, [reason, publicId]);
}

module.exports = { start, getByPublicId, getActive, saveDraft, restart, finish, purposeFrom };
