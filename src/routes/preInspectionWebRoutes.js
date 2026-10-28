const express = require('express');
const path = require('node:path');
const { withV2Driver } = require('../database/v2Driver');
const preInspectionRepository = require('../repositories/preInspectionRepositoryAsync');
const { createLocalByteStorage } = require('../services/localByteStorage');
const { readStoredFile } = require('../services/fileStorage');
const { canReadCompletedAttachment } = require('../services/v2ContractDeliveryServiceAsync');
const { confirmPreInspectionByLandlord } = require('../services/preInspectionLineService');

const router = express.Router();
router.use('/tenant/pre-inspections', express.urlencoded({ extended: false }));
const mediaRoot = path.join(__dirname, '..', '..', 'uploads', 'pre-inspections');
const mediaStorage = createLocalByteStorage({ root: mediaRoot });
const FROZEN_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// storage_path 現在存的是相對於 uploads/pre-inspections 的 key。舊資料存的是絕對路徑,
// 而且有些是**別台機器**的絕對路徑,所以三種情況都要處理。
function mediaStorageKey(entry) {
  const raw = String(entry.storage_path || '').replace(/\\/g, '/');
  if (raw) {
    // 新格式:本來就是相對 key,直接用。
    if (!path.isAbsolute(raw) && !/^[A-Za-z]:/.test(raw) && !raw.startsWith('/')) return raw;

    // 舊格式:絕對路徑。只有落在本機 mediaRoot 底下才有意義。
    //
    // 原本這裡 path.relative(mediaRoot, 絕對路徑) 拿到結果就採用 —— 在 Windows 上跨磁碟機
    // (mediaRoot 在 C:、資料寫的是 F:)path.relative 會原封不動回傳那個絕對路徑,
    // 它不以 '../' 開頭,於是被當成合法的相對 key 送下去,storage 再以「不是相對路徑」拒絕。
    // 結果是**永遠走不到底下的 public_url 後備**,連還原得回來的檔案也讀不到。
    const relativePath = path.relative(mediaRoot, path.resolve(raw)).replace(/\\/g, '/');
    const escapes = !relativePath
      || relativePath.startsWith('../')
      || relativePath === '..'
      || path.isAbsolute(relativePath)
      || /^[A-Za-z]:/.test(relativePath);
    if (!escapes) return relativePath;
  }

  // 後備:public_url 一直都是相對的,舊資料靠它救得回來。
  const prefix = '/uploads/pre-inspections/';
  if (String(entry.public_url || '').startsWith(prefix)) return entry.public_url.slice(prefix.length);
  return null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(createdAt) {
  if (!createdAt) return '未知時間';
  const d = new Date(createdAt + 'Z');
  if (isNaN(d.getTime())) return '未知時間';
  return d.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
}

const {
  requestToken,
  resolvePreInspectionUser,
  verifyPreInspectionToken
} = require('../services/preInspectionTokenService');
const { liffBootstrap } = require('../services/liffSessionService');

// 已放棄的紀錄專用畫面。沿用明細頁的外框與配色,只是把內容換成一句說明與回列表的入口。
function cancelledRecordPage(title, token) {
  const listUrl = token
    ? `/preInspectionList?token=${encodeURIComponent(token)}`
    : '/preInspectionList';

  return `
    <!DOCTYPE html>
    <html lang="zh-Hant">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>入住前屋況紀錄 - ${escapeHtml(title)}</title>
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: #F8FAFC; color: #111827; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight: 400; }
        .records-page { width: min(800px, 100%); margin: 0 auto; padding: 18px 14px 34px; }
        .records-shell { overflow: hidden; background: #fff; border: 1px solid #E5E7EB; border-radius: 18px; box-shadow: 0 16px 42px rgba(15,23,42,.08); }
        .records-hero { background-image: linear-gradient(90deg, rgba(71,85,105,.92), rgba(15,23,42,.86)), url('/assets/ecs-neo-logo.png'); background-size: cover; background-position: center; color: #fff; }
        .hero-overlay { padding: 22px; }
        .records-hero p { margin: 0 0 8px; font-size: 13px; font-weight: 800; color: #E2E8F0; }
        .records-hero h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.25; font-weight: 600; }
        .records-hero span { font-size: 14px; opacity: .9; }
        .record-section { padding: 24px 16px; }
        .cancelled-notice { padding: 16px 18px; border-radius: 14px; background: #FEF2F2; border-left: 4px solid #EF4444; color: #7F1D1D; font-size: 15px; font-weight: 600; line-height: 1.6; }
        .cancelled-hint { margin: 14px 0 0; color: #475569; font-size: 14px; line-height: 1.7; }
        .back-link { display: block; margin-top: 20px; padding: 13px 16px; border-radius: 12px; background: #0F766E; color: #fff; font-size: 15px; font-weight: 600; text-align: center; text-decoration: none; }

        @media (max-width: 760px) {
          .records-page { padding: 0; }
          .records-shell { border-width: 0; border-radius: 0; min-height: 100vh; }
        }
      </style>
    </head>
    <body>
      <main class="records-page">
        <section class="records-shell">
          <header class="records-hero">
            <div class="hero-overlay">
              <p>入住前屋況紀錄</p>
              <h1>${escapeHtml(title)}</h1>
              <span>這筆紀錄已放棄</span>
            </div>
          </header>

          <section class="record-section">
            <div class="cancelled-notice">這筆屋況紀錄已放棄，內容不會再更新，也不會送交房東確認。</div>
            <p class="cancelled-hint">若仍要為這次看房建立屋況紀錄，請回到屋況點交列表，重新點選「開始屋況點交」。</p>
            <a class="back-link" href="${escapeHtml(listUrl)}">回到屋況點交列表</a>
          </section>
        </section>
      </main>
    </body>
    </html>
  `;
}

router.get('/tenant/pre-inspections/:publicId/media/:entryId', async (req, res, next) => {
  const lineUserId = resolvePreInspectionUser(req, req.params.publicId);
  if (!lineUserId) return res.status(401).send('unauthorized');

  try {
    const entry = await withV2Driver(async (db) => {
      const targetSession = await preInspectionRepository.getSessionByPublicId(db, req.params.publicId);
      if (!targetSession) {
        return null;
      }
      const isTenant = targetSession.line_user_id === lineUserId;
      const isLandlord = !isTenant
        && await preInspectionRepository.isLandlordForSession(db, targetSession.id, lineUserId);
      const isCompletedContractParty = !isTenant && !isLandlord && await canReadCompletedAttachment(db, {
        lineUserId, sessionPublicId: req.params.publicId, entryId: req.params.entryId
      });
      if (!isTenant && !isLandlord && !isCompletedContractParty) {
        return null;
      }

      let rootMainSession = targetSession;
      while (rootMainSession.parent_session_id) {
        const parent = await preInspectionRepository.getSession(db, rootMainSession.parent_session_id);
        if (!parent) break;
        rootMainSession = parent;
      }

      if (rootMainSession.status === 'active' && targetSession.line_user_id !== lineUserId) {
        return null;
      }

      return db.get(`
        SELECT e.storage_path, e.public_url, e.entry_type, f.storage_key AS file_storage_key, f.storage_provider AS file_storage_provider
        FROM pre_inspection_entries e
        JOIN pre_inspection_sessions s ON s.id = e.session_id
        LEFT JOIN files f ON f.id = e.file_id
        WHERE e.id = ?
          AND (
            s.id = ?
            OR (s.parent_session_id = ? AND s.record_type = 'supplement' AND s.status != 'cancelled')
          )
      `, [req.params.entryId, rootMainSession.id, rootMainSession.id]);
    });

    if (!entry) return res.status(404).send('file not found');

    const contentType = entry.entry_type === 'image'
      ? 'image/jpeg'
      : entry.entry_type === 'video' ? 'video/mp4' : null;
    if (!contentType) return res.status(404).send('file not found');

    let bytes;
    try {
      // 有 file_id 就走 files 表(本機或 R2 都用同一套 readStoredFile 判斷);
      // 舊資料沒有 file_id,退回原本的本機 key 解析。
      if (entry.file_storage_key) {
        bytes = await readStoredFile({ storage_provider: entry.file_storage_provider, storage_key: entry.file_storage_key });
      } else {
        const key = mediaStorageKey(entry);
        if (!key) return res.status(404).send('file not found');
        bytes = await mediaStorage.get(key);
      }
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).send('file not found');
      throw error;
    }
    res.set({
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(bytes);
  } catch (error) {
    next(error);
  }
});

// 凍結的 591 刊登照同樣是 private 檔案。它們只應由這筆屋況點交的房客，或已封存紀錄
// 的房東讀取；不能使用不存在的 /files 路徑，也不能把 data/listing-images 掛成 static。
router.get('/tenant/pre-inspections/:publicId/reference-media/:filePublicId', async (req, res, next) => {
  const lineUserId = resolvePreInspectionUser(req, req.params.publicId);
  if (!lineUserId) return res.status(401).send('unauthorized');

  try {
    const file = await withV2Driver(async (db) => {
      const session = await preInspectionRepository.getSessionByPublicId(db, req.params.publicId);
      if (!session) return null;

      const isTenant = session.line_user_id === lineUserId;
      const isLandlord = !isTenant && await preInspectionRepository.isLandlordForSession(db, session.id, lineUserId);
      if (!isTenant && !isLandlord) return null;
      if (session.status === 'active' && !isTenant) return null;

      return db.get(`
        SELECT f.storage_key, f.storage_provider, f.mime_type
        FROM files f
        JOIN listing_media lm ON lm.file_id = f.id
        WHERE f.public_id = ?
          AND f.status = 'active'
          AND lm.listing_id = ?
        LIMIT 1
      `, [req.params.filePublicId, session.listing_id]);
    });

    if (!file || !FROZEN_IMAGE_TYPES.has(file.mime_type)) {
      return res.status(404).send('file not found');
    }

    let bytes;
    try {
      bytes = await readStoredFile(file);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).send('file not found');
      throw error;
    }

    res.set({
      'Content-Type': file.mime_type,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(bytes);
  } catch (error) {
    next(error);
  }
});

router.post('/tenant/pre-inspections/:publicId/confirm', async (req, res, next) => {
  const publicId = req.params.publicId;
  const lineUserId = resolvePreInspectionUser(req, publicId);
  if (!lineUserId) return res.status(401).send('<h1>401 Unauthorized</h1><p>請從 LINE 通知重新開啟。</p>');

  try {
    const result = await withV2Driver(async (db) => {
      const session = await preInspectionRepository.getSessionByPublicId(db, publicId);
      if (!session) return { ok: false, code: 'NOT_FOUND', message: '找不到此屋況紀錄。' };
      return confirmPreInspectionByLandlord(db, {
        sessionId: session.id,
        landlordLineUserId: lineUserId
      });
    });
    if (!result.ok) {
      const status = result.code === 'FORBIDDEN' ? 403 : result.code === 'NOT_FOUND' ? 404 : 409;
      return res.status(status).send(`<h1>${status}</h1><p>${escapeHtml(result.message)}</p>`);
    }
    return res.redirect(303, `/tenant/pre-inspections/${encodeURIComponent(publicId)}?confirmed=1`);
  } catch (error) {
    return next(error);
  }
});

router.get('/tenant/pre-inspections/:publicId', async (req, res, next) => {
  const publicId = req.params.publicId;
  const queryToken = req.query.token ? String(req.query.token).trim() : '';

  if (queryToken) {
    const verifiedUser = verifyPreInspectionToken(queryToken, publicId);

    if (!verifiedUser) {
      // Expired cards must reauthenticate; never derive identity from their payload.
      return res.redirect(302, `/tenant/pre-inspections/${encodeURIComponent(publicId)}`);
    }

    res.cookie('v2_inspection_token', queryToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000
    });

    return res.redirect(302, `/tenant/pre-inspections/${encodeURIComponent(publicId)}`);
  }

  const token = requestToken(req);
  const lineUserId = resolvePreInspectionUser(req, publicId);

  if (!lineUserId) {
    return res.send(liffBootstrap(req.originalUrl));
  }

  try {
    const html = await withV2Driver(async (db) => {
      const session = await preInspectionRepository.getSessionByPublicId(db, publicId);

      if (!session) {
        return null;
      }

      const isTenant = session.line_user_id === lineUserId;
      const isLandlord = !isTenant && await preInspectionRepository.isLandlordForSession(db, session.id, lineUserId);

      if (!isTenant && !isLandlord) {
        return 'FORBIDDEN';
      }

      let mainSession = session;
      while (mainSession.parent_session_id) {
        const parent = await preInspectionRepository.getSession(db, mainSession.parent_session_id);
        if (!parent) break;
        mainSession = parent;
      }

      // 房東不得透過任何 token 或 URL 查看 active session；只有 sealed 且已送交房東確認的紀錄才可由房東查看。
      if (mainSession.status === 'active' && !isTenant) {
        return 'FORBIDDEN';
      }

      // 已放棄的紀錄不會再有內容,照常渲染只會得到一個只剩標題與房源照片的半殘畫面。
      // 直接講清楚它已經放棄,並給一條路回到列表重新開始。
      if (mainSession.status === 'cancelled') {
        return cancelledRecordPage(mainSession.title || '目前房源', token);
      }

      const mainEntries = await preInspectionRepository.getSessionEntries(db, mainSession.id, 1000);
      const supplements = await db.all(`
        SELECT id FROM pre_inspection_sessions
        WHERE parent_session_id = ? AND record_type = 'supplement' AND status != 'cancelled'
        ORDER BY id ASC
      `, [mainSession.id]);

      let allEntries = [...mainEntries];
      for (const sup of supplements) {
        const supEntries = await preInspectionRepository.getSessionEntries(db, sup.id, 1000);
        allEntries = allEntries.concat(supEntries);
      }

      allEntries.sort((a, b) => {
        const da = new Date((a.created_at || '') + 'Z').getTime() || 0;
        const dbTime = new Date((b.created_at || '') + 'Z').getTime() || 0;
        return da - dbTime;
      });

      const title = mainSession.title || '目前房源';
      const dateStr = mainSession.started_at ? mainSession.started_at.split('T')[0] : '未知日期';
      const confirmedNotice = req.query.confirmed === '1'
        ? '<div class="confirmation-notice success">已確認此入住前屋況紀錄，房客已收到通知。</div>'
        : '';
      const landlordConfirmHtml = isLandlord && mainSession.confirmation_status === 'pending_landlord_confirmation'
        ? `<section class="record-section landlord-action"><h2 class="section-title" style="margin-top:0;">房東確認</h2><p>確認後會通知房客；若此紀錄列為合約附件一，也會同步解除該附件的待確認狀態。</p><form method="post" action="/tenant/pre-inspections/${encodeURIComponent(mainSession.public_id)}/confirm"><button type="submit">確認已查看屋況紀錄</button></form></section>`
        : isLandlord && mainSession.confirmation_status === 'landlord_confirmed'
          ? '<section class="record-section landlord-action confirmed"><strong>✓ 房東已確認此屋況紀錄</strong></section>'
          : '';

      // Load reference data
      const equipmentItems = await preInspectionRepository.getListingInspectionReference(db, mainSession.listing_id);
      const referenceImages = await preInspectionRepository.getListingImages(db, mainSession.listing_id, 8, {
        sessionPublicId: mainSession.public_id
      });

      const timelineHtml = allEntries.map(e => {
        const timeStr = formatTime(e.created_at);
        let contentHtml = '';

        const protectedMediaUrl = `/tenant/pre-inspections/${encodeURIComponent(mainSession.public_id)}/media/${encodeURIComponent(e.id)}`;
        if (e.entry_type === 'image' && (e.storage_path || e.public_url)) {
          contentHtml = `<div class="media-container"><img src="${escapeHtml(protectedMediaUrl)}" alt="照片附件"></div>`;
        } else if (e.entry_type === 'video' && (e.storage_path || e.public_url)) {
          contentHtml = `<div class="media-container"><video controls>
                           <source src="${escapeHtml(protectedMediaUrl)}" type="video/mp4">
                         </video></div>`;
        } else if (e.entry_type === 'text') {
          contentHtml = `<p>${escapeHtml(e.message_text)}</p>`;
        } else {
          let typeLabelFallback = '檔案';
          if (e.entry_type === 'image') typeLabelFallback = '照片';
          if (e.entry_type === 'video') typeLabelFallback = '影片';
          contentHtml = `<small>[${escapeHtml(typeLabelFallback)}附件已保存]</small>`;
        }

        let iconClass = 'text';
        let iconChar = '文';
        let kindStr = '文字備註';
        if (e.entry_type === 'image') { iconClass = 'image'; iconChar = '圖'; kindStr = '照片'; }
        if (e.entry_type === 'video') { iconClass = 'video'; iconChar = '影'; kindStr = '影片'; }
        const itemContextHtml = e.inspection_item_name ? `
          <div class="item-context">
            <strong>設備：${escapeHtml(e.inspection_item_name)}</strong>
            ${e.inspection_item_note ? `<span>備註：${escapeHtml(e.inspection_item_note)}</span>` : ''}
          </div>
        ` : '';

        return `
          <article class="event">
            <div class="event-icon ${iconClass}">${iconChar}</div>
            <div class="event-card">
              <div class="event-meta">
                <span>${kindStr}${e.inspection_item_name ? `｜${escapeHtml(e.inspection_item_name)}` : ''}</span>
                <time>${timeStr}</time>
              </div>
              ${itemContextHtml}
              ${contentHtml}
            </div>
          </article>
        `;
      }).join('');

      // Build equipment list HTML
      const equipmentHtml = equipmentItems.length > 0
        ? equipmentItems.map(item => `<span class="equipment-badge">${escapeHtml(item)}</span>`).join('')
        : `<span class="empty-badge">暫無房源設備資訊</span>`;

      // Build reference images HTML
      const referenceImagesHtml = referenceImages.length > 0
        ? referenceImages.map(img => `
            <div class="reference-photo-item">
              <img src="${escapeHtml(img)}" alt="刊登參考照片" onerror="this.closest('.reference-photo-item').remove()">
            </div>
          `).join('')
        : '';

      return `
        <!DOCTYPE html>
        <html lang="zh-Hant">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
          <title>入住前屋況紀錄 - ${escapeHtml(title)}</title>
          <style>
            * { box-sizing: border-box; }
            body { margin: 0; background: #F8FAFC; color: #111827; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight: 400; }
            .records-page { width: min(800px, 100%); margin: 0 auto; padding: 18px 14px 34px; }
            .records-shell { overflow: hidden; background: #fff; border: 1px solid #E5E7EB; border-radius: 18px; box-shadow: 0 16px 42px rgba(15,23,42,.08); }
            .records-hero { background-image: linear-gradient(90deg, rgba(15,118,110,.92), rgba(15,23,42,.86)), url('/assets/ecs-neo-logo.png'); background-size: cover; background-position: center; color: #fff; }
            .hero-overlay { padding: 22px; }
            .records-hero p { margin: 0 0 8px; font-size: 13px; font-weight: 800; color: #A7E5D7; }
            .records-hero h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.25; font-weight: 600; }
            .records-hero span { font-size: 14px; opacity: .9; }
            .record-section { padding: 24px 16px; border-top: 1px solid #F1F5F9; }

            .timeline { display: grid; gap: 14px; }
            .event { position: relative; display: grid; grid-template-columns: 34px 1fr; gap: 12px; padding-bottom: 14px; }
            .event::before { content: ""; position: absolute; left: 16px; top: 36px; bottom: 0; width: 1px; background: #E5E7EB; }
            .event:last-child::before { display: none; }
            .event-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; font-size: 13px; font-weight: 700; }
            .event-icon.text { color: #0F8F7F; background: #ECFDF8; }
            .event-icon.image { color: #2563EB; background: #EFF6FF; }
            .event-icon.video { color: #E94B5F; background: #FFF3F5; }
            .event-card { padding: 14px; border: 1px solid #E5E7EB; border-radius: 15px; background: #fff; box-shadow: 0 2px 6px rgba(15,23,42,.02); }
            .event-meta { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: #0F172A; font-size: 13px; font-weight: 600; }
            .event-meta time { color: #64748B; font-weight: 400; font-size: 12px; }
            .event-card p { margin: 0; font-size: 14px; line-height: 1.5; color: #334155; white-space: pre-wrap; }
            .item-context { display: grid; gap: 3px; margin: 0 0 10px; padding: 9px 10px; border-radius: 10px; background: #ECFDF5; border: 1px solid #CCFBF1; color: #0F766E; font-size: 13px; line-height: 1.45; }
            .item-context span { color: #475569; white-space: pre-wrap; }
            .event-card small { display: block; padding: 8px 10px; border-radius: 10px; background: #F8FAFC; color: #64748B; font-size: 12px; }
            .media-container { margin-top: 6px; border-radius: 12px; overflow: hidden; background: #F8FAFC; border: 1px solid #E5E7EB; }
            .media-container img, .media-container video { display: block; width: 100%; max-height: 400px; object-fit: contain; }
            .empty-state { text-align: center; color: #64748B; padding: 40px 0; font-size: 14px; }

            .section-title { font-size: 16px; font-weight: 700; color: #1E293B; margin: 24px 0 12px; }
            .equipment-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
            .equipment-badge { font-size: 13px; font-weight: 500; color: #0F766E; background: #ECFDF5; padding: 6px 14px; border-radius: 9999px; border: 1px solid #CCFBF1; }
            .empty-badge { font-size: 13px; color: #94A3B8; background: #F8FAFC; border: 1px dashed #E2E8F0; padding: 6px 14px; border-radius: 9999px; }

            .reference-notice { font-size: 12px; color: #64748B; background: #F1F5F9; padding: 10px 14px; border-radius: 10px; border-left: 4px solid #94A3B8; margin-bottom: 14px; }
            .reference-photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 20px; }
            .reference-photo-item { border-radius: 12px; overflow: hidden; background: #F8FAFC; border: 1px solid #E2E8F0; aspect-ratio: 4/3; }
            .reference-photo-item img { width: 100%; height: 100%; object-fit: cover; }
            .confirmation-notice { margin: 16px 16px 0; padding: 12px 14px; border-radius: 12px; font-size: 14px; font-weight: 650; }
            .confirmation-notice.success { color: #065F46; background: #ECFDF5; border: 1px solid #A7F3D0; }
            .landlord-action { background: #F0FDFA; }
            .landlord-action p { margin: 0 0 14px; color: #475569; line-height: 1.6; font-size: 14px; }
            .landlord-action button { width: 100%; border: 0; border-radius: 12px; padding: 14px 16px; background: #0F766E; color: #fff; font-size: 15px; font-weight: 750; }
            .landlord-action.confirmed { color: #047857; font-size: 15px; }

            @media (max-width: 760px) {
              .records-page { padding: 0; }
              .records-shell { border-width: 0; border-radius: 0; min-height: 100vh; }
            }
          </style>
        </head>
        <body>
          <main class="records-page">
            <section class="records-shell">
              <header class="records-hero">
                <div class="hero-overlay">
                  ${mainSession.status === 'active' ? `<div style="background:#FEF3C7;color:#D97706;padding:6px 12px;border-radius:8px;font-weight:bold;font-size:13px;display:inline-block;margin-bottom:10px;border:1px solid #FCD34D;">⚡ 點交進行中，內容尚未封存</div>` : ''}
                  <p>${mainSession.status === 'active' ? '入住前屋況紀錄（進行中）' : '入住前屋況紀錄'}</p>
                  <h1>${escapeHtml(title)}</h1>
                  <span>建立日期：${escapeHtml(dateStr)}｜共 ${allEntries.length} 筆內容</span>
                </div>
              </header>
              ${confirmedNotice}
              ${landlordConfirmHtml}

              <!-- Reference Information Section -->
              <section class="record-section" style="background: #FAFAF9; border-bottom: 1px solid #E7E5E4;">
                <h2 class="section-title" style="margin-top: 0;">📋 房源設備清單 (點交參考)</h2>
                <div class="equipment-list">
                  ${equipmentHtml}
                </div>

                <h2 class="section-title">📸 刊登參考照片 (非正式點交照片)</h2>
                ${referenceImages.length > 0 ? `
                  <p class="reference-notice">⚠️ 以下照片僅供刊登參考，正式點交仍以房客實地拍攝之照片為準。</p>
                  <div class="reference-photos">
                    ${referenceImagesHtml}
                  </div>
                ` : `
                  <div class="empty-badge" style="display: block; margin-top: 6px; padding: 12px 16px;">暫無可用刊登參考照片</div>
                `}
              </section>

              <!-- Timeline Section -->
              <section class="record-section">
                <h2 class="section-title" style="margin-top: 0; color: #0F766E;">📝 房客點交照片與紀錄</h2>
                <div class="timeline">
                  ${allEntries.length > 0 ? timelineHtml : (
                    mainSession.status === 'active'
                      ? '<div class="empty-state"><p style="margin: 0; font-size: 14px; font-weight: 600; color: #475569;">目前尚未上傳任何照片、影片或備註</p><p style="margin: 4px 0 0; font-size: 12px; color: #94A3B8;">您可以從 LINE 傳送照片、影片或文字備註加入此紀錄</p></div>'
                      : '<div class="empty-state">目前這份紀錄尚未加入內容</div>'
                  )}
                </div>
              </section>
            </section>
          </main>
        </body>
        </html>
      `;
    });

    if (html === 'FORBIDDEN') {
      return res.status(403).send('<h1>403 Forbidden</h1><p>無權限查看此紀錄</p>');
    }

    if (!html) {
      return res.status(404).send('<h1>找不到此屋況紀錄</h1>');
    }

    res.send(html);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
