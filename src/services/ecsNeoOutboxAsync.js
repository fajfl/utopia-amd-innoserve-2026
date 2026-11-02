// 通知 outbox 的唯一寫入點。
//
// 規則只有兩條,但兩條都是硬的:
//   1. **一定在呼叫端的主交易內寫。** notifications 與 notification_deliveries
//      跟著業務資料一起 commit 或一起回滾,不會出現「合約成立但沒人被通知」
//      也不會出現「通知說草稿好了但草稿其實回滾了」。
//   2. **這裡永遠不碰 LINE API。** 交易內推播失敗會把已成立的合約一起帶走。
//      真正的發送由 commit 之後的 dispatcher 做。
//
// 冪等靠 notification_deliveries.idempotency_key(NOT NULL UNIQUE)。
// 同一個事件重送會撞唯一鍵,這裡把它當成正常結果回 { enqueued: false },
// 不新增第二筆,也不把它偽裝成錯誤。

const crypto = require('node:crypto');

const sameId = (left, right) =>
  left !== null && left !== undefined &&
  right !== null && right !== undefined &&
  String(left) === String(right);

function isDuplicateKeyError(error) {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (code === 'ER_DUP_ENTRY') return true;
  return Number(error.errno) === 1062;
}

/**
 * 在主交易內建立一則通知與它的 deliveries。
 *
 * @param {object} tx      交易內的 driver
 * @param {object} input
 * @param {string} input.eventType      notifications.event_type
 * @param {string} input.entityType
 * @param {string|number} input.entityId
 * @param {object} [input.payload]      **不得含個資**;dispatcher 會自己重查收件人
 * @param {Array<{role:string,userId:(string|number),lineIdentityId?:(string|number)}>} input.recipients
 * @param {string} input.idempotencyKey delivery 的 key 前綴,實際 key 是 `${key}:${role}`
 * @returns {Promise<{notificationId:(number|string|null), enqueued:number, replayed:number}>}
 */
async function enqueueNotification(tx, input = {}) {
  if (!tx || typeof tx.run !== 'function') throw new Error('transaction driver is required');
  const recipients = (Array.isArray(input.recipients) ? input.recipients : [])
    .filter((recipient) => recipient && recipient.userId !== null && recipient.userId !== undefined);
  if (!recipients.length) return { notificationId: null, enqueued: 0, replayed: 0 };

  // 先看哪些 delivery 已經存在。全部都在就完全不寫 —— 少了這一步,重送會留下
  // 一列沒有任何 delivery 的孤兒 notifications,dispatcher 永遠不會處理它,
  // 但稽核上看起來像「通知過兩次」。
  const keys = recipients.map((recipient) => `${input.idempotencyKey}:${recipient.role}`);
  const existing = await tx.all(
    `SELECT idempotency_key FROM notification_deliveries WHERE idempotency_key IN (${keys.map(() => '?').join(',')})`,
    keys
  );
  const existingKeys = new Set(existing.map((row) => row.idempotency_key));
  if (existingKeys.size >= recipients.length) {
    return { notificationId: null, enqueued: 0, replayed: recipients.length };
  }

  const userIds = [...new Set(recipients.map((recipient) => String(recipient.userId)))];
  const identities = await tx.all(
    `SELECT id, user_id FROM line_identities WHERE user_id IN (${userIds.map(() => '?').join(',')})`,
    userIds
  );
  const identityFor = (recipient) => {
    const preferred = identities.find((row) =>
      sameId(row.user_id, recipient.userId) && sameId(row.id, recipient.lineIdentityId)
    );
    if (preferred) return preferred.id;
    // A user can rebind LINE.  Prefer the most recently-created identity, not
    // whichever row the database happens to return first.
    const match = identities
      .filter((row) => sameId(row.user_id, recipient.userId))
      .sort((left, right) => Number(right.id) - Number(left.id))[0];
    return match ? match.id : null;
  };

  const inserted = await tx.run(`
    INSERT INTO notifications
      (public_id, event_type, entity_type, entity_id, template_code, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    `notification-${crypto.randomUUID()}`,
    input.eventType,
    input.entityType,
    String(input.entityId),
    input.templateCode || input.eventType,
    JSON.stringify(input.payload || {})
  ]);

  let enqueued = 0;
  let replayed = 0;
  for (const recipient of recipients) {
    try {
      await tx.run(`
        INSERT INTO notification_deliveries
          (public_id, notification_id, recipient_user_id, recipient_line_identity_id,
           channel, idempotency_key, status)
        VALUES (?, ?, ?, ?, 'line', ?, 'pending')
      `, [
        `delivery-${crypto.randomUUID()}`,
        inserted.insertId,
        recipient.userId,
        identityFor(recipient),
        `${input.idempotencyKey}:${recipient.role}`
      ]);
      enqueued += 1;
    } catch (error) {
      // 重送。第一次那筆 delivery 已經在了,狀態(pending/sent/failed)由 dispatcher
      // 管理,這裡不得覆寫 —— 覆寫等於把已送出的通知重新排隊。
      if (!isDuplicateKeyError(error)) throw error;
      replayed += 1;
    }
  }

  return { notificationId: inserted.insertId, enqueued, replayed };
}

module.exports = { enqueueNotification, isDuplicateKeyError };
