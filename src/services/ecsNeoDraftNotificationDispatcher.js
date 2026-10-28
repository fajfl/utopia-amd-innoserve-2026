// 協商與草稿階段的 outbox dispatcher。
//
// 通知是各個 domain command 在**主交易內**入列的,同一個交易只寫 notifications 與
// notification_deliveries 兩張表,不碰 LINE API —— 交易內推播失敗會把已經成立的
// 合約或房東待辦一起回滾。所以推播是這一支在 commit 之後做的事。
//
// 因此這裡的規則是:
//   - 發送前先用條件式 UPDATE 把 delivery 從 pending/failed 搶成 sending。
//     搶不到就是別的 worker 已經接手,直接跳過,不會推兩次。
//   - 推播本身在交易外。失敗只讓這一筆 delivery 變回 failed 並留下 attempt,
//     可以重試,不影響其他 delivery,也絕不假裝成功。
//   - 收件人與內容一律重新從資料庫查,不信任 payload 裡的任何身分欄位。
//
// 卡片只導頁到合約草稿頁,不提供簽署入口:發行與簽署必須是人在合約頁的明確操作。

const presenter = require('./ecsNeoConditionLinePresenter');
const renewalPresenter = require('./v2RenewalLinePresenter');
const renewalRepository = require('../repositories/v2RenewalRepositoryAsync');
const { contractsUrl } = require('./cardMessageService');

// 這一支負責的 event type。
//
// 原本只有 contract_draft_created,其他五種一律入列之後沒有人送 —— 房東不知道有
// 問題要回答、不知道有一版在等他決定,落敗的房客不知道房子已經被租走,會一直等。
// 舊的(沒開 Agent 的)路徑是直接 push 房東的,所以開了 Agent 反而變安靜,是回歸
// 不是缺功能。
//
// 刻意**不**放進來的兩種,它們已經有人送,加進來會變成推兩次:
//   intention_rejected / intention_changes_requested
//       v2ContractRoutes 在房東決定的當下就直接推播房客(帶理由)。
//   competition_disclosed
//       在 Agent 當輪的回覆裡就講掉了。它入列是為了 idempotencyKey ——
//       同一個競爭狀態只揭露一次靠的就是那一列,不能為了清乾淨把它拿掉。
// 這兩種的 delivery 會一直停在 pending。那是預期的,不是漏送。
const EVENT_TYPES = Object.freeze([
  'contract_draft_created',
  'landlord_question_created',
  'landlord_decision_requested',
  'intention_leased_to_another_tenant',
  // 續約(v2RenewalServiceAsync)。跟上面四種一樣走同一個 outbox/dispatcher,
  // 不是另外開一套推播機制。
  'renewal_requested',
  'renewal_landlord_willing',
  'renewal_declined_by_landlord',
  'renewal_proposal_ready',
  'renewal_changes_requested',
  'renewal_tenant_counterproposal_ready',
  'renewal_counterproposal_accepted',
  'renewal_rejected_by_tenant',
  'renewal_terms_accepted'
]);
const RETRYABLE_STATUSES = ['pending', 'failed'];
const DEFAULT_MAX_ATTEMPTS = 3;

function parsePayload(payloadJson) {
  if (!payloadJson) return {};
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function loadDraftContext(db, versionPublicId) {
  if (!versionPublicId) return null;
  // 房源標題走 contracts.source_inquiry_id -> inquiries -> listings,
  // 確認版號走 selected_intention_id -> confirmed_intention_version_id。
  // 兩條都是既有欄位,不用 CAST 去解 notifications.entity_id 的字串 id。
  return db.get(`
    SELECT cv.public_id AS version_public_id,
           l.title      AS listing_title,
           iv.version_number AS intention_version_number
    FROM contract_versions cv
    JOIN contracts c ON c.id = cv.contract_id
    LEFT JOIN inquiries inq ON inq.id = c.source_inquiry_id
    LEFT JOIN listings l ON l.id = inq.listing_id
    LEFT JOIN rental_intentions ri ON ri.id = c.selected_intention_id
    LEFT JOIN intention_versions iv ON iv.id = ri.confirmed_intention_version_id
    WHERE cv.public_id = ?
  `, [versionPublicId]);
}

async function loadRenewalRequestContext(db, renewalRequestPublicId) {
  if (!renewalRequestPublicId) return null;
  return db.get(
    'SELECT id, public_id, lease_id, initiated_by FROM renewal_requests WHERE public_id = ?',
    [renewalRequestPublicId]
  );
}

const textMessage = (text) => ({ type: 'text', text });

/**
 * 依 event type 組出要推的訊息。
 *
 * 內容一律重新從資料庫查,payload 只拿來當索引 —— payload 是寫入當下的快照,
 * 房東看到的應該是現在的事實。
 *
 * 回 null 代表這一筆現在組不出訊息(對應的資料被刪掉了)。呼叫端會跳過,
 * delivery 留在原狀,不會假裝送成功。
 */
async function buildMessage(db, eventType, payload) {
  if (eventType === 'contract_draft_created') {
    const context = await loadDraftContext(db, payload.versionPublicId);
    return presenter.contractDraftReadyMessage({
      listingTitle: context ? context.listing_title : null,
      versionNumber: context ? context.intention_version_number : null
    });
  }

  if (eventType === 'landlord_question_created') {
    const question = await db.get(
      'SELECT question_text FROM landlord_questions WHERE public_id = ?',
      [payload.questionPublicId]
    );
    if (!question) return null;
    // 文案跟舊路徑(tenantInquiryAiService)一致。房東不該因為系統走哪一條路
    // 而看到兩種說法。
    return textMessage(`房客提出新問題：「${question.question_text}」\n請開啟「AI知識庫」查看並回答。`);
  }

  if (eventType === 'landlord_decision_requested') {
    return textMessage('房客已經確認一版承租條件，正在等你決定。\n請開啟合約草稿頁確認條件，或要求修改。');
  }

  if (eventType === 'intention_leased_to_another_tenant') {
    // 只講「已經租出去了」。得標者是誰、條件多少、什麼時候成交,一個字都不能有。
    return textMessage('你有意向的這個出租單位已經完成簽約，這一筆承租意向到此結束。\n想再找的話，可以回「找房紀錄」換一間繼續。');
  }

  // --- 續約 ---------------------------------------------------------------
  // 內容一律重新查資料庫,payload 只拿來當索引,跟上面幾種事件同一個原則。

  if (eventType === 'renewal_requested') {
    const request = await loadRenewalRequestContext(db, payload.renewalRequestPublicId);
    if (!request) return null;
    // 房客發起只代表表達續約意願，房東收到後直接選擇沿用、調整或不續約。
    if (request.initiated_by === 'tenant') {
      const summary = await renewalRepository.getRenewalRequestSummary(db, request.public_id);
      const parties = await renewalRepository.listLeasePartyUsers(db, request.lease_id);
      const landlord = parties.find((party) => party.party_role === 'landlord');
      const preference = landlord
        ? await renewalRepository.getLandlordRenewalPreferenceByUserId(db, landlord.user_id)
        : { unchangedTermsNegotiable: false };
      return renewalPresenter.renewalLandlordDecisionCard({
        renewalRequestPublicId: request.public_id,
        tenantName: summary.tenantName,
        propertyLabel: summary.propertyLabel,
        currentRentAmount: summary.rentAmount,
        currentDepositAmount: summary.depositAmount,
        currentStartDate: summary.startDate,
        currentEndDate: summary.endDate,
        unchangedTermsNegotiable: preference.unchangedTermsNegotiable,
        contractsUrl: contractsUrl()
      });
    }
    return textMessage('房東已經提出續約，若房東同意會請你確認條件；目前不需要你做任何事。');
  }

  if (eventType === 'renewal_landlord_willing') {
    return textMessage('房東表示願意考慮續約，正在確認條件，請留意後續通知。');
  }

  if (eventType === 'renewal_declined_by_landlord') {
    return textMessage('房東目前不願意續約，這筆續約申請到此結束。');
  }

  if (eventType === 'renewal_proposal_ready') {
    const request = await loadRenewalRequestContext(db, payload.renewalRequestPublicId);
    if (!request) return null;
    const proposal = payload.proposalPublicId
      ? await db.get(
          'SELECT * FROM renewal_proposals WHERE public_id = ? AND renewal_request_id = ?',
          [payload.proposalPublicId, request.id]
        )
      : await db.get(
          'SELECT * FROM renewal_proposals WHERE renewal_request_id = ? ORDER BY version_number DESC LIMIT 1',
          [request.id]
        );
    if (!proposal) return null;
    let proposalTerms = {};
    try {
      proposalTerms = JSON.parse(proposal.terms_json || '{}');
    } catch {
      proposalTerms = {};
    }
    return renewalPresenter.renewalProposalCard({
      renewalRequestPublicId: request.public_id,
      reused: Boolean(payload.reused),
      negotiable: proposalTerms.renewalNegotiable !== false,
      proposal: {
        startDate: proposal.proposed_start_date,
        endDate: proposal.proposed_end_date,
        rentAmount: proposal.rent_amount,
        depositAmount: proposal.deposit_amount
      }
    });
  }

  if (eventType === 'renewal_changes_requested') {
    return textMessage('房客希望調整續約條件，正在填寫希望修改的內容。送出後會顯示在「待處理續約」。');
  }

  if (eventType === 'renewal_tenant_counterproposal_ready') {
    const request = await loadRenewalRequestContext(db, payload.renewalRequestPublicId);
    if (!request) return null;
    const proposal = await db.get(
      'SELECT * FROM renewal_proposals WHERE public_id = ? AND renewal_request_id = ?',
      [payload.proposalPublicId, request.id]
    );
    if (!proposal) return null;
    const summary = await renewalRepository.getRenewalRequestSummary(db, request.public_id);
    return renewalPresenter.renewalTenantCounterProposalCard({
      renewalRequestPublicId: request.public_id,
      reused: Boolean(payload.reused),
      tenantName: summary.tenantName,
      propertyLabel: summary.propertyLabel,
      proposal: {
        startDate: proposal.proposed_start_date,
        endDate: proposal.proposed_end_date,
        rentAmount: proposal.rent_amount,
        depositAmount: proposal.deposit_amount
      }
    });
  }

  if (eventType === 'renewal_counterproposal_accepted') {
    return textMessage('房東已接受你提出的續約條件。後續需建立續約合約，並由雙方完成簽署後才正式生效。');
  }

  if (eventType === 'renewal_rejected_by_tenant') {
    return textMessage('房客拒絕了這次的續約條件，這筆續約申請到此結束。');
  }

  if (eventType === 'renewal_terms_accepted') {
    return textMessage('房客已接受續約條件。條件已確認，後續需建立並完成續約合約簽署。');
  }

  return null;
}

async function nextAttemptNumber(db, deliveryId) {
  const row = await db.get(
    'SELECT MAX(attempt_number) AS max_attempt FROM notification_delivery_attempts WHERE notification_delivery_id = ?',
    [deliveryId]
  );
  return Number((row && row.max_attempt) || 0) + 1;
}

/**
 * 掃出待發的 Agent 通知並推播。
 *
 * @param {object} input
 * @param {object} input.db async driver
 * @param {object} input.lineClient 具 pushMessage 的 LINE client
 * @param {number} [input.limit] 一次最多處理幾筆
 * @param {number} [input.maxAttempts] 同一筆 delivery 最多嘗試幾次
 * @returns {Promise<{sent:number, failed:number, skipped:number}>}
 */
async function dispatchAgentNotifications({
  db, lineClient, limit = 20, maxAttempts = DEFAULT_MAX_ATTEMPTS
}) {
  if (!db || typeof db.get !== 'function') throw new Error('db driver is required');
  const summary = { sent: 0, failed: 0, skipped: 0 };

  const placeholders = RETRYABLE_STATUSES.map(() => '?').join(',');
  const eventPlaceholders = EVENT_TYPES.map(() => '?').join(',');
  const pending = await db.all(`
    SELECT nd.id, nd.public_id, nd.recipient_user_id, nd.recipient_line_identity_id,
           n.event_type, n.payload_json,
           li.line_user_id
    FROM notification_deliveries nd
    JOIN notifications n ON n.id = nd.notification_id
    LEFT JOIN line_identities li ON li.id = nd.recipient_line_identity_id
    WHERE nd.channel = 'line'
      AND nd.status IN (${placeholders})
      AND n.event_type IN (${eventPlaceholders})
    ORDER BY nd.id ASC
    LIMIT ${Number(limit) > 0 ? Number(limit) : 20}
  `, [...RETRYABLE_STATUSES, ...EVENT_TYPES]);

  for (const delivery of pending) {
    const attemptNumber = await nextAttemptNumber(db, delivery.id);
    if (attemptNumber > maxAttempts) {
      summary.skipped += 1;
      continue;
    }

    // 沒有 LINE 身分就沒有推播管道。不改狀態:等身分補上之後這一筆還能再送。
    const lineUserId = delivery.line_user_id
      || (await resolveLineUserId(db, delivery.recipient_user_id));
    if (!lineUserId || !lineClient || typeof lineClient.pushMessage !== 'function') {
      summary.skipped += 1;
      continue;
    }

    // 條件式搶單。搶不到代表別人已經在送,不能再送第二次。
    const claimed = await db.run(`
      UPDATE notification_deliveries
      SET status = 'sending'
      WHERE id = ?
        AND status IN (${placeholders})
    `, [delivery.id, ...RETRYABLE_STATUSES]);
    if (!claimed.changes) {
      summary.skipped += 1;
      continue;
    }

    await db.run(`
      INSERT INTO notification_delivery_attempts
        (notification_delivery_id, attempt_number, status)
      VALUES (?, ?, 'started')
    `, [delivery.id, attemptNumber]);

    const payload = parsePayload(delivery.payload_json);
    const message = await buildMessage(db, delivery.event_type, payload);
    if (!message) {
      // 組不出訊息(對應資料被刪了)。狀態退回原本的可重試值,不假裝送成功,
      // 也不佔著 sending 讓下一輪跳過它。
      await db.run("UPDATE notification_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      await db.run(`
        UPDATE notification_delivery_attempts SET status = 'failed'
        WHERE notification_delivery_id = ? AND attempt_number = ?
      `, [delivery.id, attemptNumber]);
      summary.failed += 1;
      continue;
    }

    try {
      await lineClient.pushMessage(lineUserId, message);
      await db.run(`
        UPDATE notification_deliveries
        SET status = 'sent', sent_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [delivery.id]);
      await db.run(`
        UPDATE notification_delivery_attempts
        SET status = 'succeeded'
        WHERE notification_delivery_id = ? AND attempt_number = ?
      `, [delivery.id, attemptNumber]);
      summary.sent += 1;
    } catch (error) {
      // 推播失敗是 notification_failed,不是合約失敗。delivery 回 failed 可重試。
      await db.run(`
        UPDATE notification_deliveries
        SET status = 'failed'
        WHERE id = ?
      `, [delivery.id]);
      await db.run(`
        UPDATE notification_delivery_attempts
        SET status = 'failed', error_summary = ?
        WHERE notification_delivery_id = ? AND attempt_number = ?
      `, [String(error.message).slice(0, 500), delivery.id, attemptNumber]);
      summary.failed += 1;
    }
  }

  return summary;
}

async function resolveLineUserId(db, userId) {
  if (userId === null || userId === undefined) return null;
  const row = await db.get(
    'SELECT line_user_id FROM line_identities WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );
  return (row && row.line_user_id) || null;
}

module.exports = {
  EVENT_TYPES,
  dispatchAgentNotifications
};
