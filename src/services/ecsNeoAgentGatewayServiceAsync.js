// Node Action Policy Gateway:Agent context 與 Agent 觸發動作的**唯一**入口。
//
// 這一層存在的理由只有一個:模型的輸出是提案,不是命令。每一個副作用都要在
// Node 這邊重新驗證 actor、inquiry、listing、exact version 與當前狀態之後才執行。
//
// 一個 turn 的固定順序(順序本身就是防線,不要調):
//   1. feature flag。關閉或 public demo 一律不進來。
//   2. 身分。只從 line_identities 推導,永遠不看模型回傳的任何身分欄位。
//   3. channel_events 持久化。webhookEventId 去重,重送不重跑副作用。
//   4. 房源脈絡。沒有 active inquiry 就請房客先選,不猜最近一筆。
//   5. **房源錯置偵測。疑似在問別間房就停在這裡,一個字都不寫。**
//   6. 訊息落地。到這一步才寫 messages —— 它會成為條件的 provenance,
//      寫進錯的 inquiry 等於把 A 房的話當成 B 房的依據。
//   7. context 組裝(ecsNeoAgentContextService,含隱私斷言)。
//   8. trace 開始 -> 呼叫 sidecar(**交易外**) -> 依 action 執行 -> trace 結束。
//
// LLM 呼叫永遠不在資料庫交易內。每個 domain command 各自開自己的短交易。

const crypto = require('node:crypto');
const { otherAgreements } = require('./ecsNeoOtherAgreements');
const { applyPendingItems } = require('./ecsNeoPendingItemsService');

const runtimeClient = require('./ecsNeoAgentRuntimeClient');
const presenter = require('./ecsNeoConditionLinePresenter');
const {
  CONVERSATION_WINDOW_LIMIT, buildAgentTurnContext, negotiationRoundStartedAt
} = require('./ecsNeoAgentContextService');
const { canonicalJson } = require('./ecsNeoContractAcceptanceServiceAsync');
const { buildIntentionCandidate, searchAuthorizedKnowledge } = require('./ecsNeoAgentToolsServiceAsync');
const { discloseCompetition, summarizeCompetition } = require('./ecsNeoCompetitionDisclosureService');
const { applyRentNegotiation } = require('./ecsNeoRentNegotiationService');
const { enqueueNotification } = require('./ecsNeoOutboxAsync');
const { finishAgentExecution, startAgentExecution, runTracedTool } = require('./ecsNeoAgentTraceServiceAsync');
const { loadIntentionVersion, saveIntentionVersion } = require('./ecsNeoIntentionVersionServiceAsync');
const { projectTrackedFields } = require('./ecsNeoConditionProvenanceService');
const { withV2Driver } = require('../database/v2Driver');
const contractCenterService = require('./v2ContractCenterServiceAsync');
const contractStatusPresenter = require('./ecsNeoContractStatusPresenter');

const RUNTIME_VERSION = 'ecs-neo-gateway-v1';
const PROVIDER = 'line';

// DeepSeek 協調器固定使用 agent.py 的 MODEL；自架時兩端都使用顯式 AI_MODEL。
// trace 必須記錄 sidecar 實際使用的模型；切換設定後需一併重啟兩端。
const { getAiConfig, assertAiConfig } = require('./aiConfigService');
const { liffUrl } = require('./liffSessionService');
const coordinatorConfig = getAiConfig();
const selfHostedCoordinator = ['vllm', 'llamacpp'].includes(coordinatorConfig.provider);
if (selfHostedCoordinator) assertAiConfig(coordinatorConfig, 'self-hosted coordinator');
const AGENT_MODEL_ID = selfHostedCoordinator ? coordinatorConfig.model : 'deepseek-flash';

// 模型可以提案的欄位。與 ecsNeoAgentToolsServiceAsync.CANDIDATE_FIELD_PATHS 對齊,
// 但這裡再擋一次:tools 是模型自己呼叫的路徑,這裡是模型輸出直接進 Node 的路徑,
// 兩條路都必須各自完整驗證。
// 每個 key 同時定義：模型候選欄位 → condition_json 位置，以及 prepared
// draft 的 clause snapshot / provenance 欄位。候選 wire 名是 snake_case，
// clause snapshot 是既有契約範本的 camelCase；兩者不可混用，否則草稿會看似
// 有資料卻因找不到同名來源而被安全地擋下。
const CANDIDATE_CONDITION_PATHS = Object.freeze({
  rent_amount: { path: ['rent', 'monthly_rent_ntd'], clauseField: 'rentAmount' },
  deposit_amount: { path: ['deposit', 'deposit_amount_ntd'], clauseField: 'depositAmount' },
  lease_start_date: { path: ['lease_term', 'start_date_roc'], clauseField: 'leaseStartDate' },
  lease_end_date: { path: ['lease_term', 'end_date_roc'], clauseField: 'leaseEndDate' },
  move_in_date: { path: ['move_in', 'date_roc'], clauseField: 'moveInDate' },
  repair_responsibility: { path: ['repairResponsibility'], clauseField: 'repairResponsibility' },
  utility_cost_allocation: { path: ['utilityCostAllocation'], clauseField: 'utilityCostAllocation' },
  early_termination: { path: ['earlyTermination'], clauseField: 'earlyTermination' },
  household_registration_allowed: {
    path: ['householdRegistrationAllowed'], clauseField: 'householdRegistrationAllowed'
  },
  pet_allowed: { path: ['petAllowed'], clauseField: 'petAllowed' }
});

function setPath(target, path, value) {
  const last = path[path.length - 1];
  const parent = path.slice(0, -1).reduce((node, key) => {
    node[key] = node[key] || {};
    return node[key];
  }, target);
  parent[last] = value;
}

function textMessage(text) {
  return { type: 'text', text };
}

const sameId = (left, right) =>
  left !== null && left !== undefined &&
  right !== null && right !== undefined &&
  String(left) === String(right);

// --- 3. inbound event 去重 ----------------------------------------------------

/**
 * 把一筆 inbound provider event 落地。沿用既有 channel_events,不新增第二張事件表。
 *
 * @returns {Promise<{publicId:string, id:(number|string), replayed:boolean}>}
 */
// 對話窗的角色。三種來源不可混在一起:
//   房客   inbound,sender = 這位房客
//   Agent  outbound 且沒有 sender(系統發的)
//   房東   outbound 且有 sender(房東透過聯絡流程直接傳給房客)
function conversationRole(row, tenantUserId) {
  if (sameId(row.sender_user_id, tenantUserId)) return 'tenant';
  if (row.direction === 'outbound' && row.sender_user_id == null) return 'agent';
  return 'landlord';
}

/**
 * 這一輪協商的對話,新到舊。
 *
 * 兩件事同時做:
 *   1. 對話窗要含 Agent 自己講過的話。少了它,模型每一輪讀到的都是房客的獨白 ——
 *      自己上一輪問過什麼、承諾過什麼全部不知道,於是重複發問、前後矛盾。
 *   2. 只到這一輪為止。房東要求修改或拒絕之後,上一輪的租金與日期不算數了,
 *      混進來模型就會拿去當現在的條件。邊界怎麼算見 negotiationRoundStartedAt。
 *
 * REPLACE 是為了讓 messages.sent_at(ISO)與 decided_at(可能是
 * CURRENT_TIMESTAMP 的空白格式)可以比大小,理由寫在那支 helper 上面。
 * 沒有邊界時(還沒有任何意向)退回原本的「最近 30 則」。
 */
async function loadRoundConversation(db, inquiryId) {
  const roundStartedAt = await negotiationRoundStartedAt(db, inquiryId);
  return db.all(`
    SELECT id, text_content, sender_user_id, direction
    FROM messages
    WHERE inquiry_id = ? AND message_type = 'text' AND text_content IS NOT NULL
      AND (? IS NULL OR REPLACE(sent_at, ' ', 'T') >= ?)
    ORDER BY sent_at DESC, id DESC
    LIMIT ?
  `, [inquiryId, roundStartedAt, roundStartedAt, CONVERSATION_WINDOW_LIMIT]);
}

/**
 * 把 Agent 這一輪送出去的文字留成 outbound 訊息,好讓下一輪看得到自己說過什麼。
 *
 * **一定要在 LINE 真的送出之後才呼叫。** reply token 只有一分鐘,而這條線本來就
 * 容易逾時;先寫再送會讓「送失敗的那句」變成模型以為自己已經回答過的內容,
 * 房客再問一次就會拿到「我剛剛說過了」。反過來寫失敗只是退回原本的行為。
 *
 * 只留 text。Flex 卡片是操作介面不是說過的話,轉成文字進脈絡只會誤導。
 *
 * provider_message_id 優先存 LINE reply API 回傳的真實 message id
 * (sentMessages[i].id)。稽核時要能從 LINE 上看到的那一則,一路回推到
 * channel event 與 agent execution;沒有真實 id 的話那一段是斷的,只能靠時間猜。
 * 拿不到就退回 channel event 綁定的合成鍵 —— 兩種都是唯一的,既有的
 * UNIQUE (provider, provider_message_id) 照樣擋得住重複寫入。
 *
 * sentMessages 的索引對的是**送出去的全部訊息**,含 Flex 卡片,所以要用原始陣列
 * 的位置去取,不能用過濾掉卡片之後的位置 —— 錯開一格就會把 A 句子標成 B 的 id,
 * 而且看起來完全正常。
 */
async function recordAgentReply(input = {}) {
  const { inquiryId, messages, channelEventPublicId, sentMessages, withDriver = withV2Driver } = input;
  const all = Array.isArray(messages) ? messages : [];
  const texts = all
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message && message.type === 'text' && String(message.text || '').trim());
  if (!inquiryId || !texts.length) return 0;

  const sent = Array.isArray(sentMessages) ? sentMessages : [];
  const { saveInquiryMessage } = require('../repositories/v2InquiryRepositoryAsync');
  return withDriver(async (db) => {
    let saved = 0;
    for (const { message, index } of texts) {
      const lineMessageId = sent[index] && sent[index].id ? String(sent[index].id) : null;
      await saveInquiryMessage(db, {
        inquiryId,
        senderUserId: null,
        direction: 'outbound',
        messageType: 'text',
        textContent: message.text,
        providerMessageId: lineMessageId
          || (channelEventPublicId ? `agent-reply:${channelEventPublicId}:${index}` : null)
      });
      saved += 1;
    }
    return saved;
  });
}

async function persistChannelEvent(db, {
  providerEventId, eventType, lineIdentityId, userId, inquiryId, rawPayload
}) {
  const existing = await db.get(
    'SELECT id, public_id, processing_status FROM channel_events WHERE provider = ? AND provider_event_id = ?',
    [PROVIDER, providerEventId]
  );
  if (existing) {
    return { id: existing.id, publicId: existing.public_id, replayed: true, status: existing.processing_status };
  }

  const publicId = `channel-event-${crypto.randomUUID()}`;
  const rawPayloadJson = JSON.stringify(rawPayload || {});
  // channel_events.raw_hash 是既有的不可空稽核欄位。Gateway 先前只寫 payload，
  // 在真的開啟 Agent flag 後會被資料庫拒絕，連 sidecar 都到不了。
  const rawHash = crypto.createHash('sha256').update(rawPayloadJson, 'utf8').digest('hex');
  try {
    await db.run(`
      INSERT INTO channel_events
        (public_id, provider, provider_event_id, event_type, line_identity_id, user_id,
         inquiry_id, received_at, processing_status, raw_payload_json, raw_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
    `, [
      publicId, PROVIDER, providerEventId, eventType,
      lineIdentityId ?? null, userId ?? null, inquiryId ?? null,
      new Date().toISOString(),
      // raw payload 只留結構欄位。訊息全文已經在 messages 裡有一份,
      // 這裡再存一份等於把同一段個資散到第二張表。
      rawPayloadJson,
      rawHash
    ]);
  } catch (error) {
    // 兩個 worker 同時收到同一則重送。回既有那筆,不新增第二列。
    const raced = await db.get(
      'SELECT id, public_id, processing_status FROM channel_events WHERE provider = ? AND provider_event_id = ?',
      [PROVIDER, providerEventId]
    );
    if (!raced) throw error;
    return { id: raced.id, publicId: raced.public_id, replayed: true, status: raced.processing_status };
  }

  const created = await db.get('SELECT id, public_id FROM channel_events WHERE public_id = ?', [publicId]);
  return { id: created.id, publicId, replayed: false, status: 'received' };
}

async function markEventProcessed(db, channelEventId, status = 'processed') {
  await db.run(`
    UPDATE channel_events
    SET processing_status = ?, processed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND processing_status IN ('received', 'processing')
  `, [status, channelEventId]);
}

// --- 5. 房源錯置偵測 ----------------------------------------------------------

// 房源名稱裡真正有辨識度的片段。兩個字以下的詞(「套房」「雅房」)幾乎每一筆房源
// 都有,拿來比對只會製造假警報。
function distinctiveTokens(title) {
  const tokens = String(title || '')
    .split(/[\s,、，。()（）\-—－_/／|｜]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  return [...new Set(tokens)];
}

// 標題常常沒有空白(「信義區套房」),房客只會說「信義區那間」。從標題與地址抽出
// 區/路/街名當辨識片段;先砍掉縣市,否則「市信義區」這種跨界片段會被抓出來。
function placeNames(...texts) {
  const names = texts.flatMap((text) => String(text || '')
    .replace(/^.*?[市縣]/u, '')
    .match(/[一-鿿]{2,3}?(?:區|路|街)/gu) || []);
  return [...new Set(names)];
}

/**
 * 房客這句話看起來在問**另一筆**詢問的房源嗎?
 *
 * 只在有明確證據時回 true:對方訊息裡出現另一筆房源獨有的名稱片段,而且那個
 * 片段不屬於目前這一筆。這是保守的判準 —— 誤判成錯置只是多問一句,
 * 誤判成沒錯置會把 A 房的條件寫進 B 房的合約。
 */
async function detectListingMismatch(db, { tenantUserId, currentInquiryId, text }) {
  const message = String(text || '');
  if (!message.trim()) return { mismatched: false, candidates: [] };

  const rows = await db.all(`
    SELECT inq.public_id AS inquiry_public_id, inq.id AS inquiry_id, l.title,
           COALESCE(s.normalized_address, p.address_text) AS address
    FROM inquiries inq
    JOIN listings l ON l.id = inq.listing_id
    LEFT JOIN listing_snapshots s ON s.id = l.latest_valid_snapshot_id
    LEFT JOIN rental_units ru ON ru.id = l.rental_unit_id
    LEFT JOIN properties p ON p.id = ru.property_id
    WHERE inq.user_id = ?
      AND inq.ended_at IS NULL
    ORDER BY inq.id
  `, [tenantUserId]);
  if (rows.length < 2) return { mismatched: false, candidates: [] };

  const current = rows.find((row) => sameId(row.inquiry_id, currentInquiryId));
  const tokensOf = (row) => [...distinctiveTokens(row && row.title), ...placeNames(row && row.title, row && row.address)];
  const currentTokens = new Set(tokensOf(current));

  const candidates = [];
  for (const row of rows) {
    if (sameId(row.inquiry_id, currentInquiryId)) continue;
    const own = tokensOf(row).filter((token) => !currentTokens.has(token));
    if (own.some((token) => message.includes(token))) {
      candidates.push({ inquiryPublicId: row.inquiry_public_id, listingTitle: row.title });
    }
  }
  return { mismatched: candidates.length > 0, candidates };
}

// 轉問房東之後要跟房客說什麼。三種結果三句話,不可以混用 ——
// 尤其「找不到房東」不能講成「已經轉給房東」,房客會一直等一個不存在的回覆。
function escalationReplyText(result) {
  if (result.noLandlord) return '目前找不到這個房源的有效房東，請稍後再試。';
  if (result.created) return '已建立房東待回覆問題。房東可在「通知與待辦事項」查看。';
  if (result.replayed) return '這題已建立房東待回覆問題，不會重複建立。';
  return '尚未成功建立房東待回覆問題，請稍後再試。';
}

// 「要不要幫你問房東」。按鈕只帶 channel event 的 public id —— postback data 是
// 使用者可以改的字串,問題內容一律由 handler 從資料庫重新取。
const ASK_LANDLORD_POSTBACK_ACTION = 'ecs_agent_ask_landlord';
const ASK_SIGNED_LANDLORD_POSTBACK_ACTION = 'ecs_agent_ask_signed_landlord';
const DECLINE_LANDLORD_POSTBACK_ACTION = 'ecs_agent_skip_landlord';

function askLandlordPrompt(channelEventPublicId) {
  const text = '這題目前沒有可以直接引用的房源資料。要幫你詢問房東嗎？';
  return {
    type: 'template',
    altText: text,
    template: {
      type: 'buttons',
      text,
      // 兩顆按鈕才是一個問句。只有「幫我問房東」的話,這則訊息讀起來像要求而不是
      // 選擇,房客只能按或裝作沒看到。「先不用」不寫任何資料,只把互動收掉。
      actions: [
        {
          type: 'postback',
          label: '幫我問房東',
          data: `action=${ASK_LANDLORD_POSTBACK_ACTION}&event=${encodeURIComponent(channelEventPublicId || '')}`,
          displayText: '幫我問房東'
        },
        {
          type: 'postback',
          label: '先不用',
          data: `action=${DECLINE_LANDLORD_POSTBACK_ACTION}`,
          displayText: '先不用'
        }
      ]
    }
  };
}

/**
 * 房客按下「幫我問房東」。
 *
 * 這一步才建立房東待辦 —— 模型自己不能開單。送給房東的問題是**房客當時的原話**,
 * 從 channel event 反查回那一則訊息重新取,不用 postback 帶進來的任何字串,也不用
 * 模型寫的版本。房東要判斷的是房客真的問了什麼。
 *
 * idempotencyKey 跟模型自願轉問時用的是同一個(agent-turn:<event>),所以連按兩下、
 * 或模型後來又轉問同一題,都只會有一則待辦。
 */
async function handleAgentEscalationPostback(db, { lineUserId, channelEventPublicId }) {
  if (!lineUserId || !channelEventPublicId) return { handled: false, messages: [] };

  // 身分與歸屬一起驗:這個 LINE 使用者必須就是那筆 channel event 的當事房客。
  const row = await db.get(`
    SELECT ce.provider_event_id, ce.inquiry_id, inq.listing_id,
           l.rental_unit_id, ru.property_id
    FROM channel_events ce
    JOIN inquiries inq ON inq.id = ce.inquiry_id
    JOIN listings l ON l.id = inq.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN line_identities li ON li.user_id = inq.user_id
    WHERE ce.public_id = ? AND li.line_user_id = ? AND inq.ended_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.source_inquiry_id=inq.id AND c.status='executed')
  `, [channelEventPublicId, lineUserId]);
  if (!row) {
    return { handled: true, messages: [textMessage('這則詢問已結束、已簽約或找不到。已簽約請從合約中心開啟合約助理。')] };
  }

  const message = await db.get(`
    SELECT id, text_content FROM messages
    WHERE inquiry_id = ? AND provider = ? AND provider_message_id = ?
  `, [row.inquiry_id, PROVIDER, row.provider_event_id]);
  if (!message || !String(message.text_content || '').trim()) {
    return { handled: true, messages: [textMessage('找不到當時的問題內容，請再說一次你要問的事。')] };
  }

  const landlord = await db.get(`
    SELECT po.owner_user_id
    FROM property_owners po
    WHERE po.property_id = ?
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ?)
      AND po.effective_from <= ?
      AND (po.effective_until IS NULL OR po.effective_until >= ?)
    ORDER BY po.rental_unit_id DESC, po.id DESC
    LIMIT 1
  `, [
    row.property_id, row.rental_unit_id,
    `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`,
    new Date().toISOString().slice(0, 10)
  ]);

  const result = await openLandlordQuestion(db, {
    inquiryId: row.inquiry_id,
    listingId: row.listing_id,
    sourceMessageId: message.id,
    questionText: String(message.text_content).slice(0, 500),
    idempotencyKey: `agent-turn:${channelEventPublicId}`,
    landlordUserId: landlord ? landlord.owner_user_id : null
  });

  return { handled: true, messages: [textMessage(escalationReplyText(result))], notificationIds: result.notificationIds || [] };
}

function uriButton(label, uri) {
  return { type: 'action', action: { type: 'uri', label, uri } };
}

// Signed questions use a separate, explicitly authorized contact command.
// The old presigning buttons remain invalid once their inquiry is signed.
async function handleSignedLandlordPostback(db, { lineUserId, channelEventPublicId, contractPublicId }) {
  if (require('./testRoleService').getActiveRole(lineUserId) === 'landlord') {
    return { handled: true, messages: [textMessage('請切換房客身分，再確認是否轉問房東。')] };
  }
  return db.transaction(async tx => {
    const row = await tx.get(`
      SELECT ce.inquiry_id, ce.provider_event_id, inq.listing_id, c.id AS contract_id
      FROM channel_events ce
      JOIN inquiries inq ON inq.id=ce.inquiry_id
      JOIN contracts c ON c.source_inquiry_id=inq.id AND c.status='executed'
      JOIN contract_parties cp ON cp.contract_id=c.id AND cp.party_role='tenant' AND cp.status='active'
      JOIN line_identities li ON li.user_id=cp.user_id
      WHERE ce.public_id=? AND c.public_id=? AND li.line_user_id=?
        AND inq.user_id=cp.user_id AND ce.user_id=cp.user_id
    `, [channelEventPublicId, contractPublicId, lineUserId]);
    if (!row) return { handled: true, messages: [textMessage('無法確認這筆問題與合約的權限，請從自己的房源重新提問。')] };
    const message = await tx.get(`SELECT id,text_content FROM messages
      WHERE inquiry_id=? AND provider=? AND provider_message_id=? AND direction='inbound' AND message_type='text'`,
    [row.inquiry_id, PROVIDER, row.provider_event_id]);
    if (!message?.text_content?.trim()) return { handled: true, messages: [textMessage('找不到原問題，請重新提問。')] };
    const landlords = await tx.all(`SELECT DISTINCT user_id FROM contract_parties
      WHERE contract_id=? AND party_role='landlord' AND status='active'`, [row.contract_id]);
    if (landlords.length !== 1) return { handled: true, messages: [textMessage('目前無法確認唯一的收件房東，尚未轉交，請聯繫客服協助。')] };
    const result = await openLandlordQuestion(tx, {
      inquiryId: row.inquiry_id, listingId: row.listing_id, sourceMessageId: message.id,
      questionText: String(message.text_content).slice(0, 500),
      idempotencyKey: `signed-contact:${contractPublicId}:${channelEventPublicId}`,
      landlordUserId: landlords[0].user_id, escalationReason: 'signed_contract_question', preserveInquiryState: true
    });
    return { handled: true, messages: [textMessage(escalationReplyText(result))], notificationIds: result.notificationIds || [] };
  });
}

// 已簽合約的問題：短答加原文依據，網址一律放按鈕。要改合約只回一句話，不必問模型。
async function answerSignedQuestion({ withDriver, lineUserId, contractPublicId, text, prefix = '', extraButtons = [], channelEventPublicId }) {
  const id = encodeURIComponent(contractPublicId);
  let body;
  let offerEscalation = false;
  if (/改|變更|調整|重簽/.test(text) && !/修理|維修|報修/.test(text)) {
    body = '已簽好的合約不能單方面修改，需要雙方另外談。';
  } else if (/完成了?嗎|下載|在哪(裡)?看/.test(text)) {
    body = '雙方都簽好了，合約已完成。點下面「查看合約」就能看完成文件，也能下載。';
  } else {
    try {
      const result = await withDriver((db) => require('./postSigningAssistantService').ask({
        db, lineUserId, contractPublicId, role: 'tenant', question: text }));
      body = [result.answer, ...result.citations.map(quote => `合約寫：「${quote.quote}」`)].join('\n\n');
      if (!result.citations.length && channelEventPublicId) {
        body = '合約裡沒有寫到這件事。要幫你詢問房東嗎？';
        offerEscalation = true;
      }
    } catch {
      body = '這題我暫時查不到，可以點下面「查看合約」看條文。';
    }
  }
  const items = [...(extraButtons || []), uriButton('查看合約', liffUrl(`/v2/contracts/${id}/completed`))];
  if (offerEscalation) items.unshift(
    { type: 'action', action: { type: 'postback', label: '幫我問房東', displayText: '幫我問房東',
      data: `action=${ASK_SIGNED_LANDLORD_POSTBACK_ACTION}&event=${encodeURIComponent(channelEventPublicId)}&contract=${id}` } },
    { type: 'action', action: { type: 'postback', label: '先不用', displayText: '先不用', data: `action=${DECLINE_LANDLORD_POSTBACK_ACTION}` } }
  );
  if (/報修|壞|漏水|維修|修理|故障/.test(text)) items.push(uriButton('填報修單', liffUrl(`/v2/contracts/${id}/assistant`)));
  return { ...textMessage(`${prefix}${body}`.slice(0, 4900)), quickReply: { items } };
}

// 只有簽完約才會問的話。寬了會把簽約前的正常提問（「租約可以簽一年嗎」）攔掉。
const SIGNED_ONLY_QUESTION = /租約到(什麼時候|哪|期)|合約(什麼時候)?到期|租期到(什麼時候|哪)|(已經|我)簽(好|的)(的)?合約|押金(什麼時候|何時)退|退租(要|怎麼)/;

function listingSwitchMessage(candidates) {
  const names = candidates.map((candidate) => `「${candidate.listingTitle}」`).join('、');
  return textMessage([
    `你這句話看起來是在問 ${names}，但目前的對話綁定的是另一筆房源。`,
    '',
    '為了不把兩間房的條件混在一起，我先不記錄這一則。',
    '請開啟「找房紀錄」切換到你要談的那一間，再說一次。'
  ].join('\n'));
}

// --- domain commands ----------------------------------------------------------

/**
 * escalate_to_landlord。以 event 推導的 idempotency key 建一次問題,commit 後才通知。
 */
async function openLandlordQuestion(db, {
  inquiryId, listingId, sourceMessageId, questionText, idempotencyKey, landlordUserId, escalationReason = null, preserveInquiryState = false
}) {
  // 沒有有效房東就整筆不做。
  //
  // 原本照樣建立待辦、只是不入列通知,然後回房客「已經轉給房東」—— 那是騙人:
  // 沒有人收得到那一題,房客卻在等回覆。這一關放在共用的 command 裡,轉問的兩條路
  // (模型自己決定、房客按按鈕)都會被擋到,不必各自記得檢查。
  if (landlordUserId === null || landlordUserId === undefined) {
    return { created: false, noLandlord: true, questionPublicId: null };
  }

  return db.transaction(async (tx) => {
    const existing = await tx.get(
      'SELECT public_id FROM landlord_questions WHERE idempotency_key = ?',
      [idempotencyKey]
    );
    if (existing) return { created: false, replayed: true, questionPublicId: existing.public_id };

    const publicId = `question-${crypto.randomUUID()}`;
    await tx.run(`
      INSERT INTO landlord_questions
        (public_id, inquiry_id, listing_id, source_message_id, question_text,
         escalation_reason, status, idempotency_key, asked_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)
    `, [publicId, inquiryId, listingId, sourceMessageId ?? null, questionText, escalationReason || 'knowledge_insufficient', idempotencyKey]);

    if (!preserveInquiryState) await tx.run(`
      UPDATE inquiries
      SET status = 'waiting_landlord', last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'inquiring'
    `, [inquiryId]);

    const notification = await enqueueNotification(tx, {
      eventType: 'landlord_question_created',
      entityType: 'landlord_question',
      entityId: publicId,
      payload: { questionPublicId: publicId },
      recipients: [{ role: 'landlord', userId: landlordUserId }],
      idempotencyKey: `landlord-question:${idempotencyKey}`
    });
    return { created: true, questionPublicId: publicId, notificationIds: notification.notificationId ? [notification.notificationId] : [] };
  });
}

/**
 * propose_tenant_confirmation。
 *
 * **Node 這裡不做第二次模型抽取。** 模型已經在同一個 turn 裡給了候選欄位與來源;
 * 再抽一次會得到兩份可能不同的條件,而房客看到的與寫進去的就會不一致。
 * 這裡做的是驗證:欄位在白名單內、來源型別合法、source_id 真的指到**這一筆詢問**
 * 的訊息。任何一項不成立就整批拒絕,不寫半套。
 */
async function saveProposedIntentionVersion(db, {
  inquiryId, listingId, tenantUserId, candidates, authorizedKnowledge, base = null, skipIfUnchanged = false
}) {
  const normalized = buildIntentionCandidate({
    fields: candidates.map((candidate) => ({
      fieldPath: candidate.fieldPath,
      value: candidate.value,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId
    }))
  });

  const fieldPaths = Object.keys(normalized.candidate);
  if (!fieldPaths.length) {
    const error = new Error('模型沒有給出任何有來源的候選條件');
    error.code = 'clarification_required';
    error.statusCode = 409;
    throw error;
  }

  const allowedSources = groundingIndex(authorizedKnowledge);
  const sources = Object.values(normalized.sources).flat();
  for (const source of sources) {
    if (source.sourceType !== 'message') {
      const entry = allowedSources.get(String(source.sourceId));
      if (!entry || entry.sourceType !== source.sourceType || entry.usePolicy === 'must_escalate' || source.sourceType === 'manual_input') {
        const error = new Error('候選條件來源未授權'); error.code = 'invalid_model_output'; error.statusCode = 400; throw error;
      }
    }
  }
  let currentSources = allowedSources;
  if (sources.some((source) => source.sourceType !== 'message')) {
    const inquiry = await db.get('SELECT public_id FROM inquiries WHERE id=?', [inquiryId]);
    if (!inquiry) { const error = new Error('來源詢問不存在'); error.code = 'invalid_model_output'; error.statusCode = 400; throw error; }
    currentSources = groundingIndex(await searchAuthorizedKnowledge(db, { actorUserId: tenantUserId, inquiryPublicId: inquiry.public_id }));
  }
  for (const source of sources) {
    if (source.sourceType === 'message') continue;
    const entry = allowedSources.get(String(source.sourceId));
    const current = currentSources.get(String(source.sourceId));
    if (!entry || !current || entry.sourceType !== source.sourceType || current.sourceType !== source.sourceType || current.usePolicy === 'must_escalate' || source.sourceType === 'manual_input') {
      const error = new Error('候選條件來源未授權');
      error.code = 'invalid_model_output'; error.statusCode = 400; throw error;
    }
    const table = source.sourceType === 'knowledge_version' ? 'knowledge_versions' : 'listing_snapshots';
    const row = await db.get(`SELECT id FROM ${table} WHERE public_id=?`, [String(source.sourceId)]);
    if (!row) { const error = new Error('候選條件來源不存在'); error.code = 'invalid_model_output'; error.statusCode = 400; throw error; }
    source.sourceId = row.id;
  }

  // source_id 必須指到這一筆詢問裡的訊息。少了這一關,模型只要回一個別人的
  // message id,那筆條件就會宣稱「依據某段對話」,而那段對話是別人的。
  const messageSourceIds = [...new Set(
    Object.values(normalized.sources)
      .flat()
      .filter((source) => source.sourceType === 'message')
      .map((source) => String(source.sourceId))
  )];
  if (messageSourceIds.length) {
    const owned = await db.all(
      `SELECT id FROM messages WHERE inquiry_id = ? AND id IN (${messageSourceIds.map(() => '?').join(',')})`,
      [inquiryId, ...messageSourceIds]
    );
    const ownedIds = new Set(owned.map((row) => String(row.id)));
    const foreign = messageSourceIds.filter((id) => !ownedIds.has(id));
    if (foreign.length) {
      const error = new Error(`來源訊息不屬於這一筆房源詢問:${foreign.join(', ')}`);
      error.code = 'invalid_model_output';
      error.statusCode = 400;
      throw error;
    }
  }

  // condition_json 由 Node 從候選欄位 deterministic 地組出來,不採用模型自由文字。
  // 從上一版開始疊:房客常常只補一兩項(「修繕房東負責」),模型這一輪也只給那幾項。
  // 從零開始的話新版會只剩那幾項,租金、租期全不見,房客卻聽 AI 說「其他沿用」。
  const conditionJson = base && base.conditionJson ? JSON.parse(JSON.stringify(base.conditionJson)) : {};
  for (const [fieldPath, mapping] of Object.entries(CANDIDATE_CONDITION_PATHS)) {
    if (!(fieldPath in normalized.candidate)) continue;
    setPath(conditionJson, mapping.path, normalized.candidate[fieldPath]);
  }
  if (normalized.candidate.pet_request_text !== undefined) {
    conditionJson.use_restrictions = { pet_allowed: null, pet_note: normalized.candidate.pet_request_text };
  }
  const specialFields = ['equipment_request_text', 'viewing_request_text', 'special_request_text']
    .map((fieldPath) => normalized.candidate[fieldPath])
    .filter((value) => typeof value === 'string' && value.trim());
  if (specialFields.length) conditionJson.special_terms = otherAgreements(specialFields.flatMap((text) => text.split(/\r?\n/)));

  const fields = fieldPaths.map((fieldPath) => ({
    // special free-text fields are not contract clause fields. All structured
    // candidate fields use the exact downstream clause name for provenance.
    path: (CANDIDATE_CONDITION_PATHS[fieldPath] || {}).clauseField || (['equipment_request_text', 'viewing_request_text', 'special_request_text'].includes(fieldPath) ? 'specialRequest' : fieldPath),
    sources: normalized.sources[fieldPath]
  }));
  const mergedFields = new Map();
  for (const field of fields) {
    const sources = mergedFields.get(field.path) || [];
    for (const source of field.sources) {
      if (!sources.some((item) => item.sourceType === source.sourceType && String(item.sourceId) === String(source.sourceId))) sources.push(source);
    }
    mergedFields.set(field.path, sources);
  }
  fields.splice(0, fields.length, ...[...mergedFields].map(([path, sources]) => ({ path, sources })));
  // 沿用的欄位連來源一起帶過來,每個欄位仍然查得到是房客哪一句話。
  const restated = new Set(fields.map((field) => field.path));
  const carried = new Map();
  for (const source of (base && base.sources) || []) {
    if (restated.has(source.field_path)) continue;
    if (!carried.has(source.field_path)) carried.set(source.field_path, []);
    carried.get(source.field_path).push({ sourceType: source.source_type, sourceId: source.source_id });
  }
  for (const [path, sources] of carried) fields.push({ path, sources });

  // 條件跟現有最新版一模一樣時不建立第二版。版本是不可變提案,一模一樣的兩版
  // 只會讓房客分不清要確認哪一個。
  if (skipIfUnchanged && base && base.conditionJson && canonicalJson(conditionJson) === canonicalJson(base.conditionJson)) {
    return null;
  }

  const saved = await saveIntentionVersion({
    db, inquiryId, listingId, tenantUserId, actorUserId: tenantUserId, conditionJson, fields
  });
  return { ...saved, normalized };
}

// --- grounding 與 use_policy 的 Node 端執行 -----------------------------------
//
// 在這之前,模型說「我引用了某條規則」和「這題房東交代要自己回答」全靠 prompt 自律。
// 沒有人檢查它引用的 id 是否真的存在,也沒有人檢查它有沒有繞過 must_escalate。
// 一次不聽話就是把房東沒授權的話講給房客聽,而且看起來像有依據。
//
// 兩條規則,必須一起看才閉合:
//   1. 引用的來源要真的在**這一輪**的 authorizedKnowledge 裡。查詢本身已經把
//      internal、過期、停用、未核准、別人 inquiry 的回答排除掉了,所以「在不在
//      這一輪的清單裡」等於「這位房客現在可不可以看到它」。
//   2. 引用到 use_policy = must_escalate 的知識時,不管模型輸出什麼一律轉問房東。
//      那條知識的意思就是「這題房東要自己回答」。
//
// 第 2 條只擋得住「有引用卻自己回答」。模型完全不引用、自己編一句的情況要靠第 1 條
// 加上「answer 至少要有一個有效來源」才擋得住 —— 少做其中一條就會留下空窗。
const AUTHORIZED_KNOWLEDGE_GROUPS = Object.freeze([
  'listingFacts', 'knowledge', 'publicRules', 'inquiryAnswers'
]);

function groundingIndex(authorizedKnowledge) {
  const index = new Map();
  for (const group of AUTHORIZED_KNOWLEDGE_GROUPS) {
    for (const entry of (authorizedKnowledge && authorizedKnowledge[group]) || []) {
      if (entry && entry.publicId) index.set(String(entry.publicId), { ...entry, knowledgeGroup: group });
    }
  }
  return index;
}

// 只渲染授權來源的公開欄位，不能把模型自由文字或整份物件當成事實。
function sourceAnswerText(entry, tenantText) {
  if (entry.knowledgeGroup === 'knowledge') return typeof entry.contentText === 'string' ? entry.contentText.trim() : '';
  if (entry.knowledgeGroup === 'inquiryAnswers') return typeof entry.answerText === 'string' ? entry.answerText.trim() : '';
  if (entry.knowledgeGroup === 'publicRules') {
    const rule = entry.ruleValue || {};
    const text = rule.confirmedText || rule.label || rule.description || rule.originalText;
    return typeof text === 'string' ? text.trim() : '';
  }
  if (entry.knowledgeGroup !== 'listingFacts') return '';
  const fields = {
    normalizedTitle: ['房源', /房名|名稱|標題/],
    normalizedAddress: ['地址', /地址|位置|地點|在哪|哪裡/],
    rentAmount: ['每月租金（元）', /租金(?!補助)|月租|房租|租多少/],
    depositAmount: ['押金（元）', /押金/],
    managementFeeAmount: ['管理費（元）', /管理費/],
    petPolicyText: ['寵物規定', /寵物|養貓|養狗|養一隻/]
  };
  // 快照有租金不代表能回答交通時間、補助資格等另一種事實。
  const facts = Object.entries(fields)
    .filter(([key, [, question]]) => question.test(tenantText) &&
      ((typeof entry[key] === 'string' && entry[key].trim()) ||
      (typeof entry[key] === 'number' && Number.isFinite(entry[key]))))
    .map(([key, [label]]) => label + '：' + entry[key]);
  if (/設備|設施|家具|家電|冷氣|冷器|空調|冰箱|洗衣機|熱水器|床|網路|wifi/i.test(tenantText)
      && Array.isArray(entry.amenities) && entry.amenities.every((value) => typeof value === 'string')) {
    if (entry.amenities.length) facts.push('設備：' + entry.amenities.join('、'));
  }
  // 591 的押金、寵物、開伙、電費多半只寫在說明裡。照樣只貼原文句子，不用模型的話。
  for (const sentence of descriptionSentences(entry.description, tenantText)) facts.push('房源說明：' + sentence);
  return [...new Set(facts)].join('\n');
}

// 房客想改規定（押金只付一個月、狗超過重量）時，只貼規定會像沒回答。
function changeRequestNote(tenantText) {
  const text = String(tenantText || '');
  if (!/(可以|能不能|可不可以|能否).{0,12}(只|改|少|降|減|便宜|算我|延|提早|超過)|超過|\d+\s*(公斤|kg)/i.test(text)) return '';
  return '你提的和上面的規定不同，要房東同意才算數。需要的話跟我說「幫我問房東」，我會把你的原話轉給房東。';
}

function descriptionFallback(action, authorizedKnowledge, tenantText, introductionText) {
  const entry = (authorizedKnowledge?.listingFacts || [])[0];
  const sentences = entry ? descriptionSentences(entry.description, tenantText) : [];
  if (!sentences.length || !entry.publicId) return null;
  return { ...action, type: 'answer', offerEscalation: false, conditionCandidates: [],
    responseText: [introductionText, '依據目前房源資料：\n' + sentences.map((value) => '房源說明：' + value).join('\n'), changeRequestNote(tenantText)].filter(Boolean).join('\n\n').slice(0, 2000),
    groundingRefs: [String(entry.publicId)] };
}

// 房客口語和 591 寫法常不同，先把問題換成說明裡會出現的字。
const DESCRIPTION_SYNONYMS = [
  [/煮飯|煮東西|下廚|開伙/, '開伙'], [/狗|柴犬|貴賓|犬|\bdogs?\b/i, '犬'], [/貓|\bcats?\b/i, '貓'], [/寵物|毛小孩|\bpets?\b/i, '養'],
  [/租多久|租期|最短|至少租/, '租期'], [/補助|補貼/, '補助'], [/報稅|申報/, '報稅'],
  [/電費|一度|每度/, '電'], [/水費/, '水'], [/抽菸|抽煙|吸菸/, '菸'], [/押金|保證金/, '押金'], [/管理費/, '管理費']
];

function descriptionSentences(description, tenantText) {
  if (typeof description !== 'string' || !description.trim()) return [];
  const keys = DESCRIPTION_SYNONYMS.filter(([pattern]) => pattern.test(String(tenantText || ''))).map(([, key]) => key);
  if (!keys.length) return [];
  return description.split(/[。；;！!\n]+/).map((value) => value.trim()).filter(Boolean)
    .filter((sentence) => keys.some((key) => sentence.includes(key) || (key === '租期' && /最短|至少/.test(sentence))))
    .slice(0, 5);
}

/**
 * 回傳實際要執行的 action。必要時把它改寫成轉問房東。
 *
 * answer 是唯一「宣稱事實」的 action,所以只有它強制要有來源。ask_clarification
 * 在問問題、explain_status_or_change 轉述的是 Node 自己算出來的 caseStatus、
 * show_condition_summary 整理的是房客自己說過的話 —— 都不需要引用房東知識,
 * 強迫它們引用只會逼模型亂指一個 id。
 *
 * 沒有有效來源的 answer 分成兩種處置,差別在於**會不會替房東製造待辦**:
 *
 *   有合法的條件候選 → 丟掉模型的答案,只留條件整理。房客真正在做的事是講條件,
 *                      那一段有原文可查,不需要驚動房東。
 *   沒有條件候選     → 問房客要不要轉問房東,不直接開單。模型出一次錯就在房東的
 *                      待回答清單裡多一則,房東會被閒聊洗版,久了整個清單就沒人看。
 *
 * 唯一直接開單的是 must_escalate:那是房東自己交代「這題一定要問我」,建立待辦
 * 正是他要的結果,不是模型出錯。
 *
 * @param {string} tenantText 房客的原話。轉問房東時用它,不用模型擅自寫的答案。
 */
const CONTRACT_TERM_GLOSSARY = [
  [/提前終止|提前解約|提早解約|違約金/, '提前終止：租約還沒到期就想搬走（或房東想收回）時要怎麼處理，通常約定要提前多久通知、要不要賠償（例如賠一個月租金）。'],
  [/修繕/, '修繕責任：東西壞了誰負責修、誰出錢，常見是一般老舊損壞由房東修、人為弄壞由房客修。'],
  [/費用分擔|分擔/, '費用分擔：水費、電費、瓦斯、管理費、網路這些各由誰付。']
];

function enforceGroundingPolicy(action, authorizedKnowledge, tenantText, listing, caseStatus) {
  // 純社交訊息沒有房源事實；只匹配整句，避免吃掉「你好，租金能降嗎」。
  const socialText = String(tenantText || '').normalize('NFKC').toLowerCase().replace(/[\s!！?？。,.，、~～]/gu, '');
  const greeting = ['你好', '您好', '嗨', '哈囉', '哈啰', '早安', '午安', '晚安', 'hi', 'hello'].includes(socialText);
  const thanks = ['謝謝', '謝謝你', '謝謝您', '感謝', '感謝你', 'thanks', 'thankyou'].includes(socialText);
  const help = ['你能幫我什麼', '你可以幫我什麼', '可以幫我什麼', '你會做什麼', '你有什麼功能', '你能做什麼'].includes(socialText);
  if (greeting || thanks || help) {
    return {
      ...action, type: 'ask_clarification',
      responseText: thanks ? '不客氣！有其他租屋問題或想整理條件，隨時跟我說。'
        : greeting ? '你好！你可以問目前這間房的資訊、跟我整理承租條件，或查看合約進度。你想先聊哪一項？'
        : '我可以依目前房源資料回答問題、整理承租條件及說明合約進度。需要房東決定的事會請你確認是否轉問；條件確認與簽署要由你本人操作。你想先處理哪一項？',
      groundingRefs: [], conditionCandidates: [], conflicts: [], missingFields: [],
      offerEscalation: false, forcedEscalation: false, decisionClassification: 'needs_clarification'
    };
  }
  // 押金上限是法條，不是房源事實；只拿房源資料回答會讓房客以為「最少兩個月」合法。
  if (/押金/.test(String(tenantText || '')) && /最多|上限|合法|違法|法律|法規/.test(String(tenantText || '')) && /[?？嗎]/.test(String(tenantText || ''))) {
    return {
      ...action, type: 'ask_clarification',
      responseText: '依《租賃住宅市場發展及管理條例》第 7 條，押金不得超過兩個月租金總額。房東可以收少於兩個月，但不能要求超過兩個月。',
      groundingRefs: [], conditionCandidates: [], conflicts: [], missingFields: [],
      offerEscalation: false, forcedEscalation: false, decisionClassification: 'needs_clarification'
    };
  }
  // 合約名詞解釋用固定文字，不是房源事實，也不需要房東回答。
  if (/意思|不懂|是指|是什麼/.test(String(tenantText || ''))) {
    const glossary = CONTRACT_TERM_GLOSSARY.filter(([pattern]) => pattern.test(String(tenantText || ''))).map(([, text]) => text);
    if (glossary.length) {
      return {
        ...action, type: 'ask_clarification',
        responseText: `${glossary.join('\n\n')}\n\n你和房東想怎麼約定，直接跟我說，我會整理成條件給你確認。`,
        groundingRefs: [], conditionCandidates: [], conflicts: [], missingFields: [],
        offerEscalation: false, forcedEscalation: false, decisionClassification: 'needs_clarification'
      };
    }
  }
  // 房客請 AI 代填時給「範本＋這間房源說明」的建議，只是草案：房客確認後，
  // 房東在送簽前仍要確認條件，所以不會繞過房東。
  if (!caseStatus?.tenantConfirmedVersion && /照一般|一般(的)?規定|照範本|你幫我(填|寫|決定|擬)|幫我填|預設就好/.test(String(tenantText || ''))) {
    const description = (authorizedKnowledge?.listingFacts || []).map((entry) => entry.description || '').join('');
    const fee = description.match(/管理費[^。；;]*/)?.[0];
    const responseText = [
      '我依內政部住宅租賃定型化契約範本，加上這間房源的說明，先擬一版給你參考：',
      '・提前終止：任一方要提前解約，至少一個月前通知，賠償不超過一個月租金。',
      '・修繕責任：一般損壞由房東修繕；你使用不當或人為弄壞的由你負責。',
      `・費用分擔：水電瓦斯由你付${fee ? `；房源說明寫「${fee}」，所以管理費也是你付` : '；管理費依房東的規定'}。`,
      '這只是建議，你覺得可以就回我「就照這樣」，我整理成條件卡給你確認；之後房東在送簽前也會再確認一次，有不同意的地方房東可以要求修改。'
    ].join('\n');
    return {
      ...action, type: 'ask_clarification', responseText,
      groundingRefs: [], conditionCandidates: [], conflicts: [], missingFields: [],
      offerEscalation: false, forcedEscalation: false, decisionClassification: 'needs_clarification'
    };
  }
  if (/介紹|細節|基本資料|整體狀況/.test(String(tenantText || '')) && /房|這間|這個/.test(String(tenantText || '')) && !/是否|能否|能不能|可不可以|可以|多少|什麼|哪些|如何|怎麼|有沒有|[嗎呢?？]|轉問|代問|幫我問|幫忙問|請問房東|問一下房東/.test(String(tenantText || ''))) {
    const facts = [];
    if (listing?.title) facts.push(`房源：${listing.title}`);
    if (listing?.currentRentAmount != null) facts.push(`月租金：${Number(listing.currentRentAmount).toLocaleString('zh-TW')} 元`);
    for (const entry of authorizedKnowledge?.listingFacts || []) {
      const detail = sourceAnswerText({ ...entry, knowledgeGroup: 'listingFacts' }, '地址 押金 管理費 寵物 設備');
      if (detail) facts.push(detail);
    }
    return { ...action, type: 'ask_clarification', responseText: facts.length ? `${[...new Set(facts)].join('\n')}\n其餘細節目前待確認。`.slice(0, 2000) : '請先到「找房紀錄」選擇要介紹的房源。', groundingRefs: [], conditionCandidates: [], offerEscalation: false };
  }
  const introductionText = /介紹/.test(String(tenantText || '')) && listing?.title
    ? [`房源：${listing.title}`, ...(listing.currentRentAmount != null ? [`月租金：${Number(listing.currentRentAmount).toLocaleString('zh-TW')} 元`] : [])].join('\n') : '';
  const declinesEscalation = /(不要|不必|不用|先別|別)[^。！？!?]{0,12}(轉問|代問|問房東)/.test(String(tenantText || ''));
  const explicitEscalation = /(轉問|代問|幫我問|幫忙問|請問房東|問一下房東)/.test(String(tenantText || '')) && !declinesEscalation;
  const ambiguousEscalation = /有答案才|有規定才/.test(String(tenantText || ''));
  const conditionalEscalation = /(如果|若|假如|沒寫|沒有寫|不知道|不清楚|未提|沒有規定)/.test(String(tenantText || ''));
  const index = groundingIndex(authorizedKnowledge);
  const refs = (action.groundingRefs || []).map(String);
  const cited = refs.filter((ref) => index.has(ref));

  // 詢問規則不代表房客已同意把規則寫成承租條件。
  const question = /[?？]|[嗎呢][。！!]*$|請問|能不能|可不可以|是否|能否|多少|什麼|哪些|如何|怎麼|有沒有/.test(String(tenantText || '').trim());
  if (question && !/整理|彙整|確認條件/.test(String(tenantText || ''))) {
    action = { ...action, type: ['propose_tenant_confirmation', 'show_condition_summary'].includes(action.type) ? 'answer' : action.type, conditionCandidates: [] };
  }

  if (cited.some((ref) => index.get(ref).usePolicy === 'must_escalate')) {
    if (declinesEscalation || ambiguousEscalation) return { ...action, type: 'ask_clarification', responseText: '這個問題需要房東確認，你希望我轉問嗎？', groundingRefs: [], offerEscalation: false };
    return {
      ...action,
      type: 'escalate_to_landlord',
      // 轉問房東的是房客原本的問題,不是模型擅自寫好的那段答案。
      responseText: String(tenantText || '').trim() || '房客有一題需要你回答。',
      groundingRefs: [],
      forcedEscalation: true
    };
  }

  if (action.type === 'answer') {
    const supported = cited.map((ref) => ({ ref, text: sourceAnswerText(index.get(ref), tenantText) })).filter((entry) => {
      if (!entry.text) return false;
      const source = index.get(entry.ref);
      if (/狗|犬/.test(tenantText) && /貓/.test(entry.text) && !/狗|犬/.test(entry.text)) return false;
      if (/貓/.test(tenantText) && /狗|犬/.test(entry.text) && !/貓/.test(entry.text)) return false;
      if (source.knowledgeGroup === 'listingFacts') return true;
      const normalize = (value) => String(value || '').toLowerCase().replace(/可以|請問|房東|幫我|什麼|多少|是否|如果|沒有|有沒有|規定|問題|怎麼|如何|[\s\p{P}]/gu, '');
      const question = normalize(tenantText);
      const material = normalize([source.topicText, source.questionText, entry.text].filter(Boolean).join(' '));
      if (/(多久|幾天|幾個月|多長時間|何時)/.test(tenantText) && !/(多久|幾天|幾個月|多長時間|何時|\d+\s*(天|日|週|月|年|小時))/.test(material)) return false;
      const terms = [...question].slice(0, -1).map((_, i) => question.slice(i, i + 2));
      return terms.some((term) => material.includes(term)) || ['貓', '狗', '犬'].some((term) => question.includes(term) && material.includes(term));
    });
    const facts = [...new Set(supported.map((entry) => entry.text))];
    if (explicitEscalation && !ambiguousEscalation && (!conditionalEscalation || !facts.length)) return { ...action, type: 'escalate_to_landlord', responseText: String(tenantText).trim(), groundingRefs: [], forcedEscalation: true };
    if (facts.length) {
      return { ...action, responseText: [introductionText, '依據目前房源資料與房東提供的內容：\n' + facts.join('\n\n'), changeRequestNote(tenantText)].filter(Boolean).join('\n\n').slice(0, 2000), groundingRefs: supported.map((entry) => entry.ref) };
    }
    if (action.conditionCandidates && action.conditionCandidates.length) {
      // responseText 清空:那段答案沒有依據,不可以送出去。條件卡片本身會說明
      // 整理到了什麼,房客不會只收到一則空訊息。
      return { ...action, type: 'show_condition_summary', responseText: '', groundingRefs: [] };
    }
    // 型別留 ask_clarification:agent_executions.proposed_action_type 有 CHECK
    // 約束,而這一步實際上就是在問房客一件事。差別在下面多一顆按鈕。
    return descriptionFallback(action, authorizedKnowledge, tenantText, introductionText) ||
      { ...action, type: 'ask_clarification', responseText: '目前沒有足夠的公開資料回答這個問題。', introductionText, groundingRefs: [], offerEscalation: true };
  }
  // 模型自己判斷要轉問房東，但說明裡其實有原文可答，就先答，不打擾房東。
  if (action.type === 'ask_clarification' && action.offerEscalation && !explicitEscalation) {
    const answered = descriptionFallback(action, authorizedKnowledge, tenantText, introductionText);
    if (answered) return answered;
  }

  if (explicitEscalation && !ambiguousEscalation) return { ...action, type: 'escalate_to_landlord', responseText: String(tenantText).trim(), groundingRefs: [], forcedEscalation: true };

  // 無效的 id 直接丟掉,不讓它流進 trace 假裝有依據。
  return refs.length === cited.length ? action : { ...action, groundingRefs: cited };
}

// --- action 分派 --------------------------------------------------------------

const CLASSIFICATION_BY_ACTION = Object.freeze({
  answer: 'grounded_and_authorized',
  ask_clarification: 'needs_clarification',
  escalate_to_landlord: 'needs_landlord',
  show_condition_summary: 'grounded_and_authorized',
  propose_tenant_confirmation: 'grounded_and_authorized',
  propose_landlord_decision: 'needs_landlord',
  explain_status_or_change: 'grounded_and_authorized',
  no_action: 'grounded_and_authorized'
});

function conditionFieldsWithSources(loaded) {
  return projectTrackedFields(loaded.conditionJson || {}).map((field) => {
    const mapping = Object.values(CANDIDATE_CONDITION_PATHS).find((entry) => entry.path.join('.') === field.path);
    return {
      ...field,
      sources: loaded.sources
        .filter((row) => row.field_path === field.path || (mapping && row.field_path === mapping.clauseField))
        .map((row) => ({ sourceType: row.source_type, sourceId: row.source_id }))
    };
  });
}

// 存好之後要給房客看的兩則訊息:模型的話,加上指名 exact version 的可確認卡片。
async function proposalMessages(db, { action, saved, scope, lineUserId }) {
  const loaded = await loadIntentionVersion({
    db, lineUserId, intentionVersionPublicId: saved.versionPublicId
  });
  const fields = conditionFieldsWithSources(loaded);
  return [
    ...(action.responseText ? [textMessage(action.responseText)] : []),
    presenter.conditionSummaryCard({
      versionPublicId: saved.versionPublicId,
      versionNumber: saved.versionNumber,
      listingTitle: scope.listing_title,
      fields,
      conflicts: saved.normalized.conflicts.map((conflict) => conflict.fieldPath),
      missingFields: saved.normalized.missingFields,
      unsourcedFields: []
    })
  ];
}

// 這一輪最新版的條件內容,用來判斷候選條件是不是真的有變。
async function latestVersion(db, { lineUserId, intention }) {
  const versions = (intention && intention.versions) || [];
  if (!versions.length) return null;
  const latest = versions.reduce((best, version) =>
    (!best || Number(version.versionNumber) > Number(best.versionNumber) ? version : best), null);
  return loadIntentionVersion({ db, lineUserId, intentionVersionPublicId: latest.publicId });
}

async function renderConditionSummary(db, { lineUserId, intention }) {
  const versions = (intention && intention.versions) || [];
  if (!versions.length) {
    return [textMessage('目前還沒有整理過的承租條件。請直接在聊天室說明租金、租期與押金，我整理好之後會給你一張可確認的卡片。')];
  }
  // 指名 exact version。清單本身沒有「最新版」欄位,所以這裡用 versionNumber
  // 的最大值挑「要顯示哪一張卡」——顯示不是確認,確認仍然要房客自己按。
  const latest = versions.reduce((best, version) =>
    (!best || Number(version.versionNumber) > Number(best.versionNumber) ? version : best), null);
  const loaded = await loadIntentionVersion({
    db, lineUserId, intentionVersionPublicId: latest.publicId
  });
  const fields = conditionFieldsWithSources(loaded);
  return [presenter.conditionSummaryCard({
    versionPublicId: loaded.versionPublicId,
    versionNumber: loaded.versionNumber,
    listingTitle: loaded.listingTitle,
    fields,
    conflicts: [],
    missingFields: [],
    unsourcedFields: [],
    confirmed: loaded.confirmed
  })];
}

/**
 * 依 proposed action 執行對應的 deterministic domain command。
 *
 * 每一個 action 都在這裡有一個分支,而且**只有這八個**。未知 type 在
 * runtimeClient.validateAction 就已經被擋掉,這裡的 default 是防禦性的第二層。
 */
async function executeProposedAction(db, {
  action, scope, lineUserId, tenantUserId, sourceMessageId, channelEventPublicId, intention, authorizedKnowledge
}) {
  switch (action.type) {
    case 'answer':
      return { messages: [textMessage(action.responseText)] };

    case 'explain_status_or_change': {
      // 模型負責用自然語言回答；合約狀態與按鈕則由 Node 重新查詢後決定。
      // 這樣模型不能自己宣稱「已簽署」或把使用者導向無權限的簽署請求。
      const center = await contractCenterService.getContractCenter({ db, lineUserId });
      const related = await db.all('SELECT id FROM contracts WHERE source_inquiry_id = ?', [scope.inquiry_id]);
      const contracts = [...center.currentContracts, ...center.history];
      const matches = contracts.filter((contract) => related.some((row) => sameId(row.id, contract.id)));
      const card = matches.length === 1 ? contractStatusPresenter.statusCardMessage(matches[0]) : null;
      return { messages: [textMessage(action.responseText), ...(card ? [card] : [])] };
    }

    case 'ask_clarification':
      // 模型答不出來又沒有依據時,問房客要不要轉問房東 —— 不自己開單。
      // 「你好」「謝謝」不會變成房東的待辦,而真的需要答案的房客按一次就好。
      // 按下去之後送給房東的是**房客原文**,不是模型編的問題,那一段在
      // handleAgentEscalationPostback 裡從資料庫重新取,不信任 postback 帶的字串。
      if (action.offerEscalation) {
        return { messages: [...(action.introductionText ? [textMessage(action.introductionText)] : []), askLandlordPrompt(channelEventPublicId)] };
      }
      return { messages: [textMessage(action.responseText)] };

    case 'no_action':
      return { messages: [] };

    case 'show_condition_summary': {
      // 模型有時候會把「房客剛講出來的新條件」講成摘要。候選條件是房客真的說過、
      // 而且來源已經驗證過的事實 —— 不能因為模型挑了哪一個 type 就丟掉。丟掉的話
      // 卡片會顯示**舊**版本,房客會以為那就是他剛講的條件。
      // 內容跟最新版一樣時 saveProposedIntentionVersion 回 null,就只顯示,不加版本。
      const candidates = Array.isArray(action.conditionCandidates) ? action.conditionCandidates : [];
      if (candidates.length) {
        const saved = await saveProposedIntentionVersion(db, {
          inquiryId: scope.inquiry_id,
          listingId: scope.listing_id,
          tenantUserId,
          candidates,
          authorizedKnowledge,
          base: await latestVersion(db, { lineUserId, intention }),
          skipIfUnchanged: true
        });
        if (saved) return { messages: await proposalMessages(db, { action, saved, scope, lineUserId }) };
      }
      return {
        messages: [
          ...(action.responseText ? [textMessage(action.responseText)] : []),
          ...(await renderConditionSummary(db, { lineUserId, intention }))
        ]
      };
    }

    case 'escalate_to_landlord': {
      const landlord = await db.get(`
        SELECT po.owner_user_id
        FROM property_owners po
        WHERE po.property_id = ?
          AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ?)
          AND po.effective_from <= ?
          AND (po.effective_until IS NULL OR po.effective_until >= ?)
        ORDER BY po.rental_unit_id DESC, po.id DESC
        LIMIT 1
      `, [
        scope.property_id, scope.rental_unit_id,
        `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`,
        new Date().toISOString().slice(0, 10)
      ]);
      const result = await openLandlordQuestion(db, {
        inquiryId: scope.inquiry_id,
        listingId: scope.listing_id,
        sourceMessageId,
        // 轉問房東的內容是模型整理過的問題,不是房客訊息全文。
        questionText: action.responseText.slice(0, 500),
        // 出價題在房東那邊換成「接受這個價／不接受殺價／輸入最低價」。
        escalationReason: action.rentOffer ? 'rent_offer' : null,
        idempotencyKey: `agent-turn:${channelEventPublicId}`,
        landlordUserId: landlord ? landlord.owner_user_id : null
      });
      // 文案固定,不回放 responseText。Node 強制轉問時 responseText 是房客自己的
      // 原話,回放給他等於複述他剛講過的句子;模型自願轉問時回放的是它自己的措辭,
      // 兩種情況房客看到的說法會不一樣。
      const reply = escalationReplyText(result);
      return { messages: [textMessage(reply)], notificationIds: result.notificationIds || [] };
    }

    case 'propose_tenant_confirmation': {
      const saved = await saveProposedIntentionVersion(db, {
        inquiryId: scope.inquiry_id,
        listingId: scope.listing_id,
        tenantUserId,
        candidates: action.conditionCandidates,
        authorizedKnowledge,
        base: await latestVersion(db, { lineUserId, intention })
      });
      return { messages: await proposalMessages(db, { action, saved, scope, lineUserId }) };
    }

    case 'propose_landlord_decision': {
      // Agent 不替房東做決定,只把「有一版待你決定」放進 outbox。
      // 決定本身要房東在簽署頁明確操作。
      const confirmedVersionPublicId = intention && intention.confirmedVersionPublicId;
      if (!confirmedVersionPublicId) {
        return { messages: [textMessage('要請房東決定之前，你必須先確認一個承租條件版本。請先輸入「條件整理」並按「確認這個版本」。')] };
      }
      const landlord = await db.get(`
        SELECT po.owner_user_id
        FROM property_owners po
        WHERE po.property_id = ?
          AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ?)
          AND po.effective_from <= ?
          AND (po.effective_until IS NULL OR po.effective_until >= ?)
        ORDER BY po.rental_unit_id DESC, po.id DESC
        LIMIT 1
      `, [
        scope.property_id, scope.rental_unit_id,
        `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`,
        new Date().toISOString().slice(0, 10)
      ]);
      if (!landlord) return { messages: [textMessage('目前找不到這個房源的有效房東，請稍後再試。')] };
      await db.transaction((tx) => enqueueNotification(tx, {
        eventType: 'landlord_decision_requested',
        entityType: 'intention_version',
        entityId: confirmedVersionPublicId,
        payload: { intentionVersionPublicId: confirmedVersionPublicId },
        recipients: [{ role: 'landlord', userId: landlord.owner_user_id }],
        idempotencyKey: `landlord-decision-request:${confirmedVersionPublicId}`
      }));
      return { messages: [textMessage(action.responseText)] };
    }

    default: {
      const error = new Error(`未支援的 proposed action ${action.type}`);
      error.code = 'invalid_model_output';
      error.statusCode = 400;
      throw error;
    }
  }
}

// --- turn ---------------------------------------------------------------------

const SYSTEM_FAILURE_TEXT = '我這邊暫時無法處理你的訊息，請稍後再說一次。你的對話紀錄都還在，不會遺失。';

/**
 * 處理一則一對一 LINE 訊息。
 *
 * 呼叫端(cleanMessageHandler)必須**先**跑完所有明確指令與流程,沒人接手才叫這裡。
 *
 * @returns {Promise<{handled:boolean, messages:Array}>} handled=false 代表 Agent
 *          沒有接手(flag 關、身分不明、沒有 active inquiry),呼叫端照舊走既有路徑。
 */
async function handleTenantTurn(input = {}) {
  const {
    lineUserId, text, providerEventId, eventType = 'message',
    client = runtimeClient, env = process.env, withDriver = withV2Driver
  } = input;

  if (!client.enabled(env)) return { handled: false, messages: [] };
  if (!lineUserId || !String(text || '').trim()) return { handled: false, messages: [] };
  if (!providerEventId) {
    // 沒有 webhookEventId 就沒有去重依據。spec 明文要求先修事件 envelope 再開 Agent,
    // 這裡寧可退回既有路徑,也不要跑一個無法冪等的 turn。
    return { handled: false, messages: [] };
  }

  // ---- 準備:身分、事件、脈絡。全部在交易外的短查詢。 ----------------------
  const prepared = await withDriver(async (db) => {
    const identity = await db.get(`
      SELECT li.id AS line_identity_id, li.user_id
      FROM line_identities li
      JOIN users u ON u.id = li.user_id
      WHERE li.line_user_id = ? AND u.status = 'active'
    `, [lineUserId]);
    if (!identity) return { kind: 'not_handled' };

    const activeContext = await db.get(`
      SELECT aic.inquiry_id
      FROM active_inquiry_contexts aic
      WHERE aic.line_identity_id = ? AND aic.cleared_at IS NULL
      ORDER BY aic.id DESC LIMIT 1
    `, [identity.line_identity_id]);

    const event = await persistChannelEvent(db, {
      providerEventId,
      eventType,
      lineIdentityId: identity.line_identity_id,
      userId: identity.user_id,
      inquiryId: activeContext ? activeContext.inquiry_id : null,
      rawPayload: { provider: PROVIDER, eventType, hasText: true }
    });
    // 重送:第一次已經處理過,副作用都在了。再回一次訊息就是重複打擾。
    if (event.replayed && event.status === 'processed') {
      return { kind: 'replayed' };
    }

    if (require('./testRoleService').getActiveRole(lineUserId) === 'landlord') {
      await markEventProcessed(db, event.id);
      const base = (process.env.WEB_URL || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      return { kind: 'landlord', messages: [textMessage(`目前以房東身分操作。\n回覆房客問題：${base}/landlord/tasks\n詢問已簽合約：${base}/v2/contracts`)] };
    }

    if (!activeContext) {
      await markEventProcessed(db, event.id);
      return {
        kind: 'no_inquiry',
        messages: [textMessage('我還不知道你要談哪一間房。請先開啟「找房紀錄」選一筆房源，再回來跟我說條件。')]
      };
    }

    const inquiry = await db.get(`
      SELECT inq.id, inq.public_id, inq.user_id, inq.listing_id
      FROM inquiries inq
      WHERE inq.id = ? AND inq.ended_at IS NULL
    `, [activeContext.inquiry_id]);
    if (!inquiry || !sameId(inquiry.user_id, identity.user_id)) {
      await markEventProcessed(db, event.id);
      return {
        kind: 'no_inquiry',
        messages: [textMessage('目前綁定的房源詢問已經結束。請開啟「找房紀錄」重新選一筆房源。')]
      };
    }

    // ---- 5. 房源錯置。停在這裡,連訊息都不落地。 --------------------------
    const mismatch = await detectListingMismatch(db, {
      tenantUserId: identity.user_id,
      currentInquiryId: inquiry.id,
      text
    });
    if (mismatch.mismatched) {
      await markEventProcessed(db, event.id, 'ignored');
      return { kind: 'listing_mismatch', messages: [listingSwitchMessage(mismatch.candidates)] };
    }

    // ---- 5b. 在還沒簽約的房問「租約到什麼時候」這種簽完才有的問題 → 提議切到已簽約那間。
    if (SIGNED_ONLY_QUESTION.test(text)) {
      const other = await db.get(`SELECT c.public_id, inq.listing_id, l.title FROM contracts c
        JOIN contract_parties cp ON cp.contract_id=c.id AND cp.status='active' AND cp.user_id=?
        JOIN inquiries inq ON inq.id=c.source_inquiry_id JOIN listings l ON l.id=inq.listing_id
        WHERE c.status='executed' AND c.source_inquiry_id<>?
          AND NOT EXISTS (SELECT 1 FROM contracts c2 WHERE c2.source_inquiry_id=? AND c2.status='executed')
        ORDER BY c.id DESC LIMIT 1`, [identity.user_id, inquiry.id, inquiry.id]);
      if (other) {
        const token = await require('../repositories/v2ListingEntryTokenRepositoryAsync').findOrCreateEntryToken(db, other.listing_id);
        await markEventProcessed(db, event.id, 'ignored');
        // 直接拿已簽那份回答；想繼續問那間再按按鈕切過去。
        return { kind: 'signed_elsewhere', contractPublicId: other.public_id, inquiryId: inquiry.id, channelEventPublicId: event.publicId,
          prefix: `目前這間還沒簽約，我用你已簽好的「${other.title}」回答：\n`,
          extraButtons: [{ type: 'action', action: { type: 'message', label: '切換到已簽約的房', text: `591租屋詢問 ${token}` } }] };
      }
    }

    // ---- 6. 訊息落地。到這裡才確定它屬於這一筆詢問。 ----------------------
    const { saveInquiryMessage } = require('../repositories/v2InquiryRepositoryAsync');
    const messageId = await saveInquiryMessage(db, {
      inquiryId: inquiry.id,
      senderUserId: identity.user_id,
      senderLineIdentityId: identity.line_identity_id,
      providerMessageId: providerEventId,
      messageType: 'text',
      textContent: text
    });

    const signed = await db.all(`SELECT DISTINCT c.public_id FROM contracts c
      JOIN contract_parties cp ON cp.contract_id=c.id AND cp.status='active'
      WHERE c.source_inquiry_id=? AND c.status='executed' AND cp.user_id=?`, [inquiry.id, identity.user_id]);
    if (signed.length) {
      await markEventProcessed(db, event.id);
      // 同一筆詢問簽了兩份以上（少見）才退回合約中心，讓人自己選。
      return { kind: 'signed', inquiryId: inquiry.id, channelEventPublicId: event.publicId,
        contractPublicId: signed.length === 1 ? signed[0].public_id : null,
        messages: [{ ...textMessage('這間房有不只一份已簽合約，請點下面按鈕選要看哪一份。'),
          quickReply: { items: [uriButton('合約中心', liffUrl('/v2/contracts'))] } }] };
    }

    const conversation = await loadRoundConversation(db, inquiry.id);

    const built = await buildAgentTurnContext(db, {
      actorUserId: identity.user_id,
      inquiryPublicId: inquiry.public_id,
      // Natural questions are not exact search terms; keep this inquiry's authorized knowledge available.
      conversationWindow: conversation.reverse().map((row) => ({
        role: conversationRole(row, identity.user_id),
        text: row.text_content,
        sourceId: row.id
      }))
    });

    const execution = await startAgentExecution(db, {
      idempotencyKey: `agent-turn:${event.publicId}`,
      channelEventPublicId: event.publicId,
      actorUserId: identity.user_id,
      inquiryId: inquiry.id,
      runtimeVersion: RUNTIME_VERSION,
      modelId: AGENT_MODEL_ID,
      promptVersion: built.promptVersion,
      contextVersion: built.contextVersion
    });

    return {
      kind: 'ready',
      identity, inquiry, event, messageId, execution, built
    };
  });

  if (prepared.kind === 'not_handled') return { handled: false, messages: [] };
  if (prepared.kind === 'replayed') return { handled: true, messages: [] };
  // 已簽合約的問題直接在聊天室回答。模型呼叫放在交易外。
  if ((prepared.kind === 'signed' || prepared.kind === 'signed_elsewhere') && prepared.contractPublicId) {
    const message = await answerSignedQuestion({ withDriver, lineUserId, contractPublicId: prepared.contractPublicId, text: String(text),
      prefix: prepared.prefix, extraButtons: prepared.extraButtons,
      channelEventPublicId: prepared.kind === 'signed' ? prepared.channelEventPublicId : null });
    return { handled: true, inquiryId: prepared.inquiryId, channelEventPublicId: prepared.channelEventPublicId, messages: [message] };
  }
  if (prepared.kind !== 'ready') return { handled: true, messages: prepared.messages, inquiryId: prepared.inquiryId, channelEventPublicId: prepared.channelEventPublicId };

  const { identity, inquiry, event, messageId, execution, built } = prepared;

  // ---- 8. 呼叫 sidecar。**交易外。** --------------------------------------
  let action = null;
  let turnError = null;
  try {
    action = await client.handleTurn({
      execution_public_id: execution.publicId,
      provider_event_public_id: event.publicId,
      actor: { role: built.context.role },
      inquiry: { public_id: inquiry.public_id, listing_title: built.context.listing.title },
      event: { type: eventType, text: String(text) },
      versions: { context: built.contextVersion, prompt: built.promptVersion },
      context: built.context,
      permitted_action_names: client.PROPOSED_ACTION_TYPES
    }, { env });
  } catch (error) {
    turnError = error;
  }

  if (!action && !turnError) {
    // flag 在準備期間被關掉。已經寫下的 trace 要收尾,但不假裝有結果。
    await withDriver((db) => finishAgentExecution(db, {
      executionPublicId: execution.publicId,
      status: 'rejected',
      errorCategory: 'invalid_input'
    }));
    return { handled: false, messages: [] };
  }

  if (turnError) {
    await withDriver(async (db) => {
      await finishAgentExecution(db, {
        executionPublicId: execution.publicId,
        status: turnError.code === 'invalid_model_output' ? 'rejected' : 'failed',
        decisionClassification: 'system_failure',
        errorCategory: turnError.code
      });
      await markEventProcessed(db, event.id, 'failed');
    });
    // 供應商故障不得偽裝成知識不足,所以這裡**不**建 landlord question。
    return { handled: true, messages: [textMessage(SYSTEM_FAILURE_TEXT)] };
  }

  // ---- Node 端執行 grounding 與 use_policy。 -------------------------------
  //
  // proposed_action_type 記的是**模型提出**的那一個,不是改寫後的。兩者混在一起
  // 的話,稽核看到的會是「模型提出 ask_clarification」,而模型其實吐了一個沒有
  // 來源的 answer —— 模型幻覺的次數會從紀錄上憑空消失,那正是最需要數的東西。
  // Node 實際執行的動作記在 agent_tool_executions.tool_name(下面那段 trace)。
  const modelProposedActionType = action.type;
  action = enforceGroundingPolicy(action, built.context.authorizedKnowledge, text, built.context.listing, built.context.caseStatus);
  // 只說「幫我問房東」時，要轉的是上一句真正的問題；不然房東只看到「幫我問房東」。
  if (action.type === 'escalate_to_landlord' && String(text).replace(/幫我|幫忙|轉問|代問|請問|問一下|問|房東|一下|好|吧|[\s，。!！?？~～]/g, '').length < 2) {
    const previous = (built.context.conversationWindow || []).filter((entry) => entry.role === 'tenant' && entry.text.trim() !== String(text).trim()).pop();
    if (previous) action = { ...action, responseText: previous.text.trim() };
  }
  // 低於刊登價的出價:接受、還價、婉拒或轉問,由 Node 依房東政策決定。
  action = await withDriver((db) => applyRentNegotiation(db, {
    action, scope: built.scope, tenantText: text, sourceMessageId: messageId
  }));

  // ---- 執行 action。每個 domain command 開自己的短交易。 -------------------
  let messages = [];
  let notificationIds = [];
  let executionError = null;
  try {
    const result = await withDriver((db) => runTracedTool(db, {
      executionPublicId: execution.publicId,
      toolKind: 'domain_command',
      toolName: action.type,
      args: { type: action.type, candidateCount: action.conditionCandidates.length },
      idempotencyKey: `agent-action:${event.publicId}`,
      summarize: (value) => ({ messageCount: value.messages.length })
    }, () => db.transaction(async (tx) => {
      const outcome = await executeProposedAction(tx, {
        action,
        scope: built.scope,
        lineUserId,
        tenantUserId: identity.user_id,
        sourceMessageId: messageId,
        channelEventPublicId: event.publicId,
        intention: built.context.intention,
        authorizedKnowledge: built.context.authorizedKnowledge
      });
      const version = await tx.get(`SELECT iv.id FROM intention_versions iv JOIN rental_intentions ri ON ri.id=iv.rental_intention_id
        WHERE ri.inquiry_id=? ORDER BY iv.id DESC LIMIT 1`, [inquiry.id]);
      await applyPendingItems(tx, { inquiryId: inquiry.id, tenantUserId: identity.user_id,
        updates: action.pendingItems, conversationWindow: built.context.conversationWindow, versionId: version?.id });
      return outcome;
    })));
    messages = result.messages;
    notificationIds = result.notificationIds || [];
  } catch (error) {
    executionError = error;
  }

  // ---- 競爭揭露。無論這一輪做了什麼,只要有競爭就揭露一次。 ---------------
  if (!executionError) {
    try {
      const disclosure = await withDriver(async (db) => {
        const intentionRow = await db.get(
          'SELECT id FROM rental_intentions WHERE inquiry_id = ? ORDER BY id DESC LIMIT 1',
          [inquiry.id]
        );
        const summary = await summarizeCompetition(db, {
          rentalUnitId: built.scope.rental_unit_id,
          excludeIntentionId: intentionRow ? intentionRow.id : null
        });
        return db.transaction((tx) => discloseCompetition(tx, {
          inquiryId: inquiry.id,
          inquiryPublicId: inquiry.public_id,
          tenantUserId: identity.user_id,
          rentalUnitId: built.scope.rental_unit_id,
          summary
        }));
      });
      if (disclosure.disclosed && disclosure.text) messages = [...messages, textMessage(disclosure.text)];
    } catch (error) {
      // 揭露失敗不該讓整個 turn 失敗,但也不能靜默。
      console.error('ECS NEO competition disclosure failed:', error.code || 'unknown', error.message);
    }
  }

  await withDriver(async (db) => {
    await finishAgentExecution(db, {
      executionPublicId: execution.publicId,
      status: executionError ? 'rejected' : 'completed',
      proposedActionType: modelProposedActionType,
      decisionClassification: executionError
        ? 'system_failure'
        // 分類跟著**實際執行**的動作走:Node 改成轉問房東時,這一輪的結果就是
        // needs_landlord,寫成 grounded_and_authorized 會讓報表以為它有依據。
        : CLASSIFICATION_BY_ACTION[action.type],
      errorCategory: executionError ? executionError.code : null
    });
    await markEventProcessed(db, event.id, executionError ? 'failed' : 'processed');
  });

  // inquiryId / channelEventPublicId 是給呼叫端在**送出成功之後**回頭呼叫
  // recordAgentReply 用的。系統故障那幾句刻意不帶:那是系統告示不是 Agent 說的話,
  // 留進對話窗只會讓模型學著講「系統暫時無法處理」。
  const replyRef = { inquiryId: inquiry.id, channelEventPublicId: event.publicId };

  if (executionError) {
    if (executionError.code === 'invalid_other_agreements') {
      return { handled: true, ...replyRef, messages: [textMessage(executionError.message)] };
    }
    if (executionError.code === 'clarification_required') {
      return { handled: true, ...replyRef, messages: [textMessage(action.responseText || '這些條件我還沒辦法追到原文依據，可以請你把租金、租期與押金再說明清楚一點嗎？')] };
    }
    if (executionError.code === 'intention_frozen') {
      return { handled: true, ...replyRef, messages: [textMessage('這筆承租意向已經進入簽約或已結束，條件不再變動。請開啟合約草稿查看目前內容。')] };
    }
    return { handled: true, messages: [textMessage(SYSTEM_FAILURE_TEXT)] };
  }

  return { handled: true, ...replyRef, messages, notificationIds };
}

module.exports = {
  AGENT_MODEL_ID,
  CANDIDATE_CONDITION_PATHS,
  CLASSIFICATION_BY_ACTION,
  RUNTIME_VERSION,
  conversationRole,
  ASK_LANDLORD_POSTBACK_ACTION,
  ASK_SIGNED_LANDLORD_POSTBACK_ACTION,
  DECLINE_LANDLORD_POSTBACK_ACTION,
  askLandlordPrompt,
  detectListingMismatch,
  placeNames,
  distinctiveTokens,
  enforceGroundingPolicy,
  handleAgentEscalationPostback,
  handleSignedLandlordPostback,
  executeProposedAction,
  handleTenantTurn,
  loadRoundConversation,
  openLandlordQuestion,
  persistChannelEvent,
  recordAgentReply,
  saveProposedIntentionVersion
};
