// 到 ADK sidecar 的唯一出口。刻意**不是**通用 HTTP proxy:呼叫端拿到的只有一個
// 已驗證的 proposed action,拿不到原始 response、header 或 status。
//
// fail closed 的四道:
//   1. feature flag 預設關。ECS_NEO_AGENT_ENABLED 不是字串 'true' 就當關,
//      而且 public demo(V2_CONTRACT_DEMO_PUBLIC / PUBLIC_DEMO_MODE)一律強制停用 ——
//      demo 是固定身分,不能讓固定身分進 Agent 授權路徑(spec Kill Criteria)。
//   2. 沒有 shared secret 就不送。缺 secret 代表部署沒設定好,不是「這次匿名跑一下」。
//   3. timeout 有上限而且會 abort。逾時是 model_timeout,**不是** knowledge_insufficient ——
//      把供應商故障寫成知識不足會讓房東收到一堆不該轉問的問題。
//   4. schema 不合法一律拒絕,不做「盡量解讀」。特別是模型回傳任何身分欄位
//      (actor / user / party / ownership)一律視為 invalid_model_output:
//      身分只能由 Node 從已持久化的事件推導。
//
// 這裡不寫資料庫、不推 LINE、不決定要做什麼。決定在 gateway。

// spec 的封閉集合,一字不差。
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

const ALLOWED_TOP_LEVEL_KEYS = Object.freeze(new Set([
  'type',
  'response_text',
  'grounding_refs',
  'condition_candidates',
  'pending_items',
  'conflicts',
  'missing_fields',
  'decision_classification'
]));

// 模型輸出裡出現這些就是想自己決定身分。整個 turn 作廢。
const IDENTITY_KEY_PATTERN = /(actor|user_id|userid|party|ownership|line_user|tenant_user|landlord_user|permission|authoriz)/i;

const RESPONSE_TEXT_MAX_LENGTH = 2000;
// Vertex cold starts and medium-thinking turns regularly exceed an ordinary
// chat webhook budget.  The caller still caps this at 30 seconds and receives
// a neutral retry instead of an invented landlord question on timeout.
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 30000;

function agentError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function flagOn(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase() === 'true';
}

/**
 * Agent 是否可用。**預設關**,而且 public demo 一律關。
 */
function enabled(env = process.env) {
  if (flagOn(env.V2_CONTRACT_DEMO_PUBLIC) || flagOn(env.PUBLIC_DEMO_MODE)) return false;
  return flagOn(env.ECS_NEO_AGENT_ENABLED);
}

function timeoutMs(env = process.env) {
  const configured = Number(env.AGENT_RUNTIME_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(configured, MAX_TIMEOUT_MS);
}

function requireStringArray(value, name) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw agentError(`${name} 必須是陣列`, 'invalid_model_output');
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw agentError(`${name} 只能是非空字串`, 'invalid_model_output');
    }
    return item.trim().slice(0, 200);
  });
}

// 候選條件只是候選。這裡不判斷值合不合理,只確保結構完整而且**每一項都有來源** ——
// 沒有來源的候選會在 gateway 被丟掉,提早在這裡擋掉可以讓 trace 指出是模型的問題。
function normalizeCandidates(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw agentError('condition_candidates 必須是陣列', 'invalid_model_output');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw agentError('condition_candidates 的每一項都必須是物件', 'invalid_model_output');
    }
    for (const key of Object.keys(item)) {
      if (IDENTITY_KEY_PATTERN.test(key)) {
        throw agentError(`condition_candidates 不得包含身分欄位 ${key}`, 'invalid_model_output');
      }
    }
    const fieldPath = item.field_path;
    if (typeof fieldPath !== 'string' || !fieldPath.trim()) {
      throw agentError('condition_candidates 缺少 field_path', 'invalid_model_output');
    }
    const sourceType = item.source_type;
    if (typeof sourceType !== 'string' || !sourceType.trim()) {
      throw agentError(`${fieldPath} 缺少 source_type`, 'invalid_model_output');
    }
    if (item.source_id === null || item.source_id === undefined || item.source_id === '') {
      throw agentError(`${fieldPath} 缺少 source_id`, 'invalid_model_output');
    }
    return {
      fieldPath: fieldPath.trim(),
      value: item.value === undefined ? null : item.value,
      sourceType: sourceType.trim(),
      sourceId: item.source_id
    };
  });
}

function normalizeConflicts(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw agentError('conflicts 必須是陣列', 'invalid_model_output');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw agentError('conflicts 的每一項都必須是物件', 'invalid_model_output');
    }
    const fieldPath = typeof item.field_path === 'string' ? item.field_path.trim() : '';
    if (!fieldPath) throw agentError('conflicts 缺少 field_path', 'invalid_model_output');
    return {
      fieldPath,
      note: typeof item.note === 'string' ? item.note.trim().slice(0, 500) : null
    };
  });
}

/**
 * 把 sidecar 回傳的東西收斂成一個 proposed action,或丟 invalid_model_output。
 */
function validateAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw agentError('Agent 回覆不是物件', 'invalid_model_output');
  }
  for (const key of Object.keys(raw)) {
    if (IDENTITY_KEY_PATTERN.test(key)) {
      // spec:模型輸出任何身分欄位,Gateway 忽略該值並記錄 invalid_model_output。
      throw agentError(`Agent 回覆不得包含身分欄位 ${key}`, 'invalid_model_output');
    }
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw agentError(`Agent 回覆含未知欄位 ${key}`, 'invalid_model_output');
    }
  }

  if (!PROPOSED_ACTION_TYPES.includes(raw.type)) {
    throw agentError(`未知的 proposed action type ${JSON.stringify(raw.type)}`, 'invalid_model_output');
  }

  const responseText = typeof raw.response_text === 'string' ? raw.response_text.trim() : '';
  // no_action 可以沒有文字(它的意思就是「這一則不需要回」)。其他一律要有。
  if (raw.type !== 'no_action' && !responseText) {
    throw agentError('proposed action 缺少 response_text', 'invalid_model_output');
  }
  if (responseText.length > RESPONSE_TEXT_MAX_LENGTH) {
    throw agentError('response_text 過長', 'invalid_model_output');
  }

  const decisionClassification = raw.decision_classification ?? null;
  if (decisionClassification !== null && !DECISION_CLASSIFICATIONS.includes(decisionClassification)) {
    throw agentError(
      `未知的 decision_classification ${JSON.stringify(decisionClassification)}`,
      'invalid_model_output'
    );
  }

  return {
    type: raw.type,
    responseText,
    groundingRefs: requireStringArray(raw.grounding_refs, 'grounding_refs'),
    conditionCandidates: normalizeCandidates(raw.condition_candidates),
    pendingItems: require('./ecsNeoPendingItemsService').normalizePendingItems(raw.pending_items),
    conflicts: normalizeConflicts(raw.conflicts),
    missingFields: requireStringArray(raw.missing_fields, 'missing_fields'),
    decisionClassification
  };
}

/**
 * 送一個 turn envelope 給 sidecar。
 *
 * @returns {Promise<object|null>} feature flag 關閉時回 null(呼叫端退回既有問答路徑)
 * @throws  code 為 model_timeout / model_provider_error / invalid_model_output 的錯誤
 */
async function handleTurn(envelope, { fetchImpl, env = process.env } = {}) {
  if (!enabled(env)) return null;

  const secret = String(env.AGENT_RUNTIME_SHARED_SECRET || '');
  if (!secret) {
    // 開了 flag 卻沒有 credential 是部署錯誤。不 fallback 成匿名呼叫。
    throw agentError('Agent runtime shared secret 未設定', 'model_provider_error');
  }

  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw agentError('這個 runtime 沒有 fetch', 'model_provider_error');
  }

  const baseUrl = String(env.AGENT_RUNTIME_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs(env));

  try {
    const response = await fetcher(`${baseUrl}/v1/turns:handle`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(envelope),
      signal: controller.signal
    });
    if (!response || !response.ok) {
      const status = response ? response.status : 'no-response';
      throw agentError(`Agent runtime 回應 ${status}`, 'model_provider_error');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw agentError('Agent runtime 回傳的不是 JSON', 'invalid_model_output');
    }
    return validateAction(payload);
  } catch (error) {
    if (error && typeof error.code === 'string'
        && ['model_timeout', 'model_provider_error', 'invalid_model_output'].includes(error.code)) {
      throw error;
    }
    // abort 只有一個來源:上面那個 timer。逾時必須是 model_timeout,
    // 混進 model_provider_error 會讓「要不要調 timeout」變成查不出來的問題。
    if (timedOut || (error && error.name === 'AbortError')) {
      throw agentError('Agent runtime 逾時', 'model_timeout');
    }
    throw agentError(`Agent runtime 無法連線:${error && error.message}`, 'model_provider_error');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DECISION_CLASSIFICATIONS,
  IDENTITY_KEY_PATTERN,
  PROPOSED_ACTION_TYPES,
  RESPONSE_TEXT_MAX_LENGTH,
  enabled,
  handleTurn,
  timeoutMs,
  validateAction
};
