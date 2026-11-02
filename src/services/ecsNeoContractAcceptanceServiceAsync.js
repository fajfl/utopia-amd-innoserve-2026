// accept_intention_and_create_contract_draft:房東接受一個**精確**意向版本,
// 在同一個交易內完成成交鎖、決策、合約與草稿。
//
// Production authority 是 TiDB/MySQL,所以這裡只用 async sqlDriver 的
// get/all/run/transaction,SQL 一律可攜:沒有 SQLite 專屬函式、沒有 partial index
// 依賴、沒有 RETURNING、沒有 CTE。SQLite 只是跑不變量回歸的本機 adapter。
// 沒有同步版雙胞胎。
//
// 三件事刻意不在這裡做:
//   1. 交易內不呼叫模型、檔案或網路。草稿內容早就由 prepared artifact 準備好,
//      這個 command 只重算 checksum、確認綁定仍有效並固化。
//   2. 不發行、不簽署、不建立 signature_requests。草稿停在
//      contract_versions.status='draft',發行必須是另一個明確的 human POST action。
//   3. 不做 release/取消/重租的 lifecycle。V1 的 claim 只進不出。
//
// 錯誤 code(service 層,不是 agent_executions.error_category 的封閉集合):
//   invalid_input 400 / authorization_denied 403
//   stale_version、draft_review_required、invalid_prepared_draft、
//   prepared_draft_checksum_mismatch、prepared_draft_already_materialized、
//   template_version_inactive、rule_pack_version_inactive、unit_claim_conflict 409
//   internal_invariant_violation 500

const crypto = require('node:crypto');

// 接受的前置狀態。spec 的 state machine 是 submitted -> under_review -> accepted,
// 房東可以在房客送出後直接接受,不必等有人把它推到 under_review。
const ACCEPTABLE_INTENTION_STATUSES = ['submitted', 'under_review'];

// 落選 intention 的終止狀態集合,與 uq_rental_intentions_active_inquiry 的排除集合一致。
const TERMINAL_INTENTION_STATUSES = ['rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'];

// BIGINT 在 mysql2 可能回字串,在 SQLite 是 number。id 比對一律先正規化,
// 否則 exact-version 檢查會在雲端靜默判成不相符。
const sameId = (left, right) =>
  left !== null && left !== undefined &&
  right !== null && right !== undefined &&
  String(left) === String(right);

function fail(message, code, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// better-sqlite3 把約束種類寫進 code 的後綴。只認唯一鍵與主鍵這兩種:
// SQLITE_CONSTRAINT_FOREIGNKEY / _CHECK / _NOTNULL / _TRIGGER 都是別的 bug,
// 被誤標成「房源已被搶走」會讓真正的問題永遠找不到。
const SQLITE_DUPLICATE_CODES = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY'
]);

// production 是 TiDB/MySQL,本機是 SQLite,兩邊的重複鍵長相完全不同。
//
// 刻意**不**單獨採用 SQLSTATE 23000。它在 MySQL/TiDB 是「integrity constraint
// violation」的大類,外鍵失敗(errno 1452)同樣回 23000。只看 SQLSTATE 會把
// 「FK 指到不存在的列」這種寫錯的 bug 靜默回報成 unit_claim_conflict 409,
// 呼叫端還會以為是正常的併發落敗。重複鍵一定同時帶 ER_DUP_ENTRY / errno 1062。
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

// --- prepared artifact 的 checksum ------------------------------------------

// 穩定的正規化 JSON:物件鍵一律排序後序列化,所以「語意相同、鍵順序不同」會得到
// 同一個字串。這是 checksum 可重現的前提 —— 直接 hash 資料庫存回來的原始字串會
// 因為空白與鍵順序而在不同環境算出不同值。
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

// prepared_contract_drafts.payload_checksum 的**唯一**定義。
// migration 015 的檔頭列的就是這十個成員,兩邊必須一致。
//
// 用 intentionVersionPublicId 而不是數字 id:public_id 跨環境穩定,
// 本機與雲端的自增 id 不同但 artifact 應該算出同一個 checksum。
function preparedDraftChecksum({
  intentionVersionPublicId,
  templateManifestChecksum,
  rulePackChecksum,
  modelId,
  modelVersion,
  promptVersion,
  clauseSnapshot,
  responsibilityMatrix,
  issues,
  sourceMap
} = {}) {
  const tuple = {
    intentionVersionPublicId: intentionVersionPublicId ?? null,
    templateManifestChecksum: templateManifestChecksum ?? null,
    rulePackChecksum: rulePackChecksum ?? null,
    modelId: modelId ?? null,
    modelVersion: modelVersion ?? null,
    promptVersion: promptVersion ?? null,
    clauseSnapshot: clauseSnapshot ?? null,
    responsibilityMatrix: responsibilityMatrix ?? null,
    issues: issues ?? null,
    sourceMap: sourceMap ?? null
  };
  return crypto.createHash('sha256').update(canonicalJson(tuple), 'utf8').digest('hex');
}

// checksum 比對用固定時間比較。長度不同直接回 false —— timingSafeEqual 對長度不同的
// buffer 會丟 RangeError,那個例外本身就會洩漏長度資訊。
function checksumMatches(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// --- JSON payload 解析 -------------------------------------------------------

// JSON.parse 的 SyntaxError 沒有 code、沒有 statusCode,直接往上丟會變成一個看不出
// 原因的 500;壞掉的 artifact 是可預期的領域狀況,要有明確的 code 讓呼叫端回覆
// 「這份草稿要重新產生」。
function parseJsonValue(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const failure = fail(`${label} 不是合法 JSON`, 'invalid_prepared_draft', 409);
    failure.cause = error;
    throw failure;
  }
}

// clause snapshot 與 source map 都是「欄位 -> 值」的映射。拿到陣列或 null 代表產生端
// 寫錯結構,不能當成空物件默默放過。
function parseJsonObject(text, label) {
  const parsed = parseJsonValue(text, label);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail(`${label} 必須是物件`, 'invalid_prepared_draft', 409);
  }
  return parsed;
}

// 「有來源」不等於「鍵存在」。空陣列、空物件與空字串都代表產生端沒有真的追到來源,
// 放過去就會出現一個宣稱有 provenance、實際指不到任何東西的合約欄位。
function hasSourceEntry(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return false;
}

// --- 重送 --------------------------------------------------------------------

// 第一步只用 idempotency key 找 claim,不 join 任何東西。
// 舊寫法把整條鏈寫在一個 JOIN 裡,鏈結不完整時整個查詢回 undefined,程式就會
// 「找不到重送紀錄」而往下走去 INSERT,撞上唯一鍵之後被回報成併發衝突 ——
// 真正的半套資料就這樣被掩蓋掉。現在先確定 key 到底存不存在。
async function findClaimByIdempotencyKey(tx, idempotencyKey) {
  return tx.get(`
    SELECT id, public_id, rental_unit_id, rental_intention_id,
           intention_version_id, contract_id, claimed_by_user_id
    FROM rental_unit_contracting_claims
    WHERE idempotency_key = ?
  `, [idempotencyKey]);
}

// 第二步才把 claim 攤成可回傳的結果。
//
// prepared artifact **只能經由它固化出來的 contract version** 找回來
// (materialized_contract_version_id -> contract_versions.contract_id = claim.contract_id),
// 不能用「同一個 intention/version 的任何 artifact」去撈:同一個 exact version 可以
// 有多份 artifact(不同 template、rule pack 或 prompt version 各一份),用 intention
// 與 version 去 join 會挑到一份根本沒被接受的草稿。
// materialized_contract_version_id 有唯一索引,所以這條鏈只會對到一列。
async function resolveClaimChain(tx, claim) {
  if (claim.contract_id === null || claim.contract_id === undefined) return null;
  return tx.get(`
    SELECT c.public_id   AS contract_public_id,
           cv.public_id  AS version_public_id,
           pcd.public_id AS prepared_draft_public_id,
           iv.public_id  AS intention_version_public_id
    FROM contracts c
    JOIN contract_versions cv ON cv.contract_id = c.id
    JOIN prepared_contract_drafts pcd ON pcd.materialized_contract_version_id = cv.id
    JOIN intention_versions iv ON iv.id = ?
    WHERE c.id = ?
  `, [claim.intention_version_id, claim.contract_id]);
}

// 重送檢查本身就是一個授權決定,所以它綁三樣東西:
//   1. claim.claimed_by_user_id —— 只有當初那位房東能重送。別人一律 403,
//      而且在比對輸入之前就擋掉,不讓對方靠 error code 分辨自己猜對了哪個參數。
//   2. exact intentionVersionPublicId
//   3. exact preparedDraftPublicId
// 後兩者不符代表呼叫端拿著同一把 key 指向別的東西,回 stale_version,
// 絕不回傳既有結果。
function replayFor(claim, chain, { actorUserId, intentionVersionPublicId, preparedDraftPublicId }) {
  if (!sameId(claim.claimed_by_user_id, actorUserId)) {
    throw fail('無權讀取這筆接受結果', 'authorization_denied', 403);
  }
  if (chain.intention_version_public_id !== intentionVersionPublicId ||
      chain.prepared_draft_public_id !== preparedDraftPublicId) {
    throw fail('這個 idempotency key 對應的是另一個意向版本或草稿', 'stale_version');
  }
  return {
    replayed: true,
    claimPublicId: claim.public_id,
    contractPublicId: chain.contract_public_id,
    versionPublicId: chain.version_public_id,
    preparedDraftPublicId: chain.prepared_draft_public_id
  };
}

// --- 前置條件 ----------------------------------------------------------------

// actor 只從 line_identities 推導,並且必須是 active 的使用者。
// 呼叫端傳進來的是已驗證的 LINE 身分,不是 user id、party id 或 ownership ——
// 模型與前端都無權指定自己是誰。
// 停權/刪除的帳號不能簽下具法律效果的接受動作,所以 users.status 也要在同一句裡查。
async function requireActor(tx, lineUserId) {
  const row = await tx.get(`
    SELECT u.id AS user_id
    FROM line_identities li
    JOIN users u ON u.id = li.user_id
    WHERE li.line_user_id = ?
      AND u.status = 'active'
  `, [lineUserId]);
  if (!row) throw fail('LINE 身分不存在或已停用', 'authorization_denied', 403);
  return row.user_id;
}

// 一次讀齊 exact version 與它所屬的 intention / inquiry / listing / unit / property,
// 外加房客確認的版本指標。用 public_id 找 version,不用 rental_intention_id +
// 「最新版」:猜 latest 是 spec 明文禁止的。
async function requireExactVersion(tx, intentionVersionPublicId) {
  const row = await tx.get(`
    SELECT iv.id                AS intention_version_id,
           iv.rental_intention_id,
           ri.status            AS intention_status,
           ri.confirmed_intention_version_id,
           ri.inquiry_id,
           ri.listing_id,
           ri.tenant_user_id,
           inq.status           AS inquiry_status,
           l.rental_unit_id,
           ru.property_id
    FROM intention_versions iv
    JOIN rental_intentions ri ON ri.id = iv.rental_intention_id
    JOIN inquiries inq        ON inq.id = ri.inquiry_id
    JOIN listings l           ON l.id = ri.listing_id
    JOIN rental_units ru      ON ru.id = l.rental_unit_id
    WHERE iv.public_id = ?
  `, [intentionVersionPublicId]);
  if (!row) throw fail('意向版本不存在', 'authorization_denied', 403);
  return row;
}

// ownership 在交易內重查,不信任任何傳入值。property 層或 unit 層的授權都算。
//
// 唯讀查證雲端確認 property_owners.effective_from 是 VARCHAR(255)、
// effective_until 是 LONGTEXT,兩者都是字串,所以字串比較是與實際雲端相容的做法。
//
// 兩個邊界用**不同粒度**的基準值,讓純日期與同一天的 DATETIME/ISO 字串都算包含:
//   effective_from  <= asOfEndOfDay ('YYYY-MM-DDT23:59:59.999Z')
//     '2026-08-24'                 <= ...T23:59:59.999Z  -> 前綴相同、較短者小 -> true
//     '2026-08-24 10:00:00'        <= ...T23:59:59.999Z  -> ' '(0x20) < 'T'(0x54) -> true
//     '2026-08-24T10:00:00.000Z'   <= ...T23:59:59.999Z  -> 'T1' < 'T2' -> true
//   effective_until >= asOfDate ('YYYY-MM-DD')
//     '2026-08-24'                 >= '2026-08-24'       -> true(最後一天仍有效)
//     '2026-08-24 18:00:00'        >= '2026-08-24'       -> 前綴相同、較長者大 -> true
//
// 全部是字串比較,沒有用 date()/CURDATE():前者是 SQLite 專屬,後者在 SQLite 會
// 靜默回 NULL,兩個都不可攜。
async function requireEffectiveOwner(tx, { actorUserId, propertyId, rentalUnitId, asOfDate, asOfEndOfDay }) {
  const row = await tx.get(`
    SELECT 1 AS ok
    FROM property_owners po
    WHERE po.owner_user_id = ?
      AND po.property_id = ?
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ?)
      AND po.effective_from <= ?
      AND (po.effective_until IS NULL OR po.effective_until >= ?)
  `, [actorUserId, propertyId, rentalUnitId, asOfEndOfDay, asOfDate]);
  if (!row) throw fail('不是這個房源的房東', 'authorization_denied', 403);
}

// prepared artifact 必須精確對應這一個 version、已通過 deterministic validation,
// 而且**在接受的這一刻**綁定仍然有效:checksum 重算相符、範本與 rule pack 仍是 active。
//
// 整段刻意排在 claim insert **之前**。壞掉或過期的 artifact 不該先搶下成交鎖再失敗,
// 那會讓這個單位在交易回滾前擋住其他合法的房東。
async function requireAcceptableDraft(tx, { preparedDraftPublicId, version }) {
  const draft = await tx.get(`
    SELECT pcd.id, pcd.public_id, pcd.rental_intention_id, pcd.intention_version_id,
           pcd.model_id, pcd.model_version, pcd.prompt_version,
           pcd.clause_snapshot_json, pcd.responsibility_matrix_json,
           pcd.issues_json, pcd.source_map_json, pcd.payload_checksum,
           pcd.status, pcd.blocking_issue_count, pcd.materialized_contract_version_id,
           iv.public_id  AS intention_version_public_id,
           ctv.status    AS template_status,
           ctv.manifest_checksum, ctv.manifest_json, ctv.public_id AS template_public_id,
           ctv.source_checksum AS template_source_checksum,
           lrpv.status   AS rule_pack_status,
           lrpv.rules_checksum, lrpv.rules_json, lrpv.public_id AS rules_public_id
    FROM prepared_contract_drafts pcd
    JOIN intention_versions iv ON iv.id = pcd.intention_version_id
    JOIN contract_template_versions ctv ON ctv.id = pcd.contract_template_version_id
    JOIN legal_rule_pack_versions lrpv ON lrpv.id = pcd.legal_rule_pack_version_id
    WHERE pcd.public_id = ?
  `, [preparedDraftPublicId]);
  if (!draft) throw fail('草稿 artifact 不存在', 'authorization_denied', 403);

  if (!sameId(draft.intention_version_id, version.intention_version_id) ||
      !sameId(draft.rental_intention_id, version.rental_intention_id)) {
    throw fail('草稿 artifact 不屬於這個意向版本', 'stale_version');
  }
  if (draft.status !== 'ready' || Number(draft.blocking_issue_count) !== 0) {
    throw fail('草稿 artifact 尚未通過審閱', 'draft_review_required');
  }
  if (draft.materialized_contract_version_id !== null &&
      draft.materialized_contract_version_id !== undefined) {
    throw fail('草稿 artifact 已經被固化過', 'prepared_draft_already_materialized');
  }

  const clauseSnapshot = parseJsonObject(draft.clause_snapshot_json, 'clause_snapshot_json');
  const sourceMap = parseJsonObject(draft.source_map_json, 'source_map_json');
  const responsibilityMatrix = parseJsonValue(draft.responsibility_matrix_json, 'responsibility_matrix_json');
  const issues = parseJsonValue(draft.issues_json, 'issues_json');

  // 接受時重算。artifact 產生後到現在之間,任何人繞過應用層改了內容都會在這裡露出來。
  const recomputed = preparedDraftChecksum({
    intentionVersionPublicId: draft.intention_version_public_id,
    templateManifestChecksum: draft.manifest_checksum,
    rulePackChecksum: draft.rules_checksum,
    modelId: draft.model_id,
    modelVersion: draft.model_version,
    promptVersion: draft.prompt_version,
    clauseSnapshot,
    responsibilityMatrix,
    issues,
    sourceMap
  });
  if (!checksumMatches(draft.payload_checksum, recomputed)) {
    throw fail('草稿 artifact 的 checksum 與內容不符', 'prepared_draft_checksum_mismatch');
  }

  // 綁定的範本與 rule pack 必須此刻仍然有效。用一份已被取代的範本或已失效的
  // 應記載事項固化合約,等於簽出一份不合現行法規的契約。
  if (draft.template_status !== 'active') {
    throw fail('契約範本版本已不是 active', 'template_version_inactive');
  }
  if (draft.rule_pack_status !== 'active') {
    throw fail('法規 rule pack 版本已不是 active', 'rule_pack_version_inactive');
  }

  const clauseFields = Object.keys(clauseSnapshot);
  // 沒有欄位就沒有可追溯的條件。這裡沒有粗粒度 fallback 列,所以零欄位等於
  // 產生一份完全沒有 provenance 的合約版本,必須擋下來。
  if (clauseFields.length === 0) {
    throw fail('草稿 artifact 沒有任何條件欄位', 'invalid_prepared_draft');
  }
  const missing = clauseFields.filter((field) => !hasSourceEntry(sourceMap[field]));
  if (missing.length > 0) {
    throw fail(`草稿 artifact 缺少來源對照:${missing.join(', ')}`, 'invalid_prepared_draft');
  }

  return { ...draft, clauseFields };
}

// --- 狀態轉移 ----------------------------------------------------------------

async function recordIntentionStatus(tx, { intentionId, fromStatus, toStatus, actorUserId, reason }) {
  await tx.run(
    'UPDATE rental_intentions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [toStatus, intentionId]
  );
  await tx.run(`
    INSERT INTO intention_status_history
      (rental_intention_id, from_status, to_status, actor_user_id, reason)
    VALUES (?, ?, ?, ?, ?)
  `, [intentionId, fromStatus, toStatus, actorUserId, reason]);
}

async function recordInquiryStatus(tx, { inquiryId, fromStatus, toStatus, actorUserId, reason }) {
  await tx.run(`
    UPDATE inquiries
    SET status = ?, last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [toStatus, inquiryId]);
  await tx.run(`
    INSERT INTO inquiry_status_history
      (inquiry_id, from_status, to_status, actor_user_id, reason)
    VALUES (?, ?, ?, ?, ?)
  `, [inquiryId, fromStatus, toStatus, actorUserId, reason]);
}

// outbox:通知在主交易內建立,commit 之後才由 dispatcher 真的發送。
// 這裡不碰 LINE API —— 交易內發推播會讓推播失敗回滾已成立的合約。
async function enqueueDraftNotification(tx, {
  contractVersionId, contractPublicId, versionPublicId, preparedDraftPublicId,
  tenantUserId, landlordUserId, idempotencyKey
}) {
  const result = await tx.run(`
    INSERT INTO notifications
      (public_id, event_type, entity_type, entity_id, template_code, payload_json)
    VALUES (?, 'contract_draft_created', 'contract_version', ?, 'contract_draft_created', ?)
  `, [
    `notification-${crypto.randomUUID()}`,
    String(contractVersionId),
    JSON.stringify({ contractPublicId, versionPublicId, preparedDraftPublicId })
  ]);
  const notificationId = result.insertId;

  const identities = await tx.all(
    'SELECT id, user_id FROM line_identities WHERE user_id = ? OR user_id = ?',
    [tenantUserId, landlordUserId]
  );
  const identityFor = (userId) => {
    const match = identities.find((row) => sameId(row.user_id, userId));
    return match ? match.id : null;
  };

  for (const recipient of [
    { role: 'tenant', userId: tenantUserId },
    { role: 'landlord', userId: landlordUserId }
  ]) {
    await tx.run(`
      INSERT INTO notification_deliveries
        (public_id, notification_id, recipient_user_id, recipient_line_identity_id,
         channel, idempotency_key, status)
      VALUES (?, ?, ?, ?, 'line', ?, 'pending')
    `, [
      `delivery-${crypto.randomUUID()}`,
      notificationId,
      recipient.userId,
      identityFor(recipient.userId),
      `${idempotencyKey}:${recipient.role}`
    ]);
  }
}

// --- command -----------------------------------------------------------------

async function acceptIntentionAndCreateContractDraft(input = {}) {
  const { db } = input;
  if (!db || typeof db.transaction !== 'function') {
    throw fail('db driver is required', 'invalid_input', 400);
  }
  const lineUserId = requireText(input.lineUserId, 'lineUserId');
  const intentionVersionPublicId = requireText(input.intentionVersionPublicId, 'intentionVersionPublicId');
  const preparedDraftPublicId = requireText(input.preparedDraftPublicId, 'preparedDraftPublicId');
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');

  // property_owners 的 effective_* 是字串日期(雲端分別是 VARCHAR(255) 與 LONGTEXT)。
  // 兩個邊界各用一個基準值,兩端都保持包含 —— 細節見 requireEffectiveOwner。
  const asOfDate = new Date().toISOString().slice(0, 10);
  const asOfEndOfDay = `${asOfDate}T23:59:59.999Z`;

  const replayBinding = { intentionVersionPublicId, preparedDraftPublicId };

  return db.transaction(async (tx) => {
    // actor 先解析,再查重送。順序不能顛倒:重送檢查要回傳合約 id,那本身就是
    // 一個授權決定,不能在還不知道呼叫者是誰的情況下就把結果交出去。
    const actorUserId = await requireActor(tx, lineUserId);

    const existingClaim = await findClaimByIdempotencyKey(tx, idempotencyKey);
    if (existingClaim) {
      const chain = await resolveClaimChain(tx, existingClaim);
      if (!chain) {
        // key 已經被佔用,但接受的產物不完整。正常路徑不可能 commit 成這樣
        // (claim、contract、version、artifact 全在一個交易裡)。
        // 這時候**不能**往下走去 INSERT:那會撞唯一鍵,然後被回報成
        // unit_claim_conflict,把資料損毀偽裝成正常的併發落敗。
        throw fail(
          `idempotency key ${idempotencyKey} 的接受結果不完整,需要人工檢查`,
          'internal_invariant_violation',
          500
        );
      }
      return replayFor(existingClaim, chain, { actorUserId, ...replayBinding });
    }

    const version = await requireExactVersion(tx, intentionVersionPublicId);

    await requireEffectiveOwner(tx, {
      actorUserId,
      propertyId: version.property_id,
      rentalUnitId: version.rental_unit_id,
      asOfDate,
      asOfEndOfDay
    });

    if (!ACCEPTABLE_INTENTION_STATUSES.includes(version.intention_status)) {
      throw fail('意向狀態不允許接受', 'stale_version');
    }

    // 只能接受**房客確認過的那一個**版本。少了這一關,房東可以接受同一筆意向的
    // 任何歷史版本(例如房客還沒同意的那份降租版),而房客從未同意過那些條件。
    if (!sameId(version.confirmed_intention_version_id, version.intention_version_id)) {
      throw fail('這不是房客確認的意向版本', 'stale_version');
    }

    const draft = await requireAcceptableDraft(tx, { preparedDraftPublicId, version });

    // 成交鎖盡早下手:rental_unit_id 的全域唯一鍵。落敗者在這一行就撞唯一約束,
    // 不會白做後面的合約與草稿。V1 沒有 release。
    //
    // try/catch 只包這一句。範圍再大一點,後面任何一處寫錯造成的唯一鍵衝突
    // 都會被貼上 unit_claim_conflict,呼叫端會把自己的 bug 當成正常的併發落敗。
    // 這裡不重試:單位已經被別人成交,重跑一百次結果一樣。
    const claimPublicId = `claim-${crypto.randomUUID()}`;
    try {
      await tx.run(`
        INSERT INTO rental_unit_contracting_claims
          (public_id, rental_unit_id, rental_intention_id, intention_version_id,
           claimed_by_user_id, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        claimPublicId,
        version.rental_unit_id,
        version.rental_intention_id,
        version.intention_version_id,
        actorUserId,
        idempotencyKey
      ]);
    } catch (error) {
      // 非唯一鍵的資料庫錯誤原樣往上丟,不吞。
      if (!isDuplicateKeyError(error)) throw error;

      // 撞到的可能是 rental_unit_id(別人搶先成交),也可能是 idempotency_key
      // (同一個 event 的兩份請求幾乎同時進來,對方在我們查完重送之後才 commit)。
      // 後者是重送而不是衝突,所以重讀一次這把 key 再決定。
      const raced = await findClaimByIdempotencyKey(tx, idempotencyKey);
      if (raced && sameId(raced.claimed_by_user_id, actorUserId) &&
          sameId(raced.intention_version_id, version.intention_version_id)) {
        const chain = await resolveClaimChain(tx, raced);
        if (chain && chain.prepared_draft_public_id === preparedDraftPublicId) {
          return replayFor(raced, chain, { actorUserId, ...replayBinding });
        }
      }
      // 交易由 driver 的 transaction() 回滾,所以不會留下半套接受結果。
      const conflict = fail('這個出租單位已經進入簽約', 'unit_claim_conflict', 409);
      conflict.cause = error;
      throw conflict;
    }

    // accepted 決策綁的是 exact version,不是 intention。
    await tx.run(`
      INSERT INTO intention_decisions
        (public_id, rental_intention_id, intention_version_id, decision,
         decided_by_user_id, reason, idempotency_key)
      VALUES (?, ?, ?, 'accepted', ?, ?, ?)
    `, [
      `decision-${crypto.randomUUID()}`,
      version.rental_intention_id,
      version.intention_version_id,
      actorUserId,
      '房東接受承租條件',
      idempotencyKey
    ]);

    // accepted 只存在於這個交易與 status history;交易外可見的最終狀態是 contracting。
    // 兩列 history 都要寫,否則稽核看不出接受這件事發生過。
    await recordIntentionStatus(tx, {
      intentionId: version.rental_intention_id,
      fromStatus: version.intention_status,
      toStatus: 'accepted',
      actorUserId,
      reason: '房東接受精確意向版本'
    });
    await recordIntentionStatus(tx, {
      intentionId: version.rental_intention_id,
      fromStatus: 'accepted',
      toStatus: 'contracting',
      actorUserId,
      reason: '成交鎖建立,進入簽約'
    });

    const contractPublicId = `contract-${crypto.randomUUID()}`;
    const contractResult = await tx.run(`
      INSERT INTO contracts
        (public_id, rental_unit_id, selected_intention_id, source_inquiry_id, status)
      VALUES (?, ?, ?, ?, 'drafting')
    `, [contractPublicId, version.rental_unit_id, version.rental_intention_id, version.inquiry_id]);
    const contractId = contractResult.insertId;

    // claim.contract_id 在 commit 前回填。交易外看不到 NULL 的中間狀態。
    await tx.run(
      'UPDATE rental_unit_contracting_claims SET contract_id = ? WHERE public_id = ?',
      [contractId, claimPublicId]
    );

    await tx.run(`
      INSERT INTO contract_status_history
        (contract_id, from_status, to_status, actor_user_id, reason)
      VALUES (?, NULL, 'drafting', ?, ?)
    `, [contractId, actorUserId, '接受意向後建立草稿']);

    // 當事人來自既有關係:房客是 intention 的 tenant,房東是通過 ownership 檢查的 actor。
    // 兩者都不是由呼叫端或模型指定的任意 user id。
    for (const party of [
      { role: 'tenant', userId: version.tenant_user_id, order: 1 },
      { role: 'landlord', userId: actorUserId, order: 2 }
    ]) {
      await tx.run(`
        INSERT INTO contract_parties
          (public_id, contract_id, user_id, party_role, required_signer, signing_order, status)
        VALUES (?, ?, ?, ?, 1, ?, 'active')
      `, [`party-${crypto.randomUUID()}`, contractId, party.userId, party.role, party.order]);
    }

    // 草稿版本直接沿用 prepared artifact 的 clause snapshot,不重新產生內容。
    // status 停在 'draft':這裡不發行、不建立 signature_requests。
    const versionPublicId = `contract-version-${crypto.randomUUID()}`;
    const versionResult = await tx.run(`
      INSERT INTO contract_versions
        (public_id, contract_id, version_number, condition_snapshot_json, status, created_by_user_id)
      VALUES (?, ?, 1, ?, 'draft', ?)
    `, [versionPublicId, contractId, JSON.stringify(contractConditionSnapshot(draft)), actorUserId]);
    const contractVersionId = versionResult.insertId;

    // 逐欄 provenance,沒有粗粒度 fallback 列。每一列都指向**這一個**被接受的
    // exact intention version,維持兩跳的追溯鏈:
    //   合約欄位 -> exact intention version -> 原始 message / knowledge / 房東回答
    // (第二跳由 intention_version_sources 保存,不在這裡重複。)
    for (const fieldPath of draft.clauseFields) {
      await tx.run(`
        INSERT INTO contract_version_sources
          (contract_version_id, field_path, source_type, source_id)
        VALUES (?, ?, 'intention_version', ?)
      `, [contractVersionId, fieldPath, version.intention_version_id]);
    }

    // artifact 與它固化出來的版本互相指認。這是 artifact 唯一允許事後寫入的欄位。
    await tx.run(
      'UPDATE prepared_contract_drafts SET materialized_contract_version_id = ? WHERE id = ?',
      [contractVersionId, draft.id]
    );

    await recordInquiryStatus(tx, {
      inquiryId: version.inquiry_id,
      fromStatus: version.inquiry_status,
      toStatus: 'contracting',
      actorUserId,
      reason: '房東接受意向,進入簽約'
    });

    // 排他成交:同一個 unit 其他還沒終止的 intention 一併結束,不留下第二條簽約路徑。
    //
    // 只動 intention,**不動 inquiry**。詢問是房客與房東的對話,不是成交路徑;
    // 房客可能改看同一房東的其他房源,或想問退租後何時再開放。
    // 系統替他把對話關掉是越權,而且 inquiry 一旦 ended 就得靠新 inquiry 才能再聊。
    const losing = await tx.all(`
      SELECT ri.id     AS rental_intention_id,
             ri.status AS intention_status
      FROM rental_intentions ri
      JOIN listings l ON l.id = ri.listing_id
      WHERE l.rental_unit_id = ?
        AND ri.id <> ?
        AND ri.status NOT IN (${TERMINAL_INTENTION_STATUSES.map(() => '?').join(',')})
    `, [version.rental_unit_id, version.rental_intention_id, ...TERMINAL_INTENTION_STATUSES]);

    for (const other of losing) {
      await recordIntentionStatus(tx, {
        intentionId: other.rental_intention_id,
        fromStatus: other.intention_status,
        toStatus: 'leased_to_another_tenant',
        actorUserId,
        reason: '此出租單位已由其他房客成交'
      });
    }

    await enqueueDraftNotification(tx, {
      contractVersionId,
      contractPublicId,
      versionPublicId,
      preparedDraftPublicId: draft.public_id,
      tenantUserId: version.tenant_user_id,
      landlordUserId: actorUserId,
      idempotencyKey
    });

    return {
      replayed: false,
      claimPublicId,
      contractPublicId,
      versionPublicId,
      preparedDraftPublicId: draft.public_id
    };
  });
}

function contractConditionSnapshot(draft) {
  const clauses = parseJsonObject(draft.clause_snapshot_json, 'clause_snapshot_json');
  const manifest = parseJsonObject(draft.manifest_json, 'manifest_json');
  if (manifest.sourceVerification !== 'official_source_verified') return clauses;
  const digest = crypto.createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
  const rules = parseJsonObject(draft.rules_json, 'rules_json');
  const ruleDigest = crypto.createHash('sha256').update(canonicalJson(rules), 'utf8').digest('hex');
  if (digest !== draft.manifest_checksum || manifest.sourceChecksum !== draft.template_source_checksum
      || manifest.coverage !== 'complete_source_text' || !manifest.fullText || !manifest.contractText
      || !manifest.clauses?.length || !manifest.annexes?.length
      || ruleDigest !== draft.rules_checksum || rules.sourceVerification !== 'official_source_verified' || !rules.fullText) {
    throw fail('官方契約範本全文或來源驗證不完整', 'invalid_prepared_draft');
  }
  return { ...clauses, __contractTemplate: {
    versionPublicId: draft.template_public_id, manifestChecksum: draft.manifest_checksum, manifest,
    rulePack: { versionPublicId: draft.rules_public_id, checksum: draft.rules_checksum, manifest: rules,
      sourceChecksum: rules.sourceChecksum, fullText: rules.fullText,
      coverage: rules.coverage, coverageNote: rules.coverageNote }
  } };
}

module.exports = {
  contractConditionSnapshot,
  acceptIntentionAndCreateContractDraft,
  canonicalJson,
  preparedDraftChecksum
};
