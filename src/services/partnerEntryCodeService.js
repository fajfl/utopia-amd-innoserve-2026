const crypto = require('crypto');

const db = require('../db');
const { ensureLineIdentity } = require('./profileService');

function cleanText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value || Date.now()).toISOString();
}

function generateEntryCode() {
  return String(crypto.randomInt(0, 100000000)).padStart(8, '0');
}

function existingActiveEntryForCase({ caseId, listingRowId = null, partner = '591' }) {
  const row = db.prepare(`
    SELECT entry_code, case_id, listing_row_id, partner, status, expires_at
    FROM partner_entry_codes
    WHERE case_id = @caseId
      AND partner = @partner
      AND status = 'active'
      AND (
        (@listingRowId IS NULL AND listing_row_id IS NULL)
        OR listing_row_id = @listingRowId
      )
    ORDER BY datetime(created_at) ASC, id ASC
    LIMIT 1
  `).get({
    caseId,
    listingRowId,
    partner
  });

  if (!row) return null;
  return {
    entryCode: row.entry_code,
    caseId: row.case_id,
    listingRowId: row.listing_row_id,
    partner: row.partner,
    status: row.status,
    expiresAt: row.expires_at
  };
}

function supersedeDuplicateActiveEntries({ caseId, listingRowId = null, partner = '591', keepEntryCode }) {
  db.prepare(`
    UPDATE partner_entry_codes
    SET status = 'superseded'
    WHERE case_id = @caseId
      AND partner = @partner
      AND status = 'active'
      AND entry_code <> @keepEntryCode
      AND (
        (@listingRowId IS NULL AND listing_row_id IS NULL)
        OR listing_row_id = @listingRowId
      )
  `).run({
    caseId,
    listingRowId,
    partner,
    keepEntryCode
  });
}

function createEntryCodeForCase({ caseId, listingRowId = null, partner = '591', now = new Date() }) {
  const createdAt = now instanceof Date ? now : new Date(now);
  const existing = existingActiveEntryForCase({
    caseId,
    listingRowId,
    partner
  });
  if (existing) {
    db.prepare(`
      UPDATE partner_entry_codes
      SET expires_at = NULL
      WHERE entry_code = @entryCode
    `).run({ entryCode: existing.entryCode });
    existing.expiresAt = null;
    supersedeDuplicateActiveEntries({
      caseId,
      listingRowId,
      partner,
      keepEntryCode: existing.entryCode
    });
    return existing;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const entryCode = generateEntryCode();
    try {
      db.prepare(`
        INSERT INTO partner_entry_codes (
          entry_code,
          case_id,
          listing_row_id,
          partner,
          status,
          created_at,
          expires_at
        ) VALUES (
          @entryCode,
          @caseId,
          @listingRowId,
          @partner,
          'active',
          @createdAt,
          NULL
        )
      `).run({
        entryCode,
        caseId,
        listingRowId,
        partner,
        createdAt: iso(createdAt)
      });
      return {
        entryCode,
        caseId,
        listingRowId,
        partner,
        status: 'active',
        expiresAt: null
      };
    } catch (error) {
      if (!/UNIQUE/i.test(error.message)) throw error;
    }
  }

  throw new Error('Unable to allocate a unique LINE entry code.');
}

function officialAccountBasicId() {
  return cleanText(
    process.env.LINE_OA_BASIC_ID ||
    process.env.LINE_OFFICIAL_ACCOUNT_ID ||
    process.env.LINE_BASIC_ID
  );
}

function buildLineChatMessage(entryCode) {
  return `591租屋詢問 ${entryCode}`;
}

function buildLineChatUrl(entryCode) {
  const basicId = officialAccountBasicId();
  if (!basicId) return null;
  const withAt = basicId.startsWith('@') ? basicId : `@${basicId}`;
  return `https://line.me/R/oaMessage/${encodeURIComponent(withAt)}/?${encodeURIComponent(buildLineChatMessage(entryCode))}`;
}

function parseEntryCodeText(text) {
  const value = cleanText(text);
  if (!value) return null;
  const exact = value.match(/^\d{8}$/);
  if (exact) return exact[0];
  const prefixed = value.match(/(?:591租屋詢問|案件碼)\s*[:：]?\s*(\d{8})/);
  return prefixed ? prefixed[1] : null;
}

function activeEntryRow(entryCode) {
  return db.prepare(`
    SELECT
      pec.*,
      c.title AS case_title,
      c.source_listing_url,
      rl.title AS listing_title,
      rl.price,
      rl.address,
      rl.rooms,
      rl.floor,
      rl.detail_items_json,
      rl.contact_info_json
    FROM partner_entry_codes pec
    JOIN cases c ON c.case_id = pec.case_id
    LEFT JOIN rental_listings rl ON rl.id = pec.listing_row_id
    WHERE pec.entry_code = @entryCode
    LIMIT 1
  `).get({ entryCode });
}

function canonicalEntryRow(row) {
  if (!row || row.status === 'active') return row;
  if (row.status !== 'superseded') return null;
  const canonical = db.prepare(`
    SELECT entry_code
    FROM partner_entry_codes
    WHERE case_id = @caseId
      AND partner = @partner
      AND status = 'active'
      AND (
        (@listingRowId IS NULL AND listing_row_id IS NULL)
        OR listing_row_id = @listingRowId
      )
    ORDER BY datetime(created_at) ASC, id ASC
    LIMIT 1
  `).get({
    caseId: row.case_id,
    listingRowId: row.listing_row_id,
    partner: row.partner
  });
  return canonical ? activeEntryRow(canonical.entry_code) : null;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function updateLineDisplayName(lineUserId, displayName) {
  if (!displayName) return;
  db.prepare(`
    UPDATE line_identities
    SET line_display_name = COALESCE(@displayName, line_display_name),
        updated_at = CURRENT_TIMESTAMP
    WHERE line_user_id = @lineUserId
  `).run({ lineUserId, displayName });
}

function upsertTenantParticipant({ caseId, lineUserId, displayName }) {
  const userId = ensureLineIdentity(lineUserId);
  updateLineDisplayName(lineUserId, displayName);

  const existing = db.prepare(`
    SELECT id
    FROM case_participants
    WHERE case_id = @caseId
      AND line_user_id = @lineUserId
      AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get({ caseId, lineUserId });

  const snapshotName = displayName || lineUserId;
  if (existing) {
    db.prepare(`
      UPDATE case_participants
      SET user_id = @userId,
          role = 'tenant',
          display_name_snapshot = @displayName,
          legal_name_snapshot = COALESCE(legal_name_snapshot, @displayName),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id: existing.id,
      userId,
      displayName: snapshotName
    });
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO case_participants (
      case_id,
      user_id,
      line_user_id,
      role,
      display_name_snapshot,
      legal_name_snapshot,
      signing_required,
      status
    ) VALUES (
      @caseId,
      @userId,
      @lineUserId,
      'tenant',
      @displayName,
      @displayName,
      1,
      'active'
    )
  `).run({
    caseId,
    userId,
    lineUserId,
    displayName: snapshotName
  });
  return result.lastInsertRowid;
}

function formatPrice(price) {
  return price ? `${Number(price).toLocaleString('zh-TW')} 元/月` : '待確認';
}

function entryReplyText(row) {
  const details = parseJson(row.detail_items_json, {});
  const contact = parseJson(row.contact_info_json, {});
  const lines = [
    '我已帶入這筆 591 房源：',
    '',
    row.listing_title || row.case_title || '591 房源',
    `月租：${formatPrice(row.price)}`,
    `地址：${row.address || '待確認'}`
  ];

  if (row.rooms) lines.push(`格局：${row.rooms}`);
  if (row.floor) lines.push(`樓層：${row.floor}`);
  if (details.deposit) lines.push(`押金：${details.deposit}`);
  if (details.pet || details.petNotice) lines.push(`寵物：${details.pet || details.petNotice}`);
  if (details.cooking || details.cookNotice) lines.push(`開伙：${details.cooking || details.cookNotice}`);
  if (contact.name) lines.push(`屋主：${contact.name}`);

  lines.push('');
  lines.push('你可以直接問我租金、押金、寵物、開伙、看房時間或租約條件。');
  lines.push('如果房源頁沒有寫清楚，我會標成待確認，不會直接當成已定案。');
  return lines.join('\n');
}

function latestBoundListingForLineUser(lineUserId) {
  const userId = cleanText(lineUserId);
  if (!userId) return null;
  return db.prepare(`
    SELECT
      pec.entry_code,
      pec.case_id,
      pec.listing_row_id,
      pecb.bound_at,
      c.title AS case_title,
      rl.title AS listing_title,
      rl.price,
      rl.address,
      rl.rooms,
      rl.floor,
      rl.detail_items_json,
      rl.contact_info_json
    FROM partner_entry_codes pec
    JOIN partner_entry_code_bindings pecb ON pecb.entry_code = pec.entry_code
    JOIN cases c ON c.case_id = pec.case_id
    LEFT JOIN rental_listings rl ON rl.id = pec.listing_row_id
    WHERE pecb.line_user_id = @lineUserId
      AND pecb.status = 'active'
      AND pec.status = 'active'
    ORDER BY datetime(pecb.bound_at) DESC, pecb.id DESC
    LIMIT 1
  `).get({ lineUserId: userId });
}

function upsertEntryCodeBinding({ row, lineUserId, displayName, now }) {
  db.prepare(`
    INSERT INTO partner_entry_code_bindings (
      entry_code,
      case_id,
      listing_row_id,
      line_user_id,
      display_name_snapshot,
      status,
      bound_at
    ) VALUES (
      @entryCode,
      @caseId,
      @listingRowId,
      @lineUserId,
      @displayName,
      'active',
      @boundAt
    )
    ON CONFLICT(entry_code, line_user_id) DO UPDATE SET
      case_id = excluded.case_id,
      listing_row_id = excluded.listing_row_id,
      display_name_snapshot = COALESCE(excluded.display_name_snapshot, partner_entry_code_bindings.display_name_snapshot),
      status = 'active',
      bound_at = excluded.bound_at
  `).run({
    entryCode: row.entry_code,
    caseId: row.case_id,
    listingRowId: row.listing_row_id,
    lineUserId,
    displayName,
    boundAt: iso(now)
  });
}

function answerBoundListingQuestion({ lineUserId, text }) {
  const row = latestBoundListingForLineUser(lineUserId);
  if (!row) return null;

  const question = cleanText(text) || '';
  const details = parseJson(row.detail_items_json, {});
  const contact = parseJson(row.contact_info_json, {});
  const lines = [
    `我會以這筆 591 房源作為背景：${row.listing_title || row.case_title || '591 房源'}`
  ];

  let matched = false;
  if (/租金|月租|多少錢|價格/.test(question)) {
    lines.push(`月租：${formatPrice(row.price)}`);
    matched = true;
  }
  if (/押金/.test(question)) {
    lines.push(`押金：${details.deposit || '待確認'}`);
    matched = true;
  }
  if (/寵物|養貓|貓|養狗|狗/.test(question)) {
    lines.push(`寵物：${details.pet || details.petNotice || '待確認'}`);
    matched = true;
  }
  if (/開伙|煮飯|料理/.test(question)) {
    lines.push(`開伙：${details.cooking || details.cookNotice || '待確認'}`);
    matched = true;
  }
  if (/地址|在哪|位置/.test(question)) {
    lines.push(`地址：${row.address || '待確認'}`);
    matched = true;
  }
  if (/屋主|房東|聯絡/.test(question)) {
    lines.push(`屋主：${contact.name || '待確認'}`);
    matched = true;
  }

  if (!matched) {
    lines.push(`月租：${formatPrice(row.price)}`);
    lines.push(`地址：${row.address || '待確認'}`);
    lines.push('你可以問租金、押金、寵物、開伙、地址或屋主資訊。');
  }

  lines.push('');
  lines.push('房源頁資料是背景；若要寫入正式租約，仍需要房東或房仲確認。');
  return lines.join('\n');
}

function bindEntryCodeToLineUser({ entryCode, lineUserId, displayName = null, now = new Date() }) {
  const code = cleanText(entryCode);
  const userId = cleanText(lineUserId);
  if (!code || !userId) {
    return {
      ok: false,
      replyText: '請提供有效的 591 案件碼。'
    };
  }

  return db.transaction(() => {
    const requestedRow = activeEntryRow(code);
    if (!requestedRow) {
      return {
        ok: false,
        entryCode: code,
        replyText: '找不到這組 591 案件碼，請重新從 591 房源頁點擊 ECS NEO 入口。'
      };
    }

    const row = canonicalEntryRow(requestedRow);
    if (!row) {
      return {
        ok: false,
        entryCode: code,
        caseId: requestedRow.case_id,
        replyText: '這組 591 案件碼已失效，請重新從 591 房源頁建立入口。'
      };
    }

    upsertTenantParticipant({
      caseId: row.case_id,
      lineUserId: userId,
      displayName
    });

    upsertEntryCodeBinding({
      row,
      lineUserId: userId,
      displayName,
      now
    });

    if (!row.bound_line_user_id) {
      db.prepare(`
        UPDATE partner_entry_codes
        SET bound_line_user_id = @lineUserId,
            bound_at = @boundAt
        WHERE entry_code = @entryCode
      `).run({
        entryCode: code,
        lineUserId: userId,
        boundAt: iso(now)
      });
    }

    return {
      ok: true,
      entryCode: row.entry_code,
      caseId: row.case_id,
      listingRowId: row.listing_row_id,
      replyText: entryReplyText(row)
    };
  })();
}

module.exports = {
  answerBoundListingQuestion,
  bindEntryCodeToLineUser,
  buildLineChatMessage,
  buildLineChatUrl,
  createEntryCodeForCase,
  parseEntryCodeText
};
