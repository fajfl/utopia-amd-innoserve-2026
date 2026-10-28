// 屋況附件 service 的 driver 版本。參數 `db` 收的是 sqlDriver 的 driver。

const contractRepository = require('../repositories/v2ContractRepositoryAsync');
const conditionRepository = require('../repositories/v2ContractConditionRepositoryAsync');
const preInspectionRepository = require('../repositories/preInspectionRepositoryAsync');

const MATCH_SOURCE_LABELS = {
  inquiry: '本案房源',
  rental_unit: '本案房源',
  party: '非本案房源'
};

// 附件一的每一份屋況紀錄對房客而言只有三種處境。標籤要說得出「在等誰」,
// 不能只說「未確認」——使用者看到「未確認」會以為是自己還沒做完某件事。
const REVIEW_STATUS_LABELS = {
  landlord_confirmed: '房東已確認',
  pending_landlord_confirmation: '待房東審閱',
  not_sent: '尚未送交審閱'
};

function reviewStatusLabel(status) {
  return REVIEW_STATUS_LABELS[status] || REVIEW_STATUS_LABELS.not_sent;
}

const ALL_CONFIRMED_MESSAGE = '附件一的屋況紀錄都已由房東確認，可以送出簽署。';

function reviewRequestMessage(rows) {
  const list = rows.map((row) => `「${row.title}」（房東：${row.landlordName}）`).join('、');
  return `附件一有 ${rows.length} 份屋況紀錄正在等待房東確認，已轉交房東審閱：${list}。房東在 LINE 完成確認後，回到這一頁就可以送出簽署。`;
}

// sessionId 與房東的 LINE ID 只在伺服器內部使用。這份 pending 清單會直接回給
// 房客的瀏覽器,不可以把內部主鍵或別人的 LINE 身分帶出去。
function publicPendingRow(row) {
  return {
    sessionPublicId: row.sessionPublicId,
    title: row.title,
    landlordName: row.landlordName,
    confirmationStatus: row.confirmationStatus,
    reviewLabel: reviewStatusLabel(row.confirmationStatus),
    submittedToLandlordAt: row.submittedToLandlordAt || null
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function loadVersion(db, { lineUserId, versionPublicId }) {
  const party = await contractRepository.requireVersionParty(db, { lineUserId, versionPublicId });
  const version = await db.get('SELECT * FROM contract_versions WHERE id=?', [party.version_id]);
  const signed = await db.get('SELECT 1 FROM signature_records WHERE contract_version_id=? LIMIT 1', [version.id]);
  // 有人簽過名之後附件就必須凍結，否則簽名涵蓋的 document_hash 會與實際附件對不上。
  return { party, version, editable: !signed };
}

// 附件變動會讓已產生的正式預覽失效：清掉 document_hash，房客必須重新「建立正式預覽」，
// 簽名時涵蓋的雜湊才會包含新的附件一。
async function invalidatePreparedDocument(db, version) {
  if (!version.document_hash) return false;
  await db.run('UPDATE contract_versions SET document_file_id=NULL, document_hash=NULL WHERE id=?', [version.id]);
  return true;
}

async function attachmentsForVersion(db, contractVersionId) {
  return conditionRepository.listAttachments(db, contractVersionId);
}

async function assertAttachmentsConfirmed(db, contractVersionId) {
  const pending = await conditionRepository.listUnconfirmedAttachments(db, contractVersionId);
  if (!pending.length) return;
  const error = badRequest(`附件一尚有 ${pending.length} 份屋況紀錄等待房東確認，確認完成後才能送出簽署。`);
  error.statusCode = 409;
  throw error;
}

// 未確認的附件要說得出「是哪幾份、在等哪個房東、什麼時候送出的」。
// 這裡不新增 SQL:狀態沿用 pre_inspection_sessions.confirmation_status,
// 房東與地址沿用屋況點交自己的 repository,兩個 dialect 都已經驗過。
async function pendingReviewDetails(db, contractVersionId) {
  const pending = await conditionRepository.listUnconfirmedAttachments(db, contractVersionId);
  const rows = [];
  for (const row of pending) {
    const session = await preInspectionRepository.getSessionByPublicId(db, row.sessionPublicId);
    const context = session ? await preInspectionRepository.getSessionContext(db, session.id) : {};
    rows.push({
      sessionPublicId: row.sessionPublicId,
      sessionId: session ? session.id : null,
      title: row.title || '入住前屋況紀錄',
      confirmationStatus: (session && session.confirmation_status) || row.confirmationStatus || 'not_sent',
      landlordName: context.landlordName || '房東',
      submittedToLandlordAt: (session && session.submitted_to_landlord_at) || null,
      newlyRequested: false
    });
  }
  return rows;
}

async function getConditionPanel({ db, lineUserId, versionPublicId }) {
  const { party, version, editable } = await loadVersion(db, { lineUserId, versionPublicId });
  const attachments = await conditionRepository.listAttachments(db, version.id);
  const attached = new Set(attachments.map((attachment) => attachment.sessionPublicId));
  const candidates = (await conditionRepository.listCandidateSessions(db, { contractId: party.contract_id, viewerLineUserId: lineUserId }))
    .filter((candidate) => !attached.has(candidate.sessionPublicId))
    .map((candidate) => ({ ...candidate, matchLabel: MATCH_SOURCE_LABELS[candidate.matchSource] }));
  const pending = await pendingReviewDetails(db, version.id);
  const pendingBySession = new Map(pending.map((row) => [row.sessionPublicId, row]));
  return {
    contractPublicId: party.contract_public_id,
    versionPublicId: version.public_id,
    editable,
    attachments: attachments.map((attachment) => {
      const waiting = pendingBySession.get(attachment.sessionPublicId);
      return {
        ...attachment,
        matchLabel: MATCH_SOURCE_LABELS[attachment.matchSource],
        reviewStatus: waiting ? waiting.confirmationStatus : 'landlord_confirmed',
        reviewLabel: reviewStatusLabel(waiting ? waiting.confirmationStatus : 'landlord_confirmed'),
        reviewLandlordName: waiting ? waiting.landlordName : null,
        reviewSubmittedAt: waiting ? waiting.submittedToLandlordAt : null
      };
    }),
    candidates,
    pendingReview: pending.map(publicPendingRow),
    readyToIssue: pending.length === 0
  };
}

const FROZEN = '本版本已有人完成簽署，無法再變更屋況附件；需要調整請回 LINE 建立新版本。';
// 訊息與判準的唯一來源在 repository(所有寫入路徑共用的邊界),這裡只是提早擋下來給更好的回覆。
const EMPTY_RECORD = conditionRepository.EMPTY_RECORD;

// 附件一是要進合約的證據,空紀錄放進去只會產生一份宣稱「已確認現況」但什麼都沒記的附件。
// 判準：**任一種**條目(照片、影片、文字)至少一則即可，完全沒有條目才擋。
// 不要求一定有照片，因為「屋況良好、無缺損」這類純文字紀錄本身就是有效陳述，
// 而且點交是否充分由房東確認流程(confirmation_status=landlord_confirmed)把關，
// 在這裡改成強制照片等於偷偷加了一條未經產品確認的規則。
function hasRecordContent(record) {
  return ((record.imageCount || 0) + (record.videoCount || 0) + (record.textCount || 0)) > 0;
}

function assertRecordHasContent(candidate) {
  if (!hasRecordContent(candidate)) throw badRequest(EMPTY_RECORD);
}

async function attachConditionRecord({ db, lineUserId, versionPublicId, sessionPublicId }) {
  const { party, version, editable } = await loadVersion(db, { lineUserId, versionPublicId });
  if (!editable) throw badRequest(FROZEN);
  const candidate = (await conditionRepository.listCandidateSessions(db, { contractId: party.contract_id, viewerLineUserId: lineUserId }))
    .find((row) => row.sessionPublicId === sessionPublicId);
  if (!candidate) throw badRequest('這份屋況紀錄不屬於本契約當事人，無法附加。');
  assertRecordHasContent(candidate);
  const invalidated = await db.transaction(async (tx) => {
    await conditionRepository.attachSession(tx, {
      contractVersionId: version.id,
      sessionPublicId,
      matchSource: candidate.matchSource,
      attachedByUserId: party.user_id
    });
    return invalidatePreparedDocument(tx, version);
  });
  return { ...await getConditionPanel({ db, lineUserId, versionPublicId }), previewInvalidated: invalidated };
}

async function detachConditionRecord({ db, lineUserId, versionPublicId, sessionPublicId }) {
  const { version, editable } = await loadVersion(db, { lineUserId, versionPublicId });
  if (!editable) throw badRequest(FROZEN);
  const invalidated = await db.transaction(async (tx) => {
    await conditionRepository.detachSession(tx, { contractVersionId: version.id, sessionPublicId });
    return invalidatePreparedDocument(tx, version);
  });
  return { ...await getConditionPanel({ db, lineUserId, versionPublicId }), previewInvalidated: invalidated };
}

// 送簽被擋下來不該是死路。房客按下送簽時,把附件一裡每一份還沒經房東確認的紀錄
// 推進到「待房東審閱」(pre_inspection_sessions.confirmation_status),再回一份
// 等待清單給房客。狀態沿用房客手動「送交房東確認」的同一個值,所以房東端既有的
// 落點(數據總攬的點交待確認、屋況點交待審閱清單)會自動亮起來,不依賴推播。
//
// notify 是加分項:推播額度用完(429)時整段流程照樣完成,只是房東要自己從落點看。
async function requestLandlordConditionReview({ db, lineUserId, versionPublicId, notify = null }) {
  const { party, version } = await loadVersion(db, { lineUserId, versionPublicId });
  const rows = await pendingReviewDetails(db, version.id);
  const result = {
    contractPublicId: party.contract_public_id,
    versionPublicId: version.public_id,
    pending: [],
    requested: 0,
    notified: false,
    message: ALL_CONFIRMED_MESSAGE
  };
  if (!rows.length) return result;

  const requestedAt = new Date().toISOString();
  const notices = [];
  for (const row of rows) {
    if (!row.sessionId) continue;
    if (row.confirmationStatus !== 'pending_landlord_confirmation') {
      await preInspectionRepository.updateConfirmationStatus(db, row.sessionId, 'pending_landlord_confirmation', {
        submittedToLandlordAt: requestedAt
      });
      row.confirmationStatus = 'pending_landlord_confirmation';
      row.submittedToLandlordAt = requestedAt;
      row.newlyRequested = true;
    }
    notices.push({
      sessionId: row.sessionId,
      sessionPublicId: row.sessionPublicId,
      title: row.title,
      landlordLineUserId: await preInspectionRepository.getLandlordLineUserId(db, row.sessionId),
      newlyRequested: row.newlyRequested
    });
  }

  if (notify && notices.length) {
    try {
      result.notified = Boolean(await notify(notices));
    } catch (error) {
      // 推播失敗不影響流程:審閱請求已經寫進資料庫,房東仍看得到。
      console.error('Failed to notify landlord about condition review:', error.message || error);
    }
  }

  result.pending = rows.map(publicPendingRow);
  result.requested = rows.filter((row) => row.newlyRequested).length;
  result.message = reviewRequestMessage(rows);
  return result;
}

// 後續協調版本保留前版選定的附件，不能因同一房源出現另一位房客的點交就換圖。
// 首版才從同一筆 inquiry 自動帶入；其他房源或當事人紀錄要由當事人明確選取。
async function autoAttachLatestRecord(db, { contractId, contractVersionId, actorUserId = null }) {
  const inherited = await conditionRepository.listPreviousVersionAttachments(db, { contractId, contractVersionId });
  if (inherited.length) {
    // 舊版程式可能已經寫進零內容的附件;repository 現在會拒絕它們,
    // 這裡先濾掉,否則沿用附件會讓整個新版本建不出來。
    const carried = inherited.filter(hasRecordContent);
    for (const attachment of carried) {
      await conditionRepository.attachSession(db, {
        contractVersionId,
        sessionPublicId: attachment.sessionPublicId,
        matchSource: attachment.matchSource,
        attachedByUserId: actorUserId
      });
    }
    // 前一版存在就不再自動挑別的紀錄:協調後的版本必須沿用前版選定的附件。
    return { attached: carried.length > 0, sessionPublicIds: carried.map((attachment) => attachment.sessionPublicId), inherited: true };
  }
  // 空紀錄不能自動帶入。這條路徑直接呼叫 repository,不經過手動附加的檢查,
  // 之前會產出 image_count=0/video_count=0/text_count=0 卻回報 attached=true 的附件一。
  const candidate = (await conditionRepository.listCandidateSessions(db, { contractId }))
    .find((row) => row.matchSource === 'inquiry' && hasRecordContent(row));
  if (!candidate) return { attached: false };
  await conditionRepository.attachSession(db, {
    contractVersionId,
    sessionPublicId: candidate.sessionPublicId,
    matchSource: candidate.matchSource,
    attachedByUserId: actorUserId
  });
  return { attached: true, sessionPublicId: candidate.sessionPublicId, inherited: false };
}

module.exports = {
  MATCH_SOURCE_LABELS,
  REVIEW_STATUS_LABELS,
  attachmentsForVersion,
  assertAttachmentsConfirmed,
  pendingReviewDetails,
  requestLandlordConditionReview,
  getConditionPanel,
  attachConditionRecord,
  detachConditionRecord,
  autoAttachLatestRecord
};
