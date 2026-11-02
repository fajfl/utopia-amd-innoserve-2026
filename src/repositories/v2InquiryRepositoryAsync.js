// 找房入口 repository 的 driver 版本:同一份實作,底下可掛 better-sqlite3 或 mysql2。
//
// 參數 `db` 收的是 sqlDriver 的 driver,不是原始的 better-sqlite3 連線。
// 傳錯的話第一次 await db.get(...) 就會炸,不會靜默出錯。
//
// 這支是共用地基:591 案件碼入口、房東知識庫、webhook 的身分建立三邊都會用到
// findOrCreateLineUser。同步版 (v2InquiryRepository.js) 仍有 7 個 consumer,
// 不能刪,兩份要靠等價性測試綁在一起。
//
// 交易中一律使用回呼給的 tx。用交易外的 driver 查詢,在 mysql2 會落到別的
// session,讀到交易外的狀態。

const crypto = require('node:crypto');
const { idEquals } = require('../database/idEquals');

function hashId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function addMinutes(value, minutes) {
  return new Date(new Date(value).getTime() + minutes * 60 * 1000).toISOString();
}

async function findOrCreateLineUserCore(db, identity) {
  if (!identity || !identity.lineUserId) throw new Error('lineUserId is required');
  const existing = await db.get(
    'SELECT id, user_id FROM line_identities WHERE line_user_id = ?',
    [identity.lineUserId]
  );
  if (existing) {
    if (identity.displayName) {
      await db.run(`
        UPDATE line_identities
        SET display_name_cache = ?, profile_synced_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [identity.displayName, existing.id]);
    }
    return { userId: existing.user_id, lineIdentityId: existing.id, created: false };
  }

  const suffix = hashId(identity.lineUserId);
  await db.run(
    "INSERT INTO users (public_id, status) VALUES (?, 'active')",
    [`line-user-${suffix}`]
  );
  // 刻意用 public_id 回查而不是拿 insertId:TiDB 的 AUTO_INCREMENT 是分段配發的,
  // 而 public_id 由 lineUserId 決定,兩個 driver 查到的是同一列。
  const userId = (await db.get('SELECT id FROM users WHERE public_id = ?', [`line-user-${suffix}`])).id;
  await db.run(`
    INSERT INTO line_identities (
      public_id, user_id, line_user_id, display_name_cache, profile_synced_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [`line-identity-${suffix}`, userId, identity.lineUserId, identity.displayName || null]);
  const lineIdentityId = (await db.get(
    'SELECT id FROM line_identities WHERE line_user_id = ?',
    [identity.lineUserId]
  )).id;
  return { userId, lineIdentityId, created: true };
}

function findOrCreateLineUser(db, identity) {
  return db.transaction((tx) => findOrCreateLineUserCore(tx, identity));
}

async function activateCore(db, input) {
  const occurredAt = input.occurredAt || new Date().toISOString();
  const identity = await db.get('SELECT user_id FROM line_identities WHERE id = ?', [input.lineIdentityId]);
  if (!identity) throw new Error('LINE identity not found');
  const listing = await db.get('SELECT id FROM listings WHERE id = ?', [input.listingId]);
  if (!listing) throw new Error('listing not found');

  let inquiry = await db.get(`
    SELECT id FROM inquiries
    WHERE user_id = ? AND listing_id = ? AND ended_at IS NULL
  `, [identity.user_id, input.listingId]);
  const created = !inquiry;
  if (!inquiry) {
    const inquiryPublicId = `inquiry-${crypto.randomUUID()}`;
    await db.run(`
      INSERT INTO inquiries (
        public_id, user_id, listing_id, status, started_at,
        last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'inquiring', ?, ?, ?, ?)
    `, [
      inquiryPublicId,
      identity.user_id,
      input.listingId,
      occurredAt,
      occurredAt,
      occurredAt,
      occurredAt
    ]);
    inquiry = await db.get('SELECT id FROM inquiries WHERE public_id = ?', [inquiryPublicId]);
    await db.run(`
      INSERT INTO inquiry_activity_sessions (
        public_id, inquiry_id, listing_id, started_at,
        last_activity_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      `inquiry-session-${crypto.randomUUID()}`,
      inquiry.id,
      input.listingId,
      occurredAt,
      occurredAt,
      addMinutes(occurredAt, 30)
    ]);
    await db.run(`
      INSERT INTO listing_demand_events (
        public_id, listing_id, inquiry_id, event_type, occurred_at, created_at
      ) VALUES (?, ?, ?, 'inquiry_active', ?, ?)
    `, [`demand-${crypto.randomUUID()}`, input.listingId, inquiry.id, occurredAt, occurredAt]);
  } else {
    await db.run(
      'UPDATE inquiries SET last_activity_at = ?, updated_at = ? WHERE id = ?',
      [occurredAt, occurredAt, inquiry.id]
    );
    const activeSession = await db.get(`
      SELECT id FROM inquiry_activity_sessions
      WHERE inquiry_id = ? AND ended_at IS NULL
      ORDER BY id DESC LIMIT 1
    `, [inquiry.id]);
    if (activeSession) {
      await db.run(`
        UPDATE inquiry_activity_sessions
        SET last_activity_at = ?, expires_at = ? WHERE id = ?
      `, [occurredAt, addMinutes(occurredAt, 30), activeSession.id]);
    }
  }

  const activeContext = await db.get(`
    SELECT id, inquiry_id FROM active_inquiry_contexts
    WHERE line_identity_id = ? AND cleared_at IS NULL
  `, [input.lineIdentityId]);
  if (activeContext && !idEquals(activeContext.inquiry_id, inquiry.id)) {
    await db.run(`
      UPDATE active_inquiry_contexts
      SET cleared_at = ?, clear_reason = 'listing_switched'
      WHERE id = ?
    `, [occurredAt, activeContext.id]);
  }
  if (!activeContext || !idEquals(activeContext.inquiry_id, inquiry.id)) {
    await db.run(`
      INSERT INTO active_inquiry_contexts (
        public_id, line_identity_id, inquiry_id, activated_at
      ) VALUES (?, ?, ?, ?)
    `, [`inquiry-context-${crypto.randomUUID()}`, input.lineIdentityId, inquiry.id, occurredAt]);
  }

  let entryEventCreated = false;
  if (input.providerEventId) {
    const prior = await db.get(`
      SELECT id FROM listing_entry_events
      WHERE source_platform = 'line' AND provider_event_id = ?
    `, [input.providerEventId]);
    if (!prior) {
      await db.run(`
        INSERT INTO listing_entry_events (
          public_id, listing_id, line_identity_id, provider_event_id,
          source_platform, result, occurred_at, detail_json
        ) VALUES (?, ?, ?, ?, 'line', ?, ?, ?)
      `, [
        `entry-event-${crypto.randomUUID()}`,
        input.listingId,
        input.lineIdentityId,
        input.providerEventId,
        created ? 'created' : 'restored',
        occurredAt,
        JSON.stringify({ inquiryId: inquiry.id })
      ]);
      entryEventCreated = true;
    }
  }

  return { inquiryId: inquiry.id, created, entryEventCreated };
}

function activateInquiryForListing(db, input) {
  return db.transaction((tx) => activateCore(tx, input));
}

// LINE 會重送 webhook,同一則訊息可能進來好幾次。provider + provider_message_id
// 先查過再寫,重送就回原本那一列的 id,不會在對話紀錄裡出現重複訊息。
async function saveInquiryMessageCore(db, input) {
  if (input.providerMessageId) {
    const provider = input.provider || 'line';
    const existing = await db.get(
      'SELECT id FROM messages WHERE provider = ? AND provider_message_id = ?',
      [provider, input.providerMessageId]
    );
    if (existing) return existing.id;
  }

  const publicId = `msg-${crypto.randomUUID()}`;
  const sentAt = input.sentAt || new Date().toISOString();
  await db.run(`
    INSERT INTO messages (
      public_id, inquiry_id, provider, provider_message_id,
      sender_user_id, sender_line_identity_id, direction,
      message_type, text_content, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    publicId, input.inquiryId, input.provider || 'line', input.providerMessageId || null,
    input.senderUserId || null, input.senderLineIdentityId || null,
    input.direction || 'inbound', input.messageType, input.textContent || null, sentAt
  ]);
  // 回查 public_id 而不是拿 insertId:TiDB 的 AUTO_INCREMENT 是分段配發的。
  return (await db.get('SELECT id FROM messages WHERE public_id = ?', [publicId])).id;
}

function saveInquiryMessage(db, input) {
  return db.transaction((tx) => saveInquiryMessageCore(tx, input));
}

module.exports = {
  activateCore,
  activateInquiryForListing,
  findOrCreateLineUser,
  findOrCreateLineUserCore,
  saveInquiryMessage,
  saveInquiryMessageCore
};
