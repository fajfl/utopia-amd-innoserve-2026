// 房東底價政策。**這一支是 Node 專屬的,結果才是模型看得到的東西。**
//
// 為什麼要獨立一支:房東的底價是 internal 規則。既有 tools layer 的做法是
// 「internal 連查詢都不碰」,那條防線必須保留;但協商 Agent 又確實需要知道
// 「房客開的這個租金,還在房東授權的議價範圍內嗎」。
//
// 解法不是把底價交給模型再拜託它別說出來 —— 那是把防線放進提示詞。
// 這裡在 Node 端讀 internal 規則、在 Node 端比大小,只把**判定**往外送:
//
//     at_or_above_floor  在授權範圍內,可以直接談
//     below_floor        低於授權下限,必須轉問房東
//     no_policy          房東沒設底價,照一般流程
//     no_proposed_rent   房客還沒開價,沒得比
//
// 回傳值裡**沒有任何金額**,也沒有 rule 的原文。ruleRefs 只有 public_id
// (那是不透明識別碼,不是價格)。evaluateRentFloorPolicy 的回傳會直接進
// agent context 與 agent trace,所以「不含金額」不是慣例而是這支的合約,
// ecsNeoFloorPricePolicyService.test.js 會逐一比對回傳值的每一個數字。
//
// production authority 是 TiDB/MySQL:只用 async driver、只用可攜 SQL。

// rule_value_json 是房東端寫進來的自由結構,不同版本的管理介面用過不同鍵名。
// 全部視為同一件事:「這個房源的最低可成交月租」。認不出來就當沒有政策 ——
// 猜錯方向會讓 Agent 拿一個不存在的下限去擋掉合法的議價。
const FLOOR_AMOUNT_KEYS = Object.freeze([
  'floorRentAmount',
  'floor_rent_amount',
  'minRentAmount',
  'min_rent_amount',
  'minimumRentAmount',
  'minimum_rent_amount',
  'floorPrice',
  'floor_price'
]);

const VERDICTS = Object.freeze([
  'no_policy',
  'no_proposed_rent',
  'at_or_above_floor',
  'below_floor'
]);

function positiveIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

// 只往下找一層。底價是單一數值,不需要遞迴;遞迴反而會把「押金上限」之類
// 語意不同的數字誤認成底價。
function readFloorAmount(ruleValueJson) {
  if (typeof ruleValueJson !== 'string' || !ruleValueJson.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(ruleValueJson);
  } catch {
    // 壞掉的 JSON 不是「沒有底價」也不是「底價是 0」。當成無法判定,
    // 由 hasUnreadablePolicy 讓呼叫端知道要走轉問房東,而不是放行。
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  for (const key of FLOOR_AMOUNT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      const amount = positiveIntegerOrNull(parsed[key]);
      if (amount !== null) return amount;
    }
  }
  return null;
}

/**
 * 用 Node 端的底價政策評估房客開的租金。
 *
 * @param {object} db async sqlDriver
 * @param {object} input
 * @param {number|string} input.rentalUnitId
 * @param {number|string} [input.propertyId]
 * @param {number|string} [input.organizationId]
 * @param {number|null} [input.proposedRentAmount] 房客這一輪開的月租
 * @returns {Promise<{verdict:string, hasPolicy:boolean, ruleRefs:string[], mustEscalate:boolean}>}
 *          **永遠不含金額。**
 */
async function evaluateRentFloorPolicy(db, input = {}) {
  if (!db || typeof db.all !== 'function') throw new Error('db driver is required');

  const rules = await db.all(`
    SELECT lr.public_id, lr.rule_value_json
    FROM landlord_rules lr
    JOIN knowledge_items ki ON ki.id = lr.knowledge_item_id
    WHERE lr.visibility = 'internal'
      AND lr.status = 'active'
      AND ki.status = 'active'
      AND lr.rule_type = 'negotiation'
      AND (lr.rental_unit_id = ?
           OR lr.property_id = ?
           OR (lr.organization_id IS NOT NULL AND lr.organization_id = ?))
    ORDER BY lr.id
  `, [
    input.rentalUnitId ?? null,
    input.propertyId ?? null,
    input.organizationId ?? null
  ]);

  const ruleRefs = [];
  let floor = null;
  let unreadable = false;
  for (const rule of rules) {
    const amount = readFloorAmount(rule.rule_value_json);
    if (amount === undefined) {
      unreadable = true;
      ruleRefs.push(rule.public_id);
      continue;
    }
    if (amount === null) continue;
    ruleRefs.push(rule.public_id);
    // 多條政策取最嚴格的那一條。放行寬鬆的那一條等於讓 Agent 越權議價。
    floor = floor === null ? amount : Math.max(floor, amount);
  }

  if (floor === null) {
    // 讀不出來的政策確實存在,只是我們看不懂它。這種情況必須轉問房東,
    // 不能因為「解析失敗」就當成房東沒設限。
    if (unreadable) {
      return { verdict: 'below_floor', hasPolicy: true, ruleRefs, mustEscalate: true };
    }
    return { verdict: 'no_policy', hasPolicy: false, ruleRefs: [], mustEscalate: false };
  }

  const proposed = positiveIntegerOrNull(input.proposedRentAmount);
  if (proposed === null) {
    return { verdict: 'no_proposed_rent', hasPolicy: true, ruleRefs, mustEscalate: false };
  }

  const withinAuthority = proposed >= floor;
  return {
    verdict: withinAuthority ? 'at_or_above_floor' : 'below_floor',
    hasPolicy: true,
    ruleRefs,
    // 低於底價不是「拒絕」,是「Agent 沒有這個授權」。必須交回房東決定。
    mustEscalate: !withinAuthority
  };
}

/**
 * 還價用的房東議價政策。**只給 Node 的議價判斷用,回傳值不可以進 agent context
 * 或 trace** —— 那裡只能放 evaluateRentFloorPolicy 的判定。
 *
 * floor:最低可成交月租(多條取最高);bargainAllowed:房東說「不接受殺價」時是 false。
 * 讀不懂的規則回 unreadable,呼叫端要轉問房東,不能當成沒設限。
 */
async function loadRentNegotiationPolicy(db, input = {}) {
  const rules = await db.all(`
    SELECT lr.rule_value_json
    FROM landlord_rules lr
    JOIN knowledge_items ki ON ki.id = lr.knowledge_item_id
    WHERE lr.visibility = 'internal'
      AND lr.status = 'active'
      AND ki.status = 'active'
      AND lr.rule_type = 'negotiation'
      AND (lr.rental_unit_id = ?
           OR lr.property_id = ?
           OR (lr.organization_id IS NOT NULL AND lr.organization_id = ?))
    ORDER BY lr.id
  `, [input.rentalUnitId ?? null, input.propertyId ?? null, input.organizationId ?? null]);

  let floor = null;
  let bargainAllowed = true;
  let unreadable = false;
  for (const rule of rules) {
    const amount = readFloorAmount(rule.rule_value_json);
    if (amount === undefined) { unreadable = true; continue; }
    if (amount !== null) floor = floor === null ? amount : Math.max(floor, amount);
    try {
      if (JSON.parse(rule.rule_value_json).bargainAllowed === false) bargainAllowed = false;
    } catch { /* readFloorAmount 已經處理壞掉的 JSON */ }
  }
  return { hasPolicy: rules.length > 0, floor, bargainAllowed, unreadable };
}

module.exports = {
  FLOOR_AMOUNT_KEYS,
  loadRentNegotiationPolicy,
  VERDICTS,
  evaluateRentFloorPolicy,
  readFloorAmount
};
