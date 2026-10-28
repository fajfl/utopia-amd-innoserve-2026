// 承租條件的逐欄來源判定。純函式:不碰資料庫、不呼叫模型、沒有副作用。
//
// spec invariant 3:每個 intention field 都必須能追到 message、listing_snapshot、
// knowledge_version 或 manual_input。conditionExtractionService 只回一份
// condition_json,沒有逐欄來源,所以來源必須在這裡用**確定性**規則重新認定:
//
//   1. 先看這筆詢問的訊息原文有沒有這個值 —— 資料優先序與抽取提示詞一致,
//      LINE 對話優先於房源資料。
//   2. 再看房源快照(listing_snapshots)有沒有同一個值。
//   3. 兩邊都對不上就是**沒有來源**:欄位清空、留下 warning,不寫進資料庫。
//      放過去就會出現一個宣稱有依據、實際指不到任何東西的合約條件,
//      而下游 ecsNeoContractAcceptanceServiceAsync 正是靠 provenance 才敢固化合約。
//
// 刻意**不**接受「模型自己說它的來源是哪一則訊息」這種輸入。模型輸出是候選,
// 來源由系統認定;否則來源鏈的可信度就等於模型的幻覺率。
//
// 只認 message 與 listing_snapshot 兩種 source_type。intention_version_sources 的
// CHECK 另有 knowledge_version 與 manual_input,但那兩種來自別的流程(核准 QA 與
// 人工輸入),不是這條抽取路徑產生的,不在這裡假造。

const { collectMissingFields } = require('./conditionJsonService');

// 追蹤的欄位清單。只放「抽得出來、對得上原文、而且下游真的會用」的欄位。
// 沒列在這裡的 condition_json 欄位仍會原樣保存在 condition_json 全文裡,
// 但不會被當成有來源的結構化條件,也不會出現在給房客確認的逐項清單。
const TRACKED_FIELDS = [
  { path: 'special_terms', clauseField: 'specialRequest', label: '其他約定', kind: 'text' },
  { path: 'property.address_text', label: '租賃住宅地址', kind: 'text', snapshotColumn: 'normalized_address' },
  { path: 'lease_term.start_date_roc', label: '租期起日', kind: 'roc_date' },
  { path: 'lease_term.end_date_roc', label: '租期迄日', kind: 'roc_date' },
  { path: 'move_in.date_roc', label: '預計入住日', kind: 'roc_date' },
  { path: 'rent.monthly_rent_ntd', label: '每月租金', kind: 'number', snapshotColumn: 'rent_amount' },
  { path: 'rent.payment_due_day', label: '每月繳租日', kind: 'number' },
  { path: 'rent.payment_method', label: '租金付款方式', kind: 'text' },
  { path: 'deposit.deposit_months', label: '押金月數', kind: 'number' },
  {
    path: 'deposit.deposit_amount_ntd',
    label: '押金金額',
    kind: 'number',
    snapshotColumn: 'deposit_amount',
    // 抽取器與 normalizeConditionJson 都會用「租金 × 押金月數」推算押金金額,
    // 所以這個值常常不會逐字出現在對話裡。推算值的來源就是它兩個輸入的來源;
    // 只有在數字真的等於乘積時才適用,不相等代表另有說法,要走一般判定並成為矛盾。
    derivedFrom: ['rent.monthly_rent_ntd', 'deposit.deposit_months'],
    derive: (values) => {
      const rent = values['rent.monthly_rent_ntd'];
      const months = values['deposit.deposit_months'];
      if (!Number.isFinite(rent) || !Number.isFinite(months)) return null;
      return rent * months;
    }
  },
  { path: 'fees.management_fee.amount_ntd', label: '管理費金額', kind: 'number' },
  {
    path: 'use_restrictions.pet_allowed',
    label: '是否可養寵物',
    kind: 'boolean',
    keywords: ['寵物', '貓', '狗'],
    snapshotColumn: 'pet_policy_text'
  },
  { path: 'use_restrictions.sublease_allowed', label: '是否可轉租', kind: 'boolean', keywords: ['轉租', '分租'] },
  { path: 'use_restrictions.cooking_allowed', label: '是否可開伙', kind: 'boolean', keywords: ['開伙'] },
  { path: 'termination.notice_days', label: '提前終止通知日數', kind: 'number' },
  { path: 'termination.penalty_months_max', label: '提前終止違約金上限', kind: 'number' }
];

const NEGATIVE_PATTERN = /(不可以|不能|不可|不得|不行|禁止|不允許|不同意|拒絕)/;
const POSITIVE_PATTERN = /(可以|可|允許|同意|沒問題|歡迎)/;
// 「可討論」「應該可以」「再看看」不是已同意 —— 抽取提示詞已明文禁止,
// 這裡也不能因為看到「可以」三個字就替房東答應。
const HEDGE_PATTERN = /(可討論|可以討論|再討論|應該可以|再看看|再說|看情況|不一定)/;

const DATE_PATTERN = /(?:民國\s*)?(\d{2,4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?/g;
const RENT_MENTION_PATTERN = /(?:月租|租金|房租)\D{0,8}?(\d[\d,]*)/g;
const MOVE_IN_KEYWORDS = ['入住', '搬入', '起租', '租期', '交屋'];

function getByPath(value, path) {
  return path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), value);
}

function setByPath(target, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), target);
  if (parent && typeof parent === 'object') parent[last] = value;
}

// 民國/西元混用的日期一律收斂成 'ROC-M-D',比較與比對都只用這個形式。
function canonicalDateParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const rocYear = y >= 1912 ? y - 1911 : y;
  if (rocYear < 1 || rocYear > 999) return null;
  return `${rocYear}-${m}-${d}`;
}

function canonicalRocDate(value) {
  if (value === null || value === undefined) return null;
  const match = new RegExp(DATE_PATTERN.source).exec(String(value));
  return match ? canonicalDateParts(match[1], match[2], match[3]) : null;
}

// 民國日期轉 'YYYY-MM-DD'。intention_versions 的 lease_start_date/lease_end_date
// 有 end >= start 的 CHECK,而 CHECK 是字串比較,所以只有零填的 ISO 才比得對。
function rocDateToIso(value) {
  const canonical = canonicalRocDate(value);
  if (!canonical) return null;
  const [rocYear, month, day] = canonical.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  return `${rocYear + 1911}-${pad(month)}-${pad(day)}`;
}

function collectDateTokens(text) {
  const tokens = new Set();
  const pattern = new RegExp(DATE_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const canonical = canonicalDateParts(match[1], match[2], match[3]);
    if (canonical) tokens.add(canonical);
  }
  return tokens;
}

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// 中文數字寫法。「押金兩個月」抽出來是 2,但原文裡一個阿拉伯數字都沒有 ——
// 只比對數字字面會把這個欄位判成「沒有依據」而清空,房客明明講過。
// 只處理 1..31(月數、日數、天數),再大的數字在租屋對話裡幾乎都寫阿拉伯數字,
// 硬要展開反而會亂比對。
function chineseNumeralForms(value) {
  if (!Number.isInteger(value) || value < 1 || value > 31) return [];
  if (value < 10) return value === 2 ? ['二', '兩'] : [CHINESE_DIGITS[value]];
  if (value === 10) return ['十'];
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  const prefix = tens === 1 ? '十' : `${CHINESE_DIGITS[tens]}十`;
  return ones === 0 ? [prefix] : [`${prefix}${CHINESE_DIGITS[ones]}`];
}

function containsNumber(text, value) {
  if (!Number.isFinite(value)) return false;
  const normalized = String(text).replace(/,/g, '');
  // 前後不得緊接數字,否則 180 會在 18000 裡「找到」。
  if (new RegExp(`(?<!\\d)${value}(?!\\d)`).test(normalized)) return true;
  return chineseNumeralForms(value).some((form) => normalized.includes(form));
}

// 關鍵字附近的極性。整段文字掃「可以/不可以」會把別的話題的答案套到這個欄位上,
// 所以只看關鍵字前後的視窗。
function keywordPolarity(text, keywords) {
  const source = String(text || '');
  const polarities = new Set();
  for (const keyword of keywords) {
    let index = source.indexOf(keyword);
    while (index !== -1) {
      const window = source.slice(Math.max(0, index - 12), index + keyword.length + 12);
      if (HEDGE_PATTERN.test(window)) {
        polarities.add('hedged');
      } else if (NEGATIVE_PATTERN.test(window)) {
        polarities.add(false);
      } else if (POSITIVE_PATTERN.test(window)) {
        polarities.add(true);
      }
      index = source.indexOf(keyword, index + keyword.length);
    }
  }
  if (polarities.size === 0) return null;
  if (polarities.size > 1) return 'mixed';
  return [...polarities][0];
}

function textEvidence(text, value) {
  const needle = String(value).trim();
  if (needle.length < 2) return false;
  return String(text).includes(needle);
}

function matchesMessage(field, value, text) {
  if (field.kind === 'number') return containsNumber(text, Number(value));
  if (field.kind === 'roc_date') {
    const canonical = canonicalRocDate(value);
    return Boolean(canonical) && collectDateTokens(String(text)).has(canonical);
  }
  if (field.kind === 'boolean') {
    const polarity = keywordPolarity(text, field.keywords || []);
    return polarity === value;
  }
  return textEvidence(text, value);
}

function matchesSnapshot(field, value, snapshot) {
  if (!snapshot || !field.snapshotColumn) return false;
  const snapshotValue = snapshot[field.snapshotColumn];
  if (snapshotValue === null || snapshotValue === undefined) return false;
  if (field.kind === 'number') return Number(snapshotValue) === Number(value);
  if (field.kind === 'boolean') return keywordPolarity(snapshotValue, field.keywords || []) === value;
  if (field.kind === 'roc_date') return canonicalRocDate(snapshotValue) === canonicalRocDate(value);
  return String(snapshotValue).trim() === String(value).trim();
}

function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function displayValue(field, value) {
  if (Array.isArray(value)) return value.join('；');
  if (field.kind === 'boolean') return value ? '可以' : '不可以';
  if (field.path.endsWith('_ntd')) return `${Number(value).toLocaleString('en-US')} 元`;
  if (field.path === 'deposit.deposit_months') return `${value} 個月`;
  if (field.path === 'rent.payment_due_day') return `每月 ${value} 日`;
  if (field.path === 'termination.notice_days') return `${value} 日`;
  if (field.path === 'termination.penalty_months_max') return `${value} 個月`;
  return String(value);
}

// 逐欄找來源。訊息優先,同一欄位可以有多筆來源(同一件事被講了兩次都算)。
function resolveFieldSources(field, value, messages, snapshot) {
  if (Array.isArray(value)) {
    const sources = value.map((item) => resolveFieldSources(field, item, messages, snapshot));
    return sources.every((items) => items.length) ? sources.flat() : [];
  }
  const sources = [];
  for (const message of messages) {
    if (!message || !isFilled(message.text)) continue;
    if (matchesMessage(field, value, message.text)) {
      sources.push({ sourceType: 'message', sourceId: message.id });
    }
  }
  if (matchesSnapshot(field, value, snapshot)) {
    sources.push({ sourceType: 'listing_snapshot', sourceId: snapshot.id });
  }
  return sources;
}

function detectConflicts({ conditionJson, values, messages, snapshot }) {
  const conflicts = [];

  const rent = values['rent.monthly_rent_ntd'];
  const months = values['deposit.deposit_months'];
  const depositAmount = values['deposit.deposit_amount_ntd'];
  if (Number.isFinite(rent) && Number.isFinite(months) && Number.isFinite(depositAmount) &&
      rent * months !== depositAmount) {
    conflicts.push(`押金金額 ${depositAmount} 元與「租金 ${rent} × ${months} 個月」不一致，需要你確認哪一個才對。`);
  }

  const start = canonicalRocDate(getByPath(conditionJson, 'lease_term.start_date_roc'));
  const end = canonicalRocDate(getByPath(conditionJson, 'lease_term.end_date_roc'));
  if (start && end) {
    const startIso = rocDateToIso(getByPath(conditionJson, 'lease_term.start_date_roc'));
    const endIso = rocDateToIso(getByPath(conditionJson, 'lease_term.end_date_roc'));
    if (endIso < startIso) conflicts.push('租期迄日早於起日，需要你重新確認租期。');
  }

  // 對話裡出現多個不同的租金金額,代表議價過程還沒收斂到一個數字。
  // 這種情況不能自己挑最後一句 —— 那就是替房客決定條件。
  const rentMentions = new Set();
  const moveInDates = new Set();
  for (const message of messages) {
    const text = String((message && message.text) || '');
    const pattern = new RegExp(RENT_MENTION_PATTERN.source, 'g');
    let match;
    while ((match = pattern.exec(text.replace(/,/g, ''))) !== null) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount) && amount > 0) rentMentions.add(amount);
    }
    if (MOVE_IN_KEYWORDS.some((keyword) => text.includes(keyword))) {
      for (const token of collectDateTokens(text)) moveInDates.add(token);
    }
  }
  if (rentMentions.size > 1) {
    conflicts.push(`對話中出現多個不同的租金金額：${[...rentMentions].join('、')} 元，需要你指認哪一個是最後談定的。`);
  }
  if (moveInDates.size > 1) {
    conflicts.push(`對話中出現多個不同的入住／租期日期：${[...moveInDates].join('、')}（民國），需要你指認正確的日期。`);
  }

  // 同一個限制同時出現「可以」與「不可以」,或只出現「可討論」,都不是已談定。
  for (const field of TRACKED_FIELDS) {
    if (field.kind !== 'boolean') continue;
    const polarities = new Set();
    for (const message of messages) {
      const polarity = keywordPolarity((message && message.text) || '', field.keywords || []);
      if (polarity !== null) polarities.add(polarity);
    }
    if (polarities.has('mixed') || (polarities.has(true) && polarities.has(false))) {
      conflicts.push(`關於「${field.label}」，對話中同時出現可以與不可以的說法，需要你確認。`);
    } else if (polarities.size === 1 && polarities.has('hedged') && !isFilled(values[field.path])) {
      conflicts.push(`關於「${field.label}」，對話只到「可以討論」，還不算談定，需要房東明確答覆。`);
    }
  }

  return conflicts;
}

/**
 * 判定 condition_json 的逐欄來源,並把沒有來源的欄位清空。
 *
 * @param {object} input
 * @param {object} input.conditionJson 已正規化的 condition_json(會被就地修改)
 * @param {Array<{id:number,text:string}>} input.messages 只能是**這一筆詢問**的訊息
 * @param {object|null} input.listingSnapshot listing_snapshots 的一列(需含 id)
 * @returns {{conditionJson:object, fields:Array, unsourcedFields:Array, conflicts:Array<string>, missingFields:Array<string>}}
 */
function resolveConditionProvenance({ conditionJson, messages = [], listingSnapshot = null }) {
  if (!conditionJson || typeof conditionJson !== 'object') {
    throw new Error('conditionJson is required');
  }
  const safeMessages = messages.filter((message) => message && message.id !== null && message.id !== undefined);
  const snapshot = listingSnapshot && listingSnapshot.id !== null && listingSnapshot.id !== undefined
    ? listingSnapshot
    : null;

  const values = {};
  for (const field of TRACKED_FIELDS) {
    values[field.path] = getByPath(conditionJson, field.path);
  }

  // 矛盾要在清空之前判定:清空後就看不出「押金金額與乘積不符」這種矛盾了。
  const conflicts = detectConflicts({ conditionJson, values, messages: safeMessages, snapshot });

  const fields = [];
  const unsourcedFields = [];
  const sourcesByPath = {};

  for (const field of TRACKED_FIELDS) {
    const value = values[field.path];
    if (!isFilled(value)) continue;

    let sources = resolveFieldSources(field, value, safeMessages, snapshot);

    // 推算欄位:值等於推算結果時,來源就是它輸入欄位的來源。
    if (sources.length === 0 && field.derivedFrom && typeof field.derive === 'function') {
      const derived = field.derive(values);
      if (derived !== null && Number(derived) === Number(value)) {
        const inherited = [];
        let complete = true;
        for (const dependency of field.derivedFrom) {
          const dependencySources = sourcesByPath[dependency];
          if (!dependencySources || dependencySources.length === 0) {
            complete = false;
            break;
          }
          inherited.push(...dependencySources);
        }
        if (complete) sources = inherited;
      }
    }

    if (sources.length === 0) {
      unsourcedFields.push({ path: field.path, label: field.label, value });
      setByPath(conditionJson, field.path, null);
      continue;
    }

    // 同一筆來源可能被兩條規則加進來(推算欄位繼承時尤其容易),去重後才寫 DB:
    // intention_version_sources 對 (version, field_path, source_type, source_id) 有唯一鍵。
    const deduped = [];
    const seen = new Set();
    for (const source of sources) {
      const key = `${source.sourceType}:${source.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(source);
    }

    sourcesByPath[field.path] = deduped;
    fields.push({
      path: field.clauseField || field.path,
      label: field.label,
      value,
      display: displayValue(field, value),
      sources: deduped
    });
  }

  if (unsourcedFields.length > 0) {
    const warnings = new Set(conditionJson.compliance ? conditionJson.compliance.warnings || [] : []);
    for (const dropped of unsourcedFields) {
      warnings.add(`provenance_missing: ${dropped.path} 無法追溯到訊息或房源快照，已清空`);
    }
    if (conditionJson.compliance) conditionJson.compliance.warnings = [...warnings];
  }

  // 清空之後缺漏清單一定會變。不重跑 normalizeConditionJson —— 它會用
  // 「租金 × 月數」把剛剛清掉的押金金額再推算回來,等於繞過來源判定。
  if (conditionJson.compliance) {
    conditionJson.compliance.missing_fields = collectMissingFields(conditionJson);
  }

  return {
    conditionJson,
    fields,
    unsourcedFields,
    conflicts,
    missingFields: conditionJson.compliance ? conditionJson.compliance.missing_fields || [] : []
  };
}

/**
 * 只把 condition_json 投影成「有值的追蹤欄位」清單,不做任何來源判定。
 *
 * 讀回既有版本時用這一支:那些版本的來源早就寫在 intention_version_sources 裡,
 * 是既成事實。拿 resolveConditionProvenance 重跑會因為手上沒有原始訊息而
 * 把每個欄位都判成「無來源」,那是把讀取當成重新認定。
 */
function projectTrackedFields(conditionJson) {
  if (!conditionJson || typeof conditionJson !== 'object') return [];
  const fields = [];
  for (const field of TRACKED_FIELDS) {
    const value = getByPath(conditionJson, field.path);
    if (!isFilled(value)) continue;
    fields.push({ path: field.clauseField || field.path, label: field.label, value, display: displayValue(field, value) });
  }
  return fields;
}

module.exports = {
  TRACKED_FIELDS,
  canonicalRocDate,
  projectTrackedFields,
  resolveConditionProvenance,
  rocDateToIso
};
