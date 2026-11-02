// 屋況附件 repository 的 driver 版本。參數 `db` 收的是 sqlDriver 的 driver。
//
// 讀屋況紀錄的三句 SQL 與 preInspectionRepository 共用 preInspectionQueries,
// 不另外複製一份 —— 屋況點交功能本身仍跑在同步路徑上。

const crypto = require('node:crypto');
const preInspectionQueries = require('./preInspectionQueries');
const { assertConditionAttachmentMutable } = require('../database/integrityGuardsAsync');

const publicId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

// 屋況紀錄與合約的關聯強度：同一筆詢問 > 同一個出租單位 > 只是合約當事人自己的紀錄。
const MATCH_SOURCE_RANK = { inquiry: 0, rental_unit: 1, party: 2 };

// CTE 在 SQLite 3.8.3+ 與 TiDB(MySQL 8.0 相容)都支援。
const CANDIDATE_SQL = `
WITH contract_scope AS (
  SELECT c.id AS contract_id, c.rental_unit_id, c.source_inquiry_id, ri.inquiry_id AS intention_inquiry_id
  FROM contracts c
  LEFT JOIN rental_intentions ri ON ri.id = c.selected_intention_id
  WHERE c.id = @contractId
),
contract_inquiries AS (
  SELECT source_inquiry_id AS inquiry_id FROM contract_scope WHERE source_inquiry_id IS NOT NULL
  UNION
  SELECT intention_inquiry_id FROM contract_scope WHERE intention_inquiry_id IS NOT NULL
),
contract_listings AS (
  SELECT l.id AS listing_id FROM listings l JOIN contract_scope cs ON l.rental_unit_id = cs.rental_unit_id
),
contract_line_users AS (
  SELECT li.line_user_id
  FROM contract_parties cp
  JOIN contract_scope cs ON cs.contract_id = cp.contract_id
  JOIN line_identities li ON li.user_id = cp.user_id
  WHERE cp.status = 'active'
)
SELECT
  s.id, s.public_id, s.title, s.listing_id, s.inquiry_id, s.line_user_id,
  s.started_at, s.sealed_at, s.confirmation_status,
  CASE
    WHEN s.inquiry_id IN (SELECT inquiry_id FROM contract_inquiries) THEN 'inquiry'
    WHEN s.listing_id IN (SELECT listing_id FROM contract_listings) THEN 'rental_unit'
    ELSE 'party'
  END AS match_source
FROM pre_inspection_sessions s
WHERE s.status = 'sealed'
  AND s.record_type = 'main'
  -- 授權與關聯強度要分開看。inquiry_id / listing_id 只決定 match_source 與排序,
  -- **不能**當成准入條件:inquiry_id 是別人也可能填到的欄位,只要它對得上就放行,
  -- 等於讓陌生人的照片與文字被整份複製進本合約的附件一。
  -- 准入條件一律是「由本合約 active 當事人建立的紀錄」。
  AND s.line_user_id IN (SELECT line_user_id FROM contract_line_users)
ORDER BY COALESCE(s.sealed_at, s.started_at) DESC, s.id DESC
`;

// 候選清單只是 UI 過濾;前端可以直接送任意 sessionPublicId,所以寫入前必須再擋一次。
// 判準與 CANDIDATE_SQL 相同:紀錄必須由本合約 active 當事人建立。
// 同一筆 inquiry 不構成授權(見 CANDIDATE_SQL 的說明)。
// JOIN 的 ON 裡沒有子查詢(TiDB 不支援),當事人比對放在 WHERE 的相關子查詢。
const SESSION_ALLOWED_SQL = `
SELECT 1 AS allowed
FROM contract_versions cv
JOIN contracts c ON c.id = cv.contract_id
JOIN pre_inspection_sessions s ON s.id = @sessionId
WHERE cv.id = @contractVersionId
  AND s.line_user_id IN (
    SELECT li.line_user_id
    FROM contract_parties cp
    JOIN line_identities li ON li.user_id = cp.user_id
    WHERE cp.contract_id = c.id AND cp.status = 'active'
  )
LIMIT 1
`;

const FOREIGN_RECORD = '這份屋況紀錄不屬於本契約當事人，無法附加。';
const EMPTY_RECORD = '這份屋況紀錄沒有任何內容，無法列為附件一；請回 LINE 補上照片或文字後再重新封存。';

async function collectEntries(db, sessionId) {
  const own = await preInspectionQueries.getSessionEntries(db, sessionId, 1000);
  const supplements = await preInspectionQueries.getSupplementSessions(db, sessionId);
  const all = [...own];
  for (const supplement of supplements) {
    all.push(...await preInspectionQueries.getSessionEntries(db, supplement.id, 1000));
  }
  return all.sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')) || left.id - right.id);
}

async function buildManifest(db, session) {
  const entries = (await collectEntries(db, session.id)).map((entry, index) => ({
    index: index + 1,
    kind: entry.entry_type,
    recordedAt: entry.created_at || null,
    text: entry.entry_type === 'text' ? String(entry.message_text || '') : null,
    // 檔案可能在 R2，public_url 的本機路徑讀不到；走受權限保護的媒體路由（補充紀錄也由主紀錄帶出）。
    url: entry.entry_type === 'image' || entry.entry_type === 'video'
      ? `/tenant/pre-inspections/${encodeURIComponent(session.public_id)}/media/${encodeURIComponent(entry.id)}`
      : null,
    mimeType: entry.mime_type || null
  }));
  const counts = entries.reduce(
    (totals, entry) => ({ ...totals, [entry.kind]: (totals[entry.kind] || 0) + 1 }),
    {}
  );
  const manifest = {
    sessionPublicId: session.public_id,
    title: session.title || null,
    sealedAt: session.sealed_at || null,
    confirmationStatus: session.confirmation_status || 'not_sent',
    entries
  };
  return {
    manifest,
    manifestJson: JSON.stringify(manifest),
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    imageCount: counts.image || 0,
    videoCount: counts.video || 0,
    textCount: counts.text || 0
  };
}

// viewerLineUserId 仍由呼叫端傳入(路由層有它),但**不參與授權**:能看到什麼候選
// 只由 contract_parties 決定,不由「誰在看」決定。
async function listCandidateSessions(db, { contractId }) {
  const sessions = (await db.all(CANDIDATE_SQL, { contractId }))
    .sort((left, right) => MATCH_SOURCE_RANK[left.match_source] - MATCH_SOURCE_RANK[right.match_source]);

  const result = [];
  for (const session of sessions) {
    const summary = await buildManifest(db, session);
    result.push({
      sessionPublicId: session.public_id,
      title: session.title,
      sealedAt: session.sealed_at,
      startedAt: session.started_at,
      confirmationStatus: session.confirmation_status || 'not_sent',
      matchSource: session.match_source,
      imageCount: summary.imageCount,
      videoCount: summary.videoCount,
      textCount: summary.textCount
    });
  }
  return result;
}

async function listAttachments(db, contractVersionId) {
  const rows = await db.all(`
    SELECT public_id, session_public_id, title, sealed_at, match_source,
           image_count, video_count, text_count, manifest_json, manifest_hash, created_at
    FROM contract_condition_attachments
    WHERE contract_version_id = ?
    ORDER BY id ASC
  `, [contractVersionId]);
  return rows.map((row) => ({
    publicId: row.public_id,
    sessionPublicId: row.session_public_id,
    title: row.title,
    sealedAt: row.sealed_at,
    matchSource: row.match_source,
    imageCount: row.image_count,
    videoCount: row.video_count,
    textCount: row.text_count,
    manifestHash: row.manifest_hash,
    attachedAt: row.created_at,
    entries: JSON.parse(row.manifest_json).entries || []
  }));
}

// 發行時必須讀目前的點交狀態，不能信任附加當下寫進 manifest 的快照；
// 房東可能是在草稿建立後才完成確認。
async function listUnconfirmedAttachments(db, contractVersionId) {
  return db.all(`
    SELECT cca.session_public_id AS sessionPublicId, pis.title, pis.confirmation_status AS confirmationStatus
    FROM contract_condition_attachments cca
    JOIN pre_inspection_sessions pis ON pis.id = cca.pre_inspection_session_id
    WHERE cca.contract_version_id = ?
      AND COALESCE(pis.confirmation_status, 'not_sent') <> 'landlord_confirmed'
    ORDER BY cca.id ASC
  `, [contractVersionId]);
}

async function listPreviousVersionAttachments(db, { contractId, contractVersionId }) {
  const current = await db.get('SELECT version_number, id FROM contract_versions WHERE id=? AND contract_id=?', [contractVersionId, contractId]);
  if (!current) return [];
  const previous = await db.get(`SELECT id FROM contract_versions
    WHERE contract_id=? AND (version_number < ? OR (version_number=? AND id<?))
    ORDER BY version_number DESC, id DESC LIMIT 1`, [contractId, current.version_number, current.version_number, current.id]);
  if (previous) return listAttachments(db, previous.id);
  const parent = await db.get('SELECT renewed_from_contract_id FROM contracts WHERE id=?', [contractId]);
  if (!parent?.renewed_from_contract_id) return [];
  const parentVersion = await db.get(`SELECT cv.id FROM contract_versions cv
    JOIN signature_records sr ON sr.contract_version_id = cv.id
    WHERE cv.contract_id=? ORDER BY cv.version_number DESC, cv.id DESC LIMIT 1`, [parent.renewed_from_contract_id]);
  return parentVersion ? listAttachments(db, parentVersion.id) : [];
}

async function listAttachmentCounts(db, contractVersionIds) {
  if (!contractVersionIds.length) return new Map();
  const rows = await db.all(`
    SELECT contract_version_id, COUNT(*) AS attachment_count,
           COALESCE(SUM(image_count), 0) AS image_count,
           COALESCE(SUM(video_count), 0) AS video_count
    FROM contract_condition_attachments
    WHERE contract_version_id IN (${contractVersionIds.map(() => '?').join(',')})
    GROUP BY contract_version_id
  `, contractVersionIds);
  // mysql2 的 SUM() 可能回傳 DECIMAL 字串,呼叫端會拿去相加或比較。
  return new Map(rows.map((row) => [row.contract_version_id, {
    attachmentCount: Number(row.attachment_count),
    imageCount: Number(row.image_count),
    videoCount: Number(row.video_count)
  }]));
}

async function attachSession(db, { contractVersionId, sessionPublicId, matchSource, attachedByUserId = null }) {
  await assertConditionAttachmentMutable(db, contractVersionId);
  const session = await preInspectionQueries.getSessionByPublicId(db, sessionPublicId);
  if (!session) { const error = new Error('屋況紀錄不存在'); error.statusCode = 404; throw error; }
  if (session.status !== 'sealed') { const error = new Error('屋況紀錄尚未封存，請先在 LINE 點「完成紀錄」'); error.statusCode = 400; throw error; }
  if (!await db.get(SESSION_ALLOWED_SQL, { sessionId: session.id, contractVersionId })) {
    const error = new Error(FOREIGN_RECORD); error.statusCode = 403; throw error;
  }
  const summary = await buildManifest(db, session);
  // 非空是所有寫入路徑共用的邊界。service 的手動附加會先擋一次並給更好的訊息,
  // 但自動帶入(autoAttachLatestRecord)與任何未來的呼叫端都直接走這裡,
  // 只擋在 service 就會出現 image_count=0/video_count=0/text_count=0 的附件一。
  if (!summary.imageCount && !summary.videoCount && !summary.textCount) {
    const error = new Error(EMPTY_RECORD); error.statusCode = 400; throw error;
  }
  const d = db.dialect;
  await db.run(`
    INSERT INTO contract_condition_attachments (
      public_id, contract_version_id, pre_inspection_session_id, session_public_id, title, sealed_at,
      match_source, image_count, video_count, text_count, manifest_json, manifest_hash, attached_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ${d.onConflict('contract_version_id, pre_inspection_session_id')}
      title = ${d.incoming('title')}, sealed_at = ${d.incoming('sealed_at')}, match_source = ${d.incoming('match_source')},
      image_count = ${d.incoming('image_count')}, video_count = ${d.incoming('video_count')}, text_count = ${d.incoming('text_count')},
      manifest_json = ${d.incoming('manifest_json')}, manifest_hash = ${d.incoming('manifest_hash')}
  `, [
    publicId('condition-attachment'), contractVersionId, session.id, session.public_id, session.title,
    session.sealed_at, matchSource, summary.imageCount, summary.videoCount, summary.textCount,
    summary.manifestJson, summary.manifestHash, attachedByUserId
  ]);
  return { sessionPublicId: session.public_id, manifestHash: summary.manifestHash };
}

async function detachSession(db, { contractVersionId, sessionPublicId }) {
  await assertConditionAttachmentMutable(db, contractVersionId);
  const result = await db.run(`
    DELETE FROM contract_condition_attachments
    WHERE contract_version_id = ? AND session_public_id = ?
  `, [contractVersionId, sessionPublicId]);
  if (!result.changes) { const error = new Error('這份屋況紀錄未附加於本版本'); error.statusCode = 404; throw error; }
  return { detached: true };
}

module.exports = {
  MATCH_SOURCE_RANK,
  EMPTY_RECORD,
  FOREIGN_RECORD,
  buildManifest,
  listCandidateSessions,
  listAttachments,
  listUnconfirmedAttachments,
  listPreviousVersionAttachments,
  listAttachmentCounts,
  attachSession,
  detachSession
};
