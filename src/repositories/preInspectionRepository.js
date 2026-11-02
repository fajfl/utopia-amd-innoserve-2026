const crypto = require('node:crypto');
// 合約附件一也要讀這幾句,SQL 抽在 preInspectionQueries 只寫一份。
const queries = require('./preInspectionQueries');

function getActiveListingContextByLineUser(db, lineUserId) {
  const row = db.prepare(`
    SELECT
      l.id as listing_id,
      i.id as inquiry_id,
      l.title as listing_title,
      ru.unit_label,
      ls.normalized_address as address_text,
      up.display_name as landlord_name,
      up.phone as landlord_phone
    FROM active_inquiry_contexts aic
    JOIN line_identities li ON li.id = aic.line_identity_id
    JOIN inquiries i ON i.id = aic.inquiry_id
    JOIN listings l ON l.id = i.listing_id
    LEFT JOIN rental_units ru ON ru.id = l.rental_unit_id
    LEFT JOIN listing_snapshots ls ON ls.id = l.latest_valid_snapshot_id
    LEFT JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
    LEFT JOIN user_profiles up ON up.user_id = po.owner_user_id
    WHERE li.line_user_id = ? AND aic.cleared_at IS NULL
    ORDER BY aic.id DESC
    LIMIT 1
  `).get(lineUserId);

  if (!row) return null;

  return {
    listingId: row.listing_id,
    inquiryId: row.inquiry_id,
    listingTitle: row.listing_title,
    unitLabel: row.unit_label,
    addressText: row.address_text,
    landlordName: row.landlord_name,
    landlordPhone: row.landlord_phone
  };
}

function getActiveSession(db, lineUserId) {
  return db.prepare(`
    SELECT * FROM pre_inspection_sessions
    WHERE line_user_id = ? AND status = 'active'
    ORDER BY id DESC LIMIT 1
  `).get(lineUserId);
}

function createSession(db, { lineUserId, recordType = 'main', parentSessionId = null, listingId = null, inquiryId = null, title = null }) {
  const publicId = `pre-insp-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO pre_inspection_sessions (
      public_id, listing_id, inquiry_id, line_user_id, record_type, parent_session_id, status, title, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(publicId, listingId, inquiryId, lineUserId, recordType, parentSessionId, title, startedAt);

  return db.prepare('SELECT * FROM pre_inspection_sessions WHERE public_id = ?').get(publicId);
}

function getSessionStats(db, sessionId) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN entry_type = 'image' THEN 1 ELSE 0 END) as image_count,
      SUM(CASE WHEN entry_type = 'video' THEN 1 ELSE 0 END) as video_count,
      SUM(CASE WHEN entry_type = 'text' THEN 1 ELSE 0 END) as text_count
    FROM pre_inspection_entries
    WHERE session_id = ?
  `).get(sessionId);

  return {
    imageCount: Number(row.image_count || 0),
    videoCount: Number(row.video_count || 0),
    textCount: Number(row.text_count || 0)
  };
}

function addEntry(db, { sessionId, entryType, messageText = null, lineMessageId = null, fileId = null, storagePath = null, publicUrl = null, mimeType = null }) {
  db.prepare(`
    INSERT INTO pre_inspection_entries (
      session_id, entry_type, message_text, line_message_id, file_id, storage_path, public_url, mime_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, entryType, messageText, lineMessageId, fileId, storagePath, publicUrl, mimeType);

  db.prepare(`
    UPDATE pre_inspection_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(sessionId);
}

function sealSession(db, sessionId) {
  const sealedAt = new Date().toISOString();
  db.prepare(`
    UPDATE pre_inspection_sessions
    SET status = 'sealed', sealed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(sealedAt, sessionId);
}

function listSealedSessions(db, lineUserId) {
  return db.prepare(`
    SELECT * FROM pre_inspection_sessions
    WHERE line_user_id = ? AND status = 'sealed' AND record_type = 'main'
    ORDER BY id DESC
  `).all(lineUserId);
}

function getSession(db, sessionId) {
  return db.prepare(`
    SELECT * FROM pre_inspection_sessions WHERE id = ?
  `).get(sessionId);
}

function getSessionByPublicId(db, publicId) {
  return db.prepare(queries.SESSION_BY_PUBLIC_ID).get(publicId);
}

function getSupplementSessions(db, parentSessionId) {
  return db.prepare(queries.SUPPLEMENT_SESSIONS).all(parentSessionId);
}

function getSessionEntries(db, sessionId, limit = 10) {
  return db.prepare(queries.SESSION_ENTRIES).all(sessionId, limit);
}

function getSessionWithStats(db, sessionId) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const stats = getSessionStats(db, sessionId);
  return { ...session, stats };
}

function getSessionContext(db, sessionId) {
  const row = db.prepare(`
    SELECT
      ls.normalized_address as address_text,
      up.display_name as landlord_name
    FROM pre_inspection_sessions pis
    LEFT JOIN listings l ON l.id = pis.listing_id
    LEFT JOIN listing_snapshots ls ON ls.id = l.latest_valid_snapshot_id
    LEFT JOIN rental_units ru ON ru.id = l.rental_unit_id
    LEFT JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
    LEFT JOIN user_profiles up ON up.user_id = po.owner_user_id
    WHERE pis.id = ?
    LIMIT 1
  `).get(sessionId);
  return {
    addressText: row?.address_text || '未提供地址',
    landlordName: row?.landlord_name || '系統房東'
  };
}

function updateConfirmationStatus(db, sessionId, status, payload = {}) {
  const updates = ['confirmation_status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [status];

  if (payload.submittedToLandlordAt) {
    updates.push('submitted_to_landlord_at = ?');
    params.push(payload.submittedToLandlordAt);
  }
  if (payload.landlordConfirmedAt) {
    updates.push('landlord_confirmed_at = ?');
    params.push(payload.landlordConfirmedAt);
  }

  params.push(sessionId);
  db.prepare(`
    UPDATE pre_inspection_sessions
    SET ${updates.join(', ')}
    WHERE id = ?
  `).run(...params);
}

function getLandlordLineUserId(db, sessionId) {
  const row = db.prepare(`
    SELECT li.line_user_id
    FROM pre_inspection_sessions pis
    JOIN listings l ON l.id = pis.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE pis.id = ?
    ORDER BY li.id DESC
    LIMIT 1
  `).get(sessionId);
  return row ? row.line_user_id : null;
}

module.exports = {
  getActiveListingContextByLineUser,
  getActiveSession,
  createSession,
  sealSession,
  addEntry,
  listSealedSessions,
  getSession,
  getSessionByPublicId,
  getSupplementSessions,
  getSessionEntries,
  getSessionStats,
  getSessionWithStats,
  getSessionContext,
  updateConfirmationStatus,
  getLandlordLineUserId
};
