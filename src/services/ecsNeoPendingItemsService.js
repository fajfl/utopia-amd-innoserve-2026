const crypto = require('node:crypto');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_model_output', statusCode: 400 });
}

function normalizePendingItems(value = []) {
  if (!Array.isArray(value) || value.length > 20) throw invalid('pending_items 最多 20 項');
  return value.map((item) => {
    if (!item || !['add', 'resolve'].includes(item.operation) ||
        Object.keys(item).some((key) => !['operation', 'source_id', 'item_id', 'resolution', 'quote', 'field_path'].includes(key))) {
      throw invalid('pending_items 格式錯誤');
    }
    if (!['string', 'number'].includes(typeof item.source_id) || !/^[1-9][0-9]{0,19}$/.test(String(item.source_id))) throw invalid('pending_items 缺少合法訊息來源');
    if (item.quote !== undefined && (typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 1000)) throw invalid('待確認原話須為 1 至 1000 字');
    if (item.field_path !== undefined && !require('./ecsNeoAgentToolsServiceAsync').CANDIDATE_FIELD_PATHS.includes(item.field_path)) throw invalid('待確認事項的條件欄位無效');
    if (item.operation === 'resolve' && (typeof item.item_id !== 'string' || !/^pending-[0-9a-f-]{36}$/.test(item.item_id) ||
        !['included', 'withdrawn'].includes(item.resolution))) throw invalid('pending_items 缺少結案依據');
    return { ...item, source_id: String(item.source_id) };
  });
}

async function listPendingItems(db, inquiryId) {
  return db.all(`SELECT public_id AS itemId, source_message_id AS sourceId, original_text AS originalText, source_field AS sourceField
    FROM inquiry_pending_items WHERE inquiry_id=? AND status='pending' ORDER BY id`, [inquiryId]);
}

async function applyPendingItems(db, { inquiryId, tenantUserId, updates = [], conversationWindow = [], versionId = null }) {
  const normalized = normalizePendingItems(updates);
  if (!normalized.length) return;
  const visible = new Set(conversationWindow.filter((item) => item.role === 'tenant').map((item) => String(item.sourceId)));
  return db.transaction(async (tx) => {
    for (const item of normalized) {
      if (!visible.has(item.source_id)) throw invalid('待確認事項來源不在本輪房客對話中');
      const message = await tx.get(`SELECT id,text_content FROM messages
        WHERE id=? AND inquiry_id=? AND sender_user_id=? AND direction='inbound'`, [item.source_id, inquiryId, tenantUserId]);
      if (!message?.text_content) throw invalid('待確認事項來源不屬於這位房客');
      if (item.operation === 'add') {
        const quote = item.quote ?? message.text_content;
        if (!message.text_content.includes(quote)) throw invalid('待確認事項必須逐字引用房客原話');
        const sourceField = clauseField(item.field_path || 'special_request_text');
        const hash = crypto.createHash('sha256').update(quote).digest('hex');
        const existing = await tx.get('SELECT id FROM inquiry_pending_items WHERE inquiry_id=? AND source_message_id=? AND source_field=? AND original_hash=?', [inquiryId, message.id, sourceField, hash]);
        if (!existing) await tx.run(`INSERT INTO inquiry_pending_items
          (public_id,inquiry_id,source_message_id,original_text,source_field,original_hash,status) VALUES (?,?,?,?,?,?,'pending')`,
        [`pending-${crypto.randomUUID()}`, inquiryId, message.id, quote, sourceField, hash]);
      } else {
        const pending = await tx.get(`SELECT * FROM inquiry_pending_items WHERE public_id=? AND inquiry_id=? AND status='pending'`, [item.item_id, inquiryId]);
        if (!pending) throw invalid('待確認事項不屬於這筆詢問或已結案');
        if (item.resolution === 'included') {
          const source = versionId && await tx.get(`SELECT iv.special_request_text FROM intention_version_sources s
            JOIN intention_versions iv ON iv.id=s.intention_version_id
            JOIN rental_intentions ri ON ri.id=iv.rental_intention_id
            WHERE iv.id=? AND ri.confirmed_intention_version_id=iv.id AND ri.inquiry_id=? AND s.source_type='message'
              AND s.field_path=? AND s.source_id=? LIMIT 1`,
          [versionId, inquiryId, pending.source_field, pending.source_message_id]);
          if (!source || !includesQuote(pending, source)) throw invalid('事項尚未納入條件版本，不能結案');
        }
        await tx.run(`UPDATE inquiry_pending_items SET status=?,resolution_message_id=?,resolved_version_id=?,resolved_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='pending'`, [item.resolution, item.resolution === 'withdrawn' ? message.id : null,
          item.resolution === 'included' ? versionId : null, pending.id]);
      }
    }
  });
}

async function completePendingItemsForVersion(db, { inquiryId, versionId }) {
  const items = await db.all(`SELECT p.*,iv.special_request_text FROM inquiry_pending_items p
    JOIN intention_version_sources s ON s.source_type='message' AND s.source_id=p.source_message_id AND s.field_path=p.source_field
    JOIN intention_versions iv ON iv.id=s.intention_version_id
    WHERE p.inquiry_id=? AND p.status='pending' AND iv.id=?`, [inquiryId, versionId]);
  for (const item of items) {
    if (includesQuote(item, item)) await db.run(`UPDATE inquiry_pending_items SET status='included',resolved_version_id=?,resolved_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='pending'`, [versionId, item.id]);
  }
}

function clauseField(path) {
  if (['special_request_text', 'equipment_request_text', 'viewing_request_text'].includes(path)) return 'specialRequest';
  return path.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function includesQuote(item, version) {
  // 同一句話同時談租金與車位時，確認租金不能把車位一起清掉。
  return item.source_field !== 'specialRequest' || String(version.special_request_text || '').includes(item.original_text);
}

module.exports = { normalizePendingItems, listPendingItems, applyPendingItems, completePendingItemsForVersion };
