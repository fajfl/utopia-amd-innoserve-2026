const crypto = require('node:crypto');
const { localStamp, normalizeStamp } = require('../services/showingSlotTime');

// 看房時間是 Asia/Taipei 的牆上時間。當天 09:00 提醒；若看房在 11:00 前，
// 則改成看房前兩小時，避免提醒落在看房之後。跨日的極早時段最多提早到當日 00:00。
function reminderStampForShowing(startsAt) {
  const normalized = normalizeStamp(startsAt);
  if (!normalized) return null;
  const datePart = normalized.slice(0, 10);
  const [date, time] = normalized.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const twoHoursBefore = new Date(Date.UTC(year, month - 1, day, hour, minute - 120));
  const twoHoursStamp = [
    twoHoursBefore.getUTCFullYear(),
    String(twoHoursBefore.getUTCMonth() + 1).padStart(2, '0'),
    String(twoHoursBefore.getUTCDate()).padStart(2, '0')
  ].join('-') + `T${String(twoHoursBefore.getUTCHours()).padStart(2, '0')}:${String(twoHoursBefore.getUTCMinutes()).padStart(2, '0')}`;
  const nineAm = `${datePart}T09:00`;
  if (twoHoursStamp.slice(0, 10) !== datePart) return `${datePart}T00:00`;
  return twoHoursStamp < nineAm ? twoHoursStamp : nineAm;
}

// 取得即將到期的事件（看房、租金、租約）
async function getDueEvents(db, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const nowWallStamp = localStamp(nowDate);

  // 1. Showing appointments
  const showings = await db.all(`
    SELECT
      CONCAT('showing_day_of_', sa.id) AS idempotency_key,
      sa.id AS entity_id,
      sa.public_id AS appointment_public_id,
      'showing_appointments' AS entity_type,
      'showing' AS event_type,
      l.title AS title,
      '今天要看房，記得開啟屋況點交，拍照並留下重要備註。' AS description,
      sa.starts_at AS starts_at,
      li.id AS recipient_line_identity_id,
      li.line_user_id AS recipient_line_user_id
    FROM showing_appointments sa
    JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) rn FROM line_identities
    ) li ON li.user_id = sa.tenant_user_id AND li.rn = 1
    JOIN listings l ON l.id = sa.listing_id
    WHERE sa.status = 'confirmed'
  `);

  // 2. Rent due
  const rents = await db.all(`
    SELECT
      CONCAT('rent_', bc.id) AS idempotency_key,
      bc.id AS entity_id,
      'billing_charges' AS entity_type,
      'rent_due' AS event_type,
      CONCAT(l.title, ' 租金繳交') AS title,
      CONCAT('本期租金：', bc.amount, ' 元') AS description,
      CONCAT(bc.due_date, 'T00:00:00.000Z') AS starts_at,
      li.id AS recipient_line_identity_id,
      li.line_user_id AS recipient_line_user_id
    FROM billing_charges bc
    JOIN leases le ON le.id = bc.lease_id
    JOIN contracts c ON c.id = le.contract_id
    JOIN inquiries i ON i.id = c.source_inquiry_id
    JOIN lease_parties lp ON lp.lease_id = le.id AND lp.party_role = 'tenant'
    JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) rn FROM line_identities
    ) li ON li.user_id = lp.user_id AND li.rn = 1
    JOIN listings l ON l.id = i.listing_id
    WHERE bc.charge_type = 'rent' AND bc.status IN ('pending', 'overdue')
  `);

  // 3. Lease start & end
  const leases = await db.all(`
    SELECT
      CONCAT('lease_start_', le.id) AS idempotency_key,
      le.id AS entity_id,
      'leases' AS entity_type,
      'lease_start' AS event_type,
      CONCAT(l.title, ' 租約開始') AS title,
      '您的租約即將開始' AS description,
      CONCAT(le.start_date, 'T00:00:00.000Z') AS starts_at,
      li.id AS recipient_line_identity_id,
      li.line_user_id AS recipient_line_user_id
    FROM leases le
    JOIN contracts c ON c.id = le.contract_id
    JOIN inquiries i ON i.id = c.source_inquiry_id
    JOIN lease_parties lp ON lp.lease_id = le.id AND lp.party_role = 'tenant'
    JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) rn FROM line_identities
    ) li ON li.user_id = lp.user_id AND li.rn = 1
    JOIN listings l ON l.id = i.listing_id
    WHERE le.status IN ('signed', 'active')
    
    UNION ALL
    
    SELECT
      CONCAT('lease_end_', le.id) AS idempotency_key,
      le.id AS entity_id,
      'leases' AS entity_type,
      'lease_end' AS event_type,
      CONCAT(l.title, ' 租約結束') AS title,
      '您的租約即將到期' AS description,
      CONCAT(le.end_date, 'T00:00:00.000Z') AS starts_at,
      li.id AS recipient_line_identity_id,
      li.line_user_id AS recipient_line_user_id
    FROM leases le
    JOIN contracts c ON c.id = le.contract_id
    JOIN inquiries i ON i.id = c.source_inquiry_id
    JOIN lease_parties lp ON lp.lease_id = le.id AND lp.party_role = 'tenant'
    JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) rn FROM line_identities
    ) li ON li.user_id = lp.user_id AND li.rn = 1
    JOIN listings l ON l.id = i.listing_id
    WHERE le.status = 'active'
  `);

  const showingEvents = showings
    .map((event) => {
      const reminderAt = reminderStampForShowing(event.starts_at);
      return reminderAt ? {
        ...event,
        remind_at: reminderAt,
        idempotency_key: `${event.idempotency_key}_${reminderAt.slice(0, 10)}`
      } : null;
    })
    .filter(Boolean);
  const calendarEvents = await db.all(`
    SELECT
      CONCAT('calevent_', ce.id) AS idempotency_key,
      ce.id AS entity_id,
      'calendar_events' AS entity_type,
      ce.event_type AS event_type,
      ce.title AS title,
      '' AS description,
      ce.starts_at AS starts_at,
      li.id AS recipient_line_identity_id,
      li.line_user_id AS recipient_line_user_id
    FROM calendar_events ce
    JOIN contracts c ON c.id = ce.contract_id
    JOIN contract_parties cp ON cp.contract_id = c.id AND cp.party_role = 'tenant'
    JOIN (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) rn FROM line_identities
    ) li ON li.user_id = cp.user_id AND li.rn = 1
    WHERE ce.status = 'pending'
  `);

  const allEvents = [...showingEvents, ...rents, ...leases, ...calendarEvents];
  
  // Return early if nothing
  if (allEvents.length === 0) return [];
  
  // Filter and deduplicate
  const filtered = [];
  for (const event of allEvents) {
    if (event.remind_at) {
      if (event.remind_at > nowWallStamp) continue;
    } else {
    const eventTime = parseEventTime(event.starts_at);
    if (!eventTime || eventTime.getTime() > nowMs) continue; // Not due yet
    }
    
    // Check if already delivered
    const hasLog = await hasDeliveryLog(db, event.idempotency_key);
    if (!hasLog) {
      filtered.push(event);
    }
  }
  return filtered;
}

function parseEventTime(timeStr) {
  if (!timeStr) return null;
  const d = new Date(timeStr);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function hasDeliveryLog(db, idempotencyKey) {
  const row = await db.get(`
    SELECT id FROM notification_deliveries 
    WHERE idempotency_key = ? AND status IN ('sent', 'failed')
    LIMIT 1
  `, [idempotencyKey]);
  return Boolean(row);
}

async function insertNotificationLog(db, { idempotencyKey, recipientLineIdentityId, recipientUserId, eventType, entityType, entityId, payloadJson, status, errorMessage }) {
  const notificationPublicId = crypto.randomUUID();
  const deliveryPublicId = crypto.randomUUID();

  // Create notification
  const nResult = await db.run(`
    INSERT INTO notifications (public_id, event_type, entity_type, entity_id, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `, [notificationPublicId, eventType, entityType, entityId, JSON.stringify(payloadJson || {})]);

  const notificationId = nResult.insertId;

  // Create delivery
  await db.run(`
    INSERT INTO notification_deliveries (
      public_id, notification_id, recipient_user_id, recipient_line_identity_id,
      channel, idempotency_key, status, sent_at
    ) VALUES (?, ?, ?, ?, 'line', ?, ?, ?)
  `, [
    deliveryPublicId, notificationId, recipientUserId || null, recipientLineIdentityId || null,
    idempotencyKey, status, status === 'sent' ? new Date().toISOString() : null
  ]);
}

module.exports = {
  getDueEvents,
  insertNotificationLog,
  hasDeliveryLog,
  reminderStampForShowing
};
