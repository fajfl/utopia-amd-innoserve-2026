// save_intention_version / submit_confirmed_intention:把 AI 整理出來的承租條件
// 存成**不可變**的 intention version,並讓房客確認其中一個**精確**版本。
//
// 這一支補上的是 spec 主線裡「整理與協商承租條件 -> 房客確認 exact intention
// version」這一段。下游 ecsNeoContractAcceptanceServiceAsync 只接受
// rental_intentions.confirmed_intention_version_id 指到的那一個版本,所以這裡
// 寫進去的東西必須餵得進它:condition_json 全文、可對應的結構化欄位,加上
// intention_version_sources 的逐欄來源。
//
// production authority 是 TiDB/MySQL,所以只用 async driver 的 get/all/run/
// transaction,SQL 一律可攜:沒有 SQLite 專屬函式、沒有 RETURNING、沒有 CTE、
// 沒有 partial index 依賴。自增 id 一律用 public_id 回查,不拿 insertId ——
// TiDB 的 AUTO_INCREMENT 是分段配發的。
//
// 三件事刻意不在這裡做:
//   1. **模型呼叫不進交易。** extractAndSaveIntentionVersion 先在交易外把
//      condition_json 產生完、來源判定完,交易內只做驗證與固化。
//   2. 不修改任何既有 intention version。每次抽取都是新的 version_number,
//      舊版本連 condition_json 都不碰。
//   3. 不替房客確認、不替房東接受、不建立合約與 signature request。
//
// 錯誤 code(service 層):
//   invalid_input 400 / authorization_denied 403
//   no_active_inquiry、intention_frozen、missing_provenance、stale_version、
//   already_confirmed 409
//   extraction_failed 502

const crypto = require('node:crypto');
const { otherAgreements } = require('./ecsNeoOtherAgreements');

const { normalizeConditionJson } = require('./conditionJsonService');
const { resolveConditionProvenance, rocDateToIso } = require('./ecsNeoConditionProvenanceService');

// 已經進入簽約或已終止的意向不再產生新版本。confirmed 之後仍可再整理(房東要求
// 修改就是這條路),但 accepted/contracting 之後條件已凍結。
const FROZEN_INTENTION_STATUSES = [
  'accepted', 'contracting', 'rejected', 'withdrawn', 'leased_to_another_tenant', 'ended'
];
const CONFIRMABLE_INTENTION_STATUSES = ['draft', 'submitted', 'under_review'];

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

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw fail(`${name} is required`, 'invalid_input', 400);
  }
  return value;
}

function requireDriver(db) {
  if (!db || typeof db.transaction !== 'function') {
    throw fail('db driver is required', 'invalid_input', 400);
  }
  return db;
}

function integerOrNull(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

/**
 * condition_json 投影成 intention_versions 的結構化欄位。
 *
 * 只投影有**明確對應**的欄位。equipment_request_text 與
 * viewing_request_text 一律 null:condition_json 沒有語意等價的欄位,硬湊就是
 * 在合約條件裡塞一個沒人講過的值。全文仍完整保存在 condition_json。
 */
function mapStructuredColumns(conditionJson) {
  const leaseTerm = conditionJson.lease_term || {};
  let leaseStart = rocDateToIso(leaseTerm.start_date_roc);
  let leaseEnd = rocDateToIso(leaseTerm.end_date_roc);
  // intention_versions 有 lease_end_date >= lease_start_date 的 CHECK。日期顛倒是
  // 已經被 detectConflicts 抓到的矛盾,這裡若照寫會讓整筆 INSERT 被資料庫擋掉,
  // 連「有一份待人工釐清的候選」都留不下來。所以結構化欄位留空,原文留在
  // condition_json 等房客釐清。
  if (leaseStart && leaseEnd && leaseEnd < leaseStart) {
    leaseStart = null;
    leaseEnd = null;
  }

  const petAllowed = (conditionJson.use_restrictions || {}).pet_allowed;
  const specialTerms = Array.isArray(conditionJson.special_terms) ? conditionJson.special_terms : [];

  return {
    rent_amount: integerOrNull((conditionJson.rent || {}).monthly_rent_ntd),
    deposit_amount: integerOrNull((conditionJson.deposit || {}).deposit_amount_ntd),
    lease_start_date: leaseStart,
    lease_end_date: leaseEnd,
    move_in_date: rocDateToIso((conditionJson.move_in || {}).date_roc),
    pet_request_text: petAllowed === null || petAllowed === undefined
      ? null
      : (petAllowed ? '可養寵物' : '不可養寵物'),
    equipment_request_text: null,
    viewing_request_text: null,
    special_request_text: specialTerms.length ? specialTerms.join('\n') : null
  };
}

// --- 唯讀:協商脈絡 ----------------------------------------------------------

/**
 * 讀出這位 LINE 使用者目前活躍的詢問脈絡。
 *
 * 不猜、不自動綁最新詢問:沒有 active context 就回 null,由呼叫端要求使用者
 * 先選房源。同一房客同時問多間房時,猜錯就是把 A 房的條件寫到 B 房。
 */
async function loadNegotiationContext({ db, lineUserId }) {
  requireDriver(db);
  requireText(lineUserId, 'lineUserId');

  const identity = await db.get(`
    SELECT li.id AS line_identity_id, li.user_id
    FROM line_identities li
    JOIN users u ON u.id = li.user_id
    WHERE li.line_user_id = ?
      AND u.status = 'active'
  `, [lineUserId]);
  if (!identity) return null;

  const context = await db.get(`
    SELECT aic.inquiry_id
    FROM active_inquiry_contexts aic
    WHERE aic.line_identity_id = ?
      AND aic.cleared_at IS NULL
    ORDER BY aic.id DESC
    LIMIT 1
  `, [identity.line_identity_id]);
  if (!context) return { lineIdentityId: identity.line_identity_id, userId: identity.user_id, inquiry: null };

  const inquiry = await db.get(`
    SELECT i.id, i.public_id, i.status, i.listing_id, i.user_id,
           l.title AS listing_title
    FROM inquiries i
    JOIN listings l ON l.id = i.listing_id
    WHERE i.id = ?
      AND i.ended_at IS NULL
  `, [context.inquiry_id]);
  if (!inquiry) return { lineIdentityId: identity.line_identity_id, userId: identity.user_id, inquiry: null };

  // 只讀這位房客自己的詢問。別人的詢問就算 id 猜對也不能讀。
  if (!sameId(inquiry.user_id, identity.user_id)) {
    return { lineIdentityId: identity.line_identity_id, userId: identity.user_id, inquiry: null };
  }

  // 只讀**這一筆詢問**的訊息。跨詢問撈訊息會把別的房源、甚至別的房東的內容
  // 餵進模型與條件裡。
  const messages = await db.all(`
    SELECT id, text_content
    FROM messages
    WHERE inquiry_id = ?
      AND message_type = 'text'
      AND text_content IS NOT NULL
    ORDER BY sent_at ASC, id ASC
  `, [inquiry.id]);

  // 房源快照只取公開事實。房東 internal rule 不在這裡,也不會進 prompt。
  const listingSnapshot = await db.get(`
    SELECT ls.id, ls.normalized_title, ls.normalized_address, ls.rent_amount,
           ls.deposit_amount, ls.management_fee_amount, ls.pet_policy_text
    FROM listings l
    JOIN listing_snapshots ls ON ls.id = l.latest_valid_snapshot_id
    WHERE l.id = ?
  `, [inquiry.listing_id]);

  const intention = await db.get(`
    SELECT ri.id, ri.public_id, ri.status, ri.confirmed_intention_version_id
    FROM rental_intentions ri
    WHERE ri.inquiry_id = ?
      AND ri.ended_at IS NULL
      AND ri.status NOT IN ('rejected', 'withdrawn', 'leased_to_another_tenant', 'ended')
    ORDER BY ri.id DESC
    LIMIT 1
  `, [inquiry.id]);

  return {
    lineIdentityId: identity.line_identity_id,
    userId: identity.user_id,
    inquiry: {
      id: inquiry.id,
      publicId: inquiry.public_id,
      status: inquiry.status,
      listingId: inquiry.listing_id,
      listingTitle: inquiry.listing_title
    },
    messages: messages.map((row) => ({ id: row.id, text: row.text_content })),
    listingSnapshot: listingSnapshot || null,
    intention: intention || null
  };
}

/**
 * 餵給抽取器的 context。只有這一筆詢問的訊息與該房源的公開快照。
 * 房東 internal rule、其他房客的條件、未核准的 reusable answer 一律不進來。
 */
function buildExtractionContext({ inquiry, messages = [], listingSnapshot = null }) {
  return {
    line_messages: messages.map((message) => ({ id: message.id, text: message.text })),
    rental_listings: listingSnapshot
      ? [{
        title: listingSnapshot.normalized_title || (inquiry && inquiry.listingTitle) || null,
        address: listingSnapshot.normalized_address || null,
        rent_amount: listingSnapshot.rent_amount ?? null,
        deposit_amount: listingSnapshot.deposit_amount ?? null,
        management_fee_amount: listingSnapshot.management_fee_amount ?? null,
        pet_policy_text: listingSnapshot.pet_policy_text || null
      }]
      : []
  };
}

// --- 寫入:新增不可變版本 ----------------------------------------------------

async function ensureIntention(tx, { inquiryId, listingId, tenantUserId, actorUserId }) {
  const existing = await tx.get(`
    SELECT id, public_id, status, confirmed_intention_version_id
    FROM rental_intentions
    WHERE inquiry_id = ?
      AND ended_at IS NULL
      AND status NOT IN ('rejected', 'withdrawn', 'leased_to_another_tenant', 'ended')
    ORDER BY id DESC
    LIMIT 1
  `, [inquiryId]);
  if (existing) return existing;

  const publicId = `intention-${crypto.randomUUID()}`;
  await tx.run(`
    INSERT INTO rental_intentions (public_id, inquiry_id, listing_id, tenant_user_id, status)
    VALUES (?, ?, ?, ?, 'draft')
  `, [publicId, inquiryId, listingId, tenantUserId]);
  const created = await tx.get(`
    SELECT id, public_id, status, confirmed_intention_version_id
    FROM rental_intentions WHERE public_id = ?
  `, [publicId]);
  await tx.run(`
    INSERT INTO intention_status_history
      (rental_intention_id, from_status, to_status, actor_user_id, reason)
    VALUES (?, NULL, 'draft', ?, ?)
  `, [created.id, actorUserId, 'AI 整理承租條件候選,建立意向草稿']);
  return created;
}

/**
 * 建立一個新的不可變 intention version。
 *
 * fields 是 resolveConditionProvenance 的輸出:每一項都必須已經有來源。
 * 少了來源就整批拒絕,不寫半套 —— 全部在同一個交易裡。
 */
async function saveIntentionVersion({
  db, inquiryId, listingId, tenantUserId, actorUserId, conditionJson, fields = []
}) {
  requireDriver(db);
  if (!conditionJson || typeof conditionJson !== 'object') {
    throw fail('conditionJson is required', 'invalid_input', 400);
  }

  const missingProvenance = fields.filter((field) => !field.sources || field.sources.length === 0);
  if (missingProvenance.length > 0) {
    throw fail(
      `以下條件欄位缺少來源,不能寫入:${missingProvenance.map((field) => field.path).join(', ')}`,
      'missing_provenance'
    );
  }

  const columns = mapStructuredColumns(conditionJson);
  if (conditionJson.special_terms != null) otherAgreements(conditionJson.special_terms);

  return db.transaction(async (tx) => {
    const intention = await ensureIntention(tx, { inquiryId, listingId, tenantUserId, actorUserId });
    if (FROZEN_INTENTION_STATUSES.includes(intention.status)) {
      throw fail('這筆承租意向已進入簽約或已結束,不能再整理新版本', 'intention_frozen');
    }

    const latest = await tx.get(
      'SELECT MAX(version_number) AS max_version FROM intention_versions WHERE rental_intention_id = ?',
      [intention.id]
    );
    const versionNumber = Number((latest && latest.max_version) || 0) + 1;

    const versionPublicId = `intention-version-${crypto.randomUUID()}`;
    await tx.run(`
      INSERT INTO intention_versions
        (public_id, rental_intention_id, version_number, rent_amount, deposit_amount,
         lease_start_date, lease_end_date, move_in_date, pet_request_text,
         equipment_request_text, viewing_request_text, special_request_text,
         condition_json, created_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      versionPublicId, intention.id, versionNumber,
      columns.rent_amount, columns.deposit_amount,
      columns.lease_start_date, columns.lease_end_date, columns.move_in_date,
      columns.pet_request_text, columns.equipment_request_text,
      columns.viewing_request_text, columns.special_request_text,
      JSON.stringify(conditionJson), actorUserId
    ]);
    const version = await tx.get(
      'SELECT id, version_number FROM intention_versions WHERE public_id = ?',
      [versionPublicId]
    );

    for (const field of fields) {
      for (const source of field.sources) {
        await tx.run(`
          INSERT INTO intention_version_sources
            (intention_version_id, field_path, source_type, source_id)
          VALUES (?, ?, ?, ?)
        `, [version.id, field.path, source.sourceType, source.sourceId]);
      }
    }

    return {
      intentionId: intention.id,
      intentionPublicId: intention.public_id,
      intentionStatus: intention.status,
      versionId: version.id,
      versionPublicId,
      versionNumber: Number(version.version_number),
      sourceCount: fields.reduce((total, field) => total + field.sources.length, 0)
    };
  });
}

/**
 * 抽取 -> 來源判定 -> 固化。模型呼叫在交易外,交易內只驗證與寫入。
 *
 * @param {object} input
 * @param {object} input.db async driver
 * @param {string} input.lineUserId 已驗證的 LINE 身分
 * @param {Function} [input.extractor] 注入用:預設是 conditionExtractionService。
 *   測試一律注入 stub —— 這裡不應該、也不需要真的連模型。
 */
async function extractAndSaveIntentionVersion({ db, lineUserId, extractor }) {
  requireDriver(db);
  requireText(lineUserId, 'lineUserId');

  const context = await loadNegotiationContext({ db, lineUserId });
  if (!context) throw fail('LINE 身分不存在或已停用', 'authorization_denied', 403);
  if (!context.inquiry) throw fail('目前沒有進行中的房源詢問', 'no_active_inquiry');
  if (context.intention && FROZEN_INTENTION_STATUSES.includes(context.intention.status)) {
    throw fail('這筆承租意向已進入簽約或已結束,不能再整理新版本', 'intention_frozen');
  }

  const extractionContext = buildExtractionContext(context);

  // 交易外。模型可能跑好幾十秒,而且會失敗;失敗時什麼都還沒寫。
  const extract = extractor || ((payload) => require('./conditionExtractionService').extractConditionJson(payload));
  let extraction;
  try {
    extraction = await extract(extractionContext);
  } catch (error) {
    const failure = fail(`承租條件抽取失敗:${error.message}`, 'extraction_failed', 502);
    failure.cause = error;
    throw failure;
  }

  const rawConditionJson = extraction && extraction.conditionJson ? extraction.conditionJson : extraction;
  const conditionJson = normalizeConditionJson(rawConditionJson);
  const provenance = resolveConditionProvenance({
    conditionJson,
    messages: context.messages,
    listingSnapshot: context.listingSnapshot
  });

  const saved = await saveIntentionVersion({
    db,
    inquiryId: context.inquiry.id,
    listingId: context.inquiry.listingId,
    tenantUserId: context.userId,
    actorUserId: context.userId,
    conditionJson: provenance.conditionJson,
    fields: provenance.fields
  });

  return {
    ...saved,
    listingTitle: context.inquiry.listingTitle,
    conditionJson: provenance.conditionJson,
    fields: provenance.fields,
    unsourcedFields: provenance.unsourcedFields,
    conflicts: provenance.conflicts,
    missingFields: provenance.missingFields
  };
}

// --- 唯讀:讀回某個精確版本 --------------------------------------------------

/**
 * 讀回一個精確版本與它的逐欄來源,供房客檢視依據。
 * 一律用 public_id 指名,不接受「最新版」。
 */
async function loadIntentionVersion({ db, lineUserId, intentionVersionPublicId }) {
  requireDriver(db);
  requireText(lineUserId, 'lineUserId');
  requireText(intentionVersionPublicId, 'intentionVersionPublicId');

  const row = await db.get(`
    SELECT iv.id, iv.public_id, iv.version_number, iv.condition_json,
           ri.id AS rental_intention_id, ri.status AS intention_status,
           ri.tenant_user_id, ri.confirmed_intention_version_id,
           l.title AS listing_title
    FROM intention_versions iv
    JOIN rental_intentions ri ON ri.id = iv.rental_intention_id
    JOIN listings l ON l.id = ri.listing_id
    WHERE iv.public_id = ?
  `, [intentionVersionPublicId]);
  if (!row) throw fail('意向版本不存在', 'authorization_denied', 403);

  const identity = await db.get(
    'SELECT user_id FROM line_identities WHERE line_user_id = ?',
    [lineUserId]
  );
  // 授權失敗不揭露目標是否存在。
  if (!identity || !sameId(identity.user_id, row.tenant_user_id)) {
    throw fail('無權讀取這個意向版本', 'authorization_denied', 403);
  }

  const sources = await db.all(`
    SELECT ivs.field_path, ivs.source_type, ivs.source_id, m.text_content
    FROM intention_version_sources ivs
    LEFT JOIN messages m ON m.id = ivs.source_id AND ivs.source_type = 'message'
    WHERE ivs.intention_version_id = ?
    ORDER BY ivs.field_path ASC, ivs.id ASC
  `, [row.id]);

  return {
    versionId: row.id,
    versionPublicId: row.public_id,
    versionNumber: Number(row.version_number),
    listingTitle: row.listing_title,
    intentionStatus: row.intention_status,
    confirmed: sameId(row.confirmed_intention_version_id, row.id),
    conditionJson: row.condition_json ? JSON.parse(row.condition_json) : null,
    sources
  };
}

// --- 寫入:房客確認 exact version --------------------------------------------

/**
 * 房客確認一個**精確**版本。
 *
 * 確認的對象由 public_id 指名。這裡不會、也不能用「最新版」推測要確認哪一版:
 * 只會檢查被指名的版本是否**仍然**是最新版,不是就回 stale_version,讓房客
 * 重新看過再確認。少了這一關,房客按到的是三分鐘前那張卡片上的舊條件。
 */
async function confirmIntentionVersion({ db, lineUserId, intentionVersionPublicId }) {
  requireDriver(db);
  requireText(lineUserId, 'lineUserId');
  requireText(intentionVersionPublicId, 'intentionVersionPublicId');

  return db.transaction(async (tx) => {
    // actor 只從 line_identities 推導,而且必須是 active 使用者。
    const identity = await tx.get(`
      SELECT u.id AS user_id
      FROM line_identities li
      JOIN users u ON u.id = li.user_id
      WHERE li.line_user_id = ?
        AND u.status = 'active'
    `, [lineUserId]);
    if (!identity) throw fail('LINE 身分不存在或已停用', 'authorization_denied', 403);

    const row = await tx.get(`
      SELECT iv.id AS intention_version_id, iv.version_number,
             ri.id AS rental_intention_id, ri.status AS intention_status,
             ri.tenant_user_id, ri.confirmed_intention_version_id,
             ri.inquiry_id, inq.status AS inquiry_status,
             l.title AS listing_title
      FROM intention_versions iv
      JOIN rental_intentions ri ON ri.id = iv.rental_intention_id
      JOIN inquiries inq ON inq.id = ri.inquiry_id
      JOIN listings l ON l.id = ri.listing_id
      WHERE iv.public_id = ?
    `, [intentionVersionPublicId]);
    if (!row) throw fail('意向版本不存在', 'authorization_denied', 403);

    // 只有這筆意向的房客能確認。房東不能替房客按,Agent 更不行。
    if (!sameId(row.tenant_user_id, identity.user_id)) {
      throw fail('只有提出承租的房客可以確認條件', 'authorization_denied', 403);
    }

    // 意向已經走完的情況要說得出**為什麼**,不能落到下面的「已經確認過」重播分支。
    //
    // 被房東拒絕的意向刻意保留 confirmed 指標(稽核要看得出房東拒的是哪一版),
    // 所以房客再按一次確認會剛好命中重播分支,得到「你已經確認過了」——
    // 那是這一版最不需要知道的事實。
    const TERMINATED_MESSAGES = {
      rejected: '房東已經拒絕這一版條件。你可以直接在這裡跟我繼續談，我會幫你整理成新的一版。',
      leased_to_another_tenant: '這間房源已經由其他房客完成簽署，這一版不會再往下走。',
      withdrawn: '這筆承租意向已經撤回了。',
      ended: '這筆承租意向已經結束了。'
    };
    if (TERMINATED_MESSAGES[row.intention_status]) {
      // 房東有寫理由就一起說。理由是房東自己輸入的自由文字,只回給這筆意向的房客。
      const decided = row.intention_status === 'rejected'
        ? await tx.get(`
            SELECT reason FROM intention_decisions
            WHERE rental_intention_id = ? AND decision = 'rejected' AND reason IS NOT NULL
            ORDER BY id DESC LIMIT 1
          `, [row.rental_intention_id])
        : null;
      const reason = decided && String(decided.reason || '').trim();
      const error = fail(
        reason
          ? `房東已經拒絕這一版條件，理由是：${reason}。你可以直接在這裡跟我繼續談，我會幫你整理成新的一版。`
          : TERMINATED_MESSAGES[row.intention_status],
        'intention_terminated'
      );
      error.reason = reason || null;
      throw error;
    }

    // 已經確認過同一版:重送,回傳原結果,不再寫任何東西。
    if (sameId(row.confirmed_intention_version_id, row.intention_version_id)) {
      return {
        replayed: true,
        intentionVersionPublicId,
        versionNumber: Number(row.version_number),
        listingTitle: row.listing_title,
        intentionStatus: row.intention_status
      };
    }

    if (!CONFIRMABLE_INTENTION_STATUSES.includes(row.intention_status)) {
      throw fail('這筆承租意向目前的狀態不允許確認條件', 'stale_version');
    }

    // 被指名的版本必須仍是最新版。這是 staleness 檢查,不是用最新版反推該確認誰。
    const latest = await tx.get(
      'SELECT MAX(version_number) AS max_version FROM intention_versions WHERE rental_intention_id = ?',
      [row.rental_intention_id]
    );
    const latestVersionNumber = Number((latest && latest.max_version) || 0);
    if (Number(row.version_number) !== latestVersionNumber) {
      const stale = fail(
        `這是第 ${row.version_number} 版,但目前已經有第 ${latestVersionNumber} 版`,
        'stale_version'
      );
      stale.latestVersionNumber = latestVersionNumber;
      throw stale;
    }

    // 條件式 UPDATE。confirmed 指標一定會變,所以 mysql2 的 affectedRows 在成功時
    // 必定 > 0(MySQL 只計「真的改變的列」,同值 UPDATE 會回 0 —— 這裡不會發生)。
    const updated = await tx.run(`
      UPDATE rental_intentions
      SET confirmed_intention_version_id = ?,
          status = 'submitted',
          submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status IN ('draft', 'submitted', 'under_review')
        AND (confirmed_intention_version_id IS NULL OR confirmed_intention_version_id <> ?)
    `, [row.intention_version_id, row.rental_intention_id, row.intention_version_id]);
    if (!updated.changes) {
      // 讀完到寫入之間有人動過這筆意向。回 409,不做部分寫入。
      throw fail('承租意向剛剛被更新,請重新查看最新條件', 'stale_version');
    }
    await require('./ecsNeoPendingItemsService').completePendingItemsForVersion(tx, {
      inquiryId: row.inquiry_id, versionId: row.intention_version_id
    });

    // 房客確認是可稽核事件,即使 status 本來就是 submitted(房東要求修改後再確認)
    // 也要留一列,否則稽核看不出他確認過哪一版。
    await tx.run(`
      INSERT INTO intention_status_history
        (rental_intention_id, from_status, to_status, actor_user_id, reason)
      VALUES (?, ?, 'submitted', ?, ?)
    `, [
      row.rental_intention_id,
      row.intention_status,
      identity.user_id,
      `房客確認承租條件第 ${row.version_number} 版`
    ]);

    // 詢問進入 intention_confirming。已經在 contracting/ended 的不往回推。
    if (row.inquiry_status === 'inquiring' || row.inquiry_status === 'waiting_landlord') {
      await tx.run(`
        UPDATE inquiries
        SET status = 'intention_confirming',
            last_activity_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = ?
      `, [row.inquiry_id, row.inquiry_status]);
      await tx.run(`
        INSERT INTO inquiry_status_history
          (inquiry_id, from_status, to_status, actor_user_id, reason)
        VALUES (?, ?, 'intention_confirming', ?, ?)
      `, [row.inquiry_id, row.inquiry_status, identity.user_id, '房客確認承租條件版本']);
    }

    return {
      replayed: false,
      intentionVersionPublicId,
      versionNumber: Number(row.version_number),
      listingTitle: row.listing_title,
      intentionStatus: 'submitted'
    };
  });
}

module.exports = {
  buildExtractionContext,
  confirmIntentionVersion,
  extractAndSaveIntentionVersion,
  loadIntentionVersion,
  loadNegotiationContext,
  mapStructuredColumns,
  saveIntentionVersion
};
