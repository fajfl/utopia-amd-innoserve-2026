const crypto = require('node:crypto');

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function addMinutes(value, minutes) {
  return new Date(new Date(value).getTime() + minutes * 60 * 1000).toISOString();
}

function findOrCreateLineUserCore(db, identity) {
  if (!identity || !identity.lineUserId) throw new Error('lineUserId is required');
  const existing = db.prepare(`
    SELECT id, user_id FROM line_identities WHERE line_user_id = ?
  `).get(identity.lineUserId);
  if (existing) {
    if (identity.displayName) {
      db.prepare(`
        UPDATE line_identities
        SET display_name_cache = ?, profile_synced_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(identity.displayName, existing.id);
    }
    return { userId: existing.user_id, lineIdentityId: existing.id, created: false };
  }

  const suffix = hashId(identity.lineUserId);
  db.prepare(`
    INSERT INTO users (public_id, status) VALUES (?, 'active')
  `).run(`line-user-${suffix}`);
  const userId = db.prepare('SELECT id FROM users WHERE public_id = ?')
    .get(`line-user-${suffix}`).id;
  db.prepare(`
    INSERT INTO line_identities (
      public_id, user_id, line_user_id, display_name_cache, profile_synced_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(`line-identity-${suffix}`, userId, identity.lineUserId, identity.displayName || null);
  const lineIdentityId = db.prepare('SELECT id FROM line_identities WHERE line_user_id = ?')
    .get(identity.lineUserId).id;
  return { userId, lineIdentityId, created: true };
}

function findOrCreateLineUser(db, identity) {
  if (db.inTransaction) return findOrCreateLineUserCore(db, identity);
  return db.transaction(() => findOrCreateLineUserCore(db, identity)).immediate();
}

function activateCore(db, input) {
  const occurredAt = input.occurredAt || new Date().toISOString();
  const identity = db.prepare('SELECT user_id FROM line_identities WHERE id = ?')
    .get(input.lineIdentityId);
  if (!identity) throw new Error('LINE identity not found');
  const listing = db.prepare('SELECT id FROM listings WHERE id = ?').get(input.listingId);
  if (!listing) throw new Error('listing not found');

  let inquiry = db.prepare(`
    SELECT id FROM inquiries
    WHERE user_id = ? AND listing_id = ? AND ended_at IS NULL
  `).get(identity.user_id, input.listingId);
  const created = !inquiry;
  if (!inquiry) {
    const inquiryPublicId = `inquiry-${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO inquiries (
        public_id, user_id, listing_id, status, started_at,
        last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'inquiring', ?, ?, ?, ?)
    `).run(
      inquiryPublicId,
      identity.user_id,
      input.listingId,
      occurredAt,
      occurredAt,
      occurredAt,
      occurredAt
    );
    inquiry = db.prepare('SELECT id FROM inquiries WHERE public_id = ?').get(inquiryPublicId);
    db.prepare(`
      INSERT INTO inquiry_activity_sessions (
        public_id, inquiry_id, listing_id, started_at,
        last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `inquiry-session-${crypto.randomUUID()}`,
      inquiry.id,
      input.listingId,
      occurredAt,
      occurredAt,
      addMinutes(occurredAt, 30)
    );
    db.prepare(`
      INSERT INTO listing_demand_events (
        public_id, listing_id, inquiry_id, event_type, occurred_at, created_at
      ) VALUES (?, ?, ?, 'inquiry_active', ?, ?)
    `).run(`demand-${crypto.randomUUID()}`, input.listingId, inquiry.id, occurredAt, occurredAt);
  } else {
    db.prepare(`
      UPDATE inquiries SET last_activity_at = ?, updated_at = ? WHERE id = ?
    `).run(occurredAt, occurredAt, inquiry.id);
    const activeSession = db.prepare(`
      SELECT id FROM inquiry_activity_sessions
      WHERE inquiry_id = ? AND ended_at IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(inquiry.id);
    if (activeSession) {
      db.prepare(`
        UPDATE inquiry_activity_sessions
        SET last_activity_at = ?, expires_at = ? WHERE id = ?
      `).run(occurredAt, addMinutes(occurredAt, 30), activeSession.id);
    }
  }

  const activeContext = db.prepare(`
    SELECT id, inquiry_id FROM active_inquiry_contexts
    WHERE line_identity_id = ? AND cleared_at IS NULL
  `).get(input.lineIdentityId);
  if (activeContext && activeContext.inquiry_id !== inquiry.id) {
    db.prepare(`
      UPDATE active_inquiry_contexts
      SET cleared_at = ?, clear_reason = 'listing_switched'
      WHERE id = ?
    `).run(occurredAt, activeContext.id);
  }
  if (!activeContext || activeContext.inquiry_id !== inquiry.id) {
    db.prepare(`
      INSERT INTO active_inquiry_contexts (
        public_id, line_identity_id, inquiry_id, activated_at
      ) VALUES (?, ?, ?, ?)
    `).run(`inquiry-context-${crypto.randomUUID()}`, input.lineIdentityId, inquiry.id, occurredAt);
  }

  let entryEventCreated = false;
  if (input.providerEventId) {
    const prior = db.prepare(`
      SELECT id FROM listing_entry_events
      WHERE source_platform = 'line' AND provider_event_id = ?
    `).get(input.providerEventId);
    if (!prior) {
      db.prepare(`
        INSERT INTO listing_entry_events (
          public_id, listing_id, line_identity_id, provider_event_id,
          source_platform, result, occurred_at, detail_json
        ) VALUES (?, ?, ?, ?, 'line', ?, ?, ?)
      `).run(
        `entry-event-${crypto.randomUUID()}`,
        input.listingId,
        input.lineIdentityId,
        input.providerEventId,
        created ? 'created' : 'restored',
        occurredAt,
        JSON.stringify({ inquiryId: inquiry.id })
      );
      entryEventCreated = true;
    }
  }

  return { inquiryId: inquiry.id, created, entryEventCreated };
}

function activateInquiryForListing(db, input) {
  if (db.inTransaction) return activateCore(db, input);
  return db.transaction(() => activateCore(db, input)).immediate();
}

function saveInquiryMessageCore(db, input) {
  if (input.providerMessageId) {
    const provider = input.provider || 'line';
    const existing = db.prepare('SELECT id FROM messages WHERE provider = ? AND provider_message_id = ?').get(provider, input.providerMessageId);
    if (existing) return existing.id;
  }

  const publicId = `msg-${crypto.randomUUID()}`;
  const sentAt = input.sentAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (
      public_id, inquiry_id, provider, provider_message_id,
      sender_user_id, sender_line_identity_id, direction,
      message_type, text_content, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publicId, input.inquiryId, input.provider || 'line', input.providerMessageId || null,
    input.senderUserId || null, input.senderLineIdentityId || null,
    input.direction || 'inbound', input.messageType, input.textContent || null, sentAt
  );
  return db.prepare('SELECT id FROM messages WHERE public_id = ?').get(publicId).id;
}

function saveInquiryMessage(db, input) {
  if (db.inTransaction) return saveInquiryMessageCore(db, input);
  return db.transaction(() => saveInquiryMessageCore(db, input)).immediate();
}

module.exports = {
  activateInquiryForListing,
  findOrCreateLineUser,
  saveInquiryMessage
};
