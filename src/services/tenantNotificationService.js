const path = require('node:path');

const { withV2Driver } = require('../database/v2Driver');
const repo = require('../repositories/v2TenantNotificationRepository');
const presenter = require('./tenantNotificationPresenter');

// 房客端這三支已改走 driver，V2_DB_DRIVER=mysql 時讀 TiDB。
// notifyTenantOfLandlordReply 亦已切換為透過 withV2Driver 存取資料庫。
// 已經有一份 driver 版在 tenantNotificationServiceAsync.js，房東端搬的時候直接接。
//
// 這三支從同步改成非同步，呼叫端沒補 await 的話 card 會是個未完成的值，
// 事件被當成沒處理——不會報錯、只會沒反應。tenantFeatureLineService 那五個
// 呼叫點由 test/tenantNotificationAwait.test.js 守著。

function currentMonthString(now = new Date()) {
  // 用本地時區推算年月，不是 UTC——月初與月底那幾個小時會差一個月。
  const tzOffset = now.getTimezoneOffset() * 60000;
  return (new Date(now - tzOffset)).toISOString().slice(0, -1).substring(0, 7);
}

async function handleTenantNotification(lineUserId, options = {}) {
  return withV2Driver(async (db) => {
    const row = await db.get('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
    const userId = row ? row.user_id : null;

    if (!userId) {
      // If no user found in V2 db, return empty state
      return options.forceState === 'post_leasing'
        ? presenter.postLeasingCard({ currentMonthRent: null, activeLease: null })
        : presenter.preLeasingCard({ landlordAnswers: [], upcomingShowings: [] });
    }

    // Decide state
    let isPostLeasing = false;
    if (options.forceState === 'post_leasing') {
      isPostLeasing = true;
    } else if (options.forceState === 'pre_leasing') {
      isPostLeasing = false;
    } else {
      isPostLeasing = await repo.getTenantSigningStatus(db, userId);
    }

    if (isPostLeasing) {
      return presenter.postLeasingCard({
        currentMonthRent: await repo.getCurrentMonthRentCharge(db, userId, currentMonthString()),
        activeLease: await repo.getActiveLease(db, userId),
        latestRepair: await repo.getLatestTenantRepairTicket(db, userId)
      });
    }
    return presenter.preLeasingCard({
      landlordAnswers: await repo.getLandlordAnswers(db, userId),
      upcomingShowings: await repo.getUpcomingShowings(db, userId)
    });
  });
}

async function handleTenantNotificationHistory(lineUserId) {
  return withV2Driver(async (db) => {
    const row = await db.get('SELECT id, user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
    if (!row || !row.user_id) return presenter.notificationHistoryCard([]);
    return presenter.notificationHistoryCard(await repo.getNotificationHistory(db, row.id, row.user_id, 10));
  });
}

function handleTenantNotificationTestMenu() {
  return presenter.testNotificationMenuCard();
}

async function handleTenantNotificationSingle(lineUserId, type) {
  return withV2Driver(async (db) => {
    const row = await db.get('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
    const userId = row ? row.user_id : null;

    if (!userId) {
      // Return empty cards if user not found
      switch (type) {
        case 'billing': return presenter.singleBillingCard(null);
        case 'contract': return presenter.singleContractCard();
        case 'landlord_answer': return presenter.singleLandlordAnswerCard([]);
        case 'showing': return presenter.singleShowingCard([]);
        case 'renewal': return presenter.singleRenewalCard();
        default: return { type: 'text', text: '未知的通知類型' };
      }
    }

    switch (type) {
      case 'billing':
        return presenter.singleBillingCard(await repo.getCurrentMonthRentCharge(db, userId, currentMonthString()));
      case 'contract':
        return presenter.singleContractCard();
      case 'landlord_answer':
        return presenter.singleLandlordAnswerCard(await repo.getLandlordAnswers(db, userId));
      case 'showing':
        return presenter.singleShowingCard(await repo.getUpcomingShowings(db, userId));
      case 'renewal':
        return presenter.singleRenewalCard();
      default:
        return { type: 'text', text: '未知的通知類型' };
    }
  });
}

async function notifyTenantOfLandlordReply(inquiryId, rawText, landlordLineUserId) {
  await withV2Driver(async (db) => {
    const row = await db.get(`
      SELECT li.line_user_id, l.title AS listing_title
      FROM inquiries i
      JOIN line_identities li ON li.user_id = i.user_id
      JOIN listings l ON l.id = i.listing_id
      WHERE i.id = ?
    `, [inquiryId]);

    if (!row || !row.line_user_id) return;
    const tenantLineUserId = row.line_user_id;

    if (tenantLineUserId === landlordLineUserId || tenantLineUserId.startsWith('U-DEMO')) {
      return;
    }

    const { client: lineClient } = require('../lineClient');
    if (!lineClient || !lineClient.pushMessage) return;

    function formatHistoryTime(timeStr) {
      if (!timeStr) return '';
      const match = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
      if (!match) return timeStr;
      return `${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
    }

    let pushMessage;

    if (rawText && rawText.startsWith('房東傳來訊息：')) {
      const messageText = rawText.replace(/^房東傳來訊息：\n/, '');
      const msgText = `房東傳來訊息\n\n房源：${row.listing_title}\n\n訊息內容：\n${messageText}\n\n時間：${formatHistoryTime(new Date().toISOString())}`;

      pushMessage = {
        type: 'text',
        text: msgText,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '回覆房東', text: '聯絡房東' } },
            { type: 'action', action: { type: 'postback', label: '查看詢問進度', data: `action=tenant_contact_history&inquiry_id=${inquiryId}` } }
          ]
        }
      };
    } else {
      const qa = await db.get(`
        SELECT q.question_text, a.answer_text, a.answered_at
        FROM landlord_answers a
        JOIN landlord_questions q ON q.id = a.landlord_question_id
        WHERE q.inquiry_id = ?
        ORDER BY a.answered_at DESC
        LIMIT 1
      `, [inquiryId]);

      if (qa) {
        const msgText = `房東已回覆\n\n房源：${row.listing_title}\n\n你的問題：\n${qa.question_text}\n\n房東回覆：\n${qa.answer_text}\n\n回覆時間：${formatHistoryTime(qa.answered_at)}`;
        pushMessage = {
          type: 'text',
          text: msgText,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'postback', label: '查看詢問進度', data: `action=tenant_contact_history&inquiry_id=${inquiryId}` } },
              { type: 'action', action: { type: 'message', label: '繼續詢問房東', text: '聯絡房東' } }
            ]
          }
        };
      } else {
        pushMessage = { type: 'text', text: rawText };
      }
    }

    try {
      await lineClient.pushMessage(tenantLineUserId, pushMessage);
    } catch (err) {
      console.error('Failed to notify tenant of landlord reply:', err.message);
    }
  });
}

module.exports = {
  handleTenantNotification,
  handleTenantNotificationHistory,
  handleTenantNotificationTestMenu,
  handleTenantNotificationSingle,
  notifyTenantOfLandlordReply
};
