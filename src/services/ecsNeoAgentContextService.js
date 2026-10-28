// Agent context 的唯一組裝點。
//
// 模型看到的東西**只能**由這一支產生,而且只有五種來源:
//   1. 已授權的房源／詢問脈絡          ecsNeoAgentToolsServiceAsync.getInquiryContext
//   2. public knowledge 與本案房東回答  ecsNeoAgentToolsServiceAsync.searchAuthorizedKnowledge
//   3. 這筆意向的 exact version 清單    (同上,刻意沒有「最新版」欄位)
//   4. 隱私安全的競爭摘要              ecsNeoCompetitionDisclosureService(只有計數)
//   5. Node 端底價政策的**判定**        ecsNeoFloorPricePolicyService(只有 verdict)
//   6. 流程走到哪的判定                  buildCaseStatus(下一步在等誰,沒有時間與金額)
//
// 沒有第七種。特別是:
//   - 原始底價金額永遠不進來。第 5 項回的是 at_or_above_floor / below_floor,
//     不是數字。這一點由 assertContextIsPrivacySafe 在每次組裝後強制檢查,
//     不是靠寫程式的人記得。
//   - 其他房客的姓名、條件、進度、出價不進來。第 4 項只有計數。
//   - internal landlord rule、未核准的 reusable answer 不進來(工具層就擋掉了)。
//   - 房客與房東的真實姓名、電話、email、LINE id 不進來。模型用角色稱呼對方。

const crypto = require('node:crypto');

const {
  getInquiryContext,
  searchAuthorizedKnowledge,
  requireAuthorizedInquiry
} = require('./ecsNeoAgentToolsServiceAsync');
const { canonicalJson } = require('./ecsNeoContractAcceptanceServiceAsync');
const { evaluateRentFloorPolicy } = require('./ecsNeoFloorPricePolicyService');
const { summarizeCompetition } = require('./ecsNeoCompetitionDisclosureService');
const { latestLandlordDecision } = require('./ecsNeoLandlordDecisionServiceAsync');
const { blockingIssueLabels } = require('./ecsNeoLegalRuleValidator');

// 這些鍵一旦出現在 context 裡就是外洩。用鍵名擋是因為值是什麼型別都可能,
// 但鍵名是我們自己組出來的 —— 出現這些名字代表有人加了新的一段拼裝程式。
const FORBIDDEN_KEY_PATTERNS = Object.freeze([
  /display_?name/i,
  /(^|_)phone/i,
  /mobile/i,
  /e_?mail/i,
  /line_?user_?id/i,
  /national_?id/i,
  /id_?number/i,
  /tenant_?name/i,
  /landlord_?name/i,
  /floor_?price/i,
  /floor_?rent/i,
  /min(imum)?_?rent/i,
  /secret|token|password|credential/i
]);

const PROMPT_VERSION = 'ecs-neo-negotiation-coordinator-v4';

function fail(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * 走過整棵 context,任何被禁的鍵名都讓組裝失敗。
 *
 * 刻意做成**丟例外**而不是靜默移除:靜默移除會讓「有人不小心把底價塞進 context」
 * 這件事永遠沒人發現,下一次改動就可能繞過它。
 */
function assertContextIsPrivacySafe(value, path = 'context') {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertContextIsPrivacySafe(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    const forbidden = FORBIDDEN_KEY_PATTERNS.find((pattern) => pattern.test(key));
    if (forbidden) {
      throw fail(
        `agent context 不得包含 ${path}.${key}`,
        'internal_invariant_violation',
        500
      );
    }
    assertContextIsPrivacySafe(value[key], `${path}.${key}`);
  }
}

// 流程走到哪。**由 Node 判定,模型只負責轉述。**
//
// 沒有這一段的時候,模型被問到「接下來呢」只能用一般常識猜,而這條線的順序是
// 產品自己定的(房東要先確認條件才開始簽署、拒絕之後詢問留著)。猜錯的代價是
// 房客照著錯的說法去按按鈕,然後被擋。
//
// 這裡刻意只回一個 nextStep 字串加幾個布林,不回時間、金額或任何身分。
const NEXT_STEPS = Object.freeze({
  coordinating: '還在協調條件,尚未有房客確認的版本',
  awaiting_tenant_confirmation: '條件已整理,等房客自己確認某一個版本',
  awaiting_draft: '房客已確認版本,草稿還沒建立',
  draft_blocked: '房客確認的版本缺少法規要求一定要約定的條款,草稿建不出來。請房客補上 missingClauses 列的項目,再整理成新版本讓他確認',
  awaiting_landlord_terms: '草稿已建立,等房東確認條件才能開始簽署',
  awaiting_tenant_signature: '房東已確認條件,合約已發行,等房客簽名',
  awaiting_landlord_signature: '房客已簽名,等房東完成簽署',
  // 模型只能照 nextStepNote 講;沒寫入口它就只會說「不知道下載位置」。
  executed: '雙方都已簽署,契約成立;完成文件在合約中心,按回覆下方卡片的「查看合約」即可查看、下載或列印',
  changes_requested: '房東要求修改,已退回協調',
  rejected: '房東拒絕了這一筆意向,房客可以在原地重新協調',
  closed: '這一筆意向已經結束'
});

async function buildCaseStatus(db, { intentionId, intentionStatus, hasConfirmedVersion }) {
  const base = {
    intentionStatus: intentionStatus || null,
    tenantConfirmedVersion: Boolean(hasConfirmedVersion),
    draftReady: false,
    landlordConfirmedTerms: false,
    tenantSigned: false,
    landlordDecision: null
  };
  if (!intentionId) return { ...base, nextStep: 'coordinating', nextStepNote: NEXT_STEPS.coordinating };

  const contract = await db.get(`
    SELECT c.id, c.status,
           cv.id AS version_id, cv.status AS version_status, cv.landlord_terms_confirmed_at
    FROM contracts c
    LEFT JOIN contract_versions cv ON cv.contract_id = c.id
    WHERE c.selected_intention_id = ?
    ORDER BY cv.version_number DESC, cv.id DESC
    LIMIT 1
  `, [intentionId]);

  const decision = contract ? await latestLandlordDecision(db, contract.id) : null;
  const signed = contract && contract.version_id
    ? await db.get(`
        SELECT 1 AS signed FROM signature_records sr
        JOIN contract_parties cp ON cp.id = sr.contract_party_id AND cp.party_role = 'tenant'
        WHERE sr.contract_version_id = ?
      `, [contract.version_id])
    : null;

  const status = {
    ...base,
    draftReady: Boolean(contract && contract.version_id),
    landlordConfirmedTerms: Boolean(contract && contract.landlord_terms_confirmed_at),
    tenantSigned: Boolean(signed),
    // 理由是房東寫給這位房客看的,本來就會推播給他,不算外洩。
    landlordDecision: decision ? { decision: decision.decision, reason: decision.reason } : null
  };

  const nextStep = (() => {
    if (['withdrawn', 'leased_to_another_tenant', 'ended'].includes(intentionStatus)) return 'closed';
    if (intentionStatus === 'rejected') return 'rejected';
    if (contract && contract.status === 'executed') return 'executed';
    if (decision && decision.decision === 'changes_requested' && !status.tenantConfirmedVersion) return 'changes_requested';
    if (!status.tenantConfirmedVersion) return 'coordinating';
    if (!status.draftReady) return 'awaiting_draft';
    if (!status.landlordConfirmedTerms) return 'awaiting_landlord_terms';
    if (contract && contract.version_status === 'draft') return 'awaiting_landlord_terms';
    if (!status.tenantSigned) return 'awaiting_tenant_signature';
    return 'awaiting_landlord_signature';
  })();

  if (nextStep === 'awaiting_draft') {
    // 確認時法規檢查沒過,草稿就不會建立。不講缺什麼,模型只會說「系統會建立草稿」。
    const blocked = await db.get(`
      SELECT issues_json FROM prepared_contract_drafts
      WHERE rental_intention_id = ? AND blocking_issue_count > 0 AND materialized_contract_version_id IS NULL
      ORDER BY id DESC LIMIT 1
    `, [intentionId]);
    if (blocked) {
      const missingClauses = blockingIssueLabels(JSON.parse(blocked.issues_json || '[]'));
      return { ...status, nextStep: 'draft_blocked', nextStepNote: NEXT_STEPS.draft_blocked, missingClauses };
    }
  }
  return { ...status, nextStep, nextStepNote: NEXT_STEPS[nextStep] };
}

function contextVersionOf(context) {
  return `ctx-${crypto.createHash('sha256').update(canonicalJson(context), 'utf8').digest('hex').slice(0, 32)}`;
}

const CONVERSATION_ROLES = Object.freeze(['tenant', 'agent', 'landlord']);
// gateway 一次撈 CONVERSATION_WINDOW_LIMIT 筆(含房客、Agent、房東三種訊息,約 25 來回)。這裡的上限必須一致 —— 兩層各自截斷的話,gateway 好不容易
// 撈進來的 Agent 回覆會在這裡被切掉,而且沒有人會發現。
const CONVERSATION_WINDOW_LIMIT = 50;

// 這一輪協商是從什麼時候開始的。
//
// 房東「要求修改」或「拒絕」之後就是新的一輪:上一輪的租金、押金、入住日期都不算數
// 了。沒有這個邊界的時候,gateway 無腦撈最後 30 則,模型會把上一輪講過的 18,000 當
// 成現在的租金,然後拿去產生條件版本。舊訊息仍然留在 LINE 與資料庫裡供稽核,只是
// 不進 context;要看舊條件的話讀 intention_versions,那才是不可變的版本紀錄。
//
// 不新增 negotiation_round 欄位:邊界本來就記在 intention_decisions 裡。
//
// **時間格式兩邊都要正規化。** messages.sent_at 是 new Date().toISOString()
// (2026-09-04T08:12:33.123Z);intention_decisions.decided_at 走
// DEFAULT CURRENT_TIMESTAMP 時是 SQLite 的 2026-09-04 08:12:33,而
// dashboardLineService 那條路徑又自己傳 ISO 進來 —— 同一個欄位兩種格式並存。
// 直接比字串的話 'T'(0x54) 大於空白(0x20),同一天的舊訊息會**全部**通過過濾,
// 而且只測跨天情境的測試會漂亮地綠燈。把空白換成 T 之後(兩邊都是 UTC),
// 字典序才等於時間序。
const TERMINAL_INTENTION_STATUSES = Object.freeze([
  'rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'
]);

function normalizeTimestamp(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.replace(' ', 'T') : null;
}

async function negotiationRoundStartedAt(db, inquiryId) {
  const row = await db.get(`
    SELECT ri.created_at,
           (SELECT MAX(REPLACE(d.decided_at, ' ', 'T'))
              FROM intention_decisions d
             WHERE d.rental_intention_id = ri.id
               AND d.decision IN ('rejected', 'changes_requested')) last_decided_at
    FROM rental_intentions ri
    WHERE ri.inquiry_id = ?
    ORDER BY CASE WHEN ri.status IN (${TERMINAL_INTENTION_STATUSES.map(() => '?').join(',')}) THEN 1 ELSE 0 END,
             ri.id DESC
    LIMIT 1
  `, [inquiryId, ...TERMINAL_INTENTION_STATUSES]);
  if (!row) return null;
  // 意向被拒之後房客還沒開新條件時,目前意向就是被拒的那一筆,邊界落在拒絕的當下。
  // 房客一講出新條件,saveIntentionVersion 會開一筆新意向(被拒的那筆是 terminal,
  // 不佔 uq_rental_intentions_active_inquiry),邊界就變成新意向的 created_at。
  return normalizeTimestamp(row.last_decided_at) || normalizeTimestamp(row.created_at);
}

/**
 * conversationWindow 是房客、Agent 與房東在這一筆詢問裡的對話。內容本來就是
 * 當事人自己寫的,但仍然截長:一次餵三百則訊息不會讓模型更準,只會讓成本與
 * 洩漏面變大。
 *
 * 三種角色都要原樣帶過去。把 landlord 摺成 tenant 會讓模型把房東說的話當成
 * 房客的意思;把 agent 摺成 tenant 會讓它把自己講過的話當成房客講的。
 */
function projectConversationWindow(window) {
  return (Array.isArray(window) ? window : [])
    .slice(-CONVERSATION_WINDOW_LIMIT)
    .map((entry) => ({
      role: entry && CONVERSATION_ROLES.includes(entry.role) ? entry.role : 'tenant',
      text: String((entry && entry.text) || '').slice(0, 1000),
      // 這不是身分或 provider id，而是本 inquiry 的 message primary key。
      // Agent 提出條件時必須引用它；Node 會再次查 ownership，模型不能藉此
      // 指向其他 inquiry 的對話。
      sourceId: entry && entry.sourceId !== null && entry.sourceId !== undefined
        ? String(entry.sourceId)
        : null
    }))
    .filter((entry) => entry.text);
}

// 房客最新一份入住前點交紀錄。只給文字備註與照片張數:照片網址模型用不到,
// 給了只會被貼回聊天裡。沒有紀錄就回 null,模型才不會說「你的點交紀錄顯示…」。
async function loadConditionRecord(db, inquiryId) {
  const session = await db.get(`
    SELECT id, status FROM pre_inspection_sessions
    WHERE inquiry_id = ? AND record_type = 'main'
    ORDER BY id DESC LIMIT 1
  `, [inquiryId]);
  if (!session) return null;
  const entries = await db.all('SELECT entry_type, message_text FROM pre_inspection_entries WHERE session_id = ? ORDER BY id', [session.id]);
  return {
    completed: session.status === 'sealed',
    notes: entries.filter((entry) => entry.entry_type === 'text' && entry.message_text)
      .slice(0, 20).map((entry) => String(entry.message_text).slice(0, 200)),
    photoCount: entries.filter((entry) => entry.entry_type === 'image').length,
    usage: '建立草稿時會自動成為合約附件一,作為入住前就存在的狀況證據'
  };
}

/**
 * 組出一個 turn 的模型 context。
 *
 * @param {object} db async driver
 * @param {object} input
 * @param {number|string} input.actorUserId       Node 已驗證的身分,不是模型說的
 * @param {string} input.inquiryPublicId          明確指名,不猜最近一筆
 * @param {number|null} [input.proposedRentAmount] 房客這一輪開的月租(用於底價政策)
 * @param {string} [input.topic]                  用來縮小 knowledge 搜尋範圍
 * @param {Array<{role:string,text:string,sourceId:(number|string)}>} [input.conversationWindow]
 */
async function buildAgentTurnContext(db, input = {}) {
  if (!db || typeof db.get !== 'function') throw fail('db driver is required', 'invalid_input', 400);

  const scope = await requireAuthorizedInquiry(db, {
    actorUserId: input.actorUserId,
    inquiryPublicId: input.inquiryPublicId,
    now: input.now
  });

  const [inquiryContext, knowledge] = await Promise.all([
    getInquiryContext(db, {
      actorUserId: input.actorUserId,
      inquiryPublicId: input.inquiryPublicId,
      now: input.now
    }),
    searchAuthorizedKnowledge(db, {
      actorUserId: input.actorUserId,
      inquiryPublicId: input.inquiryPublicId,
      topic: input.topic,
      now: input.now
    })
  ]);

  // 與 getInquiryContext 的 loadIntention 用同一種排序:優先進行中的那一筆。
  // 兩邊不一致的話,caseStatus 講的會是另一筆意向的進度。
  const TERMINAL_INTENTION = ['rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'];
  const intention = await db.get(`
    SELECT id FROM rental_intentions
    WHERE inquiry_id = ?
    ORDER BY CASE WHEN status IN (${TERMINAL_INTENTION.map(() => '?').join(',')}) THEN 1 ELSE 0 END, id DESC
    LIMIT 1
  `, [scope.inquiry_id, ...TERMINAL_INTENTION]);

  const caseStatus = await buildCaseStatus(db, {
    intentionId: intention ? intention.id : null,
    intentionStatus: inquiryContext.intention ? inquiryContext.intention.status : null,
    hasConfirmedVersion: Boolean(inquiryContext.intention && inquiryContext.intention.confirmedVersionPublicId)
  });

  const [floorPricePolicy, competition] = await Promise.all([
    evaluateRentFloorPolicy(db, {
      rentalUnitId: scope.rental_unit_id,
      propertyId: scope.property_id,
      organizationId: scope.organization_id,
      proposedRentAmount: input.proposedRentAmount ?? null
    }),
    summarizeCompetition(db, {
      rentalUnitId: scope.rental_unit_id,
      excludeIntentionId: intention ? intention.id : null
    })
  ]);

  // conversationWindow 是房客與 Agent 這一筆詢問裡的對話。內容本來就是房客自己
  // 寫的,但仍然截長:一次餵三百則訊息不會讓模型更準,只會讓成本與洩漏面變大。
  const conversationWindow = projectConversationWindow(input.conversationWindow);
  const conditionRecord = await loadConditionRecord(db, scope.inquiry_id);

  const context = {
    role: inquiryContext.role,
    inquiry: inquiryContext.inquiry,
    listing: inquiryContext.listing,
    rentalUnit: inquiryContext.rentalUnit,
    listingSnapshot: inquiryContext.listingSnapshot,
    // 只有 exact versions 與房客確認過的那一個。刻意沒有 latestVersionPublicId。
    intention: inquiryContext.intention,
    authorizedKnowledge: knowledge,
    // 判定,不是金額。名字刻意不叫 floorPrice*:那個字串本身在 assert 的黑名單裡,
    // 讓「context 裡不准出現底價相關鍵名」這條規則對容器與內容一視同仁。
    negotiationAuthority: {
      verdict: floorPricePolicy.verdict,
      hasPolicy: floorPricePolicy.hasPolicy,
      mustEscalate: floorPricePolicy.mustEscalate
    },
    // 流程走到哪、下一步在等誰。判定在 Node,模型只轉述。
    caseStatus,
    conditionRecord,
    pendingItems: await require('./ecsNeoPendingItemsService').listPendingItems(db, scope.inquiry_id),
    // 計數,不是身分。
    competition: {
      otherActiveIntentionCount: competition.otherActiveIntentionCount,
      unitClaimed: competition.unitClaimed
    },
    conversationWindow
  };

  assertContextIsPrivacySafe(context);

  return {
    scope,
    context,
    contextVersion: contextVersionOf(context),
    promptVersion: PROMPT_VERSION,
    floorPricePolicy,
    competition
  };
}

module.exports = {
  CONVERSATION_WINDOW_LIMIT,
  FORBIDDEN_KEY_PATTERNS,
  PROMPT_VERSION,
  assertContextIsPrivacySafe,
  buildAgentTurnContext,
  contextVersionOf,
  negotiationRoundStartedAt,
  normalizeTimestamp,
  projectConversationWindow
};
