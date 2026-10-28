// 房東回覆後推播給房客的 driver 版本。
//
// 同步版 (tenantNotificationService.js) 的 notifyTenantOfLandlordReply 不接收 db,
// 而是自己從 V2_DATABASE_PATH 開一條 better-sqlite3 連線。在 V2_DB_DRIVER=mysql
// 之下這是實質的資料錯誤:回答寫進 TiDB,推播卻回頭讀本機 SQLite —— 那邊可能查不到
// 這筆 inquiry(房客不會收到通知),也可能查到同 id 但完全不同的資料(推給錯的人)。
//
// 這裡只搬 notifyTenantOfLandlordReply 一支。tenantNotificationService 其餘的
// handleTenantNotification* 是房客端 LIFF 的讀取路徑,不在這輪範圍。
//
// 呼叫時機:所有資料庫寫入結束、交易已經 commit 之後。LINE push 是外部呼叫,
// 交易開著的時候不可以 await 它。

const presenterTime = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/;

function formatHistoryTime(value) {
  if (!value) return '';
  const match = String(value).match(presenterTime);
  if (!match) return String(value);
  return `${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
}

function messageForRawText(inquiryId, listingTitle, rawText) {
  const messageText = rawText.replace(/^房東傳來訊息：\n/, '');
  return {
    type: 'text',
    text: `房東傳來訊息\n\n房源：${listingTitle}\n\n訊息內容：\n${messageText}\n\n時間：${formatHistoryTime(new Date().toISOString())}`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '回覆房東', text: '聯絡房東' } },
        { type: 'action', action: { type: 'postback', label: '查看詢問進度', data: `action=tenant_contact_history&inquiry_id=${inquiryId}` } }
      ]
    }
  };
}

function messageForAnswer(inquiryId, listingTitle, qa) {
  return {
    type: 'text',
    text: `房東已回覆\n\n房源：${listingTitle}\n\n你的問題：\n${qa.question_text}\n\n房東回覆：\n${qa.answer_text}\n\n回覆時間：${formatHistoryTime(qa.answered_at)}`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '查看詢問進度', data: `action=tenant_contact_history&inquiry_id=${inquiryId}` } },
        { type: 'action', action: { type: 'message', label: '繼續詢問房東', text: '聯絡房東' } }
      ]
    }
  };
}

async function notifyTenantOfLandlordReply(db, inquiryId, rawText, landlordLineUserId, options = {}) {
  if (!db) throw new Error('driver is required');

  const row = await db.get(`
    SELECT li.line_user_id, l.title AS listing_title
    FROM inquiries i
    JOIN (
      SELECT li2.*, ROW_NUMBER() OVER (PARTITION BY li2.user_id ORDER BY li2.id) rn
      FROM line_identities li2
    ) li ON li.user_id = i.user_id AND li.rn = 1
    JOIN listings l ON l.id = i.listing_id
    WHERE i.id = ?
  `, [inquiryId]);

  if (!row || !row.line_user_id) return false;
  const tenantLineUserId = row.line_user_id;

  // 房東自己問自己、以及 demo 種子帳號,都不推播。
  if (tenantLineUserId === landlordLineUserId || tenantLineUserId.startsWith('U-DEMO')) return false;

  const lineClient = options.lineClient || require('../lineClient').client;
  if (!lineClient || !lineClient.pushMessage) return false;

  let pushMessage;
  if (rawText && rawText.startsWith('房東傳來訊息：')) {
    pushMessage = messageForRawText(inquiryId, row.listing_title, rawText);
  } else {
    const qa = await db.get(`
      SELECT q.question_text, a.answer_text, a.answered_at
      FROM landlord_answers a
      JOIN landlord_questions q ON q.id = a.landlord_question_id
      WHERE q.inquiry_id = ?
      ORDER BY a.answered_at DESC
      LIMIT 1
    `, [inquiryId]);
    pushMessage = qa
      ? messageForAnswer(inquiryId, row.listing_title, qa)
      : { type: 'text', text: rawText };
  }

  try {
    await lineClient.pushMessage(tenantLineUserId, pushMessage);
    return true;
  } catch (error) {
    // 推播失敗不該讓房東端的回覆流程失敗,但也不能只是消失 —— 留下可查的紀錄。
    console.error('[tenantNotificationAsync] push failed for inquiry %s: %s', inquiryId, error.message);
    return false;
  }
}

module.exports = { formatHistoryTime, notifyTenantOfLandlordReply, notifyTenantsOfNewShowingSlot, notifyLandlordOfNewInquiry, notifyLandlordToOpenSlots };

async function notifyTenantsOfNewShowingSlot(db, listingId) {
  if (!db) throw new Error('driver is required');

  const rows = await db.all(`
    SELECT i.id as inquiry_id, li.line_user_id, l.title as listing_title
    FROM inquiries i
    JOIN (
      SELECT li2.*, ROW_NUMBER() OVER (PARTITION BY li2.user_id ORDER BY li2.id) rn
      FROM line_identities li2
    ) li ON li.user_id = i.user_id AND li.rn = 1
    JOIN listings l ON l.id = i.listing_id
    WHERE i.listing_id = ? AND i.ended_at IS NULL
      AND i.status IN ('active','intention_confirming','inquiring','waiting_landlord')
  `, [listingId]);

  const lineClient = require('../lineClient').client;
  if (!lineClient || !lineClient.pushMessage) return 0;

  let notifiedCount = 0;
  for (const row of rows) {
    const pushMessage = {
      type: 'flex',
      altText: '📅 房東已新增看房時段，請點此預約！',
      contents: {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', backgroundColor: '#0F766E', contents: [
          { type: 'text', text: '📅 新的看房時段', color: '#FFFFFF', weight: 'bold', size: 'lg' }
        ]},
        body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'text', text: `房東已為「${row.listing_title || '房源'}」新增看房時段！`, size: 'sm', color: '#374151', wrap: true },
          { type: 'text', text: '趕快預約，搶先看房吧！', size: 'sm', color: '#6b7280' }
        ]},
        footer: { type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'primary', color: '#0F766E', height: 'sm', action: {
            type: 'message', label: '前往預約看房', text: '看房預約'
          }}
        ]}
      }
    };
    try {
      await lineClient.pushMessage(row.line_user_id, pushMessage);
      notifiedCount++;
    } catch (err) {
      console.error('[tenantNotificationAsync] push slot notification failed for', row.line_user_id, err.message);
    }
  }
  return notifiedCount;
}

function buildLandlordManageUrl() {
  const liffId = process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  if (liffId && liffId !== 'your_line_liff_app_id' && !liffId.includes('placeholder') && liffId.trim() !== '') {
    return `https://miniapp.line.me/${liffId.trim()}/landlordManage`;
  }
  return `${baseUrl}/landlordManage`;
}

async function findLandlordLineUserId(db, rentalUnitId) {
  const nowStamp = new Date().toISOString().slice(0, 10);
  const landlord = await db.get(`
    SELECT li.line_user_id
    FROM property_owners po
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE po.property_id = (SELECT property_id FROM rental_units WHERE id = ?)
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ?)
      AND (po.effective_until IS NULL OR po.effective_until >= ?)
    ORDER BY li.id DESC LIMIT 1
  `, [rentalUnitId, rentalUnitId, nowStamp]);
  if (!landlord || !landlord.line_user_id || landlord.line_user_id.includes('DEMO')) return null;
  return landlord.line_user_id;
}

async function notifyLandlordOfNewInquiry(db, inquiryId) {
  if (!db) throw new Error('driver is required');
  const lineClient = require('../lineClient').client;
  if (!lineClient || !lineClient.pushMessage) return false;

  const inquiry = await db.get(`SELECT * FROM inquiries WHERE id = ?`, [inquiryId]);
  if (!inquiry) return false;

  const listing = await db.get(`SELECT id, title, rental_unit_id FROM listings WHERE id = ?`, [inquiry.listing_id]);
  if (!listing) return false;

  const landlordLineUserId = await findLandlordLineUserId(db, listing.rental_unit_id);
  if (!landlordLineUserId) return false;

  const tenantIdentity = await db.get(`
    SELECT display_name_cache FROM line_identities WHERE user_id = ?
  `, [inquiry.user_id]);

  const tenantName = (tenantIdentity && tenantIdentity.display_name_cache) || '新房客';
  const listingTitle = listing.title || '您的房源';
  const landlordManageUrl = buildLandlordManageUrl();

  const pushMessage = {
    type: 'flex',
    altText: '【系統通知】有新房客對您的房源感興趣！',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0F766E', contents: [
        { type: 'text', text: '【新客詢問】有房客感興趣！', color: '#FFFFFF', weight: 'bold', size: 'lg' }
      ]},
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: `房客 ${tenantName} 對您的房源很感興趣。`, size: 'sm', color: '#374151' },
        { type: 'box', layout: 'vertical', backgroundColor: '#F3F4F6', paddingAll: '12px', cornerRadius: '8px', contents: [
          { type: 'text', text: `房源：${listingTitle}`, weight: 'bold', size: 'sm', color: '#111827', wrap: true }
        ]}
      ]},
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#0F766E', height: 'sm', action: {
          type: 'uri', label: '開放看房時間', uri: landlordManageUrl
        }},
        { type: 'button', style: 'secondary', height: 'sm', action: {
          type: 'postback', label: '回覆房客', data: `action=reply_inquiry&id=${inquiry.public_id}`
        }}
      ]}
    }
  };

  try {
    await lineClient.pushMessage(landlordLineUserId, [pushMessage]);
    return true;
  } catch (pushErr) {
    console.error('Failed to push landlord new inquiry notification:', pushErr.message);
    return false;
  }
}

async function notifyLandlordToOpenSlots(db, inquiryId) {
  if (!db) throw new Error('driver is required');
  const lineClient = require('../lineClient').client;
  if (!lineClient || !lineClient.pushMessage) return false;

  const inquiry = await db.get(`SELECT * FROM inquiries WHERE id = ?`, [inquiryId]);
  if (!inquiry) return false;

  const listing = await db.get(`SELECT id, title, rental_unit_id FROM listings WHERE id = ?`, [inquiry.listing_id]);
  if (!listing) return false;

  const landlordLineUserId = await findLandlordLineUserId(db, listing.rental_unit_id);
  if (!landlordLineUserId) return false;

  const tenantIdentity = await db.get(`
    SELECT display_name_cache FROM line_identities WHERE user_id = ?
  `, [inquiry.user_id]);

  const tenantName = (tenantIdentity && tenantIdentity.display_name_cache) || '房客';
  const listingTitle = listing.title || '您的房源';
  const landlordManageUrl = buildLandlordManageUrl();

  const pushMessage = {
    type: 'flex',
    altText: '【系統通知】房客正在等您開放看房時間！',
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#0F766E', contents: [
        { type: 'text', text: '【提醒】房客想看房', color: '#FFFFFF', weight: 'bold', size: 'lg' }
      ]},
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: `房客 ${tenantName} 非常有興趣，正在等您開放看房時間！`, size: 'sm', color: '#374151', wrap: true },
        { type: 'box', layout: 'vertical', backgroundColor: '#F3F4F6', paddingAll: '12px', cornerRadius: '8px', contents: [
          { type: 'text', text: `房源：${listingTitle}`, weight: 'bold', size: 'sm', color: '#111827', wrap: true }
        ]}
      ]},
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#0F766E', height: 'sm', action: {
          type: 'uri', label: '前往開放時間', uri: landlordManageUrl
        }}
      ]}
    }
  };

  try {
    await lineClient.pushMessage(landlordLineUserId, [pushMessage]);
    return true;
  } catch (pushErr) {
    console.error('Failed to push landlord slot request notification:', {
      inquiryPublicId: inquiry.public_id,
      status: pushErr.response?.status || pushErr.statusCode,
      message: pushErr.response?.data?.message || pushErr.message,
      requestId: pushErr.response?.headers?.['x-line-request-id'],
    });
    const err = new Error('PUSH_FAILED');
    err.statusCode = pushErr.response?.status || pushErr.statusCode || (pushErr.message && pushErr.message.includes('429') ? 429 : 500);
    throw err;
  }
}
