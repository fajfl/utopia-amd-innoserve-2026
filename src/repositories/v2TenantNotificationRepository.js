/**
 * Repository for querying Tenant Notifications and Rental Status
 *
 * driver 版本：`db` 收的是 sqlDriver 的 driver，不是 better-sqlite3 的原始連線。
 * 唯一的呼叫端是 tenantNotificationService，所以直接改，不留同步版。
 */

async function getTenantSigningStatus(db, tenantUserId) {
  const result = await db.get(`
    SELECT c.status
    FROM contracts c
    JOIN contract_parties cp ON cp.contract_id = c.id
    WHERE cp.user_id = ? AND cp.party_role = 'tenant' AND c.status = 'executed'
    LIMIT 1
  `, [tenantUserId]);
  return Boolean(result);
}

function getLandlordAnswers(db, tenantUserId) {
  return db.all(`
    SELECT lq.id, lq.question_text, la.answer_text, la.answered_at, l.title AS unit_title
    FROM landlord_questions lq
    JOIN landlord_answers la ON la.landlord_question_id = lq.id
    JOIN inquiries i ON i.id = lq.inquiry_id
    JOIN listings l ON l.id = lq.listing_id
    WHERE i.user_id = ?
    UNION ALL
    SELECT m.id, '房東傳來訊息' as question_text, m.text_content as answer_text, m.sent_at as answered_at, l.title AS unit_title
    FROM messages m
    JOIN inquiries i ON i.id = m.inquiry_id
    JOIN listings l ON l.id = i.listing_id
    WHERE i.user_id = ? AND m.direction = 'outbound' AND m.message_type = 'text'
    ORDER BY answered_at DESC
    LIMIT 5
  `, [tenantUserId, tenantUserId]);
}

// 原本是 `ce.starts_at > datetime('now')`。TiDB 沒有 datetime() 這個純量函式，
// 時間直接由呼叫端算好傳進來比較。starts_at 存的是 ISO-8601 字串，字典序等於
// 時序，所以純字串比較就是正確的時間比較。
function getUpcomingShowings(db, tenantUserId, now = new Date().toISOString()) {
  return db.all(`
    SELECT ce.id, ce.title, ce.starts_at, ce.status
    FROM calendar_events ce
    JOIN inquiries i ON i.id = ce.inquiry_id
    WHERE i.user_id = ? AND ce.event_type = 'showing' AND ce.status = 'scheduled'
      AND ce.starts_at > ?
    ORDER BY ce.starts_at ASC
  `, [tenantUserId, now]);
}

function getCurrentMonthRentCharge(db, tenantUserId, currentMonthString) {
  // currentMonthString should be like '2026-07'
  return db.get(`
    SELECT bc.id, bc.amount, bc.due_date, bc.status, bc.billing_period_start
    FROM billing_charges bc
    JOIN leases le ON le.id = bc.lease_id
    JOIN lease_parties lp ON lp.lease_id = le.id
    WHERE lp.user_id = ? AND lp.party_role = 'tenant'
      AND bc.charge_type = 'rent'
      AND substr(bc.billing_period_start, 1, 7) = ?
    ORDER BY bc.due_date DESC
    LIMIT 1
  `, [tenantUserId, currentMonthString]);
}

function getActiveLease(db, tenantUserId) {
  return db.get(`
    SELECT le.id, le.end_date, le.status
    FROM leases le
    JOIN lease_parties lp ON lp.lease_id = le.id
    WHERE lp.user_id = ? AND lp.party_role = 'tenant' AND le.status = 'active'
    LIMIT 1
  `, [tenantUserId]);
}

function getLatestTenantRepairTicket(db, tenantUserId) {
  const query = `
    SELECT
      rt.public_id,
      rt.category,
      rt.description,
      rt.priority,
      rt.status,
      rt.reported_at,
      rt.updated_at,
      ru.unit_label,
      (
        SELECT COUNT(*)
        FROM repair_updates ru2
        JOIN file_links fl2
          ON fl2.entity_type = 'repair_update'
         AND fl2.entity_id = ru2.id
         AND fl2.purpose = 'damage_photo'
        JOIN files f ON f.id = fl2.file_id
        WHERE ru2.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS damage_photo_count,
      (
        SELECT COUNT(*)
        FROM repair_updates ru3
        JOIN file_links fl3
          ON fl3.entity_type = 'repair_update'
         AND fl3.entity_id = ru3.id
         AND fl3.purpose = 'completion_photo'
        JOIN files f ON f.id = fl3.file_id
        WHERE ru3.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS completion_photo_count
    FROM repair_tickets rt
    JOIN leases le ON le.id = rt.lease_id
    JOIN lease_parties lp ON lp.lease_id = le.id AND lp.party_role = 'tenant'
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    WHERE lp.user_id = ?
      AND rt.status NOT IN ('tenant_confirmed', 'cancelled', 'rejected')
    ORDER BY rt.updated_at DESC, rt.reported_at DESC
    LIMIT 1
  `;
  return db.get(query, [tenantUserId]);
}

function getNotificationHistory(db, lineIdentityId, tenantUserId, limit = 5) {
  return db.all(`
    SELECT n.id, n.event_type, n.payload_json, n.created_at, nd.channel, nd.status
    FROM notifications n
    JOIN notification_deliveries nd ON nd.notification_id = n.id
    WHERE nd.recipient_line_identity_id = ? OR nd.recipient_user_id = ?
    ORDER BY n.created_at DESC
    LIMIT ?
  `, [lineIdentityId, tenantUserId, limit]);
}

module.exports = {
  getTenantSigningStatus,
  getLandlordAnswers,
  getUpcomingShowings,
  getCurrentMonthRentCharge,
  getActiveLease,
  getLatestTenantRepairTicket,
  getNotificationHistory
};
