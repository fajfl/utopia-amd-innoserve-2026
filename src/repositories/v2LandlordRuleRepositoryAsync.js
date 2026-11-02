// 房東規則的列出、排序與軟刪除(driver 版,SQLite 與 TiDB 共用一份實作)。
//
// 新增規則仍然在 v2LandlordKnowledgeRepository(Async) 的 saveConfirmedRule,
// 這裡只負責建立之後的管理動作。分開是因為新增會一次寫四張表(knowledge_items /
// knowledge_versions / knowledge_scope_links / landlord_rules + knowledge_sources),
// 而管理動作只碰其中兩張。
//
// 排序語意
// --------
// landlord_rules.sort_order 是唯一的排序來源,排序鍵固定是
// (sort_order ASC, created_at ASC, id ASC)。migration 014 把舊資料的 sort_order
// 補成 id,所以升級前後的顯示順序完全一致。新規則取同一個 rental_unit 目前的
// MAX(sort_order) + 10,重排時重新編號成 10, 20, 30…,中間留空好插入。
//
// 軟刪除語意
// ----------
// 刪除 = landlord_rules.status = 'inactive',同時把對應的 knowledge_items 標成
// 'retired'、未結束的 knowledge_versions 補上 effective_until。
//
// 只改 landlord_rules 是不夠的:AI 的 buildListingContext 讀 landlord_rules,但
// 房東 LINE 的 getListingKnowledgeSummary 走的是 knowledge_scope_links →
// knowledge_versions → knowledge_items 這條路,只改一邊會出現「房東以為刪掉了、
// 知識庫摘要還列著」的狀態。兩邊一起改,而且都是狀態欄位,資料列全部留著。

const { idEquals } = require('../database/idEquals');

const RULE_ORDER_STEP = 10;

// knowledge_versions 的兩個時間欄位在雲端是**不同型別**的:
//   effective_from  DATETIME   → mysql2 開了 dateStrings,讀回來是 '2026-08-24 12:34:57'
//   effective_until longtext   → 全專案寫進去的是 new Date().toISOString()
// 本機 SQLite 兩個都是 TEXT,兩個都是 ISO 字串。
//
// 所以這兩個值**不能直接比字串**:同一天的話,空格(0x20)排在 'T'(0x54)前面,
// '2026-08-24 23:00:00' 會被判成小於 '2026-08-24T10:00:00.000Z'。
// 真的踩到的話,停用會把 effective_until 設成比 effective_from 還早的時間,
// 撞上雲端的 chk_knowledge_versions_tbl(@@tidb_enable_check_constraint = 1,真的會擋),
// 結果是本機測試全過、雲端停用整個失敗。轉成 epoch 再比。
function toEpoch(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || '').trim();
  if (!text) return 0;
  // 'YYYY-MM-DD HH:MM:SS'(TiDB)補成 ISO;已經是 ISO 的原樣通過。
  const iso = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 停用時間一律寫成 ISO-8601,跟專案其他地方一致;而且保證不早於 effective_from,
// 免得撞上 effective_until >= effective_from 這條 CHECK。
function effectiveUntilFor(now, effectiveFrom) {
  const fromEpoch = toEpoch(effectiveFrom);
  return fromEpoch > toEpoch(now) ? new Date(fromEpoch).toISOString() : now;
}

class RuleOwnershipError extends Error {
  constructor(message = '這條規則不屬於這個房源。') {
    super(message);
    this.name = 'RuleOwnershipError';
    this.statusCode = 403;
  }
}

function ruleText(valueJson) {
  const raw = valueJson && typeof valueJson === 'object' ? valueJson : (() => {
    try { return JSON.parse(valueJson); } catch { return null; }
  })();
  if (!raw) return String(valueJson || '');
  return raw.confirmedText || raw.label || raw.description || raw.originalText || JSON.stringify(raw);
}

function usePolicyOf(valueJson) {
  const raw = valueJson && typeof valueJson === 'object' ? valueJson : (() => {
    try { return JSON.parse(valueJson); } catch { return null; }
  })();
  return (raw && raw.usePolicy) || null;
}

// 同一個 rental_unit 底下的下一個 sort_order。假設自己已經在交易裡:
// 讀 MAX 與後面的 INSERT 必須在同一個交易,否則兩筆同時新增會拿到同一個號碼。
async function nextSortOrderCore(db, rentalUnitId) {
  const row = await db.get(
    'SELECT COALESCE(MAX(sort_order), 0) current_max FROM landlord_rules WHERE rental_unit_id = ?',
    [rentalUnitId]
  );
  return Number(row.current_max || 0) + RULE_ORDER_STEP;
}

async function listRules(db, { rentalUnitId, includeInactive = true }) {
  const rows = await db.all(`
    SELECT lr.id, lr.public_id, lr.rule_type, lr.rule_value_json, lr.visibility, lr.status,
           lr.sort_order, lr.created_at, ki.public_id knowledge_public_id, ki.status knowledge_status
    FROM landlord_rules lr
    JOIN knowledge_items ki ON ki.id = lr.knowledge_item_id
    WHERE lr.rental_unit_id = ?
    ORDER BY lr.sort_order ASC, lr.created_at ASC, lr.id ASC
  `, [rentalUnitId]);
  return rows
    .filter((row) => includeInactive || row.status === 'active')
    .map((row) => ({
      publicId: row.public_id,
      knowledgePublicId: row.knowledge_public_id,
      ruleType: row.rule_type,
      text: ruleText(row.rule_value_json),
      usePolicy: usePolicyOf(row.rule_value_json),
      visibility: row.visibility,
      status: row.status,
      knowledgeStatus: row.knowledge_status,
      sortOrder: Number(row.sort_order) || 0
    }));
}

// 重新編號。傳進來的 publicId 必須全部屬於這個 rental_unit,而且必須是這個
// rental_unit 底下**全部**的規則 —— 只送一部分會讓沒送到的那些沿用舊號碼,
// 跟新號碼混在一起之後順序就不可預期了。
async function reorderRulesCore(db, { rentalUnitId, orderedPublicIds }) {
  const existing = await db.all(
    'SELECT public_id FROM landlord_rules WHERE rental_unit_id = ?',
    [rentalUnitId]
  );
  const owned = new Set(existing.map((row) => row.public_id));
  const requested = new Set(orderedPublicIds);
  if (requested.size !== orderedPublicIds.length) {
    throw new RuleOwnershipError('排序清單裡有重複的規則。');
  }
  for (const publicId of orderedPublicIds) {
    if (!owned.has(publicId)) throw new RuleOwnershipError();
  }
  if (owned.size !== requested.size) {
    throw new RuleOwnershipError('排序清單必須包含這個房源目前全部的規則。');
  }

  for (let index = 0; index < orderedPublicIds.length; index += 1) {
    const result = await db.run(`
      UPDATE landlord_rules SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE public_id = ? AND rental_unit_id = ?
    `, [(index + 1) * RULE_ORDER_STEP, orderedPublicIds[index], rentalUnitId]);
    if (result.changes !== 1) throw new RuleOwnershipError();
  }
  return { reordered: orderedPublicIds.length };
}

function reorderRules(db, input) {
  return db.transaction((tx) => reorderRulesCore(tx, input));
}

// status 只能是 active 或 inactive。superseded 是版本替換用的,不從這個入口設定。
async function setRuleStatusCore(db, { rentalUnitId, rulePublicId, status, now }) {
  if (!['active', 'inactive'].includes(status)) {
    throw new Error('rule status must be active or inactive');
  }
  const rule = await db.get(
    'SELECT id, knowledge_item_id, rental_unit_id FROM landlord_rules WHERE public_id = ?',
    [rulePublicId]
  );
  if (!rule || !idEquals(rule.rental_unit_id, rentalUnitId)) throw new RuleOwnershipError();

  await db.run(
    'UPDATE landlord_rules SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, rule.id]
  );

  // updated_at 用 CURRENT_TIMESTAMP 而不是傳 ISO 字串進去:這個欄位在雲端是 DATETIME,
  // TiDB 雖然吃得下 '...T...Z' 卻會把毫秒**四捨五入到秒**(實測 .789 進位成 57 秒),
  // 本機 SQLite 則原樣存字串。用 CURRENT_TIMESTAMP 兩邊都由資料庫決定,不會分岔。
  if (status === 'inactive') {
    await db.run(
      "UPDATE knowledge_items SET status = 'retired', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [rule.knowledge_item_id]
    );
    // 一列一列更新,因為 effective_until 要夾在各自的 effective_from 之後,
    // 而那個比較沒辦法在 SQL 裡跨兩種型別安全地做(見 effectiveUntilFor 的註解)。
    // 同一個 knowledge_item 目前只會有一個未結束的版本,所以這裡不是 N+1 的問題。
    const openVersions = await db.all(`
      SELECT id, effective_from FROM knowledge_versions
      WHERE knowledge_item_id = ? AND effective_until IS NULL
    `, [rule.knowledge_item_id]);
    for (const version of openVersions) {
      await db.run('UPDATE knowledge_versions SET effective_until = ? WHERE id = ?',
        [effectiveUntilFor(now, version.effective_from), version.id]);
    }
  } else {
    await db.run(
      "UPDATE knowledge_items SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [rule.knowledge_item_id]
    );
    const latestVersion = await db.get(
      'SELECT id FROM knowledge_versions WHERE knowledge_item_id = ? ORDER BY version_number DESC, id DESC LIMIT 1',
      [rule.knowledge_item_id]
    );
    if (latestVersion) {
      await db.run('UPDATE knowledge_versions SET effective_until = NULL WHERE id = ?', [latestVersion.id]);
    }
  }
  return { publicId: rulePublicId, status };
}

function setRuleStatus(db, input) {
  return db.transaction((tx) => setRuleStatusCore(tx, input));
}

module.exports = {
  RULE_ORDER_STEP,
  RuleOwnershipError,
  effectiveUntilFor,
  listRules,
  nextSortOrderCore,
  reorderRules,
  reorderRulesCore,
  ruleText,
  setRuleStatus,
  setRuleStatusCore
};
