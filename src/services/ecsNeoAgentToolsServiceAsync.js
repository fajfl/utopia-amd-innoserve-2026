// Model-facing tools:Negotiation Coordinator 唯一能碰到的東西。
//
// 分成兩類,沒有第三類:
//   唯讀    get_inquiry_context / search_authorized_knowledge / get_intention_diff
//   提案    build_intention_candidate(純函式,連 DB 都不碰)
//
// **刻意不存在**的工具:寫入合約、發行版本、建立或簽署 signature request、
// 代替房東接受意向、代替房客確認版本、寫 landlord_answers、改 inquiry/intention 狀態。
// 這不是靠提示詞約束,而是這個註冊表裡根本沒有那些名字,而且每個 handler 只下
// SELECT。有副作用的動作一律回到 Node 的 domain command,由 Node 在交易內重新驗證
// actor、ownership、狀態與 exact version 之後才執行。
//
// 資訊邊界同樣在工具層擋,不在提示詞裡拜託模型:
//   - knowledge_items.knowledge_type = 'landlord_internal_rule' 不會出現在任何查詢裡
//   - knowledge_versions.visibility / landlord_rules.visibility = 'internal' 一律排除
//   - 其他房客的條件、意向、訊息與詢問:所有查詢都綁在這一筆 inquiry 上
//   - 其他 inquiry 的房東回答只能透過已核准的 approved_qa knowledge 進來;
//     未核准的個別例外(reuse_approved=0)只在它自己的 inquiry 內可見
//
// production authority 是 TiDB/MySQL:只用 async driver、只用可攜 SQL,
// 沒有 SQLite 專屬函式、沒有 GROUP BY 依賴(TiDB 開著 ONLY_FULL_GROUP_BY)。

const crypto = require('node:crypto');
const { otherAgreements } = require('./ecsNeoOtherAgreements');

const { canonicalJson } = require('./ecsNeoContractAcceptanceServiceAsync');
const { runTracedTool } = require('./ecsNeoAgentTraceServiceAsync');

const READ_ONLY_TOOL_NAMES = Object.freeze([
  'get_inquiry_context',
  'search_authorized_knowledge',
  'get_intention_diff'
]);

const PROPOSAL_TOOL_NAMES = Object.freeze([
  'build_intention_candidate'
]);

// 允許出現在候選條件裡的欄位。對應 intention_versions 的實際欄位,
// 模型送別的 key(例如 landlord_floor_price)會被當成 invalid_model_output 擋掉,
// 不是靜默丟棄 —— 靜默丟棄會讓「條件不見了」變成查不出來的問題。
const CANDIDATE_FIELD_PATHS = Object.freeze([
  'rent_amount',
  'deposit_amount',
  'lease_start_date',
  'lease_end_date',
  'move_in_date',
  // 以下欄位會直接成為 prepared draft 的 clause snapshot。它們仍然只是
  // 房客提出、待確認的條件；Node 會要求可追溯來源，房東也仍須最終簽署。
  'repair_responsibility',
  'utility_cost_allocation',
  'early_termination',
  'household_registration_allowed',
  'pet_allowed',
  'pet_request_text',
  'equipment_request_text',
  'viewing_request_text',
  'special_request_text'
]);

// 必要欄位缺一個就不可能送出意向。這裡只回報缺哪些,不自己補值。
const REQUIRED_CANDIDATE_FIELDS = Object.freeze([
  'rent_amount',
  'deposit_amount',
  'lease_start_date',
  'lease_end_date'
]);

// intention_version_sources.source_type 的封閉集合。候選欄位一定要指得到來源,
// 「模型自己想的」不是來源。
const CANDIDATE_SOURCE_TYPES = Object.freeze([
  'message',
  'listing_snapshot',
  'knowledge_version',
  'manual_input'
]);

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

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

const sameId = (left, right) =>
  left !== null && left !== undefined &&
  right !== null && right !== undefined &&
  String(left) === String(right);

// property_owners / knowledge_versions 的日期欄位在雲端是字串(VARCHAR / LONGTEXT)。
// 兩個邊界用不同粒度的基準值,純日期與同一天的 DATETIME/ISO 字串都算包含 ——
// 完整理由見 ecsNeoContractAcceptanceServiceAsync.requireEffectiveOwner。
function asOfBounds(now = new Date()) {
  const asOfDate = now.toISOString().slice(0, 10);
  return { asOfDate, asOfEndOfDay: `${asOfDate}T23:59:59.999Z` };
}

// LIKE 的萬用字元在兩個方言的 ESCAPE 預設值不同(MySQL 預設反斜線,SQLite 沒有預設)。
// 與其寫一段方言相關的轉義,直接把 % 與 _ 從搜尋詞裡拿掉:這是搜尋輔助,
// 少一個萬用字元只會少幾筆結果,寫錯方言卻會讓查詢在雲端行為不同。
function likeTerm(topic) {
  if (typeof topic !== 'string') return null;
  const cleaned = topic.replace(/[%_\\]/g, ' ').trim();
  return cleaned ? `%${cleaned}%` : null;
}

function parseJsonOrNull(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 快照的 amenity_json 是外部來源,壞掉是可預期的。不能因此讓整個 context 失敗,
    // 但也不能假裝有值。
    return null;
  }
}

// context 的指紋。寫進 agent_executions.context_version,讓「模型當時看到什麼」
// 可以事後比對;內容本身不進 trace。
function contextVersionOf(context) {
  return `ctx-${crypto.createHash('sha256').update(canonicalJson(context), 'utf8').digest('hex').slice(0, 32)}`;
}

// --- 授權 --------------------------------------------------------------------

/**
 * 解析並授權一筆 inquiry。
 *
 * 高風險動作不猜「最近一筆 inquiry」,所以一律要求明確的 inquiryPublicId。
 * 房客是 inquiry 的擁有者;房東必須在此刻對該 property/unit 有有效授權。
 *
 * 不存在與無權限回**同一句話同一個 code**:錯誤訊息不可以洩漏某個 public id
 * 是否存在。
 */
async function requireAuthorizedInquiry(db, { actorUserId, inquiryPublicId, now }) {
  if (actorUserId === null || actorUserId === undefined) {
    throw fail('actorUserId is required', 'invalid_input', 400);
  }
  requireText(inquiryPublicId, 'inquiryPublicId');

  const denied = () => fail('找不到可存取的房源詢問', 'authorization_denied', 403);

  const actor = await db.get("SELECT id FROM users WHERE id = ? AND status = 'active'", [actorUserId]);
  if (!actor) throw denied();

  const row = await db.get(`
    SELECT inq.id                     AS inquiry_id,
           inq.public_id              AS inquiry_public_id,
           inq.status                 AS inquiry_status,
           inq.user_id                AS tenant_user_id,
           l.id                       AS listing_id,
           l.public_id                AS listing_public_id,
           l.title                    AS listing_title,
           l.status                   AS listing_status,
           l.current_rent_amount,
           l.current_deposit_amount,
           l.latest_valid_snapshot_id,
           ru.id                      AS rental_unit_id,
           ru.public_id               AS rental_unit_public_id,
           ru.unit_label,
           ru.floor_label,
           ru.rental_type,
           ru.room_count,
           ru.bathroom_count,
           ru.area_ping,
           p.id                       AS property_id,
           p.organization_id
    FROM inquiries inq
    JOIN listings l      ON l.id = inq.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN properties p    ON p.id = ru.property_id
    WHERE inq.public_id = ?
  `, [inquiryPublicId]);
  if (!row) throw denied();

  if (sameId(row.tenant_user_id, actorUserId)) return { ...row, role: 'tenant' };

  const { asOfDate, asOfEndOfDay } = asOfBounds(now);
  const owner = await db.get(`
    SELECT 1 AS ok
    FROM property_owners po
    WHERE po.owner_user_id = ?
      AND po.property_id = ?
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ?)
      AND po.effective_from <= ?
      AND (po.effective_until IS NULL OR po.effective_until >= ?)
  `, [actorUserId, row.property_id, row.rental_unit_id, asOfEndOfDay, asOfDate]);
  if (!owner) throw denied();

  return { ...row, role: 'landlord' };
}

// --- 唯讀 tool:get_inquiry_context -------------------------------------------

// 房源快照只取解析成功的那一筆。591 結構會變,解析失敗不得覆蓋最後有效快照,
// 所以這裡跟著 listings.latest_valid_snapshot_id 走,不自己挑最新 captured_at。
async function loadListingSnapshot(db, snapshotId) {
  if (snapshotId === null || snapshotId === undefined) return null;
  const row = await db.get(`
    SELECT public_id, captured_at, parser_version, parse_status,
           normalized_title, normalized_address,
           rent_amount, deposit_amount, management_fee_amount,
           pet_policy_text, amenity_json
    FROM listing_snapshots
    WHERE id = ?
      AND parse_status = 'valid'
  `, [snapshotId]);
  if (!row) return null;
  return {
    sourceType: 'listing_snapshot',
    publicId: row.public_id,
    capturedAt: row.captured_at,
    parserVersion: row.parser_version,
    normalizedTitle: row.normalized_title,
    normalizedAddress: row.normalized_address,
    rentAmount: row.rent_amount,
    depositAmount: row.deposit_amount,
    managementFeeAmount: row.management_fee_amount,
    petPolicyText: row.pet_policy_text,
    amenities: parseJsonOrNull(row.amenity_json)
  };
}

// 刻意**不**提供「latest version」欄位。給的是明確的 version public id 清單加上
// 房客確認過的那一個;要 diff 或要送簽都必須指名 exact version。
// spec invariant 6 禁止用 ORDER BY version_number DESC 猜 latest,少一個欄位
// 就少一個被猜的機會。
async function loadIntention(db, inquiryId) {
  // 一筆詢問可能有不只一筆意向:房東拒絕之後詢問會留著,房客重談會開新的一筆
  // (被拒的那筆連同版本原樣留著供稽核)。所以這裡必須明確排序,不能靠
  // 「反正只有一筆」—— 沒有 ORDER BY 時取到的會是最舊的那筆,也就是被拒的那筆。
  // 優先取還在進行中的;全部都終止了才回最後一筆,讓 Agent 至少說得出結果。
  const TERMINAL = ['rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'];
  const intention = await db.get(`
    SELECT ri.id, ri.public_id, ri.status, ri.tenant_user_id, ri.confirmed_intention_version_id
    FROM rental_intentions ri
    WHERE ri.inquiry_id = ?
    ORDER BY CASE WHEN ri.status IN (${TERMINAL.map(() => '?').join(',')}) THEN 1 ELSE 0 END, ri.id DESC
    LIMIT 1
  `, [inquiryId, ...TERMINAL]);
  if (!intention) return null;

  const versions = await db.all(`
    SELECT iv.public_id, iv.version_number, iv.rent_amount, iv.deposit_amount,
           iv.lease_start_date, iv.lease_end_date, iv.move_in_date,
           iv.pet_request_text, iv.equipment_request_text,
           iv.viewing_request_text, iv.special_request_text,
           iv.created_by_user_id, iv.created_at
    FROM intention_versions iv
    WHERE iv.rental_intention_id = ?
    ORDER BY iv.version_number
  `, [intention.id]);

  let confirmedVersionPublicId = null;
  if (intention.confirmed_intention_version_id !== null && intention.confirmed_intention_version_id !== undefined) {
    const confirmed = await db.get(
      'SELECT public_id FROM intention_versions WHERE id = ?',
      [intention.confirmed_intention_version_id]
    );
    confirmedVersionPublicId = confirmed?.public_id ?? null;
  }

  return {
    publicId: intention.public_id,
    status: intention.status,
    confirmedVersionPublicId,
    versions: versions.map((version) => ({
      publicId: version.public_id,
      versionNumber: version.version_number,
      rentAmount: version.rent_amount,
      depositAmount: version.deposit_amount,
      leaseStartDate: version.lease_start_date,
      leaseEndDate: version.lease_end_date,
      moveInDate: version.move_in_date,
      petRequestText: version.pet_request_text,
      equipmentRequestText: version.equipment_request_text,
      viewingRequestText: version.viewing_request_text,
      specialRequestText: version.special_request_text,
      // 只分辨「是不是房客本人提的」。要斷定另一方確實是房東必須另做 ownership 檢查,
      // 這裡不猜,所以是 other 而不是 landlord。
      createdByRole: sameId(version.created_by_user_id, intention.tenant_user_id) ? 'tenant' : 'other',
      createdAt: version.created_at
    }))
  };
}

async function getInquiryContext(db, args = {}) {
  const scope = await requireAuthorizedInquiry(db, {
    actorUserId: args.actorUserId,
    inquiryPublicId: args.inquiryPublicId,
    now: args.now
  });

  const context = {
    role: scope.role,
    inquiry: {
      publicId: scope.inquiry_public_id,
      status: scope.inquiry_status
    },
    listing: {
      publicId: scope.listing_public_id,
      title: scope.listing_title,
      status: scope.listing_status,
      currentRentAmount: scope.current_rent_amount,
      currentDepositAmount: scope.current_deposit_amount
    },
    rentalUnit: {
      publicId: scope.rental_unit_public_id,
      unitLabel: scope.unit_label,
      floorLabel: scope.floor_label,
      rentalType: scope.rental_type,
      roomCount: scope.room_count,
      bathroomCount: scope.bathroom_count,
      areaPing: scope.area_ping
    },
    listingSnapshot: await loadListingSnapshot(db, scope.latest_valid_snapshot_id),
    intention: await loadIntention(db, scope.inquiry_id)
  };

  // 個資最小化:這裡沒有姓名、電話、LINE display name 或身分證。
  // 模型要稱呼對方時用角色(房客／房東),不需要真實姓名。
  return { ...context, contextVersion: contextVersionOf(context) };
}

// --- 唯讀 tool:search_authorized_knowledge -----------------------------------

async function searchAuthorizedKnowledge(db, args = {}) {
  const scope = await requireAuthorizedInquiry(db, {
    actorUserId: args.actorUserId,
    inquiryPublicId: args.inquiryPublicId,
    now: args.now
  });
  const term = likeTerm(args.topic);
  const { asOfDate, asOfEndOfDay } = asOfBounds(args.now);

  // knowledge_type 與 visibility 的雙重過濾都寫在 SQL 裡。
  // landlord_internal_rule 連查詢都不會碰到它,不是查出來再過濾 —— 查出來再過濾
  // 的寫法只要有人改動下游程式就會外洩。
  const knowledge = await db.all(`
    SELECT DISTINCT ki.knowledge_type,
                    kv.public_id,
                    kv.version_number,
                    kv.topic_text,
                    kv.content_text,
                    kv.use_policy,
                    ksl.priority
    FROM knowledge_versions kv
    JOIN knowledge_items ki       ON ki.id = kv.knowledge_item_id
    JOIN knowledge_scope_links ksl ON ksl.knowledge_version_id = kv.id
    WHERE ki.status = 'active'
      AND ki.knowledge_type IN ('listing_fact', 'landlord_public_rule', 'approved_qa')
      AND kv.visibility = 'public'
      AND kv.superseded_by_version_id IS NULL
      AND kv.effective_from <= ?
      AND (kv.effective_until IS NULL OR kv.effective_until >= ?)
      AND (ki.knowledge_type <> 'approved_qa' OR kv.approved_at IS NOT NULL)
      AND (ksl.rental_unit_id = ?
           OR ksl.property_id = ?
           OR (ksl.organization_id IS NOT NULL AND ksl.organization_id = ?))
      AND (? IS NULL OR kv.topic_text LIKE ? OR kv.content_text LIKE ?)
    ORDER BY ksl.priority DESC, kv.version_number DESC
  `, [
    asOfEndOfDay, asOfDate,
    scope.rental_unit_id, scope.property_id, scope.organization_id ?? null,
    term, term, term
  ]);

  // use_policy 一定要跟著規則一起出來。
  //
  // 「每次先問我」在資料上就是 public + must_escalate 的規則。少了這一欄,
  // grounding 檢查看到的 publicRules 沒有政策,模型只要引用 rule-* 而不是對應的
  // knowledge version,就能繞過 must_escalate 自己回答 —— 而那正是房東交代
  // 一定要問他的那些事。
  //
  // 政策的正本在 knowledge_versions;landlord_rules.rule_value_json 裡那份是
  // 建立當下的副本,只在沒有版本可查時才用(下面的 mapper)。
  // 子查詢放在 SELECT 不放 JOIN ON —— JOIN ON 裡的子查詢跑到 TiDB 會出問題,
  // 專案有一條測試在守這件事。
  const publicRules = await db.all(`
    SELECT lr.public_id, lr.rule_type, lr.rule_value_json,
           (SELECT kv.use_policy
              FROM knowledge_versions kv
             WHERE kv.knowledge_item_id = lr.knowledge_item_id
               AND kv.superseded_by_version_id IS NULL
             ORDER BY kv.version_number DESC
             LIMIT 1) AS use_policy
    FROM landlord_rules lr
    WHERE lr.visibility = 'public'
      AND lr.status = 'active'
      AND (lr.rental_unit_id = ?
           OR lr.property_id = ?
           OR (lr.organization_id IS NOT NULL AND lr.organization_id = ?))
    -- 房東在管理頁拖出來的順序是 sort_order,不是 id。用 id 排的話房東調完順序
    -- 頁面上動了、Agent 讀到的還是舊順序,而規則之間有先後(「先問我」擺前面)。
    -- 排序鍵跟 v2LandlordRuleRepositoryAsync 同一套,兩邊看到的必須一樣。
    ORDER BY lr.sort_order ASC, lr.created_at ASC, lr.id ASC
  `, [scope.rental_unit_id, scope.property_id, scope.organization_id ?? null]);

  // 房東針對**這一筆** inquiry 的回答。reuse_approved 在這裡不是過濾條件:
  // 個別例外對當事房客當然可見,它只是不能被別人沿用。要被別人沿用必須先走
  // 核准流程變成 approved_qa knowledge,那條路在上面那段查詢。
  const inquiryAnswers = await db.all(`
    SELECT la.public_id, la.answer_text, la.reuse_approved,
           lq.public_id AS question_public_id, lq.question_text
    FROM landlord_answers la
    JOIN landlord_questions lq ON lq.id = la.landlord_question_id
    WHERE lq.inquiry_id = ?
      AND la.visibility = 'public'
      AND (? IS NULL OR la.answer_text LIKE ? OR lq.question_text LIKE ?)
    ORDER BY la.id
  `, [scope.inquiry_id, term, term, term]);

  const snapshot = await loadListingSnapshot(db, scope.latest_valid_snapshot_id);

  return {
    // 每一筆都帶來源與版本,讓 proposed_action.grounding_refs 有東西可指。
    listingFacts: snapshot ? [snapshot] : [],
    knowledge: knowledge.map((row) => ({
      sourceType: 'knowledge_version',
      knowledgeType: row.knowledge_type,
      publicId: row.public_id,
      versionNumber: row.version_number,
      topicText: row.topic_text,
      contentText: row.content_text,
      usePolicy: row.use_policy
    })),
    publicRules: publicRules.map((row) => {
      const ruleValue = parseJsonOrNull(row.rule_value_json);
      return {
        sourceType: 'landlord_public_rule',
        publicId: row.public_id,
        ruleType: row.rule_type,
        ruleValue,
        // 正本是 knowledge_versions;沒有版本可查時才退回規則自己存的那份副本。
        usePolicy: row.use_policy || (ruleValue && ruleValue.usePolicy) || null
      };
    }),
    inquiryAnswers: inquiryAnswers.map((row) => ({
      sourceType: 'landlord_answer',
      publicId: row.public_id,
      questionPublicId: row.question_public_id,
      questionText: row.question_text,
      answerText: row.answer_text,
      // 讓模型知道這條不能拿去回答別人,但真正的隔離是上面的 inquiry_id 綁定。
      reusableForOtherTenants: Number(row.reuse_approved) === 1
    }))
  };
}

// --- 唯讀 tool:get_intention_diff --------------------------------------------

const DIFF_FIELDS = Object.freeze([
  ['rent_amount', 'rentAmount'],
  ['deposit_amount', 'depositAmount'],
  ['lease_start_date', 'leaseStartDate'],
  ['lease_end_date', 'leaseEndDate'],
  ['move_in_date', 'moveInDate'],
  ['pet_request_text', 'petRequestText'],
  ['equipment_request_text', 'equipmentRequestText'],
  ['viewing_request_text', 'viewingRequestText'],
  ['special_request_text', 'specialRequestText']
]);

async function getIntentionDiff(db, args = {}) {
  const fromPublicId = requireText(args.fromVersionPublicId, 'fromVersionPublicId');
  const toPublicId = requireText(args.toVersionPublicId, 'toVersionPublicId');

  // 兩個版本都必須是 actor 看得到的 exact version,而且屬於同一個意向。
  // 先授權 inquiry,再確認版本屬於它 —— 不是先撈版本再回頭找它是誰的。
  const scope = await requireAuthorizedInquiry(db, {
    actorUserId: args.actorUserId,
    inquiryPublicId: args.inquiryPublicId,
    now: args.now
  });

  const versions = await db.all(`
    SELECT iv.public_id, iv.version_number, iv.rent_amount, iv.deposit_amount,
           iv.lease_start_date, iv.lease_end_date, iv.move_in_date,
           iv.pet_request_text, iv.equipment_request_text,
           iv.viewing_request_text, iv.special_request_text
    FROM intention_versions iv
    JOIN rental_intentions ri ON ri.id = iv.rental_intention_id
    WHERE ri.inquiry_id = ?
      AND iv.public_id IN (?, ?)
    ORDER BY iv.version_number
  `, [scope.inquiry_id, fromPublicId, toPublicId]);

  const byPublicId = new Map(versions.map((version) => [version.public_id, version]));
  const from = byPublicId.get(fromPublicId);
  const to = byPublicId.get(toPublicId);
  if (!from || !to) {
    // 同一句話:不揭露某個版本是否存在,只說在這個詢問裡找不到。
    throw fail('這個房源詢問裡找不到指定的意向版本', 'authorization_denied', 403);
  }

  const changes = [];
  for (const [column, key] of DIFF_FIELDS) {
    if (from[column] !== to[column]) {
      changes.push({ field: key, from: from[column] ?? null, to: to[column] ?? null });
    }
  }

  return {
    fromVersionPublicId: fromPublicId,
    fromVersionNumber: from.version_number,
    toVersionPublicId: toPublicId,
    toVersionNumber: to.version_number,
    changes
  };
}

// --- 提案 tool:build_intention_candidate -------------------------------------

/**
 * 把模型擷取出來的欄位正規化成候選條件、矛盾與缺項。
 *
 * 純函式:沒有 DB、沒有網路、沒有副作用。回傳的是**候選**,不是已確認條件;
 * 房客明確確認 exact version 之前,它不能變成 submitted。
 *
 * 矛盾不自動裁決。同一個欄位收到兩個不同值時,兩個值都留在 conflicts 裡並把該欄位
 * 從候選中拿掉 —— spec Case L 明確要求「矛盾日期只澄清,不自行採最後一句」。
 */
function buildIntentionCandidate(args = {}) {
  const fields = Array.isArray(args.fields) ? args.fields : null;
  if (!fields) throw fail('fields 必須是陣列', 'invalid_model_output', 400);

  const seen = new Map();
  const conflicts = [];

  for (const entry of fields) {
    if (!entry || typeof entry !== 'object') {
      throw fail('fields 的每一項都必須是物件', 'invalid_model_output', 400);
    }
    const fieldPath = entry.fieldPath;
    if (!CANDIDATE_FIELD_PATHS.includes(fieldPath)) {
      // 模型不能靠發明欄位取得新能力(例如 landlord_floor_price)。
      throw fail(`未知的 fieldPath: ${JSON.stringify(fieldPath)}`, 'invalid_model_output', 400);
    }
    if (!CANDIDATE_SOURCE_TYPES.includes(entry.sourceType)) {
      throw fail(`未知的 sourceType: ${JSON.stringify(entry.sourceType)}`, 'invalid_model_output', 400);
    }
    if (entry.sourceId === null || entry.sourceId === undefined || entry.sourceId === '') {
      // 沒有來源就不是候選條件。這條擋住「模型自己補一個合理數字」。
      throw fail(`${fieldPath} 缺少 sourceId`, 'invalid_model_output', 400);
    }

    const normalized = {
      fieldPath,
      value: fieldPath === 'special_request_text' ? otherAgreements(entry.value).join('\n') : entry.value ?? null,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId
    };

    const previous = seen.get(fieldPath);
    if (!previous) {
      seen.set(fieldPath, { ...normalized, candidates: [normalized] });
      continue;
    }
    previous.candidates.push(normalized);
    if (canonicalJson(previous.value) !== canonicalJson(normalized.value)) {
      previous.conflicting = true;
    }
  }

  const candidate = {};
  const sources = {};
  for (const [fieldPath, entry] of seen) {
    if (entry.conflicting) {
      conflicts.push({
        fieldPath,
        values: entry.candidates.map((item) => ({
          value: item.value,
          sourceType: item.sourceType,
          sourceId: item.sourceId
        }))
      });
      continue;
    }
    candidate[fieldPath] = entry.value;
    sources[fieldPath] = entry.candidates.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId
    }));
  }

  const missingFields = REQUIRED_CANDIDATE_FIELDS
    .filter((fieldPath) => !(fieldPath in candidate));

  return {
    candidate,
    sources,
    conflicts,
    missingFields,
    // 有矛盾或有缺項就必須先問人。這個旗標對應 decision_classification 的
    // needs_clarification,不是「可以送出了」。
    requiresClarification: conflicts.length > 0 || missingFields.length > 0
  };
}

// --- 註冊表 ------------------------------------------------------------------

// summarize 只回**計數與角色**,不回內容。trace 是稽核資料,不是訊息備份。
const TOOLS = Object.freeze({
  get_inquiry_context: {
    kind: 'read_only',
    handler: (db, args) => getInquiryContext(db, args),
    summarize: (result) => ({
      role: result.role,
      contextVersion: result.contextVersion,
      versionCount: result.intention ? result.intention.versions.length : 0
    })
  },
  search_authorized_knowledge: {
    kind: 'read_only',
    handler: (db, args) => searchAuthorizedKnowledge(db, args),
    summarize: (result) => ({
      listingFacts: result.listingFacts.length,
      knowledge: result.knowledge.length,
      publicRules: result.publicRules.length,
      inquiryAnswers: result.inquiryAnswers.length
    })
  },
  get_intention_diff: {
    kind: 'read_only',
    handler: (db, args) => getIntentionDiff(db, args),
    summarize: (result) => ({ changeCount: result.changes.length })
  },
  build_intention_candidate: {
    kind: 'proposal',
    // 純函式,不吃 db。簽名保持一致讓註冊表可以統一呼叫。
    handler: (db, args) => buildIntentionCandidate(args),
    summarize: (result) => ({
      fieldCount: Object.keys(result.candidate).length,
      conflictCount: result.conflicts.length,
      missingFieldCount: result.missingFields.length
    })
  }
});

const AGENT_TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

/**
 * 模型呼叫工具的唯一入口。每一次呼叫都會在 agent_tool_executions 留一列,
 * 包含被拒絕的未知工具 —— 模型嘗試呼叫 sign_contract 這件事本身就必須看得見。
 */
async function callAgentTool(db, input = {}) {
  const executionPublicId = requireText(input.executionPublicId, 'executionPublicId');
  const requestedName = typeof input.toolName === 'string' ? input.toolName : '';

  // 模型給的名字是不可信輸入,會被寫進 trace 的 tool_name。先正規化再落地,
  // 否則等於把任意字串灌進稽核欄位。
  const tracedName = SAFE_TOOL_NAME.test(requestedName) ? requestedName : 'unknown_tool';
  const tool = Object.prototype.hasOwnProperty.call(TOOLS, requestedName) ? TOOLS[requestedName] : null;

  return runTracedTool(db, {
    executionPublicId,
    toolKind: 'model_tool',
    toolName: tracedName,
    args: input.args ?? null,
    summarize: (result) => tool.summarize(result)
  }, async () => {
    if (!tool) {
      throw fail(
        `未知的工具 ${JSON.stringify(requestedName).slice(0, 80)}`,
        'invalid_model_output',
        400
      );
    }
    return tool.handler(db, input.args ?? {});
  });
}

module.exports = {
  AGENT_TOOL_NAMES,
  CANDIDATE_FIELD_PATHS,
  CANDIDATE_SOURCE_TYPES,
  PROPOSAL_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  REQUIRED_CANDIDATE_FIELDS,
  buildIntentionCandidate,
  callAgentTool,
  contextVersionOf,
  getInquiryContext,
  getIntentionDiff,
  requireAuthorizedInquiry,
  searchAuthorizedKnowledge
};
