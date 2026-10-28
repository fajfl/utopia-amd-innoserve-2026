// prepare_contract_draft:把「房客確認的精確意向版本 + 指定契約範本版本 +
// 指定有效法規 rule pack 版本」變成一份**不可變**的 prepared contract draft artifact,
// 寫進 prepared_contract_drafts。
//
// 這個模組是 src/services/ecsNeoContractAcceptanceServiceAsync.js 的上游。
// 兩件事必須完全對齊,否則 artifact 永遠通不過接受:
//   1. canonical checksum。這裡**直接 require 接受服務的 preparedDraftChecksum**,
//      不自己重寫一份 canonical 序列化。重寫一份等於埋一個只在雲端或某些鍵順序下
//      才出現的不相符,而且沒有測試能穩定抓到。
//   2. 「空」的定義。clause snapshot 的每個欄位都必須有 provenance,而「有」的
//      判準與接受服務的 hasSourceEntry 一致(見 validator 的 hasValue)。
//
// LLM 的分界(硬性):
//   * 模型呼叫在**交易外**完成,而且是可注入的。交易內只做 deterministic 驗證與固化。
//   * 模型只能提供兩種東西:每個條件欄位的自然語言說明,以及疑似矛盾的初步提示。
//     兩者都不影響 blocking 判斷 —— 疑似矛盾一律降級成 advisory issue。
//   * 模型不能新增、修改或刪除任何條件欄位。clause snapshot 完全由 exact intention
//     version 的欄位與 condition_json 決定,模型輸出中的其他鍵一律丟棄。
//   * Agent 不代表任何一方表示法律意思:這裡不建立 contract、不 issue、不簽署,
//     也不改 rental_intentions / inquiries 的狀態。
//
// artifact 的不可變性:
//   * 產生後只有接受服務會寫 materialized_contract_version_id 一個欄位。
//     這個模組**永遠不 UPDATE** prepared_contract_drafts。
//   * 冪等來自 UNIQUE(intention_version_id, payload_checksum):同一組輸入重跑會拿回
//     同一份 artifact(reused: true),不會產生第二份內容相同的草稿。
//
// 錯誤 code:
//   invalid_input 400
//   intention_version_not_found / template_version_not_found /
//   rule_pack_version_not_found 404
//   intention_version_not_confirmed、template_version_inactive、
//   rule_pack_version_inactive、rule_pack_invalid、template_manifest_invalid、
//   invalid_intention_version 409
//   internal_invariant_violation 500

const crypto = require('node:crypto');

const { idEquals } = require('../database/idEquals');
const { preparedDraftChecksum } = require('./ecsNeoContractAcceptanceServiceAsync');
const {
  hasValue,
  normalizeRulePack,
  normalizeTemplateManifest,
  validateContractDraft
} = require('./ecsNeoLegalRuleValidator');

// prompt 內容改變就要換版號,否則同一個 promptVersion 會對應到兩種模型行為,
// artifact 的 checksum 也會失去「同輸入同輸出」的意義。
const PROMPT_VERSION = 'ecs-neo-contract-draft-v1';

// intention_versions 的結構化欄位 -> clause snapshot 的欄位名。
// 這個映射是 deterministic 的:模型無權決定哪些欄位進契約。
const INTENTION_COLUMN_CLAUSE_FIELDS = Object.freeze({
  rent_amount: 'rentAmount',
  deposit_amount: 'depositAmount',
  lease_start_date: 'leaseStartDate',
  lease_end_date: 'leaseEndDate',
  move_in_date: 'moveInDate',
  pet_request_text: 'petRequest',
  equipment_request_text: 'equipmentRequest',
  viewing_request_text: 'viewingRequest',
  special_request_text: 'specialRequest'
});

// condition_json 是協商保存的原始結構；rent / deposit / lease_term / move_in 的值已由
// mapStructuredColumns 正規化到 intention_versions columns，並在上表投影成範本
// 使用的 camelCase clause field。若兩種表示法都塞進 clause snapshot，範本會看到
// 不存在的 `rent`、`deposit`、`lease_term` 條款，還會把同一事實錯判為缺來源。
// 因此這些原始容器只作為版本保存資料，不是獨立的契約條款。
const STRUCTURED_CONDITION_CONTAINERS = new Set(['rent', 'deposit', 'lease_term', 'move_in', 'special_terms']);

function fail(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// 與接受服務的 isDuplicateKeyError 同一套判準。
// 刻意重複而不是從那邊 export:接受服務是下游消費者,它的公開介面不該因為
// 上游想省十行而變寬。兩份必須保持一致 —— 只認唯一鍵/主鍵,不認 SQLSTATE 23000
// (外鍵失敗也是 23000,誤判會把寫錯的 FK 偽裝成正常的併發重跑)。
const SQLITE_DUPLICATE_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY'
]);

function isDuplicateKeyError(error) {
  if (!error) return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (SQLITE_DUPLICATE_CODES.has(code)) return true;
  if (code === 'ER_DUP_ENTRY') return true;
  if (Number(error.errno) === 1062) return true;
  return false;
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fail(`${name} is required`, 'invalid_input', 400);
  }
  return value;
}

function parseJsonObject(text, label, code) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const failure = fail(`${label} 不是合法 JSON`, code);
    failure.cause = error;
    throw failure;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail(`${label} 必須是物件`, code);
  }
  return parsed;
}

// 依鍵排序後重建物件。儲存的 JSON 字串本身不參與 checksum(接受服務會重新
// canonicalize),但排序過的字串讓兩份 artifact 的 diff 是可讀的。
function sortedObject(source) {
  const result = {};
  for (const key of Object.keys(source).sort()) result[key] = source[key];
  return result;
}

// --- 讀取綁定 ----------------------------------------------------------------

async function loadExactVersion(reader, intentionVersionPublicId) {
  const row = await reader.get(`
    SELECT iv.id AS intention_version_id,
           iv.public_id,
           iv.rental_intention_id,
           iv.version_number,
           iv.rent_amount,
           iv.deposit_amount,
           iv.lease_start_date,
           iv.lease_end_date,
           iv.move_in_date,
           iv.pet_request_text,
           iv.equipment_request_text,
           iv.viewing_request_text,
           iv.special_request_text,
           iv.condition_json,
           ri.status AS intention_status,
           ri.confirmed_intention_version_id
    FROM intention_versions iv
    JOIN rental_intentions ri ON ri.id = iv.rental_intention_id
    WHERE iv.public_id = ?
  `, [intentionVersionPublicId]);
  if (!row) throw fail('意向版本不存在', 'intention_version_not_found', 404);
  return row;
}

async function loadTemplateVersion(reader, templateVersionPublicId) {
  const row = await reader.get(`
    SELECT id, public_id, version_label, manifest_json, manifest_checksum, status
    FROM contract_template_versions
    WHERE public_id = ?
  `, [templateVersionPublicId]);
  if (!row) throw fail('契約範本版本不存在', 'template_version_not_found', 404);
  return row;
}

async function loadRulePackVersion(reader, rulePackVersionPublicId) {
  const row = await reader.get(`
    SELECT id, public_id, version_label, rules_json, rules_checksum, status
    FROM legal_rule_pack_versions
    WHERE public_id = ?
  `, [rulePackVersionPublicId]);
  if (!row) throw fail('法規 rule pack 版本不存在', 'rule_pack_version_not_found', 404);
  return row;
}

// 綁定的是**具體版本**,不是「最新」。這裡也不做 fallback:傳進來的版本不是
// active 就直接失敗,不會自動改綁另一個版本。默默換版本等於用一份沒人核准過的
// 範本產生契約。
function requireActiveBindings(templateVersion, rulePackVersion) {
  if (templateVersion.status !== 'active') {
    throw fail(`契約範本版本 ${templateVersion.public_id} 不是 active(目前為 ${templateVersion.status})`, 'template_version_inactive');
  }
  if (rulePackVersion.status !== 'active') {
    throw fail(`法規 rule pack 版本 ${rulePackVersion.public_id} 不是 active(目前為 ${rulePackVersion.status})`, 'rule_pack_version_inactive');
  }
}

// --- clause snapshot 與 provenance -------------------------------------------

// clause snapshot 只放「能追回這個 exact intention version 的協商條件」。
//
// 刻意**不**放依法固定的條文與範本樣板文字:接受服務會為 snapshot 的每一個
// 欄位寫一列 contract_version_sources(source_type='intention_version'),
// 把法定文字混進來會產生「這條是雙方談出來的」這種假 provenance。
// 完整條文留在 template manifest,責任說明留在 responsibility matrix。
function buildClauseSnapshot(version) {
  const snapshot = {};

  // condition_json 先進,結構化欄位後進並覆蓋:欄位是正規化過的權威值,
  // condition_json 是協商過程留下的補充。
  if (hasValue(version.condition_json)) {
    const condition = parseJsonObject(version.condition_json, 'condition_json', 'invalid_intention_version');
    for (const key of Object.keys(condition)) {
      if (STRUCTURED_CONDITION_CONTAINERS.has(key)) continue;
      // false 是有意義的值(例如 petAllowed=false),所以不能用 hasValue 過濾 boolean。
      // 只跳過 null / undefined / 空字串 / 空容器。
      if (condition[key] === false || hasValue(condition[key])) snapshot[key] = condition[key];
    }
  }

  for (const [column, field] of Object.entries(INTENTION_COLUMN_CLAUSE_FIELDS)) {
    const value = version[column];
    if (value === false || hasValue(value)) snapshot[field] = value;
  }

  if (snapshot.specialRequest != null) snapshot.specialRequest = require('./ecsNeoOtherAgreements').otherAgreements(snapshot.specialRequest).join('\n');
  return sortedObject(snapshot);
}

// provenance 有三種來源,全部寫進 source_map_json:
//   人類依據   intention_version_sources 的逐欄來源(訊息、房源快照、知識版本、
//              手動輸入、房東回答)
//   範本條次   template manifest 的 slot -> clauseRef
//   法規條號   rule pack 裡直接規範這個欄位的 ruleRef
//
// validator 只把第一種算成「有依據」;後兩種是「這一條落在哪裡、依據哪一條法規」,
// 不能替代人類同意。
async function buildSourceMap(reader, { intentionVersionId, clauseSnapshot, templateManifest, rulePack }) {
  const rows = await reader.all(`
    SELECT field_path, source_type, source_id
    FROM intention_version_sources
    WHERE intention_version_id = ?
    ORDER BY field_path, source_type, source_id
  `, [intentionVersionId]);

  const humanByField = new Map();
  for (const row of rows) {
    const list = humanByField.get(row.field_path) || [];
    list.push({ sourceType: row.source_type, sourceId: Number(row.source_id) });
    humanByField.set(row.field_path, list);
  }

  const ruleRefsByField = new Map();
  const addRuleRef = (field, ruleRef) => {
    const list = ruleRefsByField.get(field) || [];
    if (!list.includes(ruleRef)) list.push(ruleRef);
    ruleRefsByField.set(field, list);
  };
  for (const rule of rulePack.requiredClauses) addRuleRef(rule.clauseField, rule.ruleRef);
  for (const rule of rulePack.responsibilityClauses) addRuleRef(rule.clauseField, rule.ruleRef);
  for (const rule of rulePack.conflictRules) {
    for (const field of [rule.earlierField, rule.laterField, rule.numeratorField, rule.denominatorField]) {
      if (field) addRuleRef(field, rule.ruleRef);
    }
  }

  const sourceMap = {};
  for (const field of Object.keys(clauseSnapshot).sort()) {
    const entries = [...(humanByField.get(field) || [])];
    const slot = templateManifest.byClauseField.get(field);
    if (slot) {
      entries.push({
        sourceType: 'template_clause',
        clauseRef: slot.clauseRef,
        clauseTitle: slot.clauseTitle,
        slot: slot.slot
      });
    }
    for (const ruleRef of (ruleRefsByField.get(field) || []).sort()) {
      entries.push({ sourceType: 'legal_rule', ruleRef });
    }
    sourceMap[field] = entries;
  }
  return sourceMap;
}

// --- 責任矩陣 ----------------------------------------------------------------

// 責任矩陣是**草稿說明資料**,不是契約條件。它的結構欄位全部 deterministic;
// 模型只能填 modelNarrative 一格。
//
// 之所以把「誰負責」留成 null + needsHumanDecision,而不是讓模型補齊:
// 條件本身沒寫清楚時,補齊的動作就是替雙方決定責任歸屬。那是人的工作。
// 對應的 blocking issue 已由 validator 的 unclear_responsibility 產生。
const PARTY_KEYWORDS = [
  { pattern: /(房東|出租人)/, party: 'landlord' },
  { pattern: /(房客|承租人)/, party: 'tenant' },
  { pattern: /雙方/, party: 'both' }
];

function inferParty(value) {
  if (typeof value !== 'string') return null;
  const matches = PARTY_KEYWORDS.filter((entry) => entry.pattern.test(value));
  // 一句話同時提到房東與房客時無法 deterministic 地判斷主體,留給人類。
  if (matches.length !== 1) return null;
  return matches[0].party;
}

function buildResponsibilityMatrix({ clauseSnapshot, templateManifest, rulePack, sourceMap, narratives }) {
  const responsibilityFields = new Set(rulePack.responsibilityClauses.map((rule) => rule.clauseField));

  return Object.keys(clauseSnapshot).sort().map((field) => {
    const slot = templateManifest.byClauseField.get(field) || null;
    const value = clauseSnapshot[field];
    const party = inferParty(value);
    const narrative = narratives && typeof narratives[field] === 'string' ? narratives[field].trim() : null;

    return {
      clauseField: field,
      clauseRef: slot ? slot.clauseRef : null,
      clauseTitle: slot ? slot.clauseTitle : null,
      value,
      // 只有 rule pack 標為責任條款的欄位才需要責任主體;租金金額不需要「誰負責」。
      obligatedParty: responsibilityFields.has(field) ? party : null,
      needsHumanDecision: responsibilityFields.has(field) && party === null,
      sources: sourceMap[field] || [],
      // 明確標示這段文字是 AI 產生的說明,不是雙方已同意的條款。
      modelNarrative: narrative || null,
      modelNarrativeIsNotAgreedTerm: true
    };
  });
}

// --- 模型輸出的收斂 ----------------------------------------------------------

// 模型回來的東西一律先過這道濾網:只留白名單內的兩件事,其餘全部丟棄。
// 沒有這一層,模型只要多回一個 clauseSnapshot 就能把自己編的條件送進契約。
function sanitizeModelOutput(raw, clauseSnapshot) {
  const narratives = {};
  const suspectedConflicts = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { narratives, suspectedConflicts, droppedKeys: [] };
  }

  const allowed = new Set(['clauseNarratives', 'suspectedConflicts']);
  const droppedKeys = Object.keys(raw).filter((key) => !allowed.has(key)).sort();

  const rawNarratives = raw.clauseNarratives;
  if (rawNarratives && typeof rawNarratives === 'object' && !Array.isArray(rawNarratives)) {
    for (const field of Object.keys(rawNarratives).sort()) {
      // 模型不能為「不存在的條件」寫說明 —— 那是在憑空建立條款。
      if (!Object.prototype.hasOwnProperty.call(clauseSnapshot, field)) continue;
      const text = rawNarratives[field];
      if (typeof text === 'string' && text.trim()) narratives[field] = text.trim();
    }
  }

  if (Array.isArray(raw.suspectedConflicts)) {
    for (const item of raw.suspectedConflicts) {
      if (!item || typeof item !== 'object') continue;
      const note = typeof item.note === 'string' ? item.note.trim() : '';
      if (!note) continue;
      const fields = (Array.isArray(item.clauseFields) ? item.clauseFields : [])
        .filter((field) => typeof field === 'string'
          && Object.prototype.hasOwnProperty.call(clauseSnapshot, field))
        .sort();
      suspectedConflicts.push({ clauseFields: fields, note });
    }
  }

  return { narratives, suspectedConflicts, droppedKeys };
}

// --- command -----------------------------------------------------------------

/**
 * @param {object} input
 * @param {object} input.db                            async sqlDriver
 * @param {string} input.intentionVersionPublicId      房客確認的 exact version
 * @param {string} input.templateVersionPublicId       具體契約範本版本
 * @param {string} input.rulePackVersionPublicId       具體法規 rule pack 版本
 * @param {object} [input.modelClient]                 { generateDraftNarrative(payload) };
 *                                                     省略即產生純 deterministic artifact
 * @param {string} [input.agentExecutionPublicId]      對應的 agent_executions.public_id
 * @param {boolean} [input.requireConfirmedVersion=true]
 */
async function prepareContractDraft(input = {}) {
  const { db } = input;
  if (!db || typeof db.transaction !== 'function') {
    throw fail('db driver is required', 'invalid_input', 400);
  }
  const intentionVersionPublicId = requireText(input.intentionVersionPublicId, 'intentionVersionPublicId');
  const templateVersionPublicId = requireText(input.templateVersionPublicId, 'templateVersionPublicId');
  const rulePackVersionPublicId = requireText(input.rulePackVersionPublicId, 'rulePackVersionPublicId');
  const requireConfirmedVersion = input.requireConfirmedVersion !== false;

  // ---- 階段 1:交易外讀取。-------------------------------------------------
  // intention version 與 template/rule-pack 版本的**內容**都是不可變的,
  // 只有 status 會變,所以階段 3 會再確認一次 status。
  const version = await loadExactVersion(db, intentionVersionPublicId);
  const templateVersion = await loadTemplateVersion(db, templateVersionPublicId);
  const rulePackVersion = await loadRulePackVersion(db, rulePackVersionPublicId);
  requireActiveBindings(templateVersion, rulePackVersion);

  // 草稿只能依房客明確確認的那一個版本產生。少了這一關,房東可以拿房客沒同意過的
  // 版本先產生一份看起來合法的 artifact,再送進接受流程。
  if (requireConfirmedVersion
      && !idEquals(version.confirmed_intention_version_id, version.intention_version_id)) {
    throw fail('這不是房客確認的意向版本', 'intention_version_not_confirmed');
  }

  const templateManifest = normalizeTemplateManifest(
    parseJsonObject(templateVersion.manifest_json, 'manifest_json', 'template_manifest_invalid')
  );
  const rulePack = normalizeRulePack(
    parseJsonObject(rulePackVersion.rules_json, 'rules_json', 'rule_pack_invalid')
  );

  const clauseSnapshot = buildClauseSnapshot(version);
  const sourceMap = await buildSourceMap(db, {
    intentionVersionId: version.intention_version_id,
    clauseSnapshot,
    templateManifest,
    rulePack
  });

  // ---- 階段 2:交易外呼叫模型。-------------------------------------------
  // **不在交易內。** 模型延遲數十秒,而 SQLite 同時只有一個 writer、TiDB 的
  // 悲觀鎖也會一路持有;把網路呼叫放進交易會讓整個成交路徑被一次 model timeout 卡住。
  let modelOutcome = { narratives: {}, suspectedConflicts: [], droppedKeys: [] };
  let modelId = null;
  let modelVersion = null;
  let promptVersion = null;
  let modelError = null;

  if (input.modelClient && typeof input.modelClient.generateDraftNarrative === 'function') {
    promptVersion = PROMPT_VERSION;
    try {
      const raw = await input.modelClient.generateDraftNarrative({
        promptVersion: PROMPT_VERSION,
        templateVersionLabel: templateVersion.version_label,
        rulePackVersionLabel: rulePackVersion.version_label,
        templateSlots: templateManifest.slots,
        clauseSnapshot
      });
      modelOutcome = sanitizeModelOutput(raw && raw.output, clauseSnapshot);
      modelId = typeof (raw && raw.modelId) === 'string' ? raw.modelId : null;
      modelVersion = typeof (raw && raw.modelVersion) === 'string' ? raw.modelVersion : null;
    } catch (error) {
      // 模型故障不能阻止 artifact 產生:deterministic 的條款、法規檢查與責任矩陣
      // 骨架完全不需要模型。少的只有自然語言說明,人類照樣能查看與判斷。
      // 反過來把它變成錯誤,等於讓供應商故障擋住合法的成交路徑。
      modelError = error;
      promptVersion = PROMPT_VERSION;
    }
  }

  // ---- 階段 3:交易內驗證與固化。-----------------------------------------
  return db.transaction(async (tx) => {
    // status 重讀。階段 1 到現在之間,範本或 rule pack 可能被取代。
    const currentTemplate = await loadTemplateVersion(tx, templateVersionPublicId);
    const currentRulePack = await loadRulePackVersion(tx, rulePackVersionPublicId);
    requireActiveBindings(currentTemplate, currentRulePack);
    // checksum 也重讀。內容理論上不可變,不相符代表有人繞過應用層改了版本內容,
    // 那份 artifact 綁的就不是我們驗過的東西。
    if (currentTemplate.manifest_checksum !== templateVersion.manifest_checksum
        || currentRulePack.rules_checksum !== rulePackVersion.rules_checksum) {
      throw fail('範本或 rule pack 的內容在準備期間改變了', 'internal_invariant_violation', 500);
    }

    const validation = validateContractDraft({
      clauseSnapshot,
      sourceMap,
      rulePack,
      templateManifest,
      modelSuspectedConflicts: modelOutcome.suspectedConflicts
    });

    const issues = validation.issues.slice();
    // 模型故障與模型輸出被丟棄都是人類該知道的事,但都不是 blocking:
    // 這份 artifact 的法律判斷完全沒有依賴模型。
    if (modelError) {
      issues.push({
        code: 'model_narrative_unavailable',
        category: 'llm_suspected_conflict',
        severity: 'advisory',
        clauseFields: [],
        message: `AI 說明產生失敗,草稿仍以 deterministic 規則完成驗證:${modelError.message}`,
        basis: { source: 'model', ruleRef: null, label: 'AI 說明' }
      });
    }
    if (modelOutcome.droppedKeys.length > 0) {
      issues.push({
        code: 'model_output_keys_dropped',
        category: 'llm_suspected_conflict',
        severity: 'advisory',
        clauseFields: [],
        message: `AI 輸出含有不被允許的欄位並已丟棄:${modelOutcome.droppedKeys.join(', ')}。條件內容只來自房客確認的意向版本。`,
        basis: { source: 'model', ruleRef: null, label: 'AI 輸出白名單' }
      });
    }

    const responsibilityMatrix = buildResponsibilityMatrix({
      clauseSnapshot,
      templateManifest,
      rulePack,
      sourceMap,
      narratives: modelOutcome.narratives
    });

    // checksum 用接受服務的同一支函式算。這裡不重寫 canonical 序列化。
    const payloadChecksum = preparedDraftChecksum({
      intentionVersionPublicId: version.public_id,
      templateManifestChecksum: currentTemplate.manifest_checksum,
      rulePackChecksum: currentRulePack.rules_checksum,
      modelId,
      modelVersion,
      promptVersion,
      clauseSnapshot,
      responsibilityMatrix,
      issues,
      sourceMap
    });

    const existing = await tx.get(`
      SELECT public_id, status, blocking_issue_count
      FROM prepared_contract_drafts
      WHERE intention_version_id = ? AND payload_checksum = ?
    `, [version.intention_version_id, payloadChecksum]);
    if (existing) {
      // artifact 不可變:內容相同就回傳既有那一份,不 UPDATE、不新增第二份。
      return {
        reused: true,
        preparedDraftPublicId: existing.public_id,
        status: existing.status,
        blockingIssueCount: Number(existing.blocking_issue_count),
        issues,
        clauseSnapshot,
        responsibilityMatrix,
        sourceMap,
        payloadChecksum
      };
    }

    let agentExecutionId = null;
    if (typeof input.agentExecutionPublicId === 'string' && input.agentExecutionPublicId.trim()) {
      const execution = await tx.get(
        'SELECT id FROM agent_executions WHERE public_id = ?',
        [input.agentExecutionPublicId]
      );
      // artifact 一旦寫入就不能補欄位,所以 trace 關聯只有這一次機會。
      // 指到不存在的 execution 是呼叫端的錯,不能靜默寫成 NULL 了事。
      if (!execution) throw fail('agent execution 不存在', 'invalid_input', 400);
      agentExecutionId = execution.id;
    }

    const blockingIssueCount = issues.filter((item) => item.severity === 'blocking').length;
    const status = blockingIssueCount === 0 ? 'ready' : 'draft_review_required';
    const preparedDraftPublicId = `prepared-draft-${crypto.randomUUID()}`;

    try {
      await tx.run(`
        INSERT INTO prepared_contract_drafts
          (public_id, rental_intention_id, intention_version_id,
           contract_template_version_id, legal_rule_pack_version_id, agent_execution_id,
           model_id, model_version, prompt_version,
           clause_snapshot_json, responsibility_matrix_json, issues_json, source_map_json,
           payload_checksum, status, blocking_issue_count, validated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        preparedDraftPublicId,
        version.rental_intention_id,
        version.intention_version_id,
        currentTemplate.id,
        currentRulePack.id,
        agentExecutionId,
        modelId,
        modelVersion,
        promptVersion,
        JSON.stringify(clauseSnapshot),
        JSON.stringify(responsibilityMatrix),
        JSON.stringify(issues),
        JSON.stringify(sourceMap),
        payloadChecksum,
        status,
        blockingIssueCount
      ]);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // 兩個請求同時準備同一份 artifact。UNIQUE(intention_version_id,
      // payload_checksum) 讓其中一個落敗;內容一模一樣,所以回傳對方那一份即可。
      const raced = await tx.get(`
        SELECT public_id, status, blocking_issue_count
        FROM prepared_contract_drafts
        WHERE intention_version_id = ? AND payload_checksum = ?
      `, [version.intention_version_id, payloadChecksum]);
      if (!raced) {
        // 撞的不是 (version, checksum) 這個唯一鍵。原樣往上丟,不猜。
        throw error;
      }
      return {
        reused: true,
        preparedDraftPublicId: raced.public_id,
        status: raced.status,
        blockingIssueCount: Number(raced.blocking_issue_count),
        issues,
        clauseSnapshot,
        responsibilityMatrix,
        sourceMap,
        payloadChecksum
      };
    }

    return {
      reused: false,
      preparedDraftPublicId,
      status,
      blockingIssueCount,
      issues,
      clauseSnapshot,
      responsibilityMatrix,
      sourceMap,
      payloadChecksum
    };
  });
}

module.exports = {
  INTENTION_COLUMN_CLAUSE_FIELDS,
  PROMPT_VERSION,
  buildClauseSnapshot,
  prepareContractDraft,
  sanitizeModelOutput
};
