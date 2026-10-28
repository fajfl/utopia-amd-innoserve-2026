const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withInjectedSqlite, withV2Driver } = require('../database/v2Driver');
const { client: lineClient } = require('../lineClient');
const { getValidLiffId, identityMiddleware, liffBootstrap } = require('../services/liffSessionService');
const slots = require('../repositories/v2ShowingSlotRepositoryAsync');
const { localStamp } = require('../services/showingSlotTime');
const { enqueueNotification } = require('../services/ecsNeoOutboxAsync');
const { readStoredFile } = require('../services/fileStorage');
const { RENEWAL_WINDOW_MONTHS } = require('../constants/renewalConstants');

// 只有這幾種會被當成圖片送出去。凍結時是用 magic bytes 判的,這裡再擋一次。
const FROZEN_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// 有凍結副本就用自己的,否則退回 591 的 CDN。房源下架後 source_url 會掛,
// 凍結過的那些才活得下來。
function listingImageUrl(row) {
  return row && row.image_file_public_id
    ? `/v2/tenant/listing-images/${encodeURIComponent(row.image_file_public_id)}`
    : (row && row.image_url) || null;
}

function createTenantInquiryRoutes({ getDb: customGetDb } = {}) {
  const router = express.Router();

  // 這裡原本有一個 getDb() 單例,自己開 data/ecs-neo-v2.sqlite。所有路由都改走
  // driver 之後它已經沒有呼叫端,直接移除——留著只會讓下一個人又寫回本機檔案,
  // 而房客的資料已經在 TiDB 了。
  //
  // 測試用 getDb 注入自己的連線。包成 driver 交給路由用,否則路由會透過
  // withV2Driver 的單例**再開一次同一個 sqlite 檔**,跟測試持有的連線搶寫鎖,
  // 跑 migration 時直接卡住不會逾時。
  const withDriver = customGetDb ? withInjectedSqlite(customGetDb) : withV2Driver;

  // UI Route: Portal首頁
  router.get('/', (req, res) => {
    const liffState = String(req.query['liff.state'] || '');
    // liff.init() 讀到 liff.state 會自行導頁，這一輪送 bootstrap 只會白跑一次身分確認；直接交給落地頁處理。
    // liff.state 可能帶有 query string（例如 /preInspectionList?token=xxx）
    // 必須保留完整的 path + query，否則 token 會被丟掉導致目標頁面驗證失敗
    const decoded = decodeURIComponent(liffState);
    // 只接受站內絕對路徑，'//' 開頭會被瀏覽器當成外部網域。
    if (decoded.startsWith('/') && !decoded.startsWith('//')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.query.code && req.query.state) return res.send(liffBootstrap(decoded));
      return res.redirect(decoded);
    }
    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ECS NEO - 系統入口</title>
  <style>
    body {
      margin: 0;
      background: linear-gradient(135deg, #0f766e 0%, #1e3a8a 100%);
      color: #ffffff;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .portal-card {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 24px;
      padding: 32px 24px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
      text-align: center;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 0.5px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background-color: #10b981;
      border-radius: 50%;
      margin-right: 6px;
      animation: pulse 2s infinite;
    }
    p.desc {
      color: #cbd5e1;
      font-size: 14px;
      margin: 0 0 32px;
      line-height: 1.5;
    }
    .links-group {
      display: grid;
      gap: 16px;
    }
    .portal-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      background: #ffffff;
      color: #0f766e;
      text-decoration: none;
      padding: 14px;
      border-radius: 16px;
      font-weight: 700;
      font-size: 15px;
      transition: background 0.2s, transform 0.2s;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    .portal-btn:hover, .portal-btn:active {
      background: #f1f5f9;
      transform: translateY(-2px);
    }
    .portal-btn.secondary {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: none;
    }
    .portal-btn.secondary:hover, .portal-btn.secondary:active {
      background: rgba(255, 255, 255, 0.25);
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
  </style>
</head>
<body>
  <div class="portal-card">
    <h1>ECS NEO</h1>
    <div class="status-badge">
      <span class="status-dot"></span>服務運行中
    </div>
    <p class="desc">歡迎使用租賃管理開發測試入口，請點擊下方按鈕存取對應功能網頁。</p>
    <div class="links-group">
      <a class="portal-btn" href="/findHouses">🔍 找房紀錄與預約</a>
      <a class="portal-btn secondary" href="/rentalNotification">🏠 房客租屋通知</a>
      <a class="portal-btn secondary" href="/preInspectionList">📋 屋況點交列表</a>
      <a class="portal-btn secondary" href="/pre-inspections">🔧 屋況點交 (舊版)</a>
    </div>
  </div>
</body>
</html>`;
    res.send(html);
  });

  // 統一身分檢索。實作搬到 services/liffSessionService.js,房東管理頁用的是同一支,
  // 兩邊的 cookie 規則不會分岔。
  router.use(identityMiddleware);

  // UI Route: rentalNotification
  router.get('/rentalNotification', (req, res) => {
    if (!req.v2LineUserId) {
      return res.send(liffBootstrap(req.originalUrl));
    }

    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>房客租屋通知</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 100%);
      color: #1f2937;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      padding: 16px 12px;
    }
    header {
      text-align: center;
      margin-bottom: 24px;
    }
    header h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      color: #0f766e;
    }
    header p {
      margin: 4px 0 0;
      font-size: 13px;
      color: #6b7280;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .card {
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 4px 20px rgba(15, 118, 110, 0.05);
    }
    .card-title {
      font-size: 16px;
      font-weight: 700;
      color: #0f766e;
      margin: 0 0 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e5e7eb;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .info-label {
      color: #6b7280;
    }
    .info-value {
      font-weight: 600;
      color: #111827;
      text-align: right;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-active { background: #dcfce7; color: #16a34a; }
    .status-warning { background: #fef3c7; color: #d97706; }
    .status-expired { background: #fee2e2; color: #dc2626; }
    .status-pending { background: #e0e7ff; color: #4338ca; }
    
    .renewal-alert {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 16px;
      color: #b45309;
    }
    .renewal-alert strong { display: block; margin-bottom: 4px; }
    
    .repair-item, .viewing-item {
      padding: 12px;
      background: #f9fafb;
      border-radius: 8px;
      margin-bottom: 8px;
    }
    .repair-item:last-child { margin-bottom: 0; }
    
  </style>
</head>
<body>
  <header>
    <h1>房客租屋通知</h1>
    <p>目前租屋案件與進度</p>
  </header>
  
  <div id="loading" style="text-align:center; color:#6b7280; margin-top:40px;">資料載入中...</div>
  <div id="error" style="display:none; text-align:center; color:#dc2626; margin-top:40px;"></div>
  
  <main class="container" id="app-container" style="display:none;">
    <!-- Rendered by JS -->
  </main>

  <script>
    window.APP_CONFIG = {
      liffId: ${JSON.stringify(getValidLiffId())}
    };
  </script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script src="/assets/rentalNotification.js?t=${Date.now()}"></script>
</body>
</html>`;
    res.send(html);
  });

  // UI Route: findHouses
  router.get('/findHouses', (req, res) => {
    if (!req.v2LineUserId) {
      return res.send(liffBootstrap(req.originalUrl));
    }

    // 渲染 HTML
    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>找房紀錄</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 100%);
      color: #1f2937;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      padding: 16px 12px;
    }
    header {
      text-align: center;
      margin-bottom: 24px;
    }
    header h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      color: #0f766e;
    }
    header p {
      margin: 4px 0 0;
      font-size: 13px;
      color: #6b7280;
    }
    .list-container {
      max-width: 600px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .house-card {
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 4px 20px rgba(15, 118, 110, 0.05);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .house-card:active {
      transform: scale(0.98);
    }
    .house-main {
      display: flex;
      gap: 12px;
    }
    .house-img-container {
      width: 80px;
      height: 80px;
      border-radius: 12px;
      overflow: hidden;
      background: #e5e7eb;
      flex-shrink: 0;
    }
    .house-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .house-info {
      flex: 1;
      display: flex;
      flex-content: space-between;
      flex-direction: column;
    }
    .house-title {
      font-size: 15px;
      font-weight: 600;
      color: #111827;
      margin: 0 0 4px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .house-rent {
      font-size: 14px;
      font-weight: 700;
      color: #ea580c;
      margin: 0;
    }
    .house-badge {
      display: inline-block;
      align-self: flex-start;
      margin-top: 4px;
      padding: 2px 6px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-active {
      background: #ccfbf1;
      color: #0f766e;
    }
    .badge-inactive {
      background: #f3f4f6;
      color: #6b7280;
    }
    .appt-status {
      margin-top: 12px;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 500;
    }
    .appt-pending { background: #fef3c7; color: #d97706; }
    .appt-confirmed { background: #dcfce7; color: #16a34a; }
    .appt-rejected { background: #fee2e2; color: #dc2626; }
    
    .btn-cancel {
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      cursor: pointer;
    }
    
    .btn-group {
      margin-top: 14px;
      display: flex;
      gap: 10px;
    }
    .btn {
      flex: 1;
      border: 0;
      padding: 10px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      text-align: center;
      transition: opacity 0.2s;
    }
    .btn:active {
      opacity: 0.8;
    }
    .btn-ask {
      background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%);
      color: #fff;
      box-shadow: 0 4px 10px rgba(15, 118, 110, 0.2);
    }
    .btn-ask:disabled {
      background: #d1d5db;
      color: #9ca3af;
      box-shadow: none;
      cursor: not-allowed;
    }
    .btn-reserve {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      color: #fff;
      box-shadow: 0 4px 10px rgba(37, 99, 235, 0.2);
    }
    
    /* Inline reservation picker */
    .reserve-box {
      margin-top: 12px;
      padding: 12px;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #f9fafb;
      display: none;
    }
    .reserve-box.open {
      display: block;
    }
    .reserve-box label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #4b5563;
      margin-bottom: 6px;
    }
    .reserve-box input {
      width: 100%;
      padding: 8px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 10px;
    }
    .reserve-btn-row {
      display: flex;
      gap: 8px;
    }
    .reserve-btn-row button {
      flex: 1;
      padding: 6px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      border: 0;
      cursor: pointer;
    }
    .btn-submit-appt {
      background: #2563eb;
      color: #fff;
    }
    .btn-cancel-appt {
      background: #e5e7eb;
      color: #4b5563;
    }

    /* Modern Popup Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(15, 23, 42, 0.6);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
      padding: 20px;
    }
    .modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-card {
      background: #ffffff;
      border-radius: 24px;
      padding: 28px 24px;
      width: 100%;
      max-width: 360px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
      transform: scale(0.9);
      transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .modal-overlay.active .modal-card {
      transform: scale(1);
    }
    .modal-icon {
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, #ccfbf1 0%, #99f6e4 100%);
      color: #0f766e;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      margin: 0 auto 16px;
      box-shadow: 0 8px 16px rgba(15, 118, 110, 0.15);
    }
    .modal-title {
      font-size: 18px;
      font-weight: 700;
      color: #111827;
      margin: 0 0 8px;
    }
    .modal-desc {
      font-size: 14px;
      color: #4b5563;
      margin: 0 0 24px;
      line-height: 1.5;
    }
    .modal-btn {
      width: 100%;
      background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%);
      color: #ffffff;
      border: 0;
      padding: 14px;
      border-radius: 14px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(15, 118, 110, 0.3);
      transition: transform 0.15s, opacity 0.15s;
    }
    .modal-btn:active {
      transform: scale(0.98);
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <header>
    <h1>找房紀錄</h1>
    <p>點選房源進行詢問、看房預約</p>
  </header>
  <main class="list-container" id="inquiry-list">
    <p style="text-align:center; color:#6b7280; font-size:14px;">載入中…</p>
  </main>

  <!-- Popup Modal -->
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal-card">
      <div class="modal-icon">💬</div>
      <h3 class="modal-title" id="modal-title">對話情境已切換</h3>
      <p class="modal-desc" id="modal-desc">已成功切換對話情境！系統已在 LINE 聊天室為您準備好對話，點擊下方按鈕即可返回。</p>
      <button class="modal-btn" id="modal-confirm-btn" onclick="closeModalAndReturn()">返回 LINE 聊天室</button>
    </div>
  </div>

  <script>
    window.APP_CONFIG = {
      liffId: ${JSON.stringify(getValidLiffId())}
    };
  </script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script src="/assets/tenantInquiry.js?t=${Date.now()}"></script>
</body>
</html>`;
    res.send(html);
  });

  // APIs

  // 凍結後的 591 房源圖。security_classification 是 private,所以不能像原本的
  // pre-inspection 那樣掛 express.static —— 靠網址難猜不是權限。
  //
  // 授權條件跟合約檔案那條路由同一套:必須是這筆房源上還沒結束的詢問的當事人。
  // 走 file_links 是因為凍結時就是往那裡寫關聯,不必另外維護一張對照表。
  router.get('/v2/tenant/listing-images/:filePublicId', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).send('unauthorized');

    try {
      const file = await withDriver((db) => db.get(`
      SELECT f.storage_key, f.storage_provider, f.mime_type
      FROM files f
      JOIN file_links fl ON fl.file_id = f.id AND fl.entity_type = 'listing_media'
      JOIN listing_media lm ON lm.id = fl.entity_id
      JOIN inquiries i ON i.listing_id = lm.listing_id AND i.ended_at IS NULL
      JOIN line_identities li ON li.user_id = i.user_id
      WHERE f.public_id = ? AND li.line_user_id = ? AND f.status = 'active'
      LIMIT 1
    `, [req.params.filePublicId, lineUserId]));
      // 查不到跟沒有權限都回 404,否則 404/403 的差別會洩漏這個 id 存不存在。
      if (!file) return res.status(404).send('file not found');

      // mime_type 只取白名單內的值。它是寫入時判斷 magic bytes 得到的,但這裡是
      // 同源提供內容,萬一哪天寫入端鬆掉,text/html 就會變成儲存型 XSS。
      const contentType = FROZEN_IMAGE_TYPES.has(file.mime_type) ? file.mime_type : null;
      if (!contentType) return res.status(404).send('file not found');

      let bytes;
      try {
        // 凍結圖片的既有 local key 可能由測試／匯入工具指向工作目錄外；
        // 仍維持原讀法。R2 才交給共用讀取器。
        bytes = file.storage_provider === 's3'
          ? await readStoredFile(file)
          : await fs.promises.readFile(path.resolve(process.cwd(), file.storage_key));
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).send('file not found');
        throw error;
      }
      res.set({
        'Content-Type': contentType,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(bytes);
    } catch (error) {
      next(error);
    }
  });

  router.get('/v2/api/tenant/rental-notification', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
      const data = await withDriver(async (db) => {
        const userRow = await db.get('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
        if (!userRow) return null;
        const userId = userRow.user_id;

        // 1. Lease & Contract
        const lease = await db.get(`
        SELECT 
          le.id, le.start_date, le.end_date, le.rent_due_day, le.status, le.contract_id, le.rental_unit_id
        FROM lease_parties lp
        JOIN leases le ON le.id = lp.lease_id
        WHERE lp.user_id = ? AND lp.party_role = 'tenant' 
          AND le.status IN ('scheduled', 'active', 'ended')
        ORDER BY CASE le.status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, le.start_date DESC
        LIMIT 1
      `, [userId]);

        let contractInfo = null;
        let propertyInfo = null;
        let landlordInfo = null;
        let renewalInfo = null;
        let signingInfo = { hasDraft: false, latestDraftVersion: null, landlordSigned: false, tenantSigned: false, contractStatus: null };

        let rentalUnitId = null;

        if (lease) {
          rentalUnitId = lease.rental_unit_id;
          // property info
          propertyInfo = await db.get(`
          SELECT p.address_text AS addressText, p.building_name AS buildingName, 
                 ru.unit_label AS unitLabel, ru.rental_type AS rentalType
          FROM rental_units ru
          JOIN properties p ON p.id = ru.property_id
          WHERE ru.id = ?
        `, [rentalUnitId]);

          // landlord info
          landlordInfo = await db.get(`
          SELECT up.display_name AS displayName, up.legal_name AS legalName
          FROM contract_parties cp
          JOIN user_profiles up ON up.user_id = cp.user_id
          WHERE cp.contract_id = ? AND cp.party_role = 'landlord' AND cp.status = 'active'
          LIMIT 1
        `, [lease.contract_id]);

          // Executed Contract condition
          const contractVer = await db.get(`
          SELECT cv.condition_snapshot_json, cv.public_id, c.executed_at, c.public_id as contract_public_id
          FROM contract_versions cv
          JOIN contracts c ON c.id = cv.contract_id
          WHERE cv.contract_id = ? AND cv.status = 'executed'
          ORDER BY cv.version_number DESC
          LIMIT 1
        `, [lease.contract_id]);

          if (contractVer) {
            const condition = JSON.parse(contractVer.condition_snapshot_json || '{}');
            contractInfo = {
              publicId: contractVer.contract_public_id,
              executedAt: contractVer.executed_at,
              monthlyRent: condition.rent?.monthly_rent_ntd || null,
              depositAmount: condition.deposit?.deposit_amount_ntd || null,
              depositMonths: condition.deposit?.deposit_months || null,
              managementFee: condition.fees?.management_fee || null,
              waterFee: condition.fees?.water_fee || null,
              electricityFee: condition.fees?.electricity_fee || null,
              paymentDueDay: condition.rent?.payment_due_day || null
            };
          }

          // Renewal
          if (lease.end_date) {
            const endDate = new Date(lease.end_date);
            const renewalStart = new Date(endDate);
            renewalStart.setMonth(renewalStart.getMonth() - RENEWAL_WINDOW_MONTHS);
            const today = new Date();

            renewalInfo = {
              endDate: lease.end_date,
              renewalStartDate: renewalStart.toISOString().split('T')[0],
              inRenewalPeriod: today >= renewalStart && today < endDate,
              isExpired: today > endDate
            };
          }
        } else {
          // if no lease, let's check if there is an active contract draft for the tenant
          const contract = await db.get(`
          SELECT c.id, c.rental_unit_id, c.status
          FROM contract_parties cp
          JOIN contracts c ON c.id = cp.contract_id
          WHERE cp.user_id = ? AND cp.party_role = 'tenant' AND c.status IN ('drafting', 'awaiting_confirmation', 'signing')
          ORDER BY c.updated_at DESC LIMIT 1
        `, [userId]);

          if (contract) {
            signingInfo.hasDraft = true;
            signingInfo.contractStatus = contract.status;
            rentalUnitId = contract.rental_unit_id;

            propertyInfo = await db.get(`
            SELECT p.address_text AS addressText, p.building_name AS buildingName, 
                   ru.unit_label AS unitLabel, ru.rental_type AS rentalType
            FROM rental_units ru
            JOIN properties p ON p.id = ru.property_id
            WHERE ru.id = ?
          `, [rentalUnitId]);

            landlordInfo = await db.get(`
            SELECT up.display_name AS displayName, up.legal_name AS legalName
            FROM contract_parties cp
            JOIN user_profiles up ON up.user_id = cp.user_id
            WHERE cp.contract_id = ? AND cp.party_role = 'landlord' AND cp.status = 'active'
            LIMIT 1
          `, [contract.id]);

            const latestVersion = await db.get(`
            SELECT public_id, version_number, status
            FROM contract_versions
            WHERE contract_id = ?
            ORDER BY version_number DESC LIMIT 1
          `, [contract.id]);

            if (latestVersion) {
              signingInfo.latestDraftVersion = {
                publicId: latestVersion.public_id,
                versionNumber: latestVersion.version_number,
                status: latestVersion.status
              };
            }

            // Check signature requests
            if (contract.status === 'signing') {
              const sigReqs = await db.all(`
              SELECT sr.status, cp.party_role
              FROM signature_requests sr
              JOIN contract_parties cp ON cp.id = sr.contract_party_id
              WHERE sr.contract_version_id = (SELECT id FROM contract_versions WHERE contract_id = ? ORDER BY version_number DESC LIMIT 1)
            `, [contract.id]);

              for (const sr of sigReqs) {
                if (sr.party_role === 'landlord' && sr.status === 'signed') signingInfo.landlordSigned = true;
                if (sr.party_role === 'tenant' && sr.status === 'signed') signingInfo.tenantSigned = true;
              }
            }
          }
        }

        // repairs (only if we have a rental_unit_id from either lease or draft)
        let repairs = [];
        if (rentalUnitId && lease) {
          repairs = await db.all(`
          SELECT public_id, category, description, status, reported_at, 
                 (SELECT MAX(created_at) FROM repair_updates WHERE repair_ticket_id = rt.id) AS last_update_at
          FROM repair_tickets rt
          WHERE rt.lease_id = ? AND rt.reported_by_user_id = ?
            AND rt.status NOT IN ('cancelled')
          ORDER BY rt.reported_at DESC
          LIMIT 5
        `, [lease.id, userId]);
        }

        // viewing reservation (confirmed)
        const viewingReservation = await db.get(`
        SELECT sa.public_id, sa.starts_at, sa.status, l.title AS listingTitle
        FROM showing_appointments sa
        LEFT JOIN listings l ON l.id = sa.listing_id
        WHERE sa.tenant_user_id = ? AND sa.status = 'confirmed'
          AND sa.starts_at >= ?
        ORDER BY sa.starts_at ASC
        LIMIT 1
      `, [userId, new Date().toISOString().slice(0, 10)]);

        const tenantInfo = await db.get('SELECT display_name AS displayName, legal_name AS legalName FROM user_profiles WHERE user_id = ?', [userId]);

        return {
          lease: lease ? { id: lease.id, startDate: lease.start_date, endDate: lease.end_date, rentDueDay: lease.rent_due_day, status: lease.status } : null,
          property: propertyInfo,
          landlord: landlordInfo,
          tenant: tenantInfo,
          contract: contractInfo,
          renewal: renewalInfo,
          repairs: repairs.map(r => ({
            publicId: r.public_id,
            category: r.category,
            description: r.description,
            status: r.status,
            reportedAt: r.reported_at,
            lastUpdateAt: r.last_update_at
          })),
          viewingReservation: viewingReservation ? {
            publicId: viewingReservation.public_id,
            startsAt: viewingReservation.starts_at,
            status: viewingReservation.status,
            listingTitle: viewingReservation.listingTitle
          } : null,
          signing: signingInfo
        };
      });

      if (!data) {
        return res.status(404).json({ ok: false, error: 'User data not found' });
      }

      res.json({ ok: true, data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/v2/api/tenant/inquiries', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
      const result = await withDriver(async (db) => {
        const userRow = await db.get('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
        if (!userRow) return [];
        const userId = userRow.user_id;

        const inquiries = await db.all(`
    SELECT 
      i.id AS id,
      i.public_id AS public_id,
      i.listing_id AS listing_id,
      i.status AS status,
      l.title AS title,
      l.current_rent_amount AS rent_amount,
      cover.source_url AS image_url,
      cover_file.public_id AS image_file_public_id,
      (SELECT 1 FROM active_inquiry_contexts aic
       JOIN line_identities li ON li.id = aic.line_identity_id
       WHERE li.line_user_id = ? AND aic.inquiry_id = i.id AND aic.cleared_at IS NULL) AS is_active_context
    FROM inquiries i
    JOIN listings l ON l.id = i.listing_id
    LEFT JOIN (
      SELECT lm.listing_id, lm.source_url, lm.file_id,
             ROW_NUMBER() OVER (PARTITION BY lm.listing_id ORDER BY lm.sort_order ASC, lm.id ASC) rn
      FROM listing_media lm WHERE lm.media_type = 'image'
    ) cover ON cover.listing_id = l.id AND cover.rn = 1
    LEFT JOIN files cover_file ON cover_file.id = cover.file_id AND cover_file.status = 'active'
    WHERE i.user_id = ? AND i.ended_at IS NULL
    ORDER BY i.last_activity_at DESC
  `, [lineUserId, userId]);

        // 每筆詢問最新的一筆預約。原本是在迴圈裡一筆一筆查,本機檔案沒差,但接上
        // TiDB 之後每一筆都是一次跨區來回——15 筆詢問就是 15 趟。改成一次撈完。
        const appointments = new Map();
        if (inquiries.length) {
          const rows = await db.all(`
      SELECT inquiry_id, public_id, starts_at, status FROM (
        SELECT sa.inquiry_id, sa.public_id, sa.starts_at, sa.status,
               ROW_NUMBER() OVER (PARTITION BY sa.inquiry_id ORDER BY sa.id DESC) rn
        FROM showing_appointments sa
        WHERE sa.status IN ('pending', 'confirmed', 'rejected')
      ) latest WHERE latest.rn = 1
    `, []);
          for (const row of rows) appointments.set(row.inquiry_id, row);
        }

        return inquiries.map(inq => {
          const appt = appointments.get(inq.id);
          return {
            publicId: inq.public_id,
            listingId: inq.listing_id,
            title: inq.title,
            rentAmount: inq.rent_amount,
            imageUrl: listingImageUrl(inq),
            isActiveContext: Boolean(inq.is_active_context),
            appointment: appt ? {
              publicId: appt.public_id,
              startsAt: appt.starts_at,
              status: appt.status
            } : null
          };
        });
      });

      res.json({ ok: true, inquiries: result });
    } catch (error) {
      next(error);
    }
  });

// ── Calendar Web Page ──
  router.get('/calendar', (req, res) => {
    const publicDemo = process.env.V2_CONTRACT_DEMO_PUBLIC === 'true';
    if (!publicDemo && !req.v2LineUserId) {
      return res.send(liffBootstrap(req.originalUrl));
    }
    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>\u884c\u4e8b\u66c6</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 100%);
      color: #1f2937; font-family: system-ui, -apple-system, sans-serif;
      min-height: 100vh; padding: 16px 12px;
    }
    header { text-align: center; margin-bottom: 20px; }
    header h1 { font-size: 22px; font-weight: 700; color: #0f766e; }
    header p { font-size: 13px; color: #6b7280; margin-top: 4px; }
    .cal-container { max-width: 420px; margin: 0 auto; }
    .cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .cal-nav button { background: #0f766e; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 14px; cursor: pointer; }
    .cal-nav button:active { opacity: 0.8; }
    .cal-nav .cal-title { font-size: 18px; font-weight: 700; color: #0f766e; }
    .cal-grid {
      background: rgba(255,255,255,0.85); backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.4); border-radius: 16px;
      padding: 12px; box-shadow: 0 4px 20px rgba(15,118,110,0.05);
    }
    .cal-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; margin-bottom: 4px; }
    .cal-weekdays span { font-size: 12px; color: #94a3b8; font-weight: 600; padding: 4px 0; }
    .cal-days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
    .cal-day { text-align: center; padding: 8px 0; font-size: 13px; color: #334155; border-radius: 999px; cursor: default; position: relative; }
    .cal-day.empty { color: transparent; }
    .cal-day.today { font-weight: 700; box-shadow: inset 0 0 0 2px #0f766e; }
    .cal-day.has-event { font-weight: 700; }
    .cal-day .dot { width: 5px; height: 5px; border-radius: 50%; position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); }
    .legend { display: flex; gap: 16px; justify-content: center; margin: 12px 0; }
    .legend span { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #64748b; }
    .legend span::before { content: ''; width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .legend .l-pay::before { background: #E94B5F; }
    .legend .l-show::before { background: #0F8F7F; }
    .legend .l-contract::before { background: #7C9A1F; }
    .legend .l-repair::before { background: #F59E0B; }
    .events-title { font-size: 14px; font-weight: 700; color: #0f766e; margin: 16px 0 8px; }
    .event-card {
      background: rgba(255,255,255,0.85); border-radius: 12px; padding: 12px; margin-bottom: 8px;
      border-left: 4px solid #ccc; box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .event-card .ev-date { font-size: 12px; font-weight: 700; }
    .event-card .ev-title { font-size: 14px; font-weight: 600; color: #111827; margin-top: 2px; }
    .event-card .ev-sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .no-events { text-align: center; color: #9ca3af; font-size: 14px; padding: 24px 0; }
  </style>
</head>
<body>
  <header>
    <h1>\ud83d\udcc5 \u884c\u4e8b\u66c6</h1>
    <p>\u67e5\u770b\u6240\u6709\u5408\u7d04\u3001\u770b\u623f\u3001\u7e73\u8cbb\u63d0\u9192</p>
  </header>
  <div class="cal-container">
    <div class="cal-nav">
      <button id="prev-btn">\u25c0</button>
      <span class="cal-title" id="cal-title"></span>
      <button id="next-btn">\u25b6</button>
    </div>
    <div class="cal-grid">
      <div class="cal-weekdays">
        <span>\u4e00</span><span>\u4e8c</span><span>\u4e09</span><span>\u56db</span><span>\u4e94</span><span>\u516d</span><span>\u65e5</span>
      </div>
      <div class="cal-days" id="cal-days"></div>
    </div>
    <div class="legend">
      <span class="l-pay">\u7e73\u8cbb</span>
      <span class="l-show">\u770b\u623f</span>
      <span class="l-contract">\u5408\u7d04</span>
      <span class="l-repair">\u5831\u4fee</span>
    </div>
    <div class="events-title" id="events-title">\u672c\u6708\u4e8b\u9805</div>
    <div id="events-list"></div>
  </div>
  <script>
    const COLORS = {
      showing:'#0F8F7F', rent_due:'#E94B5F', billing:'#E94B5F',
      contract_expiry:'#7C9A1F', renewal_reminder:'#7C9A1F', lease_end:'#7C9A1F',
      repair_appointment:'#F59E0B', inspection:'#F59E0B'
    };
    let currentYear, currentMonth;
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth() + 1;

    document.getElementById('prev-btn').onclick = () => { navigate(-1); };
    document.getElementById('next-btn').onclick = () => { navigate(1); };

    function navigate(dir) {
      currentMonth += dir;
      if (currentMonth < 1) { currentMonth = 12; currentYear--; }
      if (currentMonth > 12) { currentMonth = 1; currentYear++; }
      loadCalendar();
    }

    async function loadCalendar() {
      document.getElementById('cal-title').textContent = currentYear + '\u5e74' + currentMonth + '\u6708';
      try {
        const resp = await fetch('/v2/api/calendar/events?year=' + currentYear + '&month=' + currentMonth);
        const data = await resp.json();
        const events = data.ok ? data.events : [];
        renderGrid(events);
        renderEvents(events);
      } catch (e) {
        document.getElementById('cal-days').innerHTML = '<div class="no-events">\u8f09\u5165\u5931\u6557</div>';
      }
    }

    function renderGrid(events) {
      const firstDay = new Date(currentYear, currentMonth - 1, 1).getDay();
      const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
      const offset = firstDay === 0 ? 6 : firstDay - 1;
      const today = now.getFullYear() === currentYear && (now.getMonth()+1) === currentMonth ? now.getDate() : -1;
      const eventMap = {};
      events.forEach(e => {
        if (!eventMap[e.day]) eventMap[e.day] = [];
        eventMap[e.day].push(e);
      });
      let html = '';
      for (let i = 0; i < offset; i++) html += '<div class="cal-day empty"></div>';
      for (let d = 1; d <= daysInMonth; d++) {
        const cls = ['cal-day'];
        if (d === today) cls.push('today');
        const evts = eventMap[d];
        let dot = '';
        if (evts && evts.length) {
          cls.push('has-event');
          const color = COLORS[evts[0].event_type] || '#475569';
          dot = '<span class="dot" style="background:' + color + '"></span>';
        }
        html += '<div class="' + cls.join(' ') + '">' + d + dot + '</div>';
      }
      document.getElementById('cal-days').innerHTML = html;
    }

    function renderEvents(events) {
      const el = document.getElementById('events-list');
      document.getElementById('events-title').textContent = '\u672c\u6708\u4e8b\u9805 (' + events.length + ')';
      if (!events.length) { el.innerHTML = '<div class="no-events">\u672c\u6708\u66ab\u7121\u6392\u5b9a\u4e8b\u9805</div>'; return; }
      el.innerHTML = events.map(e => {
        const color = COLORS[e.event_type] || '#475569';
        const dateStr = e.starts_at ? new Date(e.starts_at).toLocaleDateString('zh-TW', {month:'numeric',day:'numeric'}) : (currentMonth+'/'+e.day);
        return '<div class="event-card" style="border-left-color:'+color+'">'
          + '<div class="ev-date" style="color:'+color+'">'+dateStr+'</div>'
          + '<div class="ev-title">'+escHtml(e.title)+'</div>'
          + (e.subtitle ? '<div class="ev-sub">'+escHtml(e.subtitle)+'</div>' : '')
          + '</div>';
      }).join('');
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    loadCalendar();
  </script>
</body>
</html>`;
    res.send(html);
  });

  // Calendar API
  router.get('/v2/api/calendar/events', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    try {
      const events = await withDriver(async (db) => {
        const row = await db.get('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
        if (!row) return [];
        const { getUserCalendarEvents } = require('../repositories/v2CalendarRepository');
        return getUserCalendarEvents(db, row.user_id, year, month);
      });
      res.json({ ok: true, events, year, month });
    } catch (err) {
      next(err);
    }
  });

  router.post('/v2/api/tenant/inquiries/:inquiryPublicId/request-slots', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { inquiryPublicId } = req.params;
    try {
      const success = await withDriver(async (db) => {
        const inquiry = await db.get(`
          SELECT i.id, i.public_id, i.user_id, i.listing_id
          FROM inquiries i
          JOIN line_identities li ON li.user_id = i.user_id
          WHERE i.public_id = ? AND li.line_user_id = ? AND i.ended_at IS NULL
        `, [inquiryPublicId, lineUserId]);

        if (!inquiry) return false;

        const { notifyLandlordToOpenSlots } = require('../services/tenantNotificationServiceAsync');
        return await notifyLandlordToOpenSlots(db, inquiry.id);
      });

      if (success) {
        res.json({ ok: true });
      } else {
        res.status(404).json({ ok: false, error: 'Inquiry not found or could not notify landlord' });
      }
    } catch (err) {
      if (err.message === 'PUSH_FAILED') {
        if (err.statusCode === 400) {
          return res.status(422).json({ ok: false, error: 'LINE 無法接收這次提醒，尚未送出。請房東確認已加入目前服務的 LINE 好友、未封鎖服務，並確認綁定的是目前帳號後再試。' });
        }
        if (err.statusCode === 429) {
          return res.status(429).json({ ok: false, error: 'LINE 推播額度或頻率受限，提醒尚未送出。請稍後重試，若持續發生請聯絡管理員確認服務額度。' });
        }
        return res.status(500).json({ ok: false, error: '推播暫時無法送出，請稍後再試' });
      }
      console.error('[request-slots] error:', err);
      next(err);
    }
  });

  router.post('/v2/api/tenant/inquiries/:inquiryPublicId/activate', async (req, res) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
      // 寫入與讀房源名稱都在連線範圍內做完,LINE 推播留到外面——推播是外部呼叫,
      // 握著連線池的連線等它沒有必要。
      const outcome = await withDriver(async (db) => {
        const inquiry = await db.get(`
        SELECT i.id, i.listing_id
        FROM inquiries i
        JOIN line_identities owner_li ON owner_li.user_id = i.user_id
        WHERE i.public_id = ? AND owner_li.line_user_id = ? AND i.ended_at IS NULL
        LIMIT 1
      `, [req.params.inquiryPublicId, lineUserId]);
        const lineIdentity = await db.get('SELECT id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
        if (!inquiry || !lineIdentity) return null;

        await db.transaction(async (tx) => {
          await tx.run(`
          UPDATE active_inquiry_contexts
          SET cleared_at = CURRENT_TIMESTAMP, clear_reason = 'switch_via_liff'
          WHERE line_identity_id = ? AND cleared_at IS NULL
        `, [lineIdentity.id]);

          await tx.run(`
          INSERT INTO active_inquiry_contexts (public_id, line_identity_id, inquiry_id)
          VALUES (?, ?, ?)
        `, [`aic-${crypto.randomUUID()}`, lineIdentity.id, inquiry.id]);

          await tx.run('UPDATE inquiries SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [inquiry.id]);
        });

        const listing = await db.get('SELECT title FROM listings WHERE id = ?', [inquiry.listing_id]);
        return { listingTitle: (listing && listing.title) || '未提供房源名稱' };
      });

      if (!outcome) {
        return res.status(404).json({ ok: false, error: 'Inquiry or Identity not found' });
      }
      const listingTitle = outcome.listingTitle;

      // Push notification to tenant
      let notified = false;
      try {
        if (lineUserId) {
          const activateFlex = {
            type: 'flex',
            altText: `【切換對話情境】${listingTitle}`,
            contents: {
              type: 'bubble',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#62c4bcff',
                paddingAll: '16px',
                contents: [
                  { type: 'text', text: '💬 對話情境已切換', weight: 'bold', color: '#FFFFFF', size: 'lg' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                  { type: 'text', text: listingTitle, weight: 'bold', size: 'md', color: '#111827', wrap: true },
                  { type: 'text', text: '您現在可以在聊天室中針對此房源直接提問（例如：是否有車位、能否養寵物），AI 將為您解答！', size: 'sm', color: '#4B5563', wrap: true }
                ]
              }
            }
          };
          await lineClient.pushMessage(lineUserId, activateFlex);
          notified = true;
        }
      } catch (pushErr) {
        console.error('Failed to push activate notification:', pushErr.message);
      }

      res.json({ ok: true, listingTitle, notified });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 這筆詢問目前可以選的看房時段。房客只看得到自己那筆詢問底下、對應房源的、
  // 還開放而且還沒過期的時段。
  router.get('/v2/api/tenant/inquiries/:inquiryPublicId/slots', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
      const result = await withDriver(async (db) => {
        const identity = await db.get('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
        if (!identity) return [];
        return slots.listAvailableSlotsForInquiry(db, {
          inquiryPublicId: req.params.inquiryPublicId,
          tenantUserId: identity.user_id,
          nowStamp: localStamp()
        });
      });
      res.json({ ok: true, slots: result });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v2/api/tenant/appointments', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    // 這裡刻意**不收** startsAt。時間一律取自房東建立的時段,前端送什麼都不採信 ——
    // 收前端時間的話,房客可以送任何一個房東沒開放的時間,而後端無從分辨。
    const { inquiryPublicId, slotPublicId } = req.body || {};
    if (!inquiryPublicId || !slotPublicId) {
      return res.status(400).json({ ok: false, error: '請先選擇房東開放的看房時段。' });
    }

    const apptPublicId = `appt-${crypto.randomUUID()}`;
    const nowStamp = localStamp();

    try {
      // 先取消同一筆詢問底下還在等的預約(並把它們占著的時段還回去),再建新的——
      // 所有寫入綁在同一個交易,中途失敗會整批回捲,不會留下「兩筆都還在等」或
      // 「全部被取消但沒有新的」。LINE 推播全部留在交易與連線範圍之外。
      const prepared = await withDriver(async (db) => {
        // 詢問必須是這位房客自己的,而且還沒結束。原本這裡只用 public_id 找,任何一個
        // 登入中的使用者都能替別人的詢問下訂。
        const inquiry = await db.get(`
        SELECT i.id, i.listing_id, i.user_id
        FROM inquiries i
        JOIN line_identities li ON li.user_id = i.user_id
        WHERE i.public_id = ? AND li.line_user_id = ? AND i.ended_at IS NULL
        LIMIT 1
      `, [inquiryPublicId, lineUserId]);
        if (!inquiry) return { failure: { status: 404, message: '找不到這筆詢問，或它已經結束。' } };

        const slot = await slots.findSlotByPublicId(db, slotPublicId);
        // 時段必須屬於**這筆詢問的房源**。少了這一條,房客可以拿 A 房源的時段去預約
        // B 房源,而且雙方都會收到看起來完全正常的通知。
        if (!slot || slot.listingId !== inquiry.listing_id) {
          return { failure: { status: 404, message: '找不到這個看房時段。' } };
        }
        if (slot.status !== 'open' || slot.heldAppointmentId) {
          return { failure: { status: 409, message: '這個時段已經被預約或已停用，請改選其他時段。' } };
        }
        if (slot.startsAt <= nowStamp) {
          return { failure: { status: 409, message: '這個時段已經過了，請改選其他時段。' } };
        }

        const tenantIdentity = await db.get('SELECT display_name_cache FROM line_identities WHERE line_user_id = ?', [lineUserId]);

        // 原本是 po.effective_until >= date('now')。TiDB 沒有 date() 這個純量函式,
        // 而且**不報錯,直接回 NULL** —— 比較結果恆為 NULL,還在有效期內的房東會被
        // 濾掉,結果是房東收不到通知而且完全沒有錯誤訊息。改成傳今天的日期進來比。
        const landlord = await db.get(`
        SELECT li.id AS line_identity_id, li.user_id, li.line_user_id
        FROM listings l
        JOIN rental_units ru ON ru.id = l.rental_unit_id
        JOIN property_owners po ON po.property_id = ru.property_id
          AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
          AND (po.effective_until IS NULL OR po.effective_until >= ?)
        JOIN line_identities li ON li.user_id = po.owner_user_id
        WHERE l.id = ?
        ORDER BY li.id DESC LIMIT 1
      `, [nowStamp.slice(0, 10), inquiry.listing_id]);

        try {
          await db.transaction(async (tx) => {
            // 同一筆 inquiry 的改約必須序列化。否則兩個不同 slot 幾乎同時送進來時,
            // 兩邊可能都先讀到「目前沒有 pending」,最後各自新增並占住一個時段。
            // TiDB pessimistic transaction 會在這個 UPDATE 鎖住 inquiry row;SQLite 的
            // 寫交易同樣會序列化,所以後面的「取消舊預約 → 新增 → claim slot」才可靠。
            await tx.run('UPDATE inquiries SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?', [inquiry.id]);

            const previous = await tx.all(`
            SELECT id FROM showing_appointments
            WHERE inquiry_id = ? AND status IN ('pending', 'confirmed')
          `, [inquiry.id]);

            await tx.run(`
            UPDATE showing_appointments
            SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
            WHERE inquiry_id = ? AND status IN ('pending', 'confirmed')
          `, [inquiry.id]);

            // 改約等於放掉舊時段。不放的話房客改一次時間就永久占住兩個時段。
            for (const row of previous) {
              await slots.releaseSlotForAppointmentCore(tx, { appointmentId: row.id });
            }

            const inserted = await tx.run(`
            INSERT INTO showing_appointments (public_id, inquiry_id, listing_id, tenant_user_id, starts_at, slot_id, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
          `, [apptPublicId, inquiry.id, inquiry.listing_id, inquiry.user_id, slot.startsAt, slot.id]);

            // driver 把 lastInsertRowid / insertId 統一成 insertId。雲端的
            // showing_appointments.id 確認是 bigint AUTO_INCREMENT,所以這個值可用;
            // 真的拿不到才回頭查一次 public_id —— 少一次跨區來回。
            const appointmentId = inserted.insertId
              || (await tx.get('SELECT id FROM showing_appointments WHERE public_id = ?', [apptPublicId])).id;

            // 真正的併發防線:條件式 UPDATE + 檢查 changes。前面那三個檢查只是為了給
            // 房客看得懂的訊息,兩位房客同時按下去時,擋住的是這一行。
            await slots.claimSlotCore(tx, { slotId: slot.id, appointmentId });
          });
        } catch (error) {
          if (error instanceof slots.SlotConflictError) {
            return { failure: { status: 409, message: error.message } };
          }
          throw error;
        }

        const listing = await db.get('SELECT title FROM listings WHERE id = ?', [inquiry.listing_id]);
        const listingTitle = (listing && listing.title) || '未提供房源名稱';
        if (landlord && landlord.user_id) {
          try {
            await enqueueNotification(db, {
              eventType: 'showing_appointment_requested',
              entityType: 'showing_appointment',
              entityId: apptPublicId,
              payload: {
                title: '新的看房預約申請',
                message: `${(tenantIdentity && tenantIdentity.display_name_cache) || '房客'} 預約 ${slot.startsAt.replace('T', ' ')} 看房`,
                unitLabel: listingTitle,
                appointmentPublicId: apptPublicId,
                // 看房預約目前的房東操作（同意／拒絕）是既有管理台與 LINE 卡片。
                // 通知中心至少要帶回同一個房東管理入口，不能只留在通知分類頁。
                actionUrl: `/landlordManage?lineUserId=${encodeURIComponent(landlord.line_user_id || '')}`
              },
              recipients: [{ role: 'landlord', userId: landlord.user_id }],
              idempotencyKey: `showing_appointment_requested:${apptPublicId}`
            });
          } catch (notificationError) {
            console.error('Failed to record landlord showing notification:', notificationError.message);
          }
        }
        return {
          startsAt: slot.startsAt,
          tenantName: (tenantIdentity && tenantIdentity.display_name_cache) || '房客',
          landlordLineUserId: landlord && landlord.line_user_id,
          listingTitle,
          landlordUserId: landlord && landlord.user_id
        };
      });

      if (prepared.failure) {
        return res.status(prepared.failure.status).json({ ok: false, error: prepared.failure.message });
      }
      const { startsAt, tenantName, landlordLineUserId, listingTitle } = prepared;
      const formattedTime = startsAt.replace('T', ' ');

      if (landlordLineUserId && !landlordLineUserId.includes('DEMO')) {
        const landlordFlex = {
          type: 'flex',
          altText: '【串接】收到新的看房預約申請',
          contents: {
            type: 'bubble',
            header: {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#0F766E',
              contents: [
                { type: 'text', text: '【串接】看房預約申請', color: '#FFFFFF', weight: 'bold', size: 'lg' }
              ]
            },
            body: {
              type: 'box',
              layout: 'vertical',
              spacing: 'md',
              contents: [
                { type: 'text', text: `房客 ${tenantName} 提出了看房預約。`, size: 'sm', color: '#374151' },
                {
                  type: 'box',
                  layout: 'vertical',
                  backgroundColor: '#F3F4F6',
                  paddingAll: '12px',
                  cornerRadius: '8px',
                  contents: [
                    { type: 'text', text: `房源：${listingTitle}`, weight: 'bold', size: 'sm', color: '#111827', wrap: true },
                    { type: 'text', text: `時間：${formattedTime}`, size: 'sm', color: '#4B5563', margin: 'xs' }
                  ]
                }
              ]
            },
            footer: {
              type: 'box',
              layout: 'horizontal',
              spacing: 'sm',
              contents: [
                {
                  type: 'button',
                  style: 'primary',
                  color: '#0F766E',
                  height: 'sm',
                  action: {
                    type: 'postback',
                    label: '同意預約',
                    data: `action=landlord_showing_decision&id=${apptPublicId}&decision=confirm`
                  }
                },
                {
                  type: 'button',
                  style: 'secondary',
                  height: 'sm',
                  action: {
                    type: 'postback',
                    label: '拒絕預約',
                    data: `action=landlord_showing_decision&id=${apptPublicId}&decision=reject`
                  }
                }
              ]
            }
          }
        };

        // 預約在這一行之前就已經 commit 了。推播失敗(權杖沒設、LINE 回 5xx)不該讓
        // 房客看到「預約失敗」——他的預約其實成立了,再按一次只會建立第二筆。
        // 房客那側的推播本來就是這樣處理的,房東這側漏掉了。
        try {
          await lineClient.pushMessage(landlordLineUserId, [
            { type: 'text', text: `【串接】房客已送出預約！預約房源：「${listingTitle}」，預約時間為：${formattedTime}。` },
            landlordFlex
          ]);
        } catch (pushErr) {
          console.error('Failed to push landlord reservation notification:', pushErr.message);
        }
      }

      if (lineUserId && !lineUserId.includes('DEMO')) {
        try {
          const tenantFlex = {
            type: 'flex',
            altText: `已預約 ${formattedTime} 正在等待房東確認`,
            contents: {
              type: 'bubble',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F59E0B',
                paddingAll: '16px',
                contents: [
                  { type: 'text', text: '⏳ 預約看房送出', color: '#FFFFFF', weight: 'bold', size: 'lg' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                  { type: 'text', text: '您的看房預約已成功送出，目前正在等待房東確認。', size: 'sm', color: '#374151', wrap: true },
                  {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#FFFBEB',
                    paddingAll: '12px',
                    cornerRadius: '8px',
                    contents: [
                      { type: 'text', text: `房源：${listingTitle}`, weight: 'bold', size: 'sm', color: '#B45309', wrap: true },
                      { type: 'text', text: `時間：${formattedTime}`, size: 'sm', color: '#92400E', margin: 'xs' }
                    ]
                  }
                ]
              }
            }
          };
          await lineClient.pushMessage(lineUserId, tenantFlex);
        } catch (pushErr) {
          console.error('Failed to push tenant reservation notification:', pushErr.message);
        }
      }

      res.json({ ok: true, appointmentPublicId: apptPublicId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/v2/api/tenant/appointments/:appointmentPublicId/cancel', async (req, res, next) => {
    const lineUserId = req.v2LineUserId;
    if (!lineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
      // 三個寫入綁在同一個交易裡;LINE 推播全部留在交易與連線範圍之外。
      const prepared = await withDriver(async (db) => {
        // 預約必須是這位房客自己的。原本這裡只用 public_id 找,任何一個登入中的
        // 使用者只要知道(或猜到)別人的 appointment public_id 就能替他取消,
        // 而且房東與房客都會收到看起來完全正常的取消通知。
        const appt = await db.get(`
        SELECT sa.id, sa.inquiry_id, sa.listing_id, sa.starts_at, sa.status
        FROM showing_appointments sa
        JOIN line_identities li ON li.user_id = sa.tenant_user_id
        WHERE sa.public_id = ? AND li.line_user_id = ?
        LIMIT 1
      `, [req.params.appointmentPublicId, lineUserId]);
        if (!appt) return null;

        await db.transaction(async (tx) => {
          await tx.run("UPDATE showing_appointments SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [appt.id]);
          await tx.run("UPDATE calendar_events SET status = 'cancelled' WHERE inquiry_id = ? AND event_type = 'showing' AND starts_at = ?", [appt.inquiry_id, appt.starts_at]);
          // 房客取消 → 時段回到 open,其他房客可以再選。房東拒絕走的是另一條規則
          // (收起來成 closed),兩者刻意不同,見 v2ShowingSlotRepositoryAsync 的註解。
          await slots.releaseSlotForAppointmentCore(tx, { appointmentId: appt.id });
        });

        // 原本是 po.effective_until >= date('now')。TiDB 沒有 date() 這個純量函式,
        // 而且**不報錯,直接回 NULL** —— 比較結果恆為 NULL,還在有效期內的房東會被
        // 濾掉,結果是房東收不到通知而且完全沒有錯誤訊息。改成傳今天的日期進來比。
        const landlord = await db.get(`
        SELECT li.id AS line_identity_id, li.user_id, li.line_user_id
        FROM listings l
        JOIN rental_units ru ON ru.id = l.rental_unit_id
        JOIN property_owners po ON po.property_id = ru.property_id
          AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
          AND (po.effective_until IS NULL OR po.effective_until >= ?)
        JOIN line_identities li ON li.user_id = po.owner_user_id
        WHERE l.id = ?
        ORDER BY li.id DESC LIMIT 1
      `, [new Date().toISOString().slice(0, 10), appt.listing_id]);

        const listing = await db.get('SELECT title FROM listings WHERE id = ?', [appt.listing_id]);
        const listingTitle = (listing && listing.title) || '未提供房源名稱';
        if (landlord && landlord.user_id) {
          try {
            await enqueueNotification(db, {
              eventType: 'showing_appointment_cancelled',
              entityType: 'showing_appointment',
              entityId: req.params.appointmentPublicId,
              payload: {
                title: '看房預約已取消',
                message: `房客已取消 ${appt.starts_at.replace('T', ' ')} 的看房預約`,
                unitLabel: listingTitle,
                appointmentPublicId: req.params.appointmentPublicId,
                actionUrl: `/landlordManage?lineUserId=${encodeURIComponent(landlord.line_user_id || '')}`
              },
              recipients: [{ role: 'landlord', userId: landlord.user_id }],
              idempotencyKey: `showing_appointment_cancelled:${req.params.appointmentPublicId}`
            });
          } catch (notificationError) {
            console.error('Failed to record landlord showing cancellation:', notificationError.message);
          }
        }
        return {
          appt,
          landlordLineUserId: landlord && landlord.line_user_id,
          listingTitle
        };
      });

      if (!prepared) return res.status(404).json({ ok: false, error: 'Appointment not found' });
      const { appt, landlordLineUserId, listingTitle } = prepared;
      const formattedTime = appt.starts_at.replace('T', ' ');

      if (landlordLineUserId && !landlordLineUserId.includes('DEMO')) {
        // 同上:取消已經 commit,推播失敗不該讓房客看到「取消失敗」而再按一次。
        try {
          await lineClient.pushMessage(landlordLineUserId, {
            type: 'text',
            text: `【通知】房客已取消原訂於 ${formattedTime} 看房「${listingTitle}」的行程。`
          });
        } catch (pushErr) {
          console.error('Failed to push landlord cancellation notification:', pushErr.message);
        }
      }

      if (lineUserId && !lineUserId.includes('DEMO')) {
        try {
          const tenantCancelFlex = {
            type: 'flex',
            altText: `已取消 ${formattedTime} 的看房預約`,
            contents: {
              type: 'bubble',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#EF4444',
                paddingAll: '16px',
                contents: [
                  { type: 'text', text: '❌ 取消預約成功', color: '#FFFFFF', weight: 'bold', size: 'lg' }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                  { type: 'text', text: '您的看房預約已成功取消，我們已通知房東。', size: 'sm', color: '#374151', wrap: true },
                  {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#FEF2F2',
                    paddingAll: '12px',
                    cornerRadius: '8px',
                    contents: [
                      { type: 'text', text: `房源：${listingTitle}`, weight: 'bold', size: 'sm', color: '#991B1B', wrap: true },
                      { type: 'text', text: `時間：${formattedTime}`, size: 'sm', color: '#7F1D1D', margin: 'xs' }
                    ]
                  }
                ]
              }
            }
          };
          await lineClient.pushMessage(lineUserId, tenantCancelFlex);
        } catch (pushErr) {
          console.error('Failed to push tenant cancellation notification:', pushErr.message);
        }
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ============================================
  // Pre-Inspection List LIFF Routes
  // ============================================

  // Dedicated Session Endpoint for Pre-Inspection
  router.post('/v2/api/pre-inspection/liff-session', async (req, res) => {
    const { verifyLineIdToken, signPreInspectionSession } = require('../services/preInspectionSessionService');
    const { idToken } = req.body || {};

    if (!idToken) {
      return res.status(400).json({ ok: false, error: 'Missing idToken' });
    }

    const result = await verifyLineIdToken({ idToken });
    if (!result.ok) {
      return res.status(401).json({ ok: false, error: result.error });
    }

    const token = signPreInspectionSession(result.lineUserId, result.expiresAt);
    const secureFlag = req.secure || req.get('x-forwarded-proto') === 'https';
    res.setHeader(
      'Set-Cookie',
      `v2_pre_inspection_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${result.maxAgeSeconds}${secureFlag ? '; Secure' : ''}`
    );
    res.json({ ok: true });
  });

  router.get('/preInspectionList', (req, res) => {
    const { preInspectionLiffBootstrap } = require('../services/preInspectionSessionService');
    const { resolveAuthenticatedPreInspectionUser } = require('../services/preInspectionTokenService');
    // 點交明細頁早已支援短效 token；列表與它的 API 也必須使用同一個身分來源，
    // 否則從 LINE 卡片／外部連結進到列表後會立刻失去身分。
    const lineUserId = resolveAuthenticatedPreInspectionUser(req);

    if (!lineUserId) {
      return res.send(preInspectionLiffBootstrap(req.originalUrl));
    }

    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>屋況點交列表</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(135deg, #fdf2f8 0%, #ede9fe 100%);
      color: #1f2937;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      padding: 16px 12px;
    }
    header { text-align: center; margin-bottom: 24px; }
    header h1 { margin: 0; font-size: 22px; font-weight: 700; color: #7c3aed; }
    header p { margin: 4px 0 0; font-size: 13px; color: #6b7280; }
    .list-container {
      max-width: 600px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .house-card {
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 4px 20px rgba(124, 58, 237, 0.05);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .house-card:active { transform: scale(0.98); }
    .house-main { display: flex; gap: 12px; }
    .house-img-container {
      width: 80px; height: 80px;
      border-radius: 12px; overflow: hidden;
      background: #e5e7eb; flex-shrink: 0;
    }
    .house-img { width: 100%; height: 100%; object-fit: cover; }
    .house-info { flex: 1; display: flex; flex-direction: column; }
    .house-title {
      font-size: 15px; font-weight: 600; color: #111827;
      margin: 0 0 4px; line-height: 1.4;
      display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden;
    }
    .house-rent { font-size: 14px; font-weight: 700; color: #ea580c; margin: 0; }
    .house-badge {
      display: inline-block; align-self: flex-start;
      margin-top: 4px; padding: 2px 6px;
      border-radius: 6px; font-size: 11px; font-weight: 600;
    }
    .badge-done { background: #dcfce7; color: #16a34a; }
    .badge-active { background: #fef3c7; color: #d97706; }
    .badge-none { background: #f3f4f6; color: #6b7280; }
    .btn-group { margin-top: 14px; display: flex; gap: 10px; }
    .btn {
      flex: 1; border: 0; padding: 10px; border-radius: 12px;
      font-size: 13px; font-weight: 700; cursor: pointer;
      text-align: center; transition: opacity 0.2s;
    }
    .btn:active { opacity: 0.8; }
    .btn:disabled { background: #d1d5db; color: #9ca3af; box-shadow: none; cursor: not-allowed; }
    .btn-start {
      background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
      color: #fff; box-shadow: 0 4px 10px rgba(124, 58, 237, 0.2);
    }
    .btn-resume {
      background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
      color: #fff; box-shadow: 0 4px 10px rgba(217, 119, 6, 0.2);
    }
    .btn-view {
      background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%);
      color: #fff; box-shadow: 0 4px 10px rgba(15, 118, 110, 0.2);
    }
  </style>
</head>
<body>
  <header>
    <h1>屋況點交</h1>
    <p>選擇房源進行入住前屋況紀錄</p>
  </header>
  <main class="list-container" id="pi-list">
    <p style="text-align:center; color:#6b7280; font-size:14px;">載入中…</p>
  </main>
  <script src="/assets/preInspectionList.js?t=${Date.now()}"></script>
</body>
</html>`;
    res.send(html);
  });

  // API: Get pre-inspection list with session status
  router.get('/v2/api/tenant/pre-inspection-list', async (req, res) => {
    const { resolveAuthenticatedPreInspectionUser } = require('../services/preInspectionTokenService');
    const lineUserId = resolveAuthenticatedPreInspectionUser(req);

    if (!lineUserId) {
      return res.status(401).json({ ok: false, error: '無法確認身分，請回到 LINE 重新開啟屋況點交列表。' });
    }

    if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
      console.log('[inspection:list]', { lineUserId });
    }

    const { withV2Driver } = require('../database/v2Driver');

    try {
      const items = await withV2Driver(async (db) => {
        const userRow = await db.get(
          'SELECT user_id FROM line_identities WHERE line_user_id = ?',
          [lineUserId]
        );
        if (!userRow) return [];

        const appointments = await db.all(`
        SELECT
          sa.public_id AS appointment_public_id,
          sa.starts_at AS appointment_starts_at,
          i.public_id AS inquiry_public_id,
          l.id AS listing_id,
          l.title AS title,
          l.current_rent_amount AS rent_amount,
          cover.source_url AS image_url,
          cover_file.public_id AS image_file_public_id,
          pis.public_id AS session_public_id,
          pis.status AS session_status,
          pis.confirmation_status AS session_confirmation_status
        FROM showing_appointments sa
        JOIN inquiries i ON i.id = sa.inquiry_id
        JOIN listings l ON l.id = sa.listing_id
        LEFT JOIN (
          SELECT lm.listing_id, lm.source_url, lm.file_id,
                 ROW_NUMBER() OVER (PARTITION BY lm.listing_id ORDER BY lm.sort_order ASC, lm.id ASC) rn
          FROM listing_media lm WHERE lm.media_type = 'image'
        ) cover ON cover.listing_id = l.id AND cover.rn = 1
        LEFT JOIN files cover_file ON cover_file.id = cover.file_id AND cover_file.status = 'active'
        LEFT JOIN pre_inspection_sessions pis
          ON pis.showing_appointment_id = sa.id AND pis.record_type = 'main'
        WHERE sa.tenant_user_id = ? AND sa.status = 'confirmed'
        ORDER BY sa.starts_at DESC, sa.id DESC
      `, [userRow.user_id]);

        // 既有點交建立時沒有看房預約，不能強行回填；仍讓房客查看與管理。
        const legacySessions = await db.all(`
        SELECT
          i.public_id AS inquiry_public_id,
          l.id AS listing_id,
          l.title AS title,
          l.current_rent_amount AS rent_amount,
          cover.source_url AS image_url,
          cover_file.public_id AS image_file_public_id,
          pis.public_id AS session_public_id,
          pis.status AS session_status,
          pis.confirmation_status AS session_confirmation_status
        FROM pre_inspection_sessions pis
        JOIN listings l ON l.id = pis.listing_id
        LEFT JOIN inquiries i ON i.id = pis.inquiry_id
        LEFT JOIN (
          SELECT lm.listing_id, lm.source_url, lm.file_id,
                 ROW_NUMBER() OVER (PARTITION BY lm.listing_id ORDER BY lm.sort_order ASC, lm.id ASC) rn
          FROM listing_media lm WHERE lm.media_type = 'image'
        ) cover ON cover.listing_id = l.id AND cover.rn = 1
        LEFT JOIN files cover_file ON cover_file.id = cover.file_id AND cover_file.status = 'active'
        WHERE pis.line_user_id = ?
          AND pis.record_type = 'main'
          AND pis.showing_appointment_id IS NULL
          AND pis.status != 'cancelled'
        ORDER BY pis.id DESC
      `, [lineUserId]);

        const toItem = (row, isLegacy = false) => ({
          publicId: row.inquiry_public_id || null,
          appointmentPublicId: row.appointment_public_id || null,
          appointmentStartsAt: row.appointment_starts_at || null,
          isLegacy,
          listingId: row.listing_id,
          title: row.title,
          rentAmount: row.rent_amount,
          imageUrl: listingImageUrl(row),
          session: row.session_public_id ? {
            publicId: row.session_public_id,
            status: row.session_status,
            confirmationStatus: row.session_confirmation_status
          } : null
        });

        return [
          ...appointments.map((row) => toItem(row)),
          ...legacySessions.map((row) => toItem(row, true))
        ];
      });

      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.json({ ok: true, items });
    } catch (err) {
      console.error('pre-inspection-list error:', err);
      res.status(500).json({ ok: false, error: '伺服器錯誤' });
    }
  });

  // API: Start / Resume pre-inspection from LIFF
  router.post('/v2/api/tenant/pre-inspections/start', async (req, res) => {
    const { resolveAuthenticatedPreInspectionUser } = require('../services/preInspectionTokenService');
    const lineUserId = resolveAuthenticatedPreInspectionUser(req);

    if (!lineUserId) {
      return res.status(401).json({
        ok: false,
        error: '無法確認身分，請回到 LINE 重新開啟屋況點交列表。'
      });
    }

    const { appointmentPublicId } = req.body || {};
    if (!appointmentPublicId) {
      return res.status(400).json({ ok: false, error: '請從房東已同意的看房預約開啟屋況點交。' });
    }

    const { withV2Driver } = require('../database/v2Driver');
    const preInspectionRepository = require('../repositories/preInspectionRepositoryAsync');
    const preInspectionLinePresenter = require('../services/preInspectionLinePresenter');

    try {
      const result = await withV2Driver(async (db) => {
        const atomicRes = await preInspectionRepository.startSessionForConfirmedAppointment(db, {
          appointmentPublicId,
          lineUserId
        });
        if (atomicRes.status === 'not_found') return { invalidAppointment: true };
        if (atomicRes.status === 'conflict') {
          const otherTitle = atomicRes.activeSession?.title || '其他房源';
          return { conflict: true, otherTitle };
        }

        const session = atomicRes.session;
        const equipmentItems = await preInspectionRepository.getListingInspectionReference(db, session.listing_id);

        return {
          session,
          title: session.title || '目前房源',
          equipmentItems,
          alreadyActive: atomicRes.status === 'existing' && session.status === 'active',
          alreadyCompleted: atomicRes.status === 'existing' && session.status !== 'active',
          isNew: atomicRes.status === 'created'
        };
      });

      if (result.invalidAppointment) {
        return res.status(404).json({ ok: false, error: '找不到已核准且屬於您的看房預約。' });
      }
      if (result.conflict) {
        return res.status(409).json({
          ok: false,
          error: `您目前已有「${result.otherTitle}」進行中的屋況紀錄。請先回到 LINE 聊天室完成或放棄該紀錄。`
        });
      }

      try {
        if (lineUserId && !lineUserId.includes('DEMO')) {
          const card = preInspectionLinePresenter.startPreInspectionCard(result.title, {
            session: result.session,
            lineUserId,
            equipmentItems: result.equipmentItems
          });
          await lineClient.pushMessage(lineUserId, card);
        }
      } catch (pushErr) {
        console.error('Failed to push pre-inspection start message:', pushErr.message);

        if (result.isNew) {
          await withV2Driver(async (db) => {
            await preInspectionRepository.cancelSessionPackage(db, { sessionId: result.session.id, lineUserId });
          });
          return res.status(500).json({ ok: false, error: '無法推播點交卡片至 LINE 聊天室，已安全取消建立紀錄。' });
        }
      }

      res.json({
        ok: true,
        sessionPublicId: result.session.public_id,
        alreadyActive: result.alreadyActive,
        alreadyCompleted: result.alreadyCompleted
      });
    } catch (err) {
      console.error('pre-inspection start error:', err);
      res.status(500).json({ ok: false, error: '伺服器錯誤，請稍後再試。' });
    }
  });

  // API: Delete (cancel) pre-inspection session
  router.post('/v2/api/tenant/pre-inspections/delete', async (req, res) => {
    const { resolveAuthenticatedPreInspectionUser } = require('../services/preInspectionTokenService');
    const lineUserId = resolveAuthenticatedPreInspectionUser(req);

    if (!lineUserId) return res.status(401).json({ ok: false, error: '無法確認身分，請回到 LINE 重新開啟屋況點交列表。' });

    const { sessionPublicId } = req.body || {};
    if (!sessionPublicId) return res.status(400).json({ ok: false, error: 'Missing sessionPublicId' });

    const { withV2Driver } = require('../database/v2Driver');
    const preInspectionRepository = require('../repositories/preInspectionRepositoryAsync');

    try {
      const result = await withV2Driver(async (db) => {
        const session = await db.get(
          'SELECT id, status, confirmation_status FROM pre_inspection_sessions WHERE public_id = ? AND line_user_id = ?',
          [sessionPublicId, lineUserId]
        );
        if (!session) return { notFound: true };

        if (['pending_landlord_confirmation', 'landlord_confirmed'].includes(session.confirmation_status)) {
          return { forbidden: true };
        }

        await preInspectionRepository.cancelSessionPackage(db, { sessionId: session.id, lineUserId });
        return { success: true };
      });

      if (result.notFound) return res.status(404).json({ ok: false, error: 'Session not found' });
      if (result.forbidden) return res.status(403).json({ ok: false, error: '已送交確認或已確認之紀錄無法移除' });

      res.json({ ok: true });
    } catch (err) {
      console.error('delete pre-inspection error:', err);
      res.status(500).json({ ok: false, error: '伺服器錯誤' });
    }
  });

  return router;
}

module.exports = { createTenantInquiryRoutes };
