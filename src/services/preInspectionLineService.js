const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');
const { withV2Driver } = require('../database/v2Driver');
const preInspectionRepository = require('../repositories/preInspectionRepositoryAsync');
const { 
  preInspectionSummaryCard, 
  preInspectionLandlordCard,
  landlordPendingReviewSummaryCard,
  conditionReviewClearedCard,
  startPreInspectionCard,
  selectListingForInspectionCard,
  addedToRecordCard,
  sealedRecordCard,
  startSupplementCard,
  sealedSupplementCard,
  sentToLandlordCard,
  deleteConfirmCard,
  submitConfirmCard
} = require('./preInspectionLinePresenter');
const conditionAttachmentRepository = require('../repositories/v2ContractConditionRepositoryAsync');
const { enqueueNotification } = require('./ecsNeoOutboxAsync');
const { client } = require('../lineClient');
const { createFileStorage, storageKey: storageKeyForStored } = require('./fileStorage');

const preInspectionStorageRoot = path.join(__dirname, '..', '..', 'uploads', 'pre-inspections');

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of Readable.from(stream)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function formatTime(createdAt) {
  if (!createdAt) return '未知時間';
  const d = new Date(createdAt + 'Z');
  if (isNaN(d.getTime())) return '未知時間';
  return d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
}

async function handleContactLandlord(lineUserId) {
  return withV2Driver(async (db) => {
    const row = await db.get('SELECT id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
    let activeCtx = null;
    if (row) {
      activeCtx = await db.get('SELECT inquiry_id FROM active_inquiry_contexts WHERE line_identity_id = ? AND cleared_at IS NULL ORDER BY id DESC LIMIT 1', [row.id]);
    }

    let activeInquiry = null;
    if (activeCtx) {
      activeInquiry = await db.get(`
        SELECT i.id, i.public_id, i.listing_id, l.title as listing_title, l.address_text
        FROM inquiries i
        JOIN listings l ON l.id = i.listing_id
        WHERE i.id = ? AND i.ended_at IS NULL
      `, [activeCtx.inquiry_id]);
    }

    let displayTitle = '此房源';
    if (activeInquiry) {
      displayTitle = activeInquiry.listing_title || activeInquiry.address_text || '此房源';
    }

    return {
      handled: true,
      messages: [
        {
          type: 'text',
          text: `關於「${displayTitle}」，您可以隨時在這裡留言或說明需求，系統會保留對話內容供評估參考。`,
        }
      ]
    };
  });
}

const { createPreInspectionToken } = require('./preInspectionTokenService');
const { liffUrl } = require('./liffSessionService');

// ── 合約附件一的審閱動線 ────────────────────────────────────────────────
// 房客送簽時,附件一裡未經房東確認的紀錄會被推進到 pending_landlord_confirmation
// (見 v2ContractConditionService*.requestLandlordConditionReview)。房東要在
// 不依賴推播的情況下找得到這些紀錄,並且確認完之後房客要知道可以繼續送簽。
//
// SQL 只用 JOIN 與常數條件:TiDB 不接受 JOIN ON 裡的子查詢,也沒有 SQLite 的
// date()/datetime();有沒有未確認附件一律沿用 conditionAttachmentRepository,
// 不再抄一份查詢。
async function draftVersionsWithSession(db, sessionId) {
  if (!sessionId) return [];
  return db.all(`
    SELECT cv.id AS version_id,
           cv.public_id AS version_public_id,
           c.id AS contract_id,
           c.public_id AS contract_public_id
    FROM contract_condition_attachments cca
    JOIN contract_versions cv ON cv.id = cca.contract_version_id
    JOIN contracts c ON c.id = cv.contract_id
    WHERE cca.pre_inspection_session_id = ?
      AND cv.status = 'draft'
    ORDER BY cv.id DESC
  `, [sessionId]);
}

async function contractTenantLineUserId(db, contractId) {
  const row = await db.get(`
    SELECT li.line_user_id
    FROM contract_parties cp
    JOIN line_identities li ON li.user_id = cp.user_id
    WHERE cp.contract_id = ?
      AND cp.party_role = 'tenant'
      AND cp.status = 'active'
    ORDER BY li.id DESC
    LIMIT 1
  `, [contractId]);
  return row ? row.line_user_id : null;
}

// 房東端的待審閱清單。推播卡片可能因為額度(429)根本沒送到,所以房東輸入
// 「屋況點交」時一定要能自己把這份清單叫出來,而且每張卡片都帶原本的
// landlord_pre_inspection_confirm postback —— 權限仍由該 postback 檢查。
async function buildLandlordReviewMessages(db, sessions) {
  if (!sessions || !sessions.length) return [];
  const bubbles = [];
  let contractCount = 0;
  for (const session of sessions.slice(0, 10)) {
    const [stats, supplements, context, drafts, landlordLineUserId] = await Promise.all([
      preInspectionRepository.getSessionStats(db, session.id),
      preInspectionRepository.getSupplementSessions(db, session.id),
      preInspectionRepository.getSessionContext(db, session.id),
      draftVersionsWithSession(db, session.id),
      preInspectionRepository.getLandlordLineUserId(db, session.id)
    ]);
    if (drafts.length) contractCount += 1;
    bubbles.push(preInspectionLandlordCard(session, stats, supplements.length, {
      ...context,
      landlordLineUserId,
      noteText: drafts.length ? '這份紀錄是合約附件一，確認後房客才能送出簽署。' : null
    }).contents);
  }
  return [
    landlordPendingReviewSummaryCard(sessions, { contractCount }),
    {
      type: 'flex',
      altText: '待審閱的入住前屋況紀錄',
      contents: { type: 'carousel', contents: bubbles }
    }
  ];
}

// 送簽時通知房東。推播是加分項:失敗只記 log,不能讓整段流程失敗——審閱請求
// 已經寫進資料庫,房東仍能從待審閱清單與數據總攬看到。
async function pushLandlordConditionReviewRequests(db, notices, { lineClient = client } = {}) {
  let pushed = 0;
  for (const notice of notices || []) {
    if (!notice.landlordLineUserId || !notice.sessionId) continue;
    const session = await preInspectionRepository.getSessionWithStats(db, notice.sessionId);
    if (!session) continue;
    // 同帳號雙角色的 Demo:房客與房東是同一個 LINE 使用者,推給自己沒有意義。
    if (session.line_user_id === notice.landlordLineUserId) continue;
    const [context, supplements] = await Promise.all([
      preInspectionRepository.getSessionContext(db, notice.sessionId),
      preInspectionRepository.getSupplementSessions(db, notice.sessionId)
    ]);
    const card = preInspectionLandlordCard(session, session.stats, supplements.length, {
      ...context,
      landlordLineUserId: notice.landlordLineUserId,
      noteText: '房客要送出合約簽署，這份紀錄列為附件一，需要您確認後房客才能繼續。'
    });
    try {
      await lineClient.pushMessage(notice.landlordLineUserId, [
        { type: 'text', text: '【合約附件一】房客送出簽署前，有一份入住前屋況紀錄需要您確認。' },
        card
      ]);
      pushed += 1;
    } catch (error) {
      console.error('Failed to push condition review request:', error.message || error);
    }
  }
  return pushed;
}

// 房東確認完之後,只要某個草稿版本的附件一已經沒有待審閱紀錄,就通知房客可以送簽。
async function notifyTenantIfContractAttachmentsReady(db, { sessionId, actorLineUserId = null, lineClient = client } = {}) {
  const versions = await draftVersionsWithSession(db, sessionId);
  const cleared = [];
  for (const version of versions) {
    const pending = await conditionAttachmentRepository.listUnconfirmedAttachments(db, version.version_id);
    if (pending.length) continue;
    cleared.push(version);
  }
  if (!cleared.length) return { cleared: [], notified: 0 };

  const session = await preInspectionRepository.getSession(db, sessionId);
  let notified = 0;
  for (const version of cleared) {
    const tenantLineUserId = await contractTenantLineUserId(db, version.contract_id);
    if (!tenantLineUserId || tenantLineUserId === actorLineUserId) continue;
    try {
      await lineClient.pushMessage(tenantLineUserId, conditionReviewClearedCard(version.contract_public_id, {
        title: (session && session.title) || '入住前屋況紀錄'
      }));
      notified += 1;
    } catch (error) {
      console.error('Failed to notify tenant that condition review cleared:', error.message || error);
    }
  }
  return {
    cleared: cleared.map((version) => ({
      contractPublicId: version.contract_public_id,
      versionPublicId: version.version_public_id
    })),
    notified
  };
}


async function handlePreInspectionCommand(lineUserId) {
  return withV2Driver(async (db) => {
    const activeSession = await preInspectionRepository.getActiveSession(db, lineUserId);
    // 房東視角先來:等他審閱的紀錄放在最前面。這是推播之外的落點,
    // 房客視角的內容照舊接在後面(同一個 LINE 帳號可能兩種身分都有)。
    const landlordPending = await preInspectionRepository.getLandlordPendingSessions(db, lineUserId);
    const reviewMessages = await buildLandlordReviewMessages(db, landlordPending);
    if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
      console.log('[inspection:line-command]', {
        lineUserId,
        activeSessionId: activeSession?.id || null,
        pendingLandlordReviewCount: landlordPending.length
      });
    }

    if (!activeSession) {
      const sealedSessions = await preInspectionRepository.listSealedSessions(db, lineUserId);
      const userRow = await db.get('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
      let confirmedAppointments = [];
      if (userRow) {
        confirmedAppointments = await db.all(`
          SELECT
            sa.public_id AS appointment_public_id,
            sa.starts_at AS appointment_starts_at,
            i.id AS inquiry_id,
            i.public_id AS inquiry_public_id,
            l.id AS listing_id,
            l.title AS listing_title
          FROM showing_appointments sa
          JOIN inquiries i ON i.id = sa.inquiry_id
          JOIN listings l ON l.id = sa.listing_id
          WHERE sa.tenant_user_id = ? AND sa.status = 'confirmed'
          ORDER BY sa.starts_at DESC, sa.id DESC
        `, [userRow.user_id]);
      }

      const token = createPreInspectionToken(lineUserId);
      const inspectionListUrl = liffUrl(`/preInspectionList?token=${encodeURIComponent(token)}`);

      if (confirmedAppointments.length === 0) {
        return {
          handled: true,
          messages: [
            ...reviewMessages,
            {
              type: 'flex',
              altText: '屋況點交列表',
              contents: {
                type: 'bubble',
                header: {
                  type: 'box',
                  layout: 'vertical',
                  backgroundColor: '#0F766E',
                  paddingAll: 'lg',
                  contents: [
                    { type: 'text', text: '📋 屋況點交紀錄', color: '#FFFFFF', weight: 'bold', size: 'md' }
                  ]
                },
                body: {
                  type: 'box',
                  layout: 'vertical',
                  spacing: 'md',
                  contents: [
                    { type: 'text', text: '目前沒有房東已核准的看房預約。屋況點交會在看房核准後開啟；您仍可在下方查看歷史紀錄。', size: 'sm', color: '#374151', wrap: true }
                  ]
                },
                footer: {
                  type: 'box',
                  layout: 'vertical',
                  contents: [
                    {
                      type: 'button',
                      style: 'primary',
                      color: '#0F766E',
                      height: 'sm',
                      action: {
                        type: 'uri',
                        label: '開啟完整房源列表',
                        uri: inspectionListUrl
                      }
                    }
                  ]
                }
              }
            }
          ]
        };
      }

      return {
        handled: true,
        messages: [...reviewMessages, selectListingForInspectionCard(confirmedAppointments, inspectionListUrl, {
          hasSealed: sealedSessions.length > 0
        })]
      };
    }

    // Active session exists – return the current record stats card with Finish & Abandon buttons
    const stats = await preInspectionRepository.getSessionStats(db, activeSession.id);
    return {
      handled: true,
      messages: [...reviewMessages, addedToRecordCard(stats, { session: activeSession, lineUserId })]
    };
  });
}

async function handleActiveSessionInput(event, messageType, content, client) {
  const lineUserId = event.source && event.source.userId;
  if (!lineUserId) return { handled: false };

  // Do NOT absorb known feature commands as inspection entries.
  // Let cleanMessageHandler pass them to isTenantFeatureCommand instead.
  if (messageType === 'text') {
    const { isTenantFeatureCommand } = require('./tenantFeatureLineService');
    if (isTenantFeatureCommand(content.text)) return { handled: false };
  }

  return withV2Driver(async (db) => {
    const activeSession = await preInspectionRepository.getActiveSession(db, lineUserId);
    if (!activeSession) return { handled: false };

    if (messageType === 'text') {
      const textTrimmed = (content.text || '').trim();
      if (['放棄點交', '放棄紀錄', '放棄本次紀錄', '取消點交'].includes(textTrimmed)) {
        await preInspectionRepository.cancelSessionPackage(db, { sessionId: activeSession.id, lineUserId });
        return {
          handled: true,
          messages: [{ type: 'text', text: '已放棄本次的屋況點交紀錄。' }]
        };
      }
    }


    // Determine entryType
    let entryType = 'text';
    let messageText = null;
    let fileId = null;
    let storagePath = null;
    let publicUrl = null;
    let mimeType = null;
    const lineMessageId = event.message && event.message.id;

    if (messageType === 'text') {
      entryType = 'text';
      messageText = content.text;
    } else if (['image', 'video', 'audio', 'file'].includes(messageType)) {
      entryType = messageType;
      fileId = content.fileId || null;

      if (client && lineMessageId && ['image', 'video'].includes(messageType)) {
        try {
          const stream = await client.getMessageContent(lineMessageId);
          const ext = messageType === 'image' ? 'jpg' : 'mp4';
          mimeType = messageType === 'image' ? 'image/jpeg' : 'video/mp4';
          const fileName = `${lineMessageId}.${ext}`;
          const buffer = await streamToBuffer(stream);
          const digest = crypto.createHash('sha256').update(buffer).digest('hex');

          // 跟 591 凍結同一套去重規則:同一份 bytes 只落地一次,靠 files 的
          // UNIQUE (sha256_hash, size_bytes, security_classification)。
          const existingFile = await db.get(
            "SELECT id, storage_key FROM files WHERE sha256_hash=? AND size_bytes=? AND security_classification='private'",
            [digest, buffer.length]
          );
          let storageKeyValue;
          if (existingFile) {
            fileId = existingFile.id;
            storageKeyValue = existingFile.storage_key;
          } else {
            const { provider, storage } = createFileStorage({ localRoot: preInspectionStorageRoot, prefix: 'private' });
            const stored = await storage.put(`${activeSession.public_id}/${fileName}`, buffer, { contentType: mimeType });
            storageKeyValue = storageKeyForStored(stored, provider);
            const filePublicId = `file-${crypto.randomUUID()}`;
            await db.run(`INSERT INTO files (public_id,storage_key,storage_provider,original_name,mime_type,size_bytes,sha256_hash,security_classification,created_by_user_id)
              VALUES (?,?,?,?,?,?,?,?,?)`, [filePublicId, storageKeyValue, provider, fileName, mimeType, buffer.length, digest, 'private', null]);
            const inserted = await db.get(
              "SELECT id FROM files WHERE sha256_hash=? AND size_bytes=? AND security_classification='private'",
              [digest, buffer.length]
            );
            fileId = inserted.id;
          }

          // storage_path/public_url 保留給舊資料與尚未走 file_id 的讀取路徑相容;
          // 新資料的正本身分是 files.id/file_id。
          //
          // 原本寫的是 stored.absolutePath,結果雲端資料庫裡出現
          // 隊友那台電腦的絕對路徑(F: 開頭)。資料表上了雲端、大家共用同一份資料,
          // 但檔案還在各自的硬碟上,這一列在別台機器解析出來的路徑根本不存在。
          // 2026-08-25 實測雲端指到的 10 個檔案有 3 個在本機找不到,而且那 3 筆
          // 都已封存、隨時可以被掛成合約附件一 —— 附件一是合約成立的舉證,
          // 那格會是空的。
          storagePath = storageKeyValue;
          publicUrl = `/uploads/pre-inspections/${activeSession.public_id}/${fileName}`;
        } catch (err) {
          console.error('Failed to download pre-inspection media:', err);
        }
      }
    }

    await preInspectionRepository.addEntry(db, {
      sessionId: activeSession.id,
      entryType,
      messageText,
      lineMessageId,
      fileId,
      storagePath,
      publicUrl,
      mimeType
    });

    const stats = await preInspectionRepository.getSessionStats(db, activeSession.id);

    return {
      handled: true,
      messages: [addedToRecordCard(stats, { session: activeSession, lineUserId })]
    };
  });
}

// This is shared by the LINE confirmation postback and the guided web capture
// page.  Keeping the actual hand-off in one place is important: an external
// capture flow must create the same notification-centre record and landlord
// card as the older LINE-only flow.
async function submitPreInspectionToLandlord(db, {
  sessionId,
  tenantLineUserId,
  tenantName = '房客',
  lineClient = client
}) {
  const session = await preInspectionRepository.getSessionWithStats(db, sessionId);
  if (!session || session.line_user_id !== tenantLineUserId) {
    return { ok: false, code: 'NOT_FOUND', message: '找不到此紀錄。' };
  }
  if (session.status !== 'sealed') {
    return { ok: false, code: 'NOT_SEALED', message: '紀錄尚未封存，無法送交。' };
  }
  if (['pending_landlord_confirmation', 'landlord_confirmed'].includes(session.confirmation_status)) {
    return { ok: false, code: 'ALREADY_SUBMITTED', message: '此紀錄已送交確認或已由房東確認。' };
  }

  const landlordRecipient = await preInspectionRepository.getLandlordRecipient(db, sessionId);
  const landlordLineUserId = landlordRecipient && landlordRecipient.line_user_id;
  if (!landlordLineUserId) {
    return { ok: false, code: 'NO_LANDLORD', message: '尚未設定此房源的房東聯絡資訊，暫時無法送交確認。' };
  }

  const isSoloTest = landlordLineUserId === tenantLineUserId;
  const context = await preInspectionRepository.getSessionContext(db, sessionId);
  context.tenantName = tenantName || '房客';
  context.landlordLineUserId = landlordLineUserId;
  const supplements = await preInspectionRepository.getSupplementSessions(db, sessionId);
  const landlordCard = preInspectionLandlordCard(session, session.stats, supplements.length, {
    ...context,
    landlordLineUserId
  });

  if (landlordRecipient.user_id) {
    try {
      await enqueueNotification(db, {
        eventType: 'pre_inspection_submitted',
        entityType: 'pre_inspection_session',
        entityId: session.public_id,
        payload: {
          title: '入住前屋況紀錄待確認',
          message: `${context.tenantName || '房客'} 已送交屋況紀錄，請查看內容後確認。`,
          unitLabel: session.title || '租屋物件',
          preInspectionPublicId: session.public_id,
          actionUrl: `/tenant/pre-inspections/${encodeURIComponent(session.public_id)}?token=${encodeURIComponent(createPreInspectionToken(landlordLineUserId, session.public_id))}`
        },
            recipients: [{
              role: 'landlord',
              userId: landlordRecipient.user_id,
              lineIdentityId: landlordRecipient.line_identity_id
            }],
        idempotencyKey: `pre_inspection_submitted:${session.public_id}`
      });
    } catch (notificationError) {
      console.error('Failed to record landlord pre-inspection notification:', notificationError.message);
    }
  }

  const isTenantContractDemo = process.env.ENABLE_TENANT_CONTRACT_DEMO === 'true'
    && String(process.env.V2_DB_DRIVER).toLowerCase() === 'sqlite'
    && String(process.env.V2_DATABASE_PATH || '').endsWith('ecs-neo-v2.test.sqlite');
  if (!isSoloTest && !isTenantContractDemo) {
    try {
      await lineClient.pushMessage(landlordLineUserId, [
        { type: 'text', text: '【串接】房客已送交入住前屋況紀錄，請查看內容後確認。' },
        landlordCard
      ]);
    } catch (error) {
      console.error('Failed to push landlord card:', error.message || error);
      return { ok: false, code: 'PUSH_FAILED', message: '通知房東失敗，請稍後再試。' };
    }
  }

  await preInspectionRepository.updateConfirmationStatus(db, sessionId, 'pending_landlord_confirmation', {
    submittedToLandlordAt: new Date().toISOString()
  });
  return { ok: true, message: isSoloTest ? '點交已送交確認。' : '點交已送交房東確認。' };
}

// LINE 卡片與房東通知中心的外部頁必須走同一個確認 command。否則一邊會
// 通知房客、另一邊只改狀態，合約附件一的下一步就可能不同步。
async function confirmPreInspectionByLandlord(db, { sessionId, landlordLineUserId, lineClient = client } = {}) {
  const session = await preInspectionRepository.getSessionWithStats(db, sessionId);
  if (!session) return { ok: false, code: 'NOT_FOUND', message: '找不到此紀錄。' };

  const isLandlord = await preInspectionRepository.isLandlordForSession(db, sessionId, landlordLineUserId);
  if (!isLandlord) return { ok: false, code: 'FORBIDDEN', message: '無權限確認此屋況紀錄。' };
  if (session.confirmation_status === 'landlord_confirmed') {
    return { ok: true, alreadyConfirmed: true, ready: { cleared: [] } };
  }
  if (session.status !== 'sealed' || session.confirmation_status !== 'pending_landlord_confirmation') {
    return { ok: false, code: 'NOT_PENDING', message: '此屋況紀錄目前不在等待確認狀態。' };
  }

  await preInspectionRepository.updateConfirmationStatus(db, sessionId, 'landlord_confirmed', {
    landlordConfirmedAt: new Date().toISOString()
  });

  const isSoloTest = session.line_user_id === landlordLineUserId;
  if (!isSoloTest) {
    lineClient.pushMessage(session.line_user_id, {
      type: 'text',
      text: '房東已查看並確認此入住前屋況紀錄。\n狀態：房東已確認。'
    }).catch((error) => console.error('Failed to notify tenant of pre-inspection confirmation:', error.message || error));
  }

  const ready = await notifyTenantIfContractAttachmentsReady(db, {
    sessionId: session.id,
    actorLineUserId: isSoloTest ? landlordLineUserId : null,
    lineClient
  });
  return { ok: true, alreadyConfirmed: false, ready };
}

async function handlePostback(event) {
  const lineUserId = event.source && event.source.userId;
  if (!lineUserId) return { handled: false };

  const data = event.postback && event.postback.data;
  const params = new URLSearchParams(String(data || ''));
  const action = params.get('action');

  if (action === 'leave_question') {
    return {
      handled: true,
      messages: [{
        type: 'text',
        text: '可以，請直接輸入你想詢問房東的問題；我會依目前選定房源整理並送出。'
      }]
    };
  }

  if (action === 'back_to_listing') {
    return handlePreInspectionCommand(lineUserId);
  }

  if (!action || (!action.startsWith('tenant_pre_inspection_') && !action.startsWith('landlord_pre_inspection_'))) {
    return { handled: false };
  }

  return withV2Driver(async (db) => {
    if (action === 'tenant_pre_inspection_select_listing') {
      return {
        handled: true,
        messages: [{ type: 'text', text: '新的屋況點交需對應房東已同意的看房預約。請從「看房預約已核准」通知卡片開啟。' }]
      };
    }

    if (action === 'tenant_pre_inspection_start') {
      const appointmentPublicId = params.get('appointment_id') || null;
      const parentId = params.get('parent_id') || null;

      if (appointmentPublicId && parentId) {
        return { handled: true, messages: [{ type: 'text', text: '屋況點交開啟參數無效，請回到看房預約通知重新操作。' }] };
      }

      if (appointmentPublicId) {
        const started = await preInspectionRepository.startSessionForConfirmedAppointment(db, {
          appointmentPublicId,
          lineUserId
        });
        if (started.status === 'not_found') {
          return { handled: true, messages: [{ type: 'text', text: '找不到已核准且屬於您的看房預約，請確認是否已由房東同意。' }] };
        }
        if (started.status === 'conflict') {
          return {
            handled: true,
            messages: [{ type: 'text', text: `目前您已有「${started.activeSession.title || '其他房源'}」進行中的屋況紀錄。請先完成或放棄該紀錄。` }]
          };
        }

        const session = started.session;
        if (started.status === 'existing' && session.status !== 'active') {
          const [stats, supplements, context] = await Promise.all([
            preInspectionRepository.getSessionStats(db, session.id),
            preInspectionRepository.getSupplementSessions(db, session.id),
            preInspectionRepository.getSessionContext(db, session.id)
          ]);
          return { handled: true, messages: [preInspectionSummaryCard(session, stats, supplements.length, context)] };
        }

        const equipmentItems = await preInspectionRepository.getListingInspectionReference(db, session.listing_id);
        return {
          handled: true,
          messages: [startPreInspectionCard(session.title || '目前房源', { session, lineUserId, equipmentItems })]
        };
      }

      if (!parentId) {
        return {
          handled: true,
          messages: [{ type: 'text', text: '新的屋況點交需從房東已同意的看房預約開啟。請回到「看房預約已核准」通知卡片操作。' }]
        };
      }

      let activeSession = await preInspectionRepository.getActiveSession(db, lineUserId);
      if (!activeSession) {
        const parentSession = await preInspectionRepository.getSession(db, parentId);
        if (!parentSession || parentSession.line_user_id !== lineUserId || parentSession.record_type !== 'main') {
          return { handled: true, messages: [{ type: 'text', text: '找不到可補充的屋況紀錄，請從該紀錄的卡片重新操作。' }] };
        }

        activeSession = await preInspectionRepository.createSession(db, {
          lineUserId,
          recordType: 'supplement',
          parentSessionId: parentId,
          listingId: parentSession.listing_id,
          inquiryId: parentSession.inquiry_id,
          title: parentSession.title
        });

        const dateStr = parentSession.started_at ? parentSession.started_at.split('T')[0] : '未知日期';
        return {
          handled: true,
          messages: [startSupplementCard(dateStr, { session: activeSession, lineUserId })]
        };
      }

      if (activeSession.record_type === 'supplement') {
        const parentSession = await preInspectionRepository.getSession(db, activeSession.parent_session_id);
        const dateStr = parentSession && parentSession.started_at ? parentSession.started_at.split('T')[0] : '未知日期';
        return {
          handled: true,
          messages: [startSupplementCard(dateStr, { session: activeSession, lineUserId })]
        };
      }

      return {
        handled: true,
        messages: [{ type: 'text', text: '目前已有進行中的屋況點交，請先完成或放棄該紀錄。' }]
      };
    }

    if (action === 'tenant_pre_inspection_finish') {
      const sessionPublicId = params.get('session_id');
      let activeSession = sessionPublicId
        ? await preInspectionRepository.getSessionByPublicId(db, sessionPublicId)
        : await preInspectionRepository.getActiveSession(db, lineUserId);
      // Legacy cards have no session ID; a web-completed record is already sealed.
      if (!activeSession && !sessionPublicId) {
        [activeSession] = await preInspectionRepository.listSealedSessions(db, lineUserId);
      }
      if (!activeSession || activeSession.line_user_id !== lineUserId
          || !['active', 'sealed'].includes(activeSession.status)) {
        return { handled: true, messages: [{ type: 'text', text: '目前沒有進行中的紀錄。' }] };
      }

      if (activeSession.status === 'sealed') {
        const stats = await preInspectionRepository.getSessionStats(db, activeSession.id);
        const supplements = await preInspectionRepository.getSupplementSessions(db, activeSession.id);
        const context = await preInspectionRepository.getSessionContext(db, activeSession.id);
        return { handled: true, messages: [preInspectionSummaryCard(activeSession, stats, supplements.length, context)] };
      }

      await preInspectionRepository.sealSession(db, activeSession.id);
      const stats = await preInspectionRepository.getSessionStats(db, activeSession.id);
      const dateStr = activeSession.started_at ? activeSession.started_at.split('T')[0] : new Date().toISOString().split('T')[0];

      if (activeSession.record_type === 'supplement' && activeSession.parent_session_id) {
        const parentSession = await preInspectionRepository.getSession(db, activeSession.parent_session_id);
        const pDateStr = parentSession.started_at ? parentSession.started_at.split('T')[0] : '未知日期';
        return {
          handled: true,
          messages: [sealedSupplementCard(pDateStr, stats)]
        };
      }

      const context = await preInspectionRepository.getSessionContext(db, activeSession.id);
      const flexMsg = preInspectionSummaryCard(activeSession, stats, 0, context);

      return {
        handled: true,
        messages: [
          sealedRecordCard(activeSession.title || '目前房源', dateStr, stats),
          flexMsg
        ]
      };
    }

    if (action === 'tenant_pre_inspection_list') {
      const sealedSessions = await preInspectionRepository.listSealedSessions(db, lineUserId);
      if (sealedSessions.length === 0) {
        return { handled: true, messages: [{ type: 'text', text: '目前沒有已封存的紀錄。' }] };
      }

      const maxItems = 12; // LINE carousel max bubbles
      const bubbles = await Promise.all(sealedSessions.slice(0, maxItems).map(async (s) => {
        const stats = await preInspectionRepository.getSessionStats(db, s.id);
        const supplements = await preInspectionRepository.getSupplementSessions(db, s.id);
        const context = await preInspectionRepository.getSessionContext(db, s.id);
        const flexMsg = preInspectionSummaryCard(s, stats, supplements.length, context);
        return flexMsg.contents;
      }));

      return {
        handled: true,
        messages: [{
          type: 'flex',
          altText: '已封存的入住前屋況紀錄',
          contents: {
            type: 'carousel',
            contents: bubbles
          }
        }]
      };
    }

    if (action === 'tenant_pre_inspection_submit') {
      const sessionId = params.get('id');
      const session = await preInspectionRepository.getSessionWithStats(db, sessionId);
      if (!session || session.line_user_id !== lineUserId) {
        return { handled: true, messages: [{ type: 'text', text: '找不到此紀錄。' }] };
      }

      if (session.status !== 'sealed') {
        return { handled: true, messages: [{ type: 'text', text: '紀錄尚未封存，無法送交。' }] };
      }

      if (['pending_landlord_confirmation', 'landlord_confirmed'].includes(session.confirmation_status)) {
        return { handled: true, messages: [{ type: 'text', text: '此紀錄已送交確認或已由房東確認。' }] };
      }

      return {
        handled: true,
        messages: [submitConfirmCard(sessionId)]
      };
    }

    if (action === 'tenant_pre_inspection_submit_cancel') {
      return {
        handled: true,
        messages: [{ type: 'text', text: '已取消送交房東。' }]
      };
    }

    if (action === 'tenant_pre_inspection_submit_confirm') {
      const sessionId = params.get('id');
      const result = await submitPreInspectionToLandlord(db, {
        sessionId,
        tenantLineUserId: lineUserId,
        tenantName: event.source.displayName || '房客'
      });
      if (!result.ok) {
        return { handled: true, messages: [{ type: 'text', text: result.message }] };
      }

      return {
        handled: true,
        messages: [sentToLandlordCard()]
      };
    }

    if (action === 'landlord_pre_inspection_confirm') {
      const sessionId = params.get('id');
      const result = await confirmPreInspectionByLandlord(db, {
        sessionId,
        landlordLineUserId: lineUserId
      });
      if (!result.ok) {
        return { handled: true, messages: [{ type: 'text', text: result.message }] };
      }

      return {
        handled: true,
        messages: [{
          type: 'text',
          text: result.alreadyConfirmed
            ? '這份入住前屋況紀錄已確認過。'
            : result.ready.cleared.length
            ? '已確認此入住前屋況紀錄。這份紀錄是合約附件一，房客現在可以送出簽署了。'
            : '已確認此入住前屋況紀錄。'
        }]
      };
    }

    if (action === 'tenant_pre_inspection_detail') {
      const sessionId = params.get('id');
      const session = await preInspectionRepository.getSessionWithStats(db, sessionId);
      if (!session || session.line_user_id !== lineUserId) {
        return { handled: true, messages: [{ type: 'text', text: '找不到此紀錄。' }] };
      }

      const supplements = await preInspectionRepository.getSupplementSessions(db, session.id);
      const context = await preInspectionRepository.getSessionContext(db, session.id);
      const flexMessage = preInspectionSummaryCard(session, session.stats, supplements.length, context);

      return {
        handled: true,
        messages: [flexMessage]
      };
    }

    // New actions: Cancel Active and Delete Sealed Record
    if (action === 'tenant_pre_inspection_cancel_active') {
      const activeSession = await preInspectionRepository.getActiveSession(db, lineUserId);
      if (!activeSession) {
        return { handled: true, messages: [{ type: 'text', text: '目前沒有進行中的屋況紀錄。' }] };
      }

      await preInspectionRepository.cancelSessionPackage(db, { sessionId: activeSession.id, lineUserId });
      return {
        handled: true,
        messages: [{ type: 'text', text: '已放棄本次的屋況點交紀錄。' }]
      };
    }

    if (action === 'tenant_pre_inspection_delete_confirm') {
      const sessionId = Number(params.get('id'));
      const session = await preInspectionRepository.getSession(db, sessionId);
      if (!session || session.line_user_id !== lineUserId) {
        return { handled: true, messages: [{ type: 'text', text: '找不到此紀錄。' }] };
      }

      if (['pending_landlord_confirmation', 'landlord_confirmed'].includes(session.confirmation_status)) {
        return { handled: true, messages: [{ type: 'text', text: '此紀錄已送交確認或已由房東確認，不可移除。' }] };
      }

      return {
        handled: true,
        messages: [deleteConfirmCard(sessionId)]
      };
    }

    if (action === 'tenant_pre_inspection_delete') {
      const sessionId = Number(params.get('id'));
      const session = await preInspectionRepository.getSession(db, sessionId);
      if (!session || session.line_user_id !== lineUserId) {
        return { handled: true, messages: [{ type: 'text', text: '找不到此紀錄。' }] };
      }

      if (['pending_landlord_confirmation', 'landlord_confirmed'].includes(session.confirmation_status)) {
        return { handled: true, messages: [{ type: 'text', text: '此紀錄已送交確認，無法移除。' }] };
      }

      await preInspectionRepository.cancelSessionPackage(db, { sessionId, lineUserId });
      return {
        handled: true,
        messages: [{ type: 'text', text: '已成功移除該紀錄包。' }]
      };
    }

    if (action === 'tenant_pre_inspection_delete_cancel') {
      return {
        handled: true,
        messages: [{ type: 'text', text: '已取消移除。' }]
      };
    }

    return { handled: false };
  });
}

module.exports = {
  handlePreInspectionCommand,
  handleContactLandlord,
  handleActiveSessionInput,
  handlePostback,
  buildLandlordReviewMessages,
  draftVersionsWithSession,
  pushLandlordConditionReviewRequests,
  notifyTenantIfContractAttachmentsReady,
  submitPreInspectionToLandlord,
  confirmPreInspectionByLandlord
};
