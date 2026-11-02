// 房東 LINE「AI 知識庫」repository 的 driver 版本:同一份實作,底下可掛
// better-sqlite3 或 mysql2。參數 `db` 收的是 sqlDriver 的 driver,不是原始的
// better-sqlite3 連線;傳錯的話第一次 await db.get(...) 就會炸,不會靜默出錯。
//
// 與同步版 (v2LandlordKnowledgeRepository.js) 的差異只有三類:
//
// 1. 全部改成 async,SQL 走 db.get / db.all / db.run。
//
// 2. 同步版用 inTransaction(db, work) 判斷「已經在交易裡就直接跑」。driver 介面
//    **沒有** inTransaction 屬性,所以照 v2InquiryRepositoryAsync 的做法拆成
//    *Core(假設自己已經在交易裡)加一個負責開交易的 wrapper。要把好幾個操作
//    合成一個交易時呼叫 Core,並把外層的 tx 傳進去。
//
// 3. 三處 ORDER BY 的 datetime(...) 全部移除。MySQL/TiDB 沒有 datetime() 純量
//    函式,那是 ER_PARSE_ERROR 級的硬錯誤,不是靜默差異。updated_at / asked_at
//    存的是 ISO-8601 字串,字典序等於時間序,所以直接排字串在兩邊都正確 ——
//    這裡刻意**不用** dialect.utcValue(),那是給「欄位在 MySQL 已經是 DATETIME」
//    的情境用的,在這裡只會留下不必要的方言相依。同樣的處理已經用在
//    v2ContractOtpServiceAsync 的 OTP 逾時比較上。
//
// 另外 listTenantsForListing 的 GROUP BY 也改寫過,原因見該函式上方註解。
//
// 交易中一律使用 transaction 回呼給的 tx。用交易外的 driver 查詢,在 mysql2 會落
// 到另一條連線,讀到交易外的狀態,也不會被回捲。

const crypto = require('node:crypto');
const { assertLandlordAnswerReusable } = require('../database/integrityGuardsAsync');
const { RULE_ORDER_STEP } = require('./v2LandlordRuleRepositoryAsync');

function parseJson(value, fallback) {
  // 若 TiDB 那側把欄位建成 JSON 型別,mysql2 會直接回傳已解析的物件,
  // 對物件呼叫 JSON.parse 會拋 SyntaxError,所以先讓物件原樣通過。
  if (value && typeof value === 'object') return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

// datetime(l.updated_at) 已移除,理由見檔頭第 3 點。
async function listLandlordListings(db, landlordUserId, { limit = 10, offset = 0 } = {}) {
  const rows = await db.all(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      COALESCE(valid.parse_status, latest.parse_status, 'partial') quality_status,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count,
      (SELECT COUNT(*) FROM knowledge_scope_links ksl
       JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
       JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
       WHERE ksl.rental_unit_id = l.rental_unit_id AND ki.status = 'active'
         AND kv.effective_until IS NULL) knowledge_count
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON (po.rental_unit_id = ru.id OR (po.rental_unit_id IS NULL AND po.property_id = ru.property_id))
    LEFT JOIN listing_snapshots valid ON valid.id = l.latest_valid_snapshot_id
    LEFT JOIN (
      SELECT ls.*, ROW_NUMBER() OVER (PARTITION BY ls.listing_id ORDER BY ls.captured_at DESC, ls.id DESC) rn
      FROM listing_snapshots ls
    ) latest ON latest.listing_id = l.id AND latest.rn = 1
    WHERE po.owner_user_id = ? AND po.effective_until IS NULL
    ORDER BY pending_count DESC, l.updated_at DESC, l.id DESC
    LIMIT ? OFFSET ?
  `, [landlordUserId, limit, offset]);
  // quality_status 曾經在這裡被漏掉(listDemoListings 有、這支沒有),
  // presenter 讀不到就一律顯示「待補充」。2026-08-19 兩邊一起補上。
  return rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    qualityStatus: row.quality_status,
    pendingQuestionCount: row.pending_count,
    knowledgeCount: row.knowledge_count
  }));
}

// 同步版寫的是「SELECT i.id, li.display_name_cache, li.line_user_id ... GROUP BY i.id
// ORDER BY i.last_activity_at DESC」。那是 SQLite 才容許的 bare column:兩個被選出
// 的 li.* 欄位既不在 GROUP BY 裡也不是聚合。TiDB 的 sql_mode 預設含
// ONLY_FULL_GROUP_BY,會直接回 ER_WRONG_FIELD_WITH_GROUP —— 又是硬錯誤。
// ORDER BY i.last_activity_at 同樣不合法(既非分組欄位也非聚合)。
//
// 改寫方式:不用 GROUP BY,改成在 JOIN 條件裡用子查詢挑出**單一**身分。
//
// 一開始改成 MIN(display_name_cache) / MIN(line_user_id),那是錯的:兩個 MIN 各自
// 獨立取值,同一個 user 掛多個 line_identity 時,暱稱可能取自 A 列、LINE ID 取自
// B 列,湊出一個不存在的人。這是房東看到的房客清單,配錯 LINE ID 會把訊息推給
// 別人。line_identities.user_id **沒有**唯一約束,現行資料裡 user_id=4 就掛了兩個
// 身分,所以這條路是走得到的。
//
// 現在的寫法保證兩個欄位一定來自同一列,取 id 最小的那個身分,兩個 driver 結果
// 相同且可重現。
async function listTenantsForListing(db, listingPublicId) {
  return db.all(`
    SELECT i.id inquiryId, li.display_name_cache displayName, li.line_user_id lineUserId
    FROM inquiries i
    JOIN listings l ON l.id = i.listing_id
    JOIN (
      SELECT li2.*, ROW_NUMBER() OVER (PARTITION BY li2.user_id ORDER BY li2.id) rn
      FROM line_identities li2
    ) li ON li.user_id = i.user_id AND li.rn = 1
    WHERE l.public_id = ? AND i.ended_at IS NULL
    ORDER BY i.last_activity_at DESC LIMIT 10
  `, [listingPublicId]);
}

// datetime(l.updated_at) 已移除,理由見檔頭第 3 點。
async function listDemoListings(db, { limit = 10, offset = 0 } = {}) {
  const rows = await db.all(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      COALESCE(valid.parse_status, latest.parse_status, 'partial') quality_status,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count,
      (SELECT COUNT(*) FROM knowledge_scope_links ksl
       JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
       JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
       WHERE ksl.rental_unit_id = l.rental_unit_id AND ki.status = 'active'
         AND kv.effective_until IS NULL) knowledge_count
    FROM listings l
    LEFT JOIN listing_snapshots valid ON valid.id = l.latest_valid_snapshot_id
    LEFT JOIN (
      SELECT ls.*, ROW_NUMBER() OVER (PARTITION BY ls.listing_id ORDER BY ls.captured_at DESC, ls.id DESC) rn
      FROM listing_snapshots ls
    ) latest ON latest.listing_id = l.id AND latest.rn = 1
    WHERE l.public_id LIKE 'demo-591-listing-%'
    ORDER BY pending_count DESC, l.updated_at DESC, l.id DESC
    LIMIT ? OFFSET ?
  `, [limit, offset]);
  return rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    qualityStatus: row.quality_status,
    pendingQuestionCount: row.pending_count,
    knowledgeCount: row.knowledge_count
  }));
}

async function getListingKnowledgeSummary(db, listingPublicId) {
  const row = await db.get(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount, l.rental_unit_id,
      p.address_text, ru.floor_label, ru.room_count,
      COALESCE(valid.parse_status, latest.parse_status, 'partial') quality_status,
      COALESCE(valid.amenity_json, latest.amenity_json, '[]') amenity_json
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN properties p ON p.id = ru.property_id
    LEFT JOIN listing_snapshots valid ON valid.id = l.latest_valid_snapshot_id
    LEFT JOIN (
      SELECT ls.*, ROW_NUMBER() OVER (PARTITION BY ls.listing_id ORDER BY ls.captured_at DESC, ls.id DESC) rn
      FROM listing_snapshots ls
    ) latest ON latest.listing_id = l.id AND latest.rn = 1
    WHERE l.public_id = ?
  `, [listingPublicId]);
  if (!row) throw new Error('listing not found');
  const knowledgeRows = await db.all(`
    SELECT ki.public_id, ki.knowledge_type, kv.topic_text, kv.content_text, kv.use_policy
    FROM knowledge_scope_links ksl
    JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
    JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
    WHERE ksl.rental_unit_id = ? AND ki.status = 'active'
      AND kv.visibility = 'public' AND kv.effective_until IS NULL
    ORDER BY ksl.priority DESC, kv.id DESC
  `, [row.rental_unit_id]);
  const publicKnowledge = knowledgeRows.map((item) => ({
    publicId: item.public_id,
    type: item.knowledge_type,
    topic: item.topic_text,
    content: item.content_text,
    usePolicy: item.use_policy
  }));
  const internalCount = (await db.get(`
    SELECT COUNT(*) count FROM knowledge_scope_links ksl
    JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
    JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
    WHERE ksl.rental_unit_id = ? AND ki.status = 'active'
      AND kv.visibility = 'internal' AND kv.effective_until IS NULL
  `, [row.rental_unit_id])).count;
  const pendingCount = (await db.get(`
    SELECT COUNT(*) count FROM landlord_questions
    WHERE listing_id = ? AND status IN ('pending','notified')
  `, [row.id])).count;
  return {
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    address: row.address_text,
    floor: row.floor_label,
    roomCount: row.room_count,
    amenities: parseJson(row.amenity_json, []),
    qualityStatus: row.quality_status,
    publicKnowledge,
    internalKnowledgeCount: internalCount,
    pendingQuestionCount: pendingCount
  };
}

// datetime(asked_at) 已移除,理由見檔頭第 3 點。asked_at 的排序是房東看到待回答
// 問題的順序,所以這條 ORDER BY 是有語意的,不是可有可無的裝飾。
async function listPendingQuestions(db, listingId) {
  const rows = await db.all(`
    SELECT public_id, question_text, asked_at, status, escalation_reason
    FROM landlord_questions
    WHERE listing_id = ? AND status IN ('pending','notified')
    ORDER BY asked_at, id
  `, [listingId]);
  return rows.map((row) => ({
    publicId: row.public_id,
    questionText: row.question_text,
    escalationReason: row.escalation_reason,
    askedAt: row.asked_at,
    status: row.status
  }));
}

async function saveLandlordAnswerCore(db, input) {
  const question = await db.get(`
    SELECT id, status, inquiry_id FROM landlord_questions WHERE public_id = ?
  `, [input.questionPublicId]);
  if (!question) throw new Error('question not found');
  if (!['pending', 'notified'].includes(question.status)) throw new Error('question is not pending');
  const publicId = `answer-${input.questionPublicId}-${crypto.randomUUID().slice(0, 8)}`;
  await db.run(`
    INSERT INTO landlord_answers (
      public_id, landlord_question_id, landlord_user_id, answer_text,
      reuse_approved, visibility, answered_at, created_at
    ) VALUES (?, ?, ?, ?, 0, 'public', ?, ?)
  `, [publicId, question.id, input.landlordUserId, input.answerText, input.answeredAt, input.answeredAt]);
  await db.run(`
    UPDATE landlord_questions SET status = 'answered', answered_at = ? WHERE id = ?
  `, [input.answeredAt, question.id]);
  return { publicId, inquiryId: question.inquiry_id, reuseApproved: false };
}

function saveLandlordAnswer(db, input) {
  return db.transaction((tx) => saveLandlordAnswerCore(tx, input));
}

async function approveAnswerForReuseCore(db, input) {
  const row = await db.get(`
    SELECT a.id answer_id, a.answer_text, a.reuse_approved,
      q.id question_id, q.public_id question_public_id, q.question_text,
      l.rental_unit_id
    FROM landlord_answers a
    JOIN landlord_questions q ON q.id = a.landlord_question_id
    JOIN listings l ON l.id = q.listing_id
    WHERE a.public_id = ?
  `, [input.answerPublicId]);
  if (!row) throw new Error('answer not found');
  const itemPublicId = `qa-${row.question_public_id}`;
  const existing = await db.get('SELECT id FROM knowledge_items WHERE public_id = ?', [itemPublicId]);
  if (existing) return { publicId: itemPublicId, knowledgeType: 'approved_qa' };
  await db.run('UPDATE landlord_answers SET reuse_approved = 1 WHERE id = ?', [row.answer_id]);
  await db.run(`
    INSERT INTO knowledge_items (public_id, knowledge_type, status, created_at, updated_at)
    VALUES (?, 'approved_qa', 'active', ?, ?)
  `, [itemPublicId, input.approvedAt, input.approvedAt]);
  const itemId = (await db.get('SELECT id FROM knowledge_items WHERE public_id = ?', [itemPublicId])).id;
  const versionPublicId = `${itemPublicId}-v1`;
  await db.run(`
    INSERT INTO knowledge_versions (
      public_id, knowledge_item_id, version_number, normalized_question,
      topic_text, content_text, visibility, use_policy, effective_from,
      approved_by_user_id, approved_at, created_at
    ) VALUES (?, ?, 1, ?, '房東核准問答', ?, 'public', 'answer_directly', ?, ?, ?, ?)
  `, [versionPublicId, itemId, row.question_text, row.answer_text,
    input.approvedAt, input.approvedByUserId, input.approvedAt, input.approvedAt]);
  const versionId = (await db.get('SELECT id FROM knowledge_versions WHERE public_id = ?', [versionPublicId])).id;
  // 這道防線取代 SQLite 的 trg_knowledge_source_landlord_answer_reuse(TiDB 不支援
  // trigger)。務必傳目前這個 db,交易中就是 tx —— 用交易外的 driver 查會讀到
  // reuse_approved 更新前的狀態,防線就形同虛設。
  await assertLandlordAnswerReusable(db, { sourceType: 'landlord_answer', sourceId: row.answer_id });
  await db.run(`INSERT INTO knowledge_sources
    (knowledge_version_id, source_type, source_id, created_at)
    VALUES (?, 'landlord_answer', ?, ?)
  `, [versionId, row.answer_id, input.approvedAt]);
  await db.run(`INSERT INTO knowledge_scope_links
    (knowledge_version_id, rental_unit_id, priority, created_at)
    VALUES (?, ?, 100, ?)
  `, [versionId, row.rental_unit_id, input.approvedAt]);
  return { publicId: itemPublicId, knowledgeType: 'approved_qa' };
}

function approveAnswerForReuse(db, input) {
  return db.transaction((tx) => approveAnswerForReuseCore(tx, input));
}

const POLICY_PAIRS = new Set([
  'public:answer_directly',
  'public:must_escalate',
  'internal:negotiate_within_rule',
  'internal:must_escalate'
]);

// 同步版在開交易「之前」就檢查 policy,所以不合法的組合連 BEGIN 都不會下。
// Core 也要檢查(它可能被外層交易直接呼叫),wrapper 也檢查以維持同樣的順序。
function assertPolicyAllowed(input) {
  if (!POLICY_PAIRS.has(`${input.visibility}:${input.usePolicy}`)) {
    throw new Error('policy is not allowed');
  }
}

async function saveConfirmedRuleCore(db, input) {
  assertPolicyAllowed(input);
  const listing = await db.get('SELECT rental_unit_id FROM listings WHERE public_id = ?', [input.listingPublicId]);
  if (!listing) throw new Error('listing not found');
  const suffix = crypto.randomUUID();
  const itemPublicId = `rule-${suffix}`;
  const knowledgeType = input.visibility === 'public' ? 'landlord_public_rule' : 'landlord_internal_rule';
  const createdAt = input.createdAt || new Date().toISOString();
  await db.run(`INSERT INTO knowledge_items
    (public_id, knowledge_type, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `, [itemPublicId, knowledgeType, createdAt, createdAt]);
  const itemId = (await db.get('SELECT id FROM knowledge_items WHERE public_id = ?', [itemPublicId])).id;
  const versionPublicId = `${itemPublicId}-v1`;
  await db.run(`INSERT INTO knowledge_versions (
    public_id, knowledge_item_id, version_number, topic_text, content_text,
    visibility, use_policy, effective_from, approved_by_user_id, approved_at, created_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [versionPublicId, itemId, input.ruleType, input.confirmedText,
    input.visibility, input.usePolicy, createdAt, input.createdByUserId, createdAt, createdAt]);
  const versionId = (await db.get('SELECT id FROM knowledge_versions WHERE public_id = ?', [versionPublicId])).id;
  await db.run(`INSERT INTO knowledge_scope_links
    (knowledge_version_id, rental_unit_id, priority, created_at) VALUES (?, ?, 50, ?)
  `, [versionId, listing.rental_unit_id, createdAt]);
  // sort_order 讀 MAX 再 +10。讀與寫在同一個交易裡,兩筆同時新增才不會拿到同一個
  // 號碼;排序鍵的 tiebreaker 是 (created_at, id),所以就算真的撞號也仍然是確定的順序。
  const sortOrder = Number((await db.get(
    'SELECT COALESCE(MAX(sort_order), 0) current_max FROM landlord_rules WHERE rental_unit_id = ?',
    [listing.rental_unit_id]
  )).current_max || 0) + RULE_ORDER_STEP;
  await db.run(`INSERT INTO landlord_rules (
    public_id, knowledge_item_id, rental_unit_id, rule_type, rule_value_json,
    visibility, status, created_by_user_id, sort_order, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `, [`landlord-rule-${suffix}`, itemId, listing.rental_unit_id, input.ruleType,
    JSON.stringify({
      ...(input.ruleValue || {}),
      originalText: input.originalText,
      confirmedText: input.confirmedText,
      usePolicy: input.usePolicy,
      adapter: input.adapter || 'deterministic-demo'
    }),
    input.visibility, input.createdByUserId, sortOrder, createdAt, createdAt]);
  const ruleId = (await db.get('SELECT id FROM landlord_rules WHERE public_id = ?',
    [`landlord-rule-${suffix}`])).id;
  await db.run(`INSERT INTO knowledge_sources
    (knowledge_version_id, source_type, source_id, source_detail_json, created_at)
    VALUES (?, 'landlord_manual_input', ?, ?, ?)
  `, [versionId, ruleId, JSON.stringify({ adapter: input.adapter || 'deterministic-demo' }), createdAt]);
  return { publicId: itemPublicId, visibility: input.visibility, usePolicy: input.usePolicy };
}

function saveConfirmedRule(db, input) {
  assertPolicyAllowed(input);
  return db.transaction((tx) => saveConfirmedRuleCore(tx, input));
}

module.exports = {
  approveAnswerForReuse,
  approveAnswerForReuseCore,
  getListingKnowledgeSummary,
  listDemoListings,
  listLandlordListings,
  listPendingQuestions,
  listTenantsForListing,
  saveConfirmedRule,
  saveConfirmedRuleCore,
  saveLandlordAnswer,
  saveLandlordAnswerCore
};
