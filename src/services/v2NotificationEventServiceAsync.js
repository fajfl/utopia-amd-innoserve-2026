const crypto = require('node:crypto');

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

async function ensureNotification(db, input) {
  const publicId = input.publicId || `notif-${input.eventType}-${stableHash(`${input.entityType}:${input.entityId}:${input.eventKey || ''}`)}`;
  await db.run(`${db.dialect.insertIgnore} INTO notifications (
    public_id, event_type, entity_type, entity_id, template_code, payload_json
  ) VALUES (?, ?, ?, ?, ?, ?)`, [publicId, input.eventType, input.entityType,
    String(input.entityId), input.templateCode || null, JSON.stringify(input.payload || {})]);
  return db.get('SELECT * FROM notifications WHERE public_id = ?', [publicId]);
}

async function ensureDelivery(db, input) {
  const idempotencyKey = input.idempotencyKey || `${input.notificationPublicId}:${input.recipientUserId || 'no-user'}:${input.recipientLineIdentityId || 'no-line'}:${input.channel || 'line'}`;
  const publicId = input.publicId || `delivery-${stableHash(idempotencyKey)}`;
  await db.run(`${db.dialect.insertIgnore} INTO notification_deliveries (
    public_id, notification_id, recipient_user_id, recipient_line_identity_id,
    channel, idempotency_key, status, scheduled_at, sent_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [publicId, input.notificationId,
    input.recipientUserId || null, input.recipientLineIdentityId || null,
    input.channel || 'line', idempotencyKey, input.status || 'pending',
    input.scheduledAt || null, input.sentAt || null]);
  return db.get('SELECT * FROM notification_deliveries WHERE public_id = ?', [publicId]);
}

async function attempt(db, deliveryId, status, extra = {}) {
  const row = await db.get('SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM notification_delivery_attempts WHERE notification_delivery_id = ?', [deliveryId]);
  await db.run(`INSERT INTO notification_delivery_attempts (
    notification_delivery_id, attempt_number, status, provider_response_json, error_summary
  ) VALUES (?, ?, ?, ?, ?)`, [deliveryId, row.next, status,
    extra.providerResponse ? JSON.stringify(extra.providerResponse) : null, extra.errorSummary || null]);
}

async function recordNotificationDelivery(input) {
  const { db } = input;
  const notification = await ensureNotification(db, input.notification);
  const delivery = await ensureDelivery(db, {
    notificationId: notification.id, notificationPublicId: notification.public_id,
    recipientUserId: input.recipient?.userId, recipientLineIdentityId: input.recipient?.lineIdentityId,
    channel: input.channel || 'line', idempotencyKey: input.idempotencyKey, status: input.initialStatus || 'pending'
  });
  if (['sent', 'sending'].includes(delivery.status)) return { notification, delivery, pushed: false, skipped: delivery.status };
  const lineUserId = input.recipient?.lineUserId;
  if (!input.lineClient || !input.message || !lineUserId || String(lineUserId).includes('DEMO')) return { notification, delivery, pushed: false };
  try {
    await attempt(db, delivery.id, 'started');
    await db.run("UPDATE notification_deliveries SET status = 'sending' WHERE id = ?", [delivery.id]);
    await input.lineClient.pushMessage(lineUserId, input.message);
    await db.run(`UPDATE notification_deliveries SET status = 'sent', sent_at = ${db.dialect.utcNow()} WHERE id = ?`, [delivery.id]);
    await attempt(db, delivery.id, 'succeeded', { providerResponse: { provider: 'line' } });
    return { notification, delivery, pushed: true };
  } catch (error) {
    await db.run("UPDATE notification_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
    await attempt(db, delivery.id, 'failed', { errorSummary: error.message });
    throw error;
  }
}

module.exports = { ensureNotification, ensureDelivery, recordNotificationDelivery };
