// Agent trace:把每一次 agent turn 與每一次 tool 呼叫寫進 agent_executions /
// agent_tool_executions,並把各服務的 error code 收斂成**封閉**的 taxonomy。
//
// 為什麼 trace 要獨立成一個 service:
//   1. 事後查一個 turn 為什麼沒有建 landlord question、為什麼回 409,靠的是這兩張表。
//      如果每個呼叫端各自 INSERT,error_category 很快就會出現自由字串,那時候
//      「model_timeout 有幾次」這種問題就再也答不出來。
//   2. trace 失敗不該讓業務失敗,業務失敗也不該讓 trace 消失。所以這裡只下單句
//      statement,不自己開交易 —— 呼叫端可能已經在一個 domain command 的交易裡,
//      巢狀 BEGIN 在 SQLite 會直接丟 "cannot start a transaction within a transaction"。
//
// 刻意不做的事:
//   - 不存原始 arguments。只存 arguments_hash(canonical JSON 的 SHA-256)。
//     spec 寫明 V1 不保存任意 raw/redacted args,欄位白名單核准後才加。
//   - 不存房客訊息全文、身分證、金額明細或 secret。result_summary 只放呼叫端明確
//     給的結構化摘要,並且截長。
//   - 不寫 notifications、不推播、不碰業務資料表。
//
// production authority 是 TiDB/MySQL,所以只用 async driver 的 get/all/run,
// SQL 保持可攜:沒有 RETURNING、沒有 SQLite 專屬函式、沒有具名參數。

const crypto = require('node:crypto');

const { canonicalJson } = require('./ecsNeoContractAcceptanceServiceAsync');

// --- 封閉集合 ----------------------------------------------------------------

// .agents-cli-spec.md 的 Error Taxonomy,一字不差的 13 項。
// migration 033 讓兩個方言的 CHECK 與這個陣列一致;測試會比對,不要單邊改。
const TRACE_ERROR_CATEGORIES = Object.freeze([
  'knowledge_insufficient',
  'clarification_required',
  'model_timeout',
  'model_provider_error',
  'invalid_model_output',
  'stale_version',
  'authorization_denied',
  'unit_claim_conflict',
  'notification_failed',
  'draft_review_required',
  'invalid_prepared_draft',
  'invalid_input',
  'internal_invariant_violation'
]);

const PROPOSED_ACTION_TYPES = Object.freeze([
  'answer',
  'ask_clarification',
  'escalate_to_landlord',
  'show_condition_summary',
  'propose_tenant_confirmation',
  'propose_landlord_decision',
  'explain_status_or_change',
  'no_action'
]);

const DECISION_CLASSIFICATIONS = Object.freeze([
  'grounded_and_authorized',
  'needs_clarification',
  'needs_landlord',
  'system_failure'
]);

const EXECUTION_STATUSES = Object.freeze(['running', 'completed', 'rejected', 'failed']);
// running 只由 startAgentExecution 寫入,不能當成「結束」的結論。
const EXECUTION_FINAL_STATUSES = Object.freeze(['completed', 'rejected', 'failed']);
const TOOL_STATUSES = Object.freeze(['running', 'succeeded', 'failed', 'rejected']);
const TOOL_KINDS = Object.freeze(['model_tool', 'domain_command']);

// service 層的 error code 比 taxonomy 細(接受命令自己就有九種)。這張表是唯一的
// 轉換點,而且**只做收斂,不做美化**:
//   - checksum 不符、artifact 已固化 -> invalid_prepared_draft(完整性問題)
//   - 範本或 rule pack 已失效        -> draft_review_required(要人重新產生草稿)
// 反過來的方向一律不允許:不可以把 model_timeout 收斂成 knowledge_insufficient,
// 也不可以把 internal_invariant_violation 收斂成 model_provider_error。
const SERVICE_ERROR_CODE_TO_TRACE_CATEGORY = Object.freeze({
  knowledge_insufficient: 'knowledge_insufficient',
  clarification_required: 'clarification_required',
  model_timeout: 'model_timeout',
  model_provider_error: 'model_provider_error',
  invalid_model_output: 'invalid_model_output',
  stale_version: 'stale_version',
  authorization_denied: 'authorization_denied',
  unit_claim_conflict: 'unit_claim_conflict',
  notification_failed: 'notification_failed',
  draft_review_required: 'draft_review_required',
  invalid_prepared_draft: 'invalid_prepared_draft',
  invalid_input: 'invalid_input',
  internal_invariant_violation: 'internal_invariant_violation',

  // 接受命令的細分 code(見 ecsNeoContractAcceptanceServiceAsync 檔頭)。
  prepared_draft_checksum_mismatch: 'invalid_prepared_draft',
  prepared_draft_already_materialized: 'invalid_prepared_draft',
  template_version_inactive: 'draft_review_required',
  rule_pack_version_inactive: 'draft_review_required'
});

// 「被規則擋下來」與「系統壞了」在 trace 裡必須分得開,不然待辦清單會被正常的
// 授權拒絕淹掉。rejected = 前置條件不成立,重試同樣會失敗;failed = 供應商、
// 通知或不可能狀態,值得有人去看。
const CATEGORY_IS_FAILURE = Object.freeze(new Set([
  'model_timeout',
  'model_provider_error',
  'notification_failed',
  'internal_invariant_violation'
]));

const RESULT_SUMMARY_MAX_LENGTH = 500;

function fail(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fail(`${name} is required`, 'invalid_input', 400);
  }
  return value;
}

function requireMember(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw fail(`${name} 必須是 ${allowed.join(' / ')} 之一,收到 ${JSON.stringify(value)}`, 'invalid_input', 400);
  }
  return value;
}

function requireDriver(db) {
  if (!db || typeof db.get !== 'function' || typeof db.run !== 'function') {
    throw fail('db driver is required', 'invalid_input', 400);
  }
  return db;
}

/**
 * 把任何 Error 或 error code 字串收斂成 taxonomy 的一員。
 *
 * null / undefined 回 null(代表這次沒有錯誤)。
 * 認不出來的 code 一律回 internal_invariant_violation:那表示某個路徑丟出了還沒被
 * 映射的 code,或真的進到不可能狀態。兩種都是實作缺口,必須有人看;讓它變成
 * 自由字串或悄悄變成 null 只會讓缺口永遠找不到。
 */
function toTraceErrorCategory(input) {
  if (input === null || input === undefined) return null;
  const code = typeof input === 'string' ? input : input.code;
  if (typeof code !== 'string' || !code) return 'internal_invariant_violation';
  return SERVICE_ERROR_CODE_TO_TRACE_CATEGORY[code] || 'internal_invariant_violation';
}

function toolStatusForCategory(category) {
  return CATEGORY_IS_FAILURE.has(category) ? 'failed' : 'rejected';
}

// 只存雜湊,不存內容。canonicalJson 讓鍵順序不同的等價參數得到同一個 hash,
// 所以「同一個 tool 被用同樣參數呼叫幾次」在 trace 上看得出來。
function argumentsHash(args) {
  if (args === null || args === undefined) return null;
  return crypto.createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

// 摘要是給人看的,不是資料交換格式。物件會被正規化成 JSON,過長直接截斷 ——
// 讓它無上限成長等於把訊息全文搬進 trace。
function normalizeResultSummary(summary) {
  if (summary === null || summary === undefined) return null;
  const text = typeof summary === 'string' ? summary : canonicalJson(summary);
  return text.length > RESULT_SUMMARY_MAX_LENGTH
    ? `${text.slice(0, RESULT_SUMMARY_MAX_LENGTH - 1)}…`
    : text;
}

function isDuplicateKeyError(error) {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  if (code === 'ER_DUP_ENTRY') return true;
  return Number(error.errno) === 1062;
}

// --- agent_executions --------------------------------------------------------

async function findExecution(db, publicId) {
  return db.get(`
    SELECT id, public_id, idempotency_key, channel_event_id, actor_user_id, inquiry_id,
           runtime_version, status, proposed_action_type, decision_classification,
           error_category, finished_at
    FROM agent_executions
    WHERE public_id = ?
  `, [publicId]);
}

/**
 * 開始一個 agent turn 的 trace。
 *
 * actor 與 provider event 都必須是**已持久化**的東西:channel_event 用 public_id 反查,
 * actorUserId 由 Node 從已驗證的身分推導。sidecar 回傳的 actor/user/party 一律不進這裡。
 *
 * 同一個 event 重試沿用同一筆 execution:idempotency_key 撞唯一鍵時回傳既有那筆,
 * 不新增第二筆,也不覆寫既有結果。
 */
async function startAgentExecution(db, input = {}) {
  requireDriver(db);
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
  const channelEventPublicId = requireText(input.channelEventPublicId, 'channelEventPublicId');
  const runtimeVersion = requireText(input.runtimeVersion, 'runtimeVersion');
  if (input.actorUserId === null || input.actorUserId === undefined) {
    throw fail('actorUserId is required', 'invalid_input', 400);
  }

  const event = await db.get('SELECT id FROM channel_events WHERE public_id = ?', [channelEventPublicId]);
  if (!event) {
    // 沒有持久化的 inbound event 就沒有 turn。這不是授權問題,是呼叫順序寫錯:
    // webhook 必須先寫 channel_events 才能開 agent turn。
    throw fail(`channel event ${channelEventPublicId} 不存在`, 'invalid_input', 400);
  }

  const publicId = input.publicId || `agent-execution-${crypto.randomUUID()}`;
  try {
    const result = await db.run(`
      INSERT INTO agent_executions
        (public_id, idempotency_key, channel_event_id, actor_user_id, inquiry_id,
         runtime_version, model_id, model_version, prompt_version, context_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')
    `, [
      publicId,
      idempotencyKey,
      event.id,
      input.actorUserId,
      input.inquiryId ?? null,
      runtimeVersion,
      input.modelId ?? null,
      input.modelVersion ?? null,
      input.promptVersion ?? null,
      input.contextVersion ?? null
    ]);
    return { executionId: result.insertId, publicId, replayed: false };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await db.get(
      'SELECT id, public_id FROM agent_executions WHERE idempotency_key = ?',
      [idempotencyKey]
    );
    if (!existing) {
      // 撞了唯一鍵卻找不到那一列。可能是 public_id 撞到(呼叫端自己指定了重複值),
      // 不是重試。原封不動往上丟,不要假裝成冪等重播。
      throw error;
    }
    return { executionId: existing.id, publicId: existing.public_id, replayed: true };
  }
}

/**
 * 結束一個 agent turn。
 *
 * 條件式 UPDATE:只有 status='running' 的那一筆會被改。重複呼叫回
 * { alreadyFinished: true },不覆寫第一次的結論 —— trace 是稽核資料,不是可變狀態。
 */
async function finishAgentExecution(db, input = {}) {
  requireDriver(db);
  const publicId = requireText(input.executionPublicId, 'executionPublicId');
  const status = requireMember(input.status, EXECUTION_FINAL_STATUSES, 'status');

  const errorCategory = input.errorCategory === undefined
    ? toTraceErrorCategory(input.serviceError ?? null)
    : toTraceErrorCategory(input.errorCategory);

  // 資料庫的 CHECK 只管「值在集合內」,管不了「失敗必須有原因、成功不能有原因」。
  // 這兩個才是查 trace 時真正依賴的東西。
  if (status === 'completed' && errorCategory) {
    throw fail('completed 的 execution 不可帶 error_category', 'invalid_input', 400);
  }
  if (status !== 'completed' && !errorCategory) {
    throw fail(`${status} 的 execution 必須帶 error_category`, 'invalid_input', 400);
  }

  const proposedActionType = input.proposedActionType ?? null;
  if (proposedActionType !== null) {
    requireMember(proposedActionType, PROPOSED_ACTION_TYPES, 'proposedActionType');
  }
  const decisionClassification = input.decisionClassification ?? null;
  if (decisionClassification !== null) {
    requireMember(decisionClassification, DECISION_CLASSIFICATIONS, 'decisionClassification');
  }

  const result = await db.run(`
    UPDATE agent_executions
    SET status = ?,
        proposed_action_type = ?,
        decision_classification = ?,
        error_category = ?,
        finished_at = CURRENT_TIMESTAMP
    WHERE public_id = ?
      AND status = 'running'
  `, [status, proposedActionType, decisionClassification, errorCategory, publicId]);

  if (result.changes === 0) {
    const existing = await findExecution(db, publicId);
    if (!existing) throw fail(`agent execution ${publicId} 不存在`, 'invalid_input', 400);
    return { alreadyFinished: true, status: existing.status, errorCategory: existing.error_category };
  }
  return { alreadyFinished: false, status, errorCategory };
}

// --- agent_tool_executions ---------------------------------------------------

async function nextSequenceNumber(db, agentExecutionId) {
  const row = await db.get(
    'SELECT MAX(sequence_number) AS max_sequence FROM agent_tool_executions WHERE agent_execution_id = ?',
    [agentExecutionId]
  );
  return Number(row?.max_sequence || 0) + 1;
}

async function requireExecutionId(db, executionPublicId) {
  const execution = await findExecution(db, executionPublicId);
  if (!execution) throw fail(`agent execution ${executionPublicId} 不存在`, 'invalid_input', 400);
  return execution.id;
}

/**
 * 記一次 tool 呼叫,並執行它。
 *
 * 先寫 running 再執行,所以「呼叫到一半整個 process 掛掉」在 trace 上是看得見的
 * running,而不是完全不存在。成功／失敗都會補完同一列。
 *
 * fn 丟出的錯誤原封不動往上丟(code、statusCode 都保留);trace 只負責分類。
 * 反過來,trace 自己的寫入錯誤**不會**被吞掉:靜默失敗的稽核比沒有稽核更糟。
 */
async function runTracedTool(db, input, fn) {
  requireDriver(db);
  const executionPublicId = requireText(input?.executionPublicId, 'executionPublicId');
  const toolKind = requireMember(input?.toolKind, TOOL_KINDS, 'toolKind');
  const toolName = requireText(input?.toolName, 'toolName');
  if (typeof fn !== 'function') throw fail('fn is required', 'invalid_input', 400);

  const agentExecutionId = await requireExecutionId(db, executionPublicId);
  const idempotencyKey = input.idempotencyKey ?? null;
  let publicId = `agent-tool-${crypto.randomUUID()}`;

  try {
    await db.run(`
      INSERT INTO agent_tool_executions
        (public_id, agent_execution_id, sequence_number, tool_kind, tool_name,
         arguments_hash, idempotency_key, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
    `, [
      publicId,
      agentExecutionId,
      await nextSequenceNumber(db, agentExecutionId),
      toolKind,
      toolName,
      argumentsHash(input.args),
      idempotencyKey
    ]);
  } catch (error) {
    // 有 idempotency key 的 domain command 重送會撞唯一鍵。這**不是**錯誤,
    // 也不該被硬塞進 taxonomy 的某一項(裡面沒有「冪等重播」這個類別,
    // 借用 unit_claim_conflict 之類的名字會讓統計失真)。
    // 正確做法是沿用既有那一列:下面的 finish() 只改 status='running' 的列,
    // 所以第一次的結論會被完整保留,trace 維持不可變。
    const existing = isDuplicateKeyError(error) && idempotencyKey
      ? await db.get(
        'SELECT public_id FROM agent_tool_executions WHERE idempotency_key = ?',
        [idempotencyKey]
      )
      : null;
    if (!existing) throw error;
    publicId = existing.public_id;
  }

  const finish = async (status, errorCategory, summary) => {
    await db.run(`
      UPDATE agent_tool_executions
      SET status = ?, error_category = ?, result_summary = ?, finished_at = CURRENT_TIMESTAMP
      WHERE public_id = ?
        AND status = 'running'
    `, [status, errorCategory, normalizeResultSummary(summary), publicId]);
  };

  try {
    const result = await fn();
    await finish('succeeded', null, typeof input.summarize === 'function' ? input.summarize(result) : null);
    return result;
  } catch (error) {
    const category = toTraceErrorCategory(error);
    await finish(toolStatusForCategory(category), category, { code: error?.code ?? null });
    throw error;
  }
}

module.exports = {
  CATEGORY_IS_FAILURE,
  DECISION_CLASSIFICATIONS,
  EXECUTION_FINAL_STATUSES,
  EXECUTION_STATUSES,
  PROPOSED_ACTION_TYPES,
  RESULT_SUMMARY_MAX_LENGTH,
  SERVICE_ERROR_CODE_TO_TRACE_CATEGORY,
  TOOL_KINDS,
  TOOL_STATUSES,
  TRACE_ERROR_CATEGORIES,
  argumentsHash,
  finishAgentExecution,
  runTracedTool,
  startAgentExecution,
  toTraceErrorCategory
};
