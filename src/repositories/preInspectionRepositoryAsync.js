const crypto = require('node:crypto');
const { imageUrlIdentity, normalizeImageUrl } = require('../services/partner591Normalizer');
const queries = require('./preInspectionQueries');

async function getActiveListingContextByLineUser(db, lineUserId) {
  const dateExpr = db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";
  const row = await db.get(`
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
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    LEFT JOIN user_profiles up ON up.user_id = po.owner_user_id
    WHERE li.line_user_id = ? AND aic.cleared_at IS NULL
    ORDER BY aic.id DESC
    LIMIT 1
  `, [lineUserId]);

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

async function getActiveSession(db, lineUserId) {
  return db.get(`
    SELECT * FROM pre_inspection_sessions
    WHERE line_user_id = ? AND status = 'active'
    ORDER BY id DESC LIMIT 1
  `, [lineUserId]);
}

function formatDbTimestamp(db, dateVal = new Date()) {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  if (db.dialect && db.dialect.name === 'mysql') {
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    const seconds = String(d.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
  return d.toISOString();
}

async function createSession(db, {
  lineUserId,
  recordType = 'main',
  parentSessionId = null,
  showingAppointmentId = null,
  listingId = null,
  inquiryId = null,
  title = null
}) {
  const publicId = `pre-insp-${crypto.randomUUID()}`;
  const startedAt = formatDbTimestamp(db);
  await db.run(`
    INSERT INTO pre_inspection_sessions (
      public_id, listing_id, inquiry_id, showing_appointment_id, line_user_id,
      record_type, parent_session_id, status, title, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `, [publicId, listingId, inquiryId, showingAppointmentId, lineUserId, recordType, parentSessionId, title, startedAt]);

  return db.get('SELECT * FROM pre_inspection_sessions WHERE public_id = ?', [publicId]);
}

async function getConfirmedAppointmentForTenant(db, { appointmentPublicId, lineUserId }) {
  return db.get(`
    SELECT
      sa.id AS appointment_id,
      sa.public_id AS appointment_public_id,
      sa.listing_id,
      sa.inquiry_id,
      l.title AS listing_title
    FROM showing_appointments sa
    JOIN line_identities li ON li.user_id = sa.tenant_user_id
    JOIN listings l ON l.id = sa.listing_id
    WHERE sa.public_id = ?
      AND li.line_user_id = ?
      AND sa.status = 'confirmed'
    LIMIT 1
  `, [appointmentPublicId, lineUserId]);
}

// 這裡刻意連 cancelled 的也一起撈出來。showing_appointment_id 上有唯一索引,
// 只把 cancelled 濾掉的話,查不到就會直接 INSERT,然後撞索引失敗。
// 呼叫端要先看到那筆已放棄的紀錄,把它脫鉤,才輪得到新的一筆。
async function getMainSessionByShowingAppointment(db, showingAppointmentId) {
  return db.get(`
    SELECT * FROM pre_inspection_sessions
    WHERE showing_appointment_id = ? AND record_type = 'main'
    LIMIT 1
  `, [showingAppointmentId]);
}

// 讓紀錄與看房預約脫鉤,但保留紀錄本身作為歷史。
// 脫鉤後這筆預約在唯一索引上就空出來了,可以重新開始點交;
// 紀錄則落到屋況點交列表的「沒有看房預約的舊紀錄」那一支。
async function detachShowingAppointment(db, sessionId) {
  await db.run(`
    UPDATE pre_inspection_sessions
    SET showing_appointment_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [sessionId]);
}

async function startSessionForConfirmedAppointment(db, { appointmentPublicId, lineUserId }) {
  const execute = async (tx) => {
    const appointment = await getConfirmedAppointmentForTenant(tx, { appointmentPublicId, lineUserId });
    if (!appointment) return { status: 'not_found' };

    const existing = await getMainSessionByShowingAppointment(tx, appointment.appointment_id);
    if (existing && existing.status !== 'cancelled') {
      return { status: 'existing', session: existing, appointment };
    }
    if (existing) {
      // 修正前放棄的紀錄還佔著這筆預約,回傳它只會給前端一個沒有功能的半殘畫面。
      // 在同一個交易裡補脫鉤,舊資料不必另外跑 migration 就能重新開始點交。
      await detachShowingAppointment(tx, existing.id);
    }

    const activeSession = await getActiveSession(tx, lineUserId);
    if (activeSession) return { status: 'conflict', activeSession, appointment };

    const session = await createSession(tx, {
      lineUserId,
      recordType: 'main',
      showingAppointmentId: appointment.appointment_id,
      listingId: appointment.listing_id,
      inquiryId: appointment.inquiry_id,
      title: appointment.listing_title || '目前房源'
    });
    return { status: 'created', session, appointment };
  };

  return typeof db.transaction === 'function' ? db.transaction(execute) : execute(db);
}

async function createSessionAtomic(db, params) {
  const { lineUserId, listingId } = params;
  const executeAtomic = async (tx) => {
    const activeSession = await getActiveSession(tx, lineUserId);
    if (activeSession) {
      if (Number(activeSession.listing_id) === Number(listingId)) {
        return { status: 'already_active', session: activeSession };
      }
      return { status: 'conflict', activeSession };
    }
    const newSession = await createSession(tx, params);
    return { status: 'created', session: newSession };
  };

  if (typeof db.transaction === 'function') {
    return db.transaction(executeAtomic);
  }
  return executeAtomic(db);
}

async function getSessionStats(db, sessionId) {
  const row = await db.get(`
    SELECT
      SUM(CASE WHEN entry_type = 'image' THEN 1 ELSE 0 END) as image_count,
      SUM(CASE WHEN entry_type = 'video' THEN 1 ELSE 0 END) as video_count,
      SUM(CASE WHEN entry_type = 'text' THEN 1 ELSE 0 END) as text_count
    FROM pre_inspection_entries
    WHERE session_id = ?
  `, [sessionId]);

  return {
    imageCount: Number(row?.image_count || 0),
    videoCount: Number(row?.video_count || 0),
    textCount: Number(row?.text_count || 0)
  };
}

async function addEntry(db, { sessionId, entryType, messageText = null, lineMessageId = null, fileId = null, storagePath = null, publicUrl = null, mimeType = null, inspectionItemId = null }) {
  await db.run(`
    INSERT INTO pre_inspection_entries (
      session_id, entry_type, message_text, line_message_id, file_id, storage_path, public_url, mime_type, inspection_item_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [sessionId, entryType, messageText, lineMessageId, fileId, storagePath, publicUrl, mimeType, inspectionItemId]);

  await db.run(`
    UPDATE pre_inspection_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `, [sessionId]);
}

function inspectionItemKey(itemName) {
  return String(itemName || '')
    .trim()
    .replace(/\s+/g, '')
    .toLocaleLowerCase('zh-Hant');
}

async function ensureInspectionItems(db, { sessionId, itemNames = [] }) {
  const unique = [];
  const seen = new Set();
  for (const rawName of itemNames) {
    const itemName = String(rawName || '').trim();
    const itemKey = inspectionItemKey(itemName);
    if (!itemName || !itemKey || seen.has(itemKey)) continue;
    seen.add(itemKey);
    unique.push({ itemName, itemKey });
  }

  for (const [index, item] of unique.entries()) {
    if (db.dialect?.name === 'mysql') {
      await db.run(`
        INSERT IGNORE INTO pre_inspection_items (session_id, item_key, item_name, source, sort_order)
        VALUES (?, ?, ?, 'listing_reference', ?)
      `, [sessionId, item.itemKey, item.itemName, index]);
    } else {
      await db.run(`
        INSERT OR IGNORE INTO pre_inspection_items (session_id, item_key, item_name, source, sort_order)
        VALUES (?, ?, ?, 'listing_reference', ?)
      `, [sessionId, item.itemKey, item.itemName, index]);
    }
  }
}

async function addInspectionItem(db, { sessionId, itemName }) {
  const cleanedName = String(itemName || '').trim();
  const itemKey = inspectionItemKey(cleanedName);
  if (!cleanedName || !itemKey) return null;
  const sortRow = await db.get(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM pre_inspection_items WHERE session_id = ?',
    [sessionId]
  );
  const nextSortOrder = Number(sortRow?.next_sort_order || 0);
  if (db.dialect?.name === 'mysql') {
    await db.run(`
      INSERT INTO pre_inspection_items (session_id, item_key, item_name, source, sort_order)
      VALUES (?, ?, ?, 'tenant_added', ?)
      ON DUPLICATE KEY UPDATE item_name = VALUES(item_name)
    `, [sessionId, itemKey, cleanedName, nextSortOrder]);
  } else {
    await db.run(`
      INSERT INTO pre_inspection_items (session_id, item_key, item_name, source, sort_order)
      VALUES (?, ?, ?, 'tenant_added', ?)
      ON CONFLICT(session_id, item_key) DO UPDATE SET item_name = excluded.item_name
    `, [sessionId, itemKey, cleanedName, nextSortOrder]);
  }
  return db.get(
    'SELECT * FROM pre_inspection_items WHERE session_id = ? AND item_key = ?',
    [sessionId, itemKey]
  );
}

async function getInspectionItems(db, sessionId) {
  return db.all(`
    SELECT
      i.*,
      COUNT(CASE WHEN e.entry_type = 'image' THEN 1 END) AS image_count,
      COUNT(CASE WHEN e.entry_type = 'video' THEN 1 END) AS video_count
    FROM pre_inspection_items i
    LEFT JOIN pre_inspection_entries e ON e.inspection_item_id = i.id
    WHERE i.session_id = ?
    GROUP BY i.id
    ORDER BY
      CASE i.status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
      i.sort_order ASC,
      i.id ASC
  `, [sessionId]);
}

async function getInspectionItem(db, { sessionId, itemId }) {
  return db.get(
    'SELECT * FROM pre_inspection_items WHERE id = ? AND session_id = ?',
    [itemId, sessionId]
  );
}

async function updateInspectionItem(db, { sessionId, itemId, status, note = null }) {
  const allowedStatuses = new Set(['pending', 'completed', 'skipped', 'not_present']);
  if (!allowedStatuses.has(status)) return null;
  await db.run(`
    UPDATE pre_inspection_items
    SET status = ?,
        note = ?,
        completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
        skipped_at = CASE WHEN ? IN ('skipped', 'not_present') THEN COALESCE(skipped_at, CURRENT_TIMESTAMP) ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND session_id = ?
  `, [status, note, status, status, itemId, sessionId]);
  return getInspectionItem(db, { sessionId, itemId });
}

async function sealSession(db, sessionId) {
  const sealedAt = formatDbTimestamp(db);
  await db.run(`
    UPDATE pre_inspection_sessions
    SET status = 'sealed', sealed_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [sealedAt, sessionId]);
}

async function listSealedSessions(db, lineUserId) {
  return db.all(`
    SELECT * FROM pre_inspection_sessions
    WHERE line_user_id = ? AND status = 'sealed' AND record_type = 'main'
    ORDER BY id DESC
  `, [lineUserId]);
}

async function getSession(db, sessionId) {
  return db.get(`
    SELECT * FROM pre_inspection_sessions WHERE id = ?
  `, [sessionId]);
}

async function getSessionByPublicId(db, publicId) {
  return queries.getSessionByPublicId(db, publicId);
}

async function getSupplementSessions(db, parentSessionId) {
  return queries.getSupplementSessions(db, parentSessionId);
}

async function getSessionEntries(db, sessionId, limit = 10) {
  return queries.getSessionEntries(db, sessionId, limit);
}

async function getSessionWithStats(db, sessionId) {
  const session = await getSession(db, sessionId);
  if (!session) return null;
  const stats = await getSessionStats(db, sessionId);
  return { ...session, stats };
}

async function getSessionContext(db, sessionId) {
  const dateExpr = db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";
  const row = await db.get(`
    SELECT
      ls.normalized_address as address_text,
      up.display_name as landlord_name
    FROM pre_inspection_sessions pis
    LEFT JOIN listings l ON l.id = pis.listing_id
    LEFT JOIN listing_snapshots ls ON ls.id = l.latest_valid_snapshot_id
    LEFT JOIN rental_units ru ON ru.id = l.rental_unit_id
    LEFT JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    LEFT JOIN user_profiles up ON up.user_id = po.owner_user_id
    WHERE pis.id = ?
    LIMIT 1
  `, [sessionId]);
  return {
    addressText: row?.address_text || '未提供地址',
    landlordName: row?.landlord_name || '系統房東'
  };
}

async function updateConfirmationStatus(db, sessionId, status, payload = {}) {
  const updates = ['confirmation_status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [status];

  if (payload.submittedToLandlordAt) {
    updates.push('submitted_to_landlord_at = ?');
    params.push(formatDbTimestamp(db, payload.submittedToLandlordAt));
  }
  if (payload.landlordConfirmedAt) {
    updates.push('landlord_confirmed_at = ?');
    params.push(formatDbTimestamp(db, payload.landlordConfirmedAt));
  }

  params.push(sessionId);
  await db.run(`
    UPDATE pre_inspection_sessions
    SET ${updates.join(', ')}
    WHERE id = ?
  `, params);
}

async function getLandlordPendingSessions(db, landlordLineUserId) {
  if (!landlordLineUserId) return [];
  const dateExpr = db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";

  return await db.all(`
    SELECT pis.*
    FROM pre_inspection_sessions pis
    JOIN listings l ON l.id = pis.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE li.line_user_id = ?
      AND pis.status = 'sealed'
      AND pis.confirmation_status = 'pending_landlord_confirmation'
    ORDER BY pis.submitted_to_landlord_at DESC, pis.id DESC
    LIMIT 12
  `, [landlordLineUserId]);
}

async function isLandlordForSession(db, sessionId, lineUserId) {
  if (!lineUserId || !sessionId) return false;
  const dateExpr = db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";

  const ownerRow = await db.get(`
    SELECT li.line_user_id
    FROM pre_inspection_sessions pis
    JOIN listings l ON l.id = pis.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE pis.id = ? AND li.line_user_id = ?
    LIMIT 1
  `, [sessionId, lineUserId]);

  return Boolean(ownerRow);
}

async function getLandlordLineUserId(db, sessionId) {
  const dateExpr = db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";
  const row = await db.get(`
    SELECT li.line_user_id
    FROM pre_inspection_sessions pis
    JOIN listings l ON l.id = pis.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE pis.id = ?
    ORDER BY li.id DESC
    LIMIT 1
  `, [sessionId]);
  return row ? row.line_user_id : null;
}

// 點交送交與房東待辦要使用同一個收件人。只回傳 line_user_id 會讓通知中心
// 無法寫 recipient_user_id，進而無法在房東的跨功能通知清單中查到這筆事件。
async function getLandlordRecipient(db, sessionId) {
  const dateExpr = db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";
  const row = await db.get(`
    SELECT li.id AS line_identity_id, li.user_id, li.line_user_id
    FROM pre_inspection_sessions pis
    JOIN listings l ON l.id = pis.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE pis.id = ?
    ORDER BY li.id DESC
    LIMIT 1
  `, [sessionId]);
  return row || null;
}

// 放棄時一併脫鉤看房預約。showing_appointment_id 是唯一索引,已放棄的紀錄若還佔著,
// 這筆看房預約就再也無法開始點交(查到已取消的紀錄照樣回傳,前端只畫得出標題)。
// 補充紀錄的 showing_appointment_id 本來就是 NULL,一起寫 NULL 不影響它們被取消。
async function cancelSessionPackage(db, { sessionId, lineUserId }) {
  await db.run(`
    UPDATE pre_inspection_sessions
    SET status = 'cancelled', showing_appointment_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE (id = ? OR parent_session_id = ?)
      AND line_user_id = ?
  `, [sessionId, sessionId, lineUserId]);
}

async function cancelSessionPackageByPublicId(db, { publicId, lineUserId }) {
  const session = await db.get(`
    SELECT id FROM pre_inspection_sessions
    WHERE public_id = ? AND line_user_id = ?
  `, [publicId, lineUserId]);
  if (!session) return;
  await cancelSessionPackage(db, { sessionId: session.id, lineUserId });
}

const ALLOWED_EQUIPMENT_KEYWORDS = [
  '冰箱', '洗衣機', '電視', '冷氣', '熱水器', '床', '衣櫃', '衣櫥', '沙發',
  '桌', '椅', '瓦斯', '陽台', '電梯', '車位', '門禁', '馬桶', '流理台',
  '微波爐', '烘衣機', '乾衣機', '飲水機', '洗碗機', '除濕機', '清淨機',
  '窗簾', '鞋櫃', '茶幾', '電視櫃', '衛浴'
];

const EXCLUDED_KEYWORDS = [
  '網路', '网络', '第四台', '寬頻', 'wifi', 'internet', 'cable',
  '租', '費', '押', '元', '月', '年', '性', '寵', '伙', '菸', '煙', '限',
  '住', '期', '身份', '身分', '日', '即可', '說明', '詳細', '備註', '條件',
  '優惠', '折', '區', '路', '街', '站', '捷運', '採光', '通風', '格局',
  '大金', '變頻', '飯店', '安全', '乾淨', '靜', '秀', '101', '自租', '代理',
  '仲介', '包', '含', '要求', '遷入', '可遷', '此房', '男女', '皆可'
];

const ENGLISH_AMENITY_MAP = {
  icebox: '冰箱',
  refrigerator: '冰箱',
  fridge: '冰箱',
  washing_machine: '洗衣機',
  washer: '洗衣機',
  tv: '電視',
  television: '電視',
  air_conditioner: '冷氣',
  ac: '冷氣',
  water_heater: '熱水器',
  bed: '床',
  wardrobe: '衣櫃',
  closet: '衣櫃',
  sofa: '沙發',
  table: '桌子',
  desk: '書桌',
  chair: '椅子',
  gas: '天然瓦斯',
  gas_stove: '瓦斯爐',
  range_hood: '抽油煙機',
  balcony: '陽台',
  elevator: '電梯',
  parking: '車位'
};

function normalizeAmenityItem(item) {
  if (item === null || item === undefined) return '';
  const raw = String(item).trim();
  if (!raw) return '';
  if (ENGLISH_AMENITY_MAP[raw.toLowerCase()]) {
    return ENGLISH_AMENITY_MAP[raw.toLowerCase()];
  }
  return raw;
}

function isPhysicalEquipment(str) {
  if (!str || typeof str !== 'string') return false;
  const cleaned = str.trim();
  if (!cleaned || cleaned.length > 10) return false;
  if (/[。，,!！?？;；\n\r：:+\/／\s]/.test(cleaned)) return false;
  if (EXCLUDED_KEYWORDS.some(k => cleaned.includes(k))) return false;
  return ALLOWED_EQUIPMENT_KEYWORDS.some(k => cleaned.includes(k));
}

function filterPhysicalEquipment(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const result = [];
  const seen = new Set();
  for (const item of rawItems) {
    const normalized = normalizeAmenityItem(item);
    if (normalized && isPhysicalEquipment(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function parseAmenityJsonSafely(rawJson) {
  if (!rawJson) return [];
  try {
    let parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (e) {}
    }
    let items = [];
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.amenities)) {
        items = parsed.amenities;
      } else {
        items = Object.keys(parsed).filter(key => Boolean(parsed[key]));
      }
    }
    return filterPhysicalEquipment(items);
  } catch (e) {
    return [];
  }
}

async function getListingInspectionReference(db, listingId) {
  const listingRow = await db.get('SELECT source FROM listings WHERE id = ?', [listingId]);

  const unitAmenitiesRows = await db.all(`
    SELECT ua.label
    FROM unit_amenities ua
    JOIN listings l ON l.rental_unit_id = ua.rental_unit_id
    WHERE l.id = ? AND ua.is_available = 1
    ORDER BY ua.id ASC
  `, [listingId]);

  const unitLabels = (unitAmenitiesRows || []).map(r => r ? r.label : null);
  const unitAmenitiesFiltered = filterPhysicalEquipment(unitLabels);

  if (!listingRow || listingRow.source !== '591') {
    return unitAmenitiesFiltered;
  }

  let snapshotItemsFiltered = [];
  const snapshotRow = await db.get(`
    SELECT amenity_json
    FROM listing_snapshots
    WHERE listing_id = ?
      AND source = '591'
      AND amenity_json IS NOT NULL
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `, [listingId]);

  if (snapshotRow && snapshotRow.amenity_json) {
    snapshotItemsFiltered = parseAmenityJsonSafely(snapshotRow.amenity_json);
  }

  const combined = [];
  const seen = new Set();
  for (const item of [...unitAmenitiesFiltered, ...snapshotItemsFiltered]) {
    if (item && !seen.has(item)) {
      seen.add(item);
      combined.push(item);
    }
  }
  return combined;
}

async function getListingImages(db, listingId, limit = 8, { sessionPublicId = null } = {}) {
  const rows = await db.all(`
    SELECT lm.source_url, lm.file_id, f.storage_key, f.public_id, l.source
    FROM listing_media lm
    JOIN listings l ON l.id = lm.listing_id
    LEFT JOIN files f ON f.id = lm.file_id
    WHERE lm.listing_id = ?
      AND lm.media_type = 'image'
      AND (lm.source_url IS NOT NULL OR lm.file_id IS NOT NULL)
    ORDER BY lm.sort_order ASC, lm.id ASC
  `, [listingId]);

  const unique = [];
  const identities = new Set();
  for (const r of rows) {
    if (!r) continue;
    let displayUrl = null;
    if (r.file_id && (r.public_id || r.storage_key)) {
      if (r.public_id) {
        displayUrl = sessionPublicId
          ? `/tenant/pre-inspections/${encodeURIComponent(sessionPublicId)}/reference-media/${encodeURIComponent(r.public_id)}`
          : `/v2/tenant/listing-images/${encodeURIComponent(r.public_id)}`;
      } else if (r.storage_key) {
        displayUrl = `/${r.storage_key}`;
      }
    } else if (r.source_url) {
      displayUrl = normalizeImageUrl(r.source_url);
    }

    const identity = r.file_id ? `file:${r.file_id}` : imageUrlIdentity(displayUrl);
    if (displayUrl && identity && !identities.has(identity)) {
      identities.add(identity);
      unique.push(displayUrl);
    }
  }
  return unique.slice(0, limit);
}

module.exports = {
  getActiveListingContextByLineUser,
  getActiveSession,
  createSession,
  createSessionAtomic,
  getConfirmedAppointmentForTenant,
  getMainSessionByShowingAppointment,
  startSessionForConfirmedAppointment,
  sealSession,
  addEntry,
  ensureInspectionItems,
  addInspectionItem,
  getInspectionItems,
  getInspectionItem,
  updateInspectionItem,
  listSealedSessions,
  getSession,
  getSessionByPublicId,
  getSupplementSessions,
  getSessionEntries,
  getSessionStats,
  getSessionWithStats,
  getSessionContext,
  updateConfirmationStatus,
  getLandlordLineUserId,
  getLandlordRecipient,
  getLandlordPendingSessions,
  isLandlordForSession,
  cancelSessionPackage,
  cancelSessionPackageByPublicId,
  getListingInspectionReference,
  getListingImages
};
