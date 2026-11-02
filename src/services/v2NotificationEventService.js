const crypto = require('node:crypto');

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function json(value) {
  return JSON.stringify(value || {});
}

function ensureNotification(db, input) {
  const publicId = input.publicId || `notif-${input.eventType}-${stableHash(`${input.entityType}:${input.entityId}:${input.eventKey || ''}`)}`;
  db.prepare(`
    INSERT OR IGNORE INTO notifications (
      public_id, event_type, entity_type, entity_id, template_code, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    publicId,
    input.eventType,
    input.entityType,
    String(input.entityId),
    input.templateCode || null,
    json(input.payload),
  );
  return db.prepare('SELECT * FROM notifications WHERE public_id = ?').get(publicId);
}

function ensureDelivery(db, input) {
  const idempotencyKey = input.idempotencyKey ||
    `${input.notificationPublicId}:${input.recipientUserId || 'no-user'}:${input.recipientLineIdentityId || 'no-line'}:${input.channel || 'line'}`;
  const publicId = input.publicId || `delivery-${stableHash(idempotencyKey)}`;
  db.prepare(`
    INSERT OR IGNORE INTO notification_deliveries (
      public_id, notification_id, recipient_user_id, recipient_line_identity_id,
      channel, idempotency_key, status, scheduled_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publicId,
    input.notificationId,
    input.recipientUserId || null,
    input.recipientLineIdentityId || null,
    input.channel || 'line',
    idempotencyKey,
    input.status || 'pending',
    input.scheduledAt || null,
    input.sentAt || null,
  );
  return db.prepare('SELECT * FROM notification_deliveries WHERE public_id = ?').get(publicId);
}

function recordAttempt(db, deliveryId, status, extra = {}) {
  const attemptNumber = db.prepare(`
    SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
    FROM notification_delivery_attempts
    WHERE notification_delivery_id = ?
  `).get(deliveryId).next;
  db.prepare(`
    INSERT INTO notification_delivery_attempts (
      notification_delivery_id, attempt_number, status, provider_response_json, error_summary
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    deliveryId,
    attemptNumber,
    status,
    extra.providerResponse ? json(extra.providerResponse) : null,
    extra.errorSummary || null,
  );
}

async function recordNotificationDelivery(input) {
  const notification = ensureNotification(input.db, input.notification);
  const delivery = ensureDelivery(input.db, {
    notificationId: notification.id,
    notificationPublicId: notification.public_id,
    recipientUserId: input.recipient && input.recipient.userId,
    recipientLineIdentityId: input.recipient && input.recipient.lineIdentityId,
    channel: input.channel || 'line',
    idempotencyKey: input.idempotencyKey,
    status: input.initialStatus || 'pending',
  });

  // A notification event is idempotent.  Routes can be retried by LINE, a
  // browser refresh, or an async workflow without sending the same push again.
  // In particular, do not overwrite a successful delivery with a later 429
  // rate-limit failure.
  if (delivery.status === 'sent') {
    return { notification, delivery, pushed: false, skipped: 'already_sent' };
  }
  if (delivery.status === 'sending') {
    return { notification, delivery, pushed: false, skipped: 'already_sending' };
  }

  const lineUserId = input.recipient && input.recipient.lineUserId;
  if (!input.lineClient || !input.message || !lineUserId || String(lineUserId).includes('DEMO')) {
    return { notification, delivery, pushed: false };
  }

  try {
    recordAttempt(input.db, delivery.id, 'started');
    input.db.prepare("UPDATE notification_deliveries SET status = 'sending' WHERE id = ?").run(delivery.id);
    await input.lineClient.pushMessage(lineUserId, input.message);
    input.db.prepare("UPDATE notification_deliveries SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(delivery.id);
    recordAttempt(input.db, delivery.id, 'succeeded', { providerResponse: { provider: 'line' } });
    return { notification, delivery, pushed: true };
  } catch (error) {
    input.db.prepare("UPDATE notification_deliveries SET status = 'failed' WHERE id = ?").run(delivery.id);
    recordAttempt(input.db, delivery.id, 'failed', { errorSummary: error.message });
    throw error;
  }
}

module.exports = {
  ensureNotification,
  ensureDelivery,
  recordNotificationDelivery,
};
