// ECS NEO 契約草稿的 deterministic legal validator。
//
// 這個模組是**純函式**:沒有 DB、沒有網路、沒有模型、沒有時鐘。
// 同一組輸入永遠得到同一組 issues,所以它的輸出可以安全地進入
// prepared_contract_drafts 的 canonical checksum。
//
// 分界是硬的:法律效力判斷與 blocking 決策**只在這裡**發生。
// 模型可以提出「這兩條看起來衝突」,但那一律降級成 advisory
// (llm_suspected_conflict),永遠不會讓 artifact 變成 blocking,也永遠不會
// 讓一個 blocking issue 消失。理由:模型輸出無法用 deterministic test 證明,
// 而「能不能固化成契約」必須能被測試釘死。
//
// 規則本體是**資料**,不是程式:legal_rule_pack_versions.rules_json 與
// contract_template_versions.manifest_json。升版官方公告只換資料與 checksum,
// 不改這個檔案。這裡只實作規則的「種類」:
//   requiredClauses       -> 必要條款缺漏
//   prohibitedTerms       -> 侵害承租人權益的約定(不得記載事項)
//   responsibilityClauses -> 責任歸屬不明(修繕、費用分擔、提前終止)
//   conflictRules         -> 條款彼此矛盾(日期順序、最短租期、金額比例)
//
// 另外兩類 issue 不來自 rule pack,而是 artifact 本身的完整性:
//   clause_not_in_template -> 範本承載不了這個條件
//   missing_provenance     -> 條件追不回房客/房東的原始依據
//
// 嚴重度只有兩級。blocking 代表「不得固化」;advisory 代表「人要看,但可以簽」。
// 刻意沒有第三級 warning:「顯示警告後繼續」正是 spec 明文禁止的行為。

// --- 嚴重度與分類的封閉集合 --------------------------------------------------

const SEVERITY_BLOCKING = 'blocking';
const SEVERITY_ADVISORY = 'advisory';

const ISSUE_CATEGORIES = new Set([
  'missing_required_clause',
  'prohibited_term',
  'clause_conflict',
  'unclear_responsibility',
  'invalid_clause_value',
  'template_coverage',
  'missing_provenance',
  'llm_suspected_conflict'
]);

// 能證明「這個條件來自人類」的來源型別。
// 前四個是 002 的 intention_version_sources CHECK;landlord_answer 是 016 預定
// 補上的房東反提案來源;intention_version 是接受服務逐欄寫入 contract_version_sources
// 時用的型別,artifact 端沿用同一個字面值。
//
// template_clause 與 legal_rule 刻意**不在**這個集合裡:範本條次與法規條號說明的是
// 「這個條件落在哪一條」,不是「誰同意了這個條件」。少了這道區分,一個完全沒有
// 人類依據的欄位只要掛上範本條次就能假裝有 provenance。
const INTENTION_SOURCE_TYPES = new Set([
  'message',
  'listing_snapshot',
  'knowledge_version',
  'manual_input',
  'landlord_answer',
  'intention_version'
]);

// --- 值的判讀 ----------------------------------------------------------------

// 「有值」不等於「鍵存在」。null、空字串、空陣列、空物件都是沒填。
// 與接受服務的 hasSourceEntry 同一個語意,兩邊對「空」的定義必須一致。
function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 只認 'YYYY-MM-DD'。契約日期不接受「大概」,格式不對就是 invalid_clause_value,
// 不做寬鬆解析 —— 猜錯一個日期會直接改變租期與押金上限的計算。
function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value.trim())) return null;
  const text = value.trim();
  const timestamp = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  // Date.parse 會把 '2026-02-31' 收下並自動進位成 3 月 3 日。回頭比對字面值,
  // 不存在的日期一律判為無效。
  if (new Date(timestamp).toISOString().slice(0, 10) !== text) return null;
  return timestamp;
}

const DAY_MS = 86400000;

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// 責任條款要能看出「誰」負責。
// 「任一方」「任何一方」跟「雙方」同義:兩邊都有這個權利或責任。
const PARTY_PATTERN = /(房東|出租人|房客|承租人|雙方|任一方|任何一方|各方)/;

// 明確表示「還沒談定」的措辭。這些字出現在責任條款裡就是責任歸屬不明,
// 不能讓它靜靜通過並在簽署後才發現沒有人負責修冷氣。
const VAGUE_PATTERN =
  /(另議|再議|另行約定|另行商議|另外談|視情況|依情況|看情況|依實際情形|由雙方協商|雙方再談|待確認|待討論|不確定|暫定|其他|等等|之類)/;

// --- rule pack 與 template manifest 的正規化 ----------------------------------

function invalid(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function requireArray(value, label, code) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${label} 必須是陣列`, code);
  return value;
}

function requireString(value, label, code) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${label} 必須是非空字串`, code);
  }
  return value.trim();
}

// 從 rule pack 資料編譯 regex。pattern 來自已核准的 rule-pack 版本(有
// approved_by_user_id 與 checksum),不是使用者輸入,但仍限制長度:
// 一個異常長的 pattern 更可能是資料寫壞,而不是真的規則。
function compilePattern(source, ruleCode) {
  const text = requireString(source, `不得記載規則 ${ruleCode} 的 textPatterns 元素`, 'rule_pack_invalid');
  if (text.length > 200) {
    throw invalid(`不得記載規則 ${ruleCode} 的 textPattern 過長`, 'rule_pack_invalid');
  }
  try {
    return new RegExp(text, 'u');
  } catch (error) {
    const failure = invalid(`不得記載規則 ${ruleCode} 的 textPattern 無法編譯`, 'rule_pack_invalid');
    failure.cause = error;
    throw failure;
  }
}

const CONFLICT_KINDS = new Set(['date_order', 'min_days', 'max_ratio']);

// rule pack 的形狀在這裡一次驗完。這是刻意的:規則資料寫錯要在產生 artifact 時
// 就爆出來,而不是變成「某條規則靜默沒有執行」。少執行一條不得記載事項,
// 測試會全過而契約會出錯。
function normalizeRulePack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('rule pack 必須是物件', 'rule_pack_invalid');
  }

  const requiredClauses = requireArray(value.requiredClauses, 'requiredClauses', 'rule_pack_invalid')
    .map((rule, index) => ({
      code: typeof rule.code === 'string' && rule.code.trim()
        ? rule.code.trim()
        : `required_clause_missing_${index}`,
      clauseField: requireString(rule.clauseField, `requiredClauses[${index}].clauseField`, 'rule_pack_invalid'),
      ruleRef: requireString(rule.ruleRef, `requiredClauses[${index}].ruleRef`, 'rule_pack_invalid'),
      label: requireString(rule.label, `requiredClauses[${index}].label`, 'rule_pack_invalid'),
      valueKind: rule.valueKind === 'date' || rule.valueKind === 'number' ? rule.valueKind : 'any'
    }));

  const responsibilityClauses = requireArray(value.responsibilityClauses, 'responsibilityClauses', 'rule_pack_invalid')
    .map((rule, index) => ({
      clauseField: requireString(rule.clauseField, `responsibilityClauses[${index}].clauseField`, 'rule_pack_invalid'),
      ruleRef: requireString(rule.ruleRef, `responsibilityClauses[${index}].ruleRef`, 'rule_pack_invalid'),
      label: requireString(rule.label, `responsibilityClauses[${index}].label`, 'rule_pack_invalid')
    }));

  const prohibitedTerms = requireArray(value.prohibitedTerms, 'prohibitedTerms', 'rule_pack_invalid')
    .map((rule, index) => {
      const code = requireString(rule.code, `prohibitedTerms[${index}].code`, 'rule_pack_invalid');
      const deniedWhenFalse = requireArray(
        rule.deniedWhenFalse, `prohibitedTerms[${index}].deniedWhenFalse`, 'rule_pack_invalid'
      ).map((field, fieldIndex) => requireString(
        field, `prohibitedTerms[${index}].deniedWhenFalse[${fieldIndex}]`, 'rule_pack_invalid'
      ));
      const textPatterns = requireArray(
        rule.textPatterns, `prohibitedTerms[${index}].textPatterns`, 'rule_pack_invalid'
      ).map((pattern) => compilePattern(pattern, code));
      if (deniedWhenFalse.length === 0 && textPatterns.length === 0) {
        throw invalid(`不得記載規則 ${code} 沒有任何可執行的判斷條件`, 'rule_pack_invalid');
      }
      return {
        code,
        ruleRef: requireString(rule.ruleRef, `prohibitedTerms[${index}].ruleRef`, 'rule_pack_invalid'),
        label: requireString(rule.label, `prohibitedTerms[${index}].label`, 'rule_pack_invalid'),
        deniedWhenFalse,
        textPatterns
      };
    });

  const conflictRules = requireArray(value.conflictRules, 'conflictRules', 'rule_pack_invalid')
    .map((rule, index) => {
      const code = requireString(rule.code, `conflictRules[${index}].code`, 'rule_pack_invalid');
      const kind = requireString(rule.kind, `conflictRules[${index}].kind`, 'rule_pack_invalid');
      if (!CONFLICT_KINDS.has(kind)) {
        throw invalid(`矛盾規則 ${code} 的 kind「${kind}」不在支援集合內`, 'rule_pack_invalid');
      }
      const normalized = {
        code,
        kind,
        ruleRef: requireString(rule.ruleRef, `conflictRules[${index}].ruleRef`, 'rule_pack_invalid'),
        label: requireString(rule.label, `conflictRules[${index}].label`, 'rule_pack_invalid')
      };
      if (kind === 'date_order' || kind === 'min_days') {
        normalized.earlierField = requireString(rule.earlierField, `conflictRules[${index}].earlierField`, 'rule_pack_invalid');
        normalized.laterField = requireString(rule.laterField, `conflictRules[${index}].laterField`, 'rule_pack_invalid');
      }
      if (kind === 'min_days') {
        const minDays = finiteNumber(rule.minDays);
        if (minDays === null || minDays <= 0) {
          throw invalid(`矛盾規則 ${code} 的 minDays 必須是正數`, 'rule_pack_invalid');
        }
        normalized.minDays = minDays;
      }
      if (kind === 'max_ratio') {
        normalized.numeratorField = requireString(rule.numeratorField, `conflictRules[${index}].numeratorField`, 'rule_pack_invalid');
        normalized.denominatorField = requireString(rule.denominatorField, `conflictRules[${index}].denominatorField`, 'rule_pack_invalid');
        const maxRatio = finiteNumber(rule.maxRatio);
        if (maxRatio === null || maxRatio <= 0) {
          throw invalid(`矛盾規則 ${code} 的 maxRatio 必須是正數`, 'rule_pack_invalid');
        }
        normalized.maxRatio = maxRatio;
      }
      return normalized;
    });

  return {
    packCode: typeof value.packCode === 'string' ? value.packCode : null,
    versionLabel: typeof value.versionLabel === 'string' ? value.versionLabel : null,
    requiredClauses,
    responsibilityClauses,
    prohibitedTerms,
    conflictRules
  };
}

// template manifest 在 V1 只需要回答一個問題:這個條件欄位有沒有對應的範本條次?
// 完整條文、選項與附件仍然保存在 manifest_json 裡供人類草稿頁呈現,
// 但 validator 只讀 slots —— 條文文字不參與 blocking 判斷。
function normalizeTemplateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('template manifest 必須是物件', 'template_manifest_invalid');
  }
  const slots = requireArray(value.slots, 'slots', 'template_manifest_invalid').map((slot, index) => ({
    slot: requireString(slot.slot, `slots[${index}].slot`, 'template_manifest_invalid'),
    clauseField: requireString(slot.clauseField, `slots[${index}].clauseField`, 'template_manifest_invalid'),
    clauseRef: requireString(slot.clauseRef, `slots[${index}].clauseRef`, 'template_manifest_invalid'),
    clauseTitle: requireString(slot.clauseTitle, `slots[${index}].clauseTitle`, 'template_manifest_invalid')
  }));
  if (slots.length === 0) {
    throw invalid('template manifest 沒有任何 slot', 'template_manifest_invalid');
  }

  const byClauseField = new Map();
  for (const slot of slots) {
    // 一個條件欄位對應兩個範本 slot 時,責任矩陣與 provenance 會出現兩份互相矛盾的
    // 條次。這是範本資料錯誤,不是可以二選一的情況。
    if (byClauseField.has(slot.clauseField)) {
      throw invalid(`template manifest 的 clauseField「${slot.clauseField}」對應到多個 slot`, 'template_manifest_invalid');
    }
    byClauseField.set(slot.clauseField, slot);
  }

  return {
    templateCode: typeof value.templateCode === 'string' ? value.templateCode : null,
    versionLabel: typeof value.versionLabel === 'string' ? value.versionLabel : null,
    slots,
    byClauseField
  };
}

// --- issue 建構 ---------------------------------------------------------------

function issue({ code, category, severity, clauseFields, message, basis, detail }) {
  if (!ISSUE_CATEGORIES.has(category)) {
    throw new Error(`unknown issue category: ${category}`);
  }
  const built = {
    code,
    category,
    severity,
    clauseFields: [...clauseFields].sort(),
    message,
    basis
  };
  if (detail !== undefined) built.detail = detail;
  return built;
}

const legalBasis = (rule) => ({
  source: 'legal_rule_pack',
  ruleRef: rule.ruleRef,
  label: rule.label
});

// --- 各類檢查 ----------------------------------------------------------------

function checkRequiredClauses(clauseSnapshot, rulePack, issues) {
  for (const rule of rulePack.requiredClauses) {
    const value = clauseSnapshot[rule.clauseField];
    if (!hasValue(value)) {
      issues.push(issue({
        code: rule.code,
        category: 'missing_required_clause',
        severity: SEVERITY_BLOCKING,
        clauseFields: [rule.clauseField],
        message: `缺少應記載事項「${rule.label}」:草稿沒有 ${rule.clauseField} 的內容,依 ${rule.ruleRef} 必須填寫。`,
        basis: legalBasis(rule)
      }));
      continue;
    }
    if (rule.valueKind === 'date' && parseIsoDate(value) === null) {
      issues.push(issue({
        code: `${rule.code}_invalid_date`,
        category: 'invalid_clause_value',
        severity: SEVERITY_BLOCKING,
        clauseFields: [rule.clauseField],
        message: `應記載事項「${rule.label}」的日期格式無法判讀:${rule.clauseField} 必須是 YYYY-MM-DD。`,
        basis: legalBasis(rule),
        detail: { value: String(value) }
      }));
    }
    if (rule.valueKind === 'number' && finiteNumber(value) === null) {
      issues.push(issue({
        code: `${rule.code}_invalid_number`,
        category: 'invalid_clause_value',
        severity: SEVERITY_BLOCKING,
        clauseFields: [rule.clauseField],
        message: `應記載事項「${rule.label}」的金額無法判讀:${rule.clauseField} 必須是數字。`,
        basis: legalBasis(rule),
        detail: { value: String(value) }
      }));
    }
  }
}

// 責任歸屬:必須看得出「誰」在什麼情況下負什麼責任。
// 物件形式視為「義務 -> 責任方」的映射,每一項都要單獨過關。
function checkResponsibilityClauses(clauseSnapshot, rulePack, issues) {
  for (const rule of rulePack.responsibilityClauses) {
    const value = clauseSnapshot[rule.clauseField];
    if (!hasValue(value)) {
      issues.push(issue({
        code: `${rule.clauseField}_responsibility_missing`,
        category: 'unclear_responsibility',
        severity: SEVERITY_BLOCKING,
        clauseFields: [rule.clauseField],
        message: `責任歸屬未約定:「${rule.label}」沒有任何內容,依 ${rule.ruleRef} 必須明確分配責任。`,
        basis: legalBasis(rule)
      }));
      continue;
    }

    const entries = typeof value === 'string'
      ? [[null, value]]
      : (Array.isArray(value)
        ? value.map((item, index) => [String(index), item])
        : Object.entries(value));

    for (const [key, raw] of entries) {
      const path = key === null ? rule.clauseField : `${rule.clauseField}.${key}`;
      if (typeof raw !== 'string' || !raw.trim()) {
        issues.push(issue({
          code: `${rule.clauseField}_responsibility_unreadable`,
          category: 'unclear_responsibility',
          severity: SEVERITY_BLOCKING,
          clauseFields: [rule.clauseField],
          message: `責任歸屬無法判讀:「${rule.label}」的 ${path} 不是可閱讀的文字約定。`,
          basis: legalBasis(rule),
          detail: { path }
        }));
        continue;
      }
      const text = raw.trim();
      if (VAGUE_PATTERN.test(text)) {
        issues.push(issue({
          code: `${rule.clauseField}_responsibility_vague`,
          category: 'unclear_responsibility',
          severity: SEVERITY_BLOCKING,
          clauseFields: [rule.clauseField],
          message: `責任歸屬不明:「${rule.label}」的 ${path} 使用「${text}」這類尚未談定的措辭,需雙方先確認再產生草稿。`,
          basis: legalBasis(rule),
          detail: { path, value: text }
        }));
        continue;
      }
      if (!PARTY_PATTERN.test(text) && !PARTY_PATTERN.test(String(key || ''))) {
        issues.push(issue({
          code: `${rule.clauseField}_responsibility_party_unspecified`,
          category: 'unclear_responsibility',
          severity: SEVERITY_BLOCKING,
          clauseFields: [rule.clauseField],
          message: `責任主體未指明:「${rule.label}」的 ${path} 沒有寫出由房東或房客負責。`,
          basis: legalBasis(rule),
          detail: { path, value: text }
        }));
      }
    }
  }
}

// 收集 clause snapshot 內所有字串值,連同它們的路徑。
// 不得記載事項常常不是一個 boolean,而是躲在 specialRequest 這種自由文字裡。
function collectTextValues(value, path, output) {
  if (typeof value === 'string') {
    if (value.trim()) output.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectTextValues(item, `${path}[${index}]`, output));
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      collectTextValues(value[key], `${path}.${key}`, output);
    }
  }
}

function checkProhibitedTerms(clauseSnapshot, rulePack, issues) {
  const texts = [];
  for (const field of Object.keys(clauseSnapshot).sort()) {
    collectTextValues(clauseSnapshot[field], field, texts);
  }

  for (const rule of rulePack.prohibitedTerms) {
    // 形式一:結構化欄位被設成 false,例如 householdRegistrationAllowed=false。
    for (const field of rule.deniedWhenFalse) {
      if (clauseSnapshot[field] === false) {
        issues.push(issue({
          code: rule.code,
          category: 'prohibited_term',
          severity: SEVERITY_BLOCKING,
          clauseFields: [field],
          message: `不得記載事項:${rule.label}(${rule.ruleRef})。草稿把 ${field} 設為 false,等於約定限制承租人權益,不得固化成契約。`,
          basis: legalBasis(rule),
          detail: { field, form: 'structured_flag' }
        }));
      }
    }

    // 形式二:自由文字裡出現禁止約定。文字是人寫的,所以要逐個欄位掃。
    for (const pattern of rule.textPatterns) {
      for (const candidate of texts) {
        const matched = candidate.text.match(pattern);
        if (!matched) continue;
        issues.push(issue({
          code: rule.code,
          category: 'prohibited_term',
          severity: SEVERITY_BLOCKING,
          clauseFields: [candidate.path.split(/[.[]/)[0]],
          message: `不得記載事項:${rule.label}(${rule.ruleRef})。${candidate.path} 出現「${matched[0]}」,屬於限制承租人權益的約定,不得固化成契約。`,
          basis: legalBasis(rule),
          detail: { path: candidate.path, matchedText: matched[0], form: 'free_text' }
        }));
      }
    }
  }
}

function checkConflictRules(clauseSnapshot, rulePack, issues) {
  for (const rule of rulePack.conflictRules) {
    if (rule.kind === 'date_order' || rule.kind === 'min_days') {
      const earlier = parseIsoDate(clauseSnapshot[rule.earlierField]);
      const later = parseIsoDate(clauseSnapshot[rule.laterField]);
      // 任一邊沒填或格式不對,由 requiredClauses / invalid_clause_value 負責報告。
      // 這裡不重複抱怨,也不拿無效值去比大小。
      if (earlier === null || later === null) continue;

      if (rule.kind === 'date_order' && later < earlier) {
        issues.push(issue({
          code: rule.code,
          category: 'clause_conflict',
          severity: SEVERITY_BLOCKING,
          clauseFields: [rule.earlierField, rule.laterField],
          message: `條款互相矛盾:${rule.label}。${rule.laterField}(${clauseSnapshot[rule.laterField]})早於 ${rule.earlierField}(${clauseSnapshot[rule.earlierField]})。`,
          basis: legalBasis(rule)
        }));
      }
      if (rule.kind === 'min_days') {
        const days = Math.round((later - earlier) / DAY_MS);
        if (days < rule.minDays) {
          issues.push(issue({
            code: rule.code,
            category: 'clause_conflict',
            severity: SEVERITY_BLOCKING,
            clauseFields: [rule.earlierField, rule.laterField],
            message: `條款不符法定下限:${rule.label}。目前租期為 ${days} 日,少於 ${rule.minDays} 日(${rule.ruleRef})。`,
            basis: legalBasis(rule),
            detail: { days, minDays: rule.minDays }
          }));
        }
      }
      continue;
    }

    // max_ratio:押金不得超過 N 個月租金這一類的上限。
    const numerator = finiteNumber(clauseSnapshot[rule.numeratorField]);
    const denominator = finiteNumber(clauseSnapshot[rule.denominatorField]);
    if (numerator === null || denominator === null || denominator <= 0) continue;
    if (numerator > denominator * rule.maxRatio) {
      issues.push(issue({
        code: rule.code,
        category: 'clause_conflict',
        severity: SEVERITY_BLOCKING,
        clauseFields: [rule.numeratorField, rule.denominatorField],
        message: `條款超過法定上限:${rule.label}。${rule.numeratorField}=${numerator} 已超過 ${rule.denominatorField}=${denominator} 的 ${rule.maxRatio} 倍(${rule.ruleRef})。`,
        basis: legalBasis(rule),
        detail: { numerator, denominator, maxRatio: rule.maxRatio }
      }));
    }
  }
}

function checkTemplateCoverage(clauseSnapshot, templateManifest, issues) {
  for (const field of Object.keys(clauseSnapshot).sort()) {
    if (templateManifest.byClauseField.has(field)) continue;
    issues.push(issue({
      code: 'clause_not_in_template',
      category: 'template_coverage',
      severity: SEVERITY_BLOCKING,
      clauseFields: [field],
      message: `契約範本承載不了這個條件:${field} 在範本 ${templateManifest.versionLabel || ''} 沒有對應條次,必須先擴充範本或由人類改寫條件。`,
      basis: {
        source: 'contract_template',
        ruleRef: templateManifest.versionLabel,
        label: '範本 slot 覆蓋'
      },
      detail: { field }
    }));
  }
}

function checkProvenance(clauseSnapshot, sourceMap, issues) {
  for (const field of Object.keys(clauseSnapshot).sort()) {
    const entries = Array.isArray(sourceMap[field]) ? sourceMap[field] : [];
    const humanSources = entries.filter(
      (entry) => entry && INTENTION_SOURCE_TYPES.has(entry.sourceType)
    );
    if (humanSources.length > 0) continue;
    issues.push(issue({
      code: 'missing_provenance',
      category: 'missing_provenance',
      severity: SEVERITY_BLOCKING,
      clauseFields: [field],
      message: `條件缺少人類依據:${field} 追不回任何訊息、房源快照、知識版本或房東回答,不得寫進契約。`,
      basis: { source: 'system', ruleRef: 'invariant-11', label: '每個實質條款必須可追溯' },
      detail: { field, presentSourceTypes: entries.map((entry) => entry && entry.sourceType).filter(Boolean).sort() }
    }));
  }
}

// 模型提出的疑似矛盾。**一律 advisory。**
// 它出現在 artifact 裡是為了讓人類知道「模型覺得這裡怪」,不是為了替模型取得
// 阻擋或放行的權力。
function collectModelSuspectedConflicts(modelSuspectedConflicts, clauseSnapshot, issues) {
  const list = Array.isArray(modelSuspectedConflicts) ? modelSuspectedConflicts : [];
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const fields = (Array.isArray(item.clauseFields) ? item.clauseFields : [])
      .filter((field) => typeof field === 'string' && Object.prototype.hasOwnProperty.call(clauseSnapshot, field));
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    if (!note) return;
    issues.push(issue({
      code: `llm_suspected_conflict_${index}`,
      category: 'llm_suspected_conflict',
      severity: SEVERITY_ADVISORY,
      clauseFields: fields,
      message: `AI 提出的疑似矛盾(僅供人工參考,未經法規判斷):${note}`,
      basis: { source: 'model', ruleRef: null, label: 'AI 初步辨識' }
    }));
  });
}

// --- 入口 --------------------------------------------------------------------

// 排序讓輸出對「檢查執行順序」不敏感。artifact 的 checksum 綁的是 issues,
// 所以順序一變 checksum 就變,冪等會失效。
function sortIssues(issues) {
  return issues.slice().sort((left, right) => {
    const keyOf = (item) => `${item.category}\u0000${item.code}\u0000${item.clauseFields.join('|')}\u0000${item.message}`;
    const a = keyOf(left);
    const b = keyOf(right);
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

function validateContractDraft({
  clauseSnapshot,
  sourceMap = {},
  rulePack,
  templateManifest,
  modelSuspectedConflicts = []
} = {}) {
  if (!clauseSnapshot || typeof clauseSnapshot !== 'object' || Array.isArray(clauseSnapshot)) {
    throw invalid('clauseSnapshot 必須是物件', 'invalid_clause_snapshot');
  }
  // rulePack / templateManifest 必須是 normalize 過的形狀。直接吃原始 JSON 會讓
  // 寫壞的規則資料變成「某幾類檢查靜默沒跑」,那是最危險的失敗模式。
  if (!rulePack || !Array.isArray(rulePack.requiredClauses)) {
    throw invalid('rulePack 必須先經過 normalizeRulePack', 'rule_pack_invalid');
  }
  if (!templateManifest || !(templateManifest.byClauseField instanceof Map)) {
    throw invalid('templateManifest 必須先經過 normalizeTemplateManifest', 'template_manifest_invalid');
  }

  const issues = [];

  // 零條件欄位是它自己的 blocking issue,不是「沒有問題」。
  // 接受服務也會擋,但擋在那裡只會回一個沒有理由的錯誤;寫在 artifact 裡人類才看得懂。
  if (Object.keys(clauseSnapshot).length === 0) {
    issues.push(issue({
      code: 'empty_clause_snapshot',
      category: 'missing_required_clause',
      severity: SEVERITY_BLOCKING,
      clauseFields: [],
      message: '草稿沒有任何已確認的條件欄位,無法產生可簽署的契約。',
      basis: { source: 'system', ruleRef: 'invariant-11', label: '每個實質條款必須可追溯' }
    }));
  }

  checkTemplateCoverage(clauseSnapshot, templateManifest, issues);
  checkProvenance(clauseSnapshot, sourceMap, issues);
  checkRequiredClauses(clauseSnapshot, rulePack, issues);
  checkResponsibilityClauses(clauseSnapshot, rulePack, issues);
  checkProhibitedTerms(clauseSnapshot, rulePack, issues);
  checkConflictRules(clauseSnapshot, rulePack, issues);
  const specialTerms = clauseSnapshot.specialRequest ?? clauseSnapshot.specialTerms;
  if (specialTerms && require('./ecsNeoDepositWarning').depositWarning(
    Array.isArray(specialTerms) ? specialTerms.join('\n') : specialTerms,
    { rentAmount: clauseSnapshot.rentAmount ?? clauseSnapshot.monthlyRent, depositAmount: clauseSnapshot.depositAmount }
  )) {
    issues.push(issue({ code: 'deposit_special_term_requires_review', category: 'clause_conflict', severity: SEVERITY_BLOCKING,
      clauseFields: ['specialRequest', 'depositAmount'], message: '其他約定含押金加收或超額要求，請先確認押金總額不超過兩個月租金。',
      basis: { source: 'legal_rule', ruleRef: '租賃住宅市場發展及管理條例第7條', label: '押金上限' } }));
  }
  collectModelSuspectedConflicts(modelSuspectedConflicts, clauseSnapshot, issues);

  const sorted = sortIssues(issues);
  const blockingIssueCount = sorted.filter((item) => item.severity === SEVERITY_BLOCKING).length;

  return {
    issues: sorted,
    blockingIssueCount,
    // status 直接對應 prepared_contract_drafts.status 的封閉集合。
    // 有 blocking 就是 draft_review_required —— 沒有「警告但放行」這個選項。
    status: blockingIssueCount === 0 ? 'ready' : 'draft_review_required'
  };
}

// 給房客看的「還缺什麼」。條款講了但沒寫誰負責,只說「缺提前終止」會讓房客以為沒講到。
// 來源追溯、範本覆蓋這類是系統自己的檢查,房客補不了,不列給他看。
const TENANT_FIXABLE = new Set(['missing_required_clause', 'unclear_responsibility', 'invalid_clause_value',
  'clause_conflict', 'prohibited_term']);
function blockingIssueLabels(issues = []) {
  const labels = issues.filter((entry) => entry.severity === SEVERITY_BLOCKING && TENANT_FIXABLE.has(entry.category)).map((entry) => {
    const label = (entry.basis && entry.basis.label) || entry.message;
    if (String(entry.code).endsWith('_party_unspecified')) return `${label}（要寫明由房東、房客還是雙方）`;
    if (String(entry.code).endsWith('_vague')) return `${label}（說法還不夠確定）`;
    return label;
  });
  return [...new Set(labels)];
}

module.exports = {
  INTENTION_SOURCE_TYPES,
  blockingIssueLabels,
  ISSUE_CATEGORIES,
  SEVERITY_ADVISORY,
  SEVERITY_BLOCKING,
  hasValue,
  normalizeRulePack,
  normalizeTemplateManifest,
  validateContractDraft
};
