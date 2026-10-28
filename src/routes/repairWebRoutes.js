const express = require('express');
const path = require('node:path');
const { openV2Database } = require('../database/v2Database');
const { driverMode, withV2Driver } = require('../database/v2Driver');
const repairRepository = require('../repositories/v2RepairRepository');
const repairRepositoryAsync = require('../repositories/v2RepairRepositoryAsync');
const dashboardRepository = require('../repositories/v2DashboardRepository');
const { client: lineClient } = require('../lineClient');
const { createPreInspectionToken } = require('../services/preInspectionTokenService');
const { sha256 } = require('../services/hashService');
const { createFileStorage, storageKey: storageKeyForStored } = require('../services/fileStorage');
const { resolveIdentity, liffBootstrap } = require('../services/liffSessionService');
const { buildRepairAssistantAnalysis, inferRepairDamageType, inferRepairRisk } = require('../services/repairAiAssistant');
const {
  handleRepairPostback,
  notifyLandlords,
  notifyLandlordsRepairUpdate,
  notifyTenant,
  tenantRepairStatusCard,
} = require('../services/tenantRepairLineService');
const { notifyLandlordsForNewRepair, notifyLandlordsForRepairUpdate, notifyTenantForRepairUpdate } = require('../services/tenantRepairNotificationAsync');

const router = express.Router();

// Rich Menu 的 URI action 無法事先知道點擊者的 LINE user ID。這個入口先用
// LIFF 建立簽章 session，再把身分帶到既有、需要 lineUserId 的報修／待辦頁。
// 目標採白名單，不讓它成為可被利用的任意轉址器。
const RICH_MENU_REPAIR_ENTRIES = Object.freeze({
  tenant_repair_new: '/tenant/repairs/new',
  landlord_tasks: '/landlord/tasks',
});

function richMenuRepairEntryTarget(entry, lineUserId) {
  const target = RICH_MENU_REPAIR_ENTRIES[entry];
  if (!target || !lineUserId) return '';
  return `${target}?lineUserId=${encodeURIComponent(lineUserId)}`;
}

router.get('/liff/repair-entry/:entry', (req, res) => {
  if (!RICH_MENU_REPAIR_ENTRIES[req.params.entry]) return res.status(404).send('找不到圖文選單入口。');
  const { lineUserId } = resolveIdentity(req);
  if (!lineUserId) return res.send(liffBootstrap(req.originalUrl));
  return res.redirect(richMenuRepairEntryTarget(req.params.entry, lineUserId));
});

// 這些 middleware 只能套在報修頁面自己的路徑上。掛在整個 router 會連 POST /webhook
// 一起吃掉 request body，讓 LINE 的簽章驗證永遠失敗。
const REPAIR_PATHS = ['/tenant/repairs', '/landlord/tasks', '/landlord/repairs'];
router.use(REPAIR_PATHS, express.urlencoded({ extended: false }));
router.use(REPAIR_PATHS, express.json({ limit: '30mb' }));
// LINE 內建瀏覽器容易保留舊版表單與判斷腳本；報修流程一律取最新頁面。
router.use(REPAIR_PATHS, (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

let dbInstance;
function getDb() {
  if (!dbInstance) {
    dbInstance = openV2Database({
      dbPath: process.env.V2_DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'ecs-neo-v2.sqlite'),
    });
  }
  return dbInstance;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fileUrl(filePublicId) {
  return `/v2/repair-files/${encodeURIComponent(filePublicId)}`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const raw = String(value);
  const parsed = new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function safeLandlordTaskReturnUrl(value) {
  const candidate = String(value || '').trim();
  return candidate === '/landlord/tasks' || candidate.startsWith('/landlord/tasks?')
    ? candidate
    : '';
}

// 通知的 actionUrl 是由伺服器端建立的內部網址；仍在這裡做一次白名單，避免
// 舊資料或手動寫入的 payload 把通知中心變成外部轉址入口。
function safeNotificationActionUrl(value) {
  const candidate = String(value || '').trim();
  return candidate.startsWith('/') && !candidate.startsWith('//') ? candidate : '';
}

// 「待我處理」不是通知的摘要頁。點交待確認要直接帶房東進該筆已封存的
// 屋況紀錄；短效 token 仍綁目前登入的 LINE 身分，明細頁會再次驗證 ownership。
function landlordInspectionActionUrl(item, lineUserId) {
  if (!item || item.source_type !== 'line_pre_inspection' || !item.public_id || !lineUserId) return '';
  const token = createPreInspectionToken(lineUserId, item.public_id);
  if (!token) return '';
  return `/tenant/pre-inspections/${encodeURIComponent(item.public_id)}?token=${encodeURIComponent(token)}`;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function notificationCategory(eventType, payload = {}) {
  const text = `${eventType || ''} ${payload.templateCode || ''} ${payload.title || ''}`.toLowerCase();
  if (/repair|maintenance/.test(text)) return 'repair';
  if (/question|inquir|answer|knowledge/.test(text)) return 'question';
  if (/showing|appointment|viewing/.test(text)) return 'viewing';
  if (/inspection|handover|pre_inspection/.test(text)) return 'handover';
  if (/contract|sign|intention|renewal/.test(text)) return 'contract';
  if (/billing|rent|charge|payment/.test(text)) return 'billing';
  return 'other';
}

function notificationTitle(eventType, category) {
  const labels = {
    repair: '修繕通知', question: '房客提問', viewing: '看房通知', handover: '點交通知',
    contract: '簽約通知', billing: '帳務提醒', other: '系統通知',
  };
  if (eventType === 'renewal_reminder') return '續約提醒';
  return labels[category] || labels.other;
}

function listLandlordNotificationEvents(db, { lineUserId, userId, limit = 40 }) {
  const rows = db.prepare(`
    SELECT n.public_id, n.event_type, n.entity_type, n.entity_id, n.template_code,
           n.payload_json, n.created_at, nd.status AS delivery_status, nd.sent_at
    FROM notification_deliveries nd
    JOIN notifications n ON n.id = nd.notification_id
    WHERE nd.recipient_user_id = @userId
       OR nd.recipient_line_identity_id IN (
         SELECT id FROM line_identities WHERE line_user_id = @lineUserId
       )
    ORDER BY datetime(COALESCE(nd.sent_at, n.created_at)) DESC, n.id DESC
    LIMIT @limit
  `).all({ lineUserId, userId, limit });
  return rows.map((row) => {
    const payload = parseJsonObject(row.payload_json);
    const category = notificationCategory(row.event_type, payload);
    const rawTitle = String(payload.title || '').trim();
    const title = !rawTitle || ['message', 'status_change', 'notification'].includes(rawTitle.toLowerCase())
      ? notificationTitle(row.event_type, category)
      : rawTitle;
    // 點交的 token 只存活十分鐘，不能把送出當下的 actionUrl 原封不動當成
    // 通知中心的永久連結。每次畫中心時依目前房東的 LINE 身分重新簽一張。
    const preInspectionPublicId = String(payload.preInspectionPublicId || '').trim();
    const actionUrl = row.event_type === 'pre_inspection_submitted' && preInspectionPublicId
      ? landlordInspectionActionUrl({ source_type: 'line_pre_inspection', public_id: preInspectionPublicId }, lineUserId)
      : safeNotificationActionUrl(payload.actionUrl || payload.action_url);
    return {
      ...row,
      payload,
      category,
      title,
      unitLabel: payload.unitLabel || payload.unit_label || '租屋物件',
      message: payload.message || payload.subtitle || payload.description || `${notificationTitle(row.event_type, category)}已建立`,
      eventAt: row.sent_at || row.created_at,
      actionUrl,
    };
  });
}

function statusText(status, completionPhotoCount = 0, ticket = {}) {
  const repairStatus = String(ticket.repair_status || '');
  const verificationStatus = String(ticket.repair_verification_status || '');
  const settlementStatus = String(ticket.settlement_status || '');
  const dispatchParty = effectiveDispatchParty(ticket);
  if (repairStatus === 'completed') {
    if (verificationStatus === 'disputed') return '房客已回報修繕結果有問題，等待房東處理';
    if (verificationStatus === 'confirmed') {
      return ['completed', 'not_required', 'waived'].includes(settlementStatus)
        ? '修復結果已確認，等待房東結案'
        : '修復結果已確認，費用待結算';
    }
    if (dispatchParty !== 'tenant' && completionPhotoCount > 0) return '房東已回傳修好資料，待房客查驗';
    if (dispatchParty === 'tenant' && completionPhotoCount > 0) return '房客已回傳修好資料，待房東查驗';
  }
  if (status === 'landlord_completed') {
    return completionPhotoCount > 0 ? '修好照片已回傳，待房東確認' : '房東標記修復，待回傳修好照片';
  }
  return ({
    reported: '房客已通報，待房東決定',
    accepted: '房東已受理',
    in_progress: '處理中，等待修復回報',
    need_info: '等待房客補件',
    vendor_judgement: '等待維修人員判斷',
    tenant_pays: '等待房客確認負擔方案',
    tenant_self_repair: '房東同意房客代修',
    tenant_confirmed: '房東已確認結案',
    reopened: '房客回報仍有問題',
    cancelled: '已取消',
  })[status] || status || '狀態待確認';
}

function statusTone(status) {
  return ({
    reported: { className: 'tone-blue', dot: '#2563EB' },
    accepted: { className: 'tone-amber', dot: '#D97706' },
    in_progress: { className: 'tone-amber', dot: '#D97706' },
    need_info: { className: 'tone-blue', dot: '#2563EB' },
    vendor_judgement: { className: 'tone-blue', dot: '#2563EB' },
    tenant_pays: { className: 'tone-amber', dot: '#D97706' },
    tenant_self_repair: { className: 'tone-purple', dot: '#7C3AED' },
    landlord_completed: { className: 'tone-purple', dot: '#7C3AED' },
    tenant_confirmed: { className: 'tone-green', dot: '#059669' },
    // 非緊急的「退回補修」是工作狀態，不用紅色警示；紅色只留給安全緊急案件。
    reopened: { className: 'tone-amber', dot: '#D97706' },
    cancelled: { className: 'tone-gray', dot: '#64748B' },
  })[status] || { className: 'tone-gray', dot: '#1F2937' };
}

function purposeLabel(purpose) {
  return ({
    damage_photo: '損壞照片',
    completion_photo: '修好後照片',
    supplement: '補充附件',
  })[purpose] || '附件';
}

function mediaHtml(files, purpose) {
  const list = files.filter((file) => !purpose || file.purpose === purpose);
  if (!list.length) return '<p class="muted empty">目前尚無附件</p>';
  return list.map((file, index) => {
    const url = fileUrl(file.public_id);
    const label = `${purposeLabel(file.purpose)} ${index + 1}`;
    if (String(file.mime_type || '').startsWith('image/')) {
      return `<figure class="media"><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}"></a><figcaption>${escapeHtml(label)}｜${escapeHtml(file.original_name || '')}</figcaption></figure>`;
    }
    if (String(file.mime_type || '').startsWith('video/')) {
      return `<figure class="media"><video controls src="${escapeHtml(url)}"></video><figcaption>${escapeHtml(label)}｜${escapeHtml(file.original_name || '')}</figcaption></figure>`;
    }
    return `<a class="file-link" target="_blank" rel="noreferrer" href="${escapeHtml(url)}">${escapeHtml(label)}｜${escapeHtml(file.original_name || '附件')}</a>`;
  }).join('');
}

function parseRepairRecordText(messageText) {
  const lines = String(messageText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const values = {};
  lines.forEach((line) => {
    const match = line.match(/^([^：:]+)[：:]\s*(.*)$/);
    if (match) values[match[1].trim()] = match[2].trim();
  });
  return values;
}

function compactBasisLabel(text, options = {}) {
  const value = String(text || '');
  if (!value) return '尚無依據';
  if (/沒有找到|無對應|例外/.test(value)) return '無對應條款，需留例外紀錄';
  if (/資訊不足|補充|佐證|缺少/.test(value)) {
    return options.noMissing
      ? '資料已齊，待房東／維修確認後套規則'
      : '資料不足，需補資料後套規則';
  }
  if (/自然損壞|正常使用|房東負擔/.test(value)) return '依一般原則偏房東修繕／負擔';
  if (/故意|過失|不當使用|房客負擔/.test(value)) return '依一般原則偏房客責任，需佐證';
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

function repairAiRecordHtml(messageText) {
  const values = parseRepairRecordText(messageText);
  if (!values['AI 協商摘要']) return `<p>${escapeHtml(messageText)}</p>`;
  const missing = values['待補'] || '無';
  const needMore = missing !== '無';
  const [riskText, ruleText] = String(values['初判'] || '待確認；待補資料')
    .split('；')
    .map((part) => part.trim());
  const displayRiskText = !needMore && riskText === '待補資料'
    ? '待確認'
    : riskText;
  const displayRuleText = !needMore && /規則要求補資料|證據不足|資訊不足/.test(ruleText || '')
    ? '資料已齊，待房東／維修確認後套用規則'
    : (ruleText || '需補資料後再套規則');
  const chip = (label, value, tone = 'default') => {
    const palette = {
      default: ['#F8FAFC', '#CBD5E1', '#334155'],
      dark: ['#1F2937', '#1F2937', '#FFFFFF'],
      warn: ['#FFF7ED', '#FDBA74', '#9A3412'],
      ok: ['#ECFDF5', '#A7F3D0', '#047857'],
      blue: ['#EFF6FF', '#BFDBFE', '#1D4ED8'],
    }[tone] || ['#F8FAFC', '#CBD5E1', '#334155'];
    return `
      <span style="display:inline-flex;align-items:center;gap:4px;border:1px solid ${palette[1]};background:${palette[0]};color:${palette[2]};border-radius:999px;padding:5px 9px;font-size:12px;font-weight:800;white-space:nowrap">
        <small style="font-weight:600;opacity:.72">${escapeHtml(label)}</small>${escapeHtml(value || '-')}
      </span>
    `;
  };
  return `
    <div style="margin-top:10px;border-left:4px solid ${needMore ? '#D97706' : '#059669'};border-radius:14px;background:#FFFFFF;padding:12px 12px 10px;box-shadow:0 1px 0 #E5E7EB inset,0 -1px 0 #E5E7EB inset,1px 0 0 #E5E7EB inset,-1px 0 0 #E5E7EB inset">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
        <strong style="font-size:15px;color:#111827">AI 摘要</strong>
        ${chip('待補', missing, needMore ? 'warn' : 'ok')}
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px">
        ${chip('設備', values['對應設備'] || '待補', 'dark')}
        ${chip('照片', values['損壞照片'] || '0 張', 'blue')}
        ${values['房客意願'] ? chip('意願', values['房客意願']) : ''}
      </div>

      <div style="padding:10px;border-radius:12px;background:#F8FAFC;border:1px solid #E5E7EB">
        <div style="font-size:12px;color:#64748B;margin-bottom:4px">初判</div>
        <div style="font-size:14px;line-height:1.5;color:#111827;font-weight:800">${escapeHtml(displayRiskText || '待確認')}</div>
        <div style="font-size:13px;line-height:1.5;color:#475569;margin-top:2px">${escapeHtml(displayRuleText)}</div>
      </div>

      <div style="margin-top:10px;font-size:13px;line-height:1.6;color:#334155">
        <b style="color:#111827">建議</b>：${escapeHtml(values['建議'] || '依目前資料處理')}
      </div>

      <details style="margin-top:8px;font-size:12px;color:#64748B">
        <summary style="cursor:pointer;color:#475569;font-weight:700">依據：${escapeHtml(compactBasisLabel(values['依據'], { noMissing: !needMore }))}</summary>
        <p style="margin:8px 0 0;white-space:pre-wrap;line-height:1.55">${escapeHtml(values['依據'] || '尚無依據')}</p>
      </details>
    </div>
  `;
}

function timelineHtml(updates, files) {
  if (!updates.length) return '<p class="muted empty">目前尚無狀態紀錄</p>';
  const filesByUpdate = new Map();
  files.forEach((file) => {
    const key = file.repair_update_public_id;
    if (!filesByUpdate.has(key)) filesByUpdate.set(key, []);
    filesByUpdate.get(key).push(file);
  });

  return updates.map((update) => {
    const linkedFiles = filesByUpdate.get(update.public_id) || [];
    const tone = statusTone(update.to_status);
    const status = update.to_status ? `<span class="pill ${escapeHtml(tone.className)}">${escapeHtml(statusText(update.to_status, 0))}</span>` : '';
    return `
      <article class="event ${escapeHtml(tone.className)}">
        <div class="dot" style="background:${escapeHtml(tone.dot)}"></div>
        <div class="event-card">
          <div class="event-meta">
            <strong>${escapeHtml(update.actor_name || '系統')}</strong>
            <time>${escapeHtml(formatDateTime(update.created_at))}</time>
          </div>
          ${status}
          ${update.message_text ? repairAiRecordHtml(update.message_text) : ''}
          ${linkedFiles.length ? `<div class="mini-grid">${mediaHtml(linkedFiles)}</div>` : ''}
        </div>
      </article>
    `;
  }).join('');
}

function repairListHtml(tickets, options = {}) {
  if (!tickets.length) return '<p class="muted empty">目前沒有已結案的報修歷史</p>';
  return tickets.map((ticket) => {
    const params = new URLSearchParams();
    if (options.lineUserId) params.set('lineUserId', options.lineUserId);
    if (options.scope) params.set('scope', options.scope);
    const query = params.toString() ? `?${params.toString()}` : '';
    const basePath = options.audience === 'landlord' ? '/landlord/repairs' : '/tenant/repairs';
    const href = `${basePath}/${encodeURIComponent(ticket.public_id)}${query}`;
    return `
      <a class="repair-link" href="${escapeHtml(href)}">
        <div>
          <strong>${escapeHtml(ticket.unit_label || '租屋物件')}</strong>
          <p>${escapeHtml(ticket.description || ticket.category || '報修內容')}</p>
          <span>${escapeHtml(formatDateTime(ticket.updated_at || ticket.reported_at))}｜損壞照片 ${Number(ticket.damage_photo_count || 0)}｜修好照片 ${Number(ticket.completion_photo_count || 0)}</span>
        </div>
        <em>查看</em>
      </a>
    `;
  }).join('');
}

function repairStatusNavHtml({ audience = 'landlord', lineUserId = '', scope = '', status = 'open', selectedUnitId = null }) {
  const isHistory = status === 'history';
  const basePath = audience === 'tenant'
    ? (isHistory ? '/tenant/repairs' : '/tenant/repairs/history')
    : '/landlord/repairs';
  const params = new URLSearchParams();
  if (lineUserId) params.set('lineUserId', lineUserId);
  if (audience === 'landlord' && scope) params.set('scope', scope);
  if (audience === 'landlord') params.set('status', isHistory ? 'open' : 'history');
  if (audience === 'landlord' && selectedUnitId != null) params.set('unitId', String(selectedUnitId));
  const alternateHref = `${basePath}?${params.toString()}`;
  return `<nav class="repair-mode-nav" aria-label="修繕案件範圍">
    <a class="${isHistory ? '' : 'active'}" href="${escapeHtml(isHistory ? alternateHref : '#')}">正在報修</a>
    <a class="${isHistory ? 'active' : ''}" href="${escapeHtml(isHistory ? '#' : alternateHref)}">修繕歷史</a>
  </nav>`;
}

function unitFilterHtml(units, selectedUnitId, lineUserId, scope = '', status = '') {
  const baseParams = new URLSearchParams();
  if (lineUserId) baseParams.set('lineUserId', lineUserId);
  if (scope) baseParams.set('scope', scope);
  if (status) baseParams.set('status', status);
  // 只有一個房源時不需要再顯示「全部／591 刊登單位」這類沒有篩選價值的按鈕。
  if (units.length <= 1) return '';
  const allParams = new URLSearchParams();
  if (lineUserId) allParams.set('lineUserId', lineUserId);
  if (scope) allParams.set('scope', scope);
  if (status) allParams.set('status', status);
  const allHref = `/landlord/repairs?${allParams.toString()}`;
  const chips = [
    `<a class="chip ${selectedUnitId == null ? 'active' : ''}" href="${escapeHtml(allHref)}">全部</a>`,
    ...units.map((unit) => {
      const query = new URLSearchParams({
        ...(lineUserId ? { lineUserId } : {}),
        ...(scope ? { scope } : {}),
        ...(status ? { status } : {}),
        unitId: String(unit.id),
      }).toString();
      return `<a class="chip ${String(selectedUnitId || '') === String(unit.id) ? 'active' : ''}" href="/landlord/repairs?${escapeHtml(query)}">${escapeHtml(unit.unit_label || '房源')} <small>${Number(unit.repair_count || 0)}</small></a>`;
    }),
  ];
  return `<div class="chips unit-chips">${chips.join('')}</div>`;
}

function repairHistoryListPage({ title, eyebrow, subtitle, tickets, units = [], selectedUnitId = null, lineUserId = '', scope = '', status = '', audience = 'tenant' }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:760px;margin:auto;padding:18px 14px 40px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:20px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:22px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:24px}.section{padding:16px}.muted{color:#64748B;font-size:14px}.empty{padding:14px;border-radius:14px;background:#F8FAFC}.repair-mode-nav{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.repair-mode-nav a{border:1px solid #CBD5E1;border-radius:11px;color:#334155;text-align:center;text-decoration:none;padding:9px 10px;font-size:14px;font-weight:800}.repair-mode-nav a.active{background:#1F2937;border-color:#1F2937;color:#fff}.chips{display:flex;gap:8px;overflow-x:auto;padding:2px 0 14px;margin-bottom:8px}.unit-chips{margin-top:2px}.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#E5E7EB;color:#334155;text-decoration:none;padding:8px 12px;font-size:14px;font-weight:700;white-space:nowrap}.chip.active{background:#1F2937;color:#fff}.chip small{opacity:.75}.repair-list{display:grid;gap:12px}.repair-link{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px;border:1px solid #E5E7EB;border-radius:16px;text-decoration:none;background:#fff;color:#111827}.repair-link strong{display:block;font-size:16px}.repair-link p{margin:5px 0;color:#334155;font-size:14px;line-height:1.45}.repair-link span{display:block;color:#94A3B8;font-size:12px}.repair-link em{font-style:normal;border-radius:999px;background:#ECFDF5;color:#047857;font-weight:700;font-size:12px;padding:5px 10px;white-space:nowrap}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:20px 16px}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
      </header>
      <section class="section">
        <p class="muted">${escapeHtml(subtitle)}</p>
        ${repairStatusNavHtml({ audience, lineUserId, scope, status: status || 'open', selectedUnitId })}
        ${audience === 'landlord' ? unitFilterHtml(units, selectedUnitId, lineUserId, scope, status) : ''}
        <div class="repair-list">${repairListHtml(tickets, { audience, lineUserId, scope })}</div>
      </section>
    </section>
  </main>
</body>
</html>`;
}

const TENANT_ACTION_REPAIR_STATUSES = new Set([
  'need_info',
  'tenant_pays',
  'tenant_self_repair',
]);

const VENDOR_ACTION_REPAIR_STATUSES = new Set([
  'vendor_judgement',
]);

function landlordRepairWorkflow(ticket) {
  const missing = safeJsonArray(ticket.ai_missing_info_json);
  const resolved = resolveAllowedRepairActions(ticket, missing);
  const state = resolved.state || normalizeRepairActionState(ticket, missing);
  const repairStatus = String(state.repairStatus || ticket.status || '');
  const primaryAction = resolved.actions[0] || null;

  if (state.caseClosed) {
    return {
      owner: 'none',
      bucket: 'closed',
      label: '已結案',
      actionText: '查看紀錄',
      intro: '案件已結案或取消，僅保留完整紀錄。',
      resolved,
    };
  }

  if (state.urgent) {
    return {
      owner: 'landlord',
      bucket: 'urgent',
      label: '緊急',
      actionText: primaryAction?.label || '立即處理',
      intro: resolved.intro || '緊急安全事件，先處理風險，不等待責任判斷。',
      resolved,
    };
  }

  // 房客已經回傳修好證據時，案件要明確交回房東確認；不能只是
  // 落在籠統的「進行中」，否則房東看不到確認／退回的下一步。
  if (state.repairCompleted && Number(state.completionPhotoCount || 0) > 0) {
    const completedByLandlordOrVendor = state.dispatchParty === 'landlord' || state.dispatchParty === 'vendor';
    if (completedByLandlordOrVendor && state.repairVerificationStatus !== 'confirmed') {
      const repairResultDisputed = state.repairVerificationStatus === 'disputed';
      return {
        owner: repairResultDisputed ? 'landlord' : 'tenant',
        bucket: repairResultDisputed ? 'mine' : 'progress',
        label: repairResultDisputed ? '房客回報修繕有問題' : '等房客查驗修繕結果',
        actionText: repairResultDisputed ? '確認是否補修' : '等待房客查驗',
        intro: repairResultDisputed
          ? '房客回報修繕結果仍有問題；請查看說明並確認是否需要補修。'
          : '房東／廠商已上傳修好資料，正在等待房客從外部頁查驗結果。',
        resolved,
      };
    }
    return {
      owner: 'landlord',
      bucket: 'mine',
      label: '待確認修好照片',
      actionText: primaryAction?.label || '確認修好與費用',
      intro: '房客已回傳修好後照片；請核對修復結果、附件與費用，再確認或退回需重新處理。',
      resolved,
    };
  }

  const appointmentPublicId = String(ticket.active_appointment_public_id || '');
  const appointmentMessage = String(ticket.latest_appointment_message || '');
  if (appointmentPublicId && !state.repairCompleted) {
    if (appointmentMessage.includes('希望改期')) {
      return {
        owner: 'system',
        bucket: 'progress',
        label: '房客希望改期',
        actionText: '等待可用時段協調',
        intro: '已保留房客的改期需求與留言；待雙方可用時段協調功能接入後再選新時間，不需重新建立預約。',
        resolved,
      };
    }
    if (appointmentMessage.includes('已確認可配合')) {
      return {
        owner: 'system',
        bucket: 'progress',
        label: '已確認修繕時間',
        actionText: '查看預約',
        intro: '房客已確認可配合預約時間，等待依約到場處理。',
        resolved,
      };
    }
    return {
      owner: 'tenant',
      bucket: 'progress',
      label: '等房客回覆預約',
      actionText: '查看預約',
      intro: '已提出修繕時間，正在等待房客確認時間或提出改期需求。',
      resolved,
    };
  }

  if (TENANT_ACTION_REPAIR_STATUSES.has(repairStatus)) {
    const waiting = {
      need_info: {
        label: '等房客補件',
        intro: '已請房客補充資料；補完後系統會重新整理並通知房東。',
      },
      tenant_pays: {
        label: '等房客確認方案',
        intro: '已通知房客確認本次處理方案；房客可接受、補件或提出異議。',
      },
      tenant_self_repair: {
        label: '等房客回傳修好照片',
        intro: '已同意房客自行處理；修好後房客需回傳照片與維修資料給房東確認。',
      },
    }[repairStatus];
    return {
      owner: 'tenant',
      bucket: 'progress',
      label: waiting.label,
      actionText: '查看案件',
      intro: waiting.intro,
      resolved,
    };
  }

  if (VENDOR_ACTION_REPAIR_STATUSES.has(repairStatus)) {
    return {
      owner: 'vendor',
      bucket: 'progress',
      label: '等專業判斷',
      actionText: '查看案件',
      intro: '已送維修／專業人員判斷；結果回來後再重新套用規則。',
      resolved,
    };
  }

  if (resolved.actions.length > 0) {
    return {
      owner: 'landlord',
      bucket: 'mine',
      label: '待我處理',
      actionText: primaryAction?.label || '處理',
      intro: resolved.intro || '目前輪到房東執行下一步。',
      resolved,
    };
  }

  return {
    owner: 'system',
    bucket: 'progress',
    label: '系統處理中',
    actionText: '查看案件',
    intro: resolved.intro || '案件仍在進行中，目前沒有需要房東立即操作的動作。',
    resolved,
  };
}

function landlordTaskCenterPage({ activeTickets, recentUpdates, notificationEvents = [], overview = {}, lineUserId, scope = '', tab = 'mine', category = 'all' }) {
  const queryParams = new URLSearchParams();
  if (lineUserId) queryParams.set('lineUserId', lineUserId);
  if (scope) queryParams.set('scope', scope);
  const query = queryParams.toString();
  const activeUrl = `/landlord/repairs${query ? `?${query}&status=open` : '?status=open'}`;
  const historyUrl = `/landlord/repairs${query ? `?${query}&status=history` : '?status=history'}`;
  const currentTab = ['mine', 'progress', 'notifications'].includes(tab) ? tab : 'mine';
  const categories = [
    { key: 'all', label: '全部', icon: '🔖' },
    { key: 'repair', label: '修繕', icon: '🛠️' },
    { key: 'question', label: '問答', icon: '💬' },
    { key: 'viewing', label: '看房', icon: '🗓️' },
    { key: 'handover', label: '點交', icon: '🏠' },
    { key: 'contract', label: '簽約', icon: '📝' },
    { key: 'billing', label: '帳務', icon: '💰' },
    { key: 'other', label: '其他', icon: '🔔' },
  ];
  const categoryMeta = (key) => categories.find((item) => item.key === key) || categories.find((item) => item.key === 'other');
  const currentCategory = categories.some((item) => item.key === category) ? category : 'all';
  const tabUrl = (nextTab, nextCategory = currentCategory) => {
    const params = new URLSearchParams(queryParams);
    params.set('tab', nextTab);
    if (nextCategory !== 'all') params.set('category', nextCategory);
    return `/landlord/tasks?${params.toString()}`;
  };
  const repairUrl = (ticketPublicId) => {
    const params = new URLSearchParams();
    if (lineUserId) params.set('lineUserId', lineUserId);
    if (scope) params.set('scope', scope);
    const returnParams = new URLSearchParams(queryParams);
    returnParams.set('tab', currentTab);
    if (currentCategory !== 'all') returnParams.set('category', currentCategory);
    params.set('returnTo', `/landlord/tasks?${returnParams.toString()}`);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return `/landlord/repairs/${encodeURIComponent(ticketPublicId)}${suffix}`;
  };
  const decoratedTickets = activeTickets
    .map((ticket) => ({ ticket, workflow: landlordRepairWorkflow(ticket) }));
  const urgentTickets = decoratedTickets.filter((entry) => entry.workflow.bucket === 'urgent');
  const myTickets = decoratedTickets.filter((entry) => entry.workflow.bucket === 'mine');
  const progressTickets = decoratedTickets.filter((entry) => entry.workflow.bucket === 'progress');
  const filterRepairEntries = (entries) => (currentCategory === 'all' || currentCategory === 'repair' ? entries : []);
  // 緊急修繕只屬於「全部」與「修繕」；切到看房、問答等類別時，不混入修繕警示。
  const showsRepairItems = currentCategory === 'all' || currentCategory === 'repair';
  const categoryEmptyText = (defaultText) => currentCategory === 'repair' || currentCategory === 'all'
    ? defaultText
    : `目前沒有「${categories.find((item) => item.key === currentCategory).label}」相關項目。`;
  const renderEmptyState = (defaultText) => `<p class="empty">${escapeHtml(categoryEmptyText(defaultText))}</p>`;
  const contextItems = {
    question: (overview.questionItems || []).map((item) => ({
      category: 'question', title: item.unit_label || '房源問題',
      summary: item.question_text || '房客有一則待回覆問題', actor: item.tenant_name || '房客', eventAt: item.event_at,
      action: '前往 AI 知識庫回覆',
    })),
    viewing: (overview.showingItems || []).map((item) => ({
      category: 'viewing', title: item.unit_label || '看房預約',
      summary: item.title || `預約時間：${formatDateTime(item.starts_at)}`, actor: item.tenant_name || '房客', eventAt: item.event_at,
      action: '查看看房安排',
    })),
    handover: (overview.inspectionItems || []).map((item) => ({
      category: 'handover', title: item.unit_label || '屋況點交',
      summary: item.title || '有一筆點交待確認', actor: item.tenant_name || '房客', eventAt: item.event_at,
      action: '查看點交資料',
      actionUrl: landlordInspectionActionUrl(item, lineUserId),
    })),
    contract: (overview.intentionItems || []).map((item) => ({
      category: 'contract', title: item.unit_label || '簽約條件',
      summary: item.title || '有一筆承租／簽約資料待處理', actor: item.tenant_name || '房客', eventAt: item.event_at,
      action: '查看簽約流程',
    })),
    billing: (overview.dueReminderItems || []).map((item) => ({
      category: 'billing', title: item.unit_label || '帳務提醒',
      summary: `${item.charge_type || '帳單'}・NT$ ${Number(item.amount || 0).toLocaleString('zh-TW')}・到期 ${formatDateTime(item.due_date)}`,
      actor: '系統', eventAt: item.event_at,
      action: '查看帳務明細',
    })),
  };
  const currentContextItems = currentCategory === 'all'
    ? Object.values(contextItems)
      .flat()
      .sort((left, right) => String(right.eventAt || '').localeCompare(String(left.eventAt || '')))
      .slice(0, 8)
    : (contextItems[currentCategory] || []);
  const renderContextCards = (entries, emptyText) => entries.length
    ? entries.slice(0, 8).map((item) => `
      <article class="task-card context-card category-${escapeHtml(item.category)}">
        <div class="task-main">
          <span class="icon">${escapeHtml(categoryMeta(item.category).icon)}</span>
          <div>
            <div class="task-title"><strong><b>${escapeHtml(categoryMeta(item.category).label)}</b>${escapeHtml(item.title)}</strong><em>待處理</em></div>
            <p>${escapeHtml(shortTaskText(item.summary, 58))}</p>
            <small>${escapeHtml(item.actor)}・${escapeHtml(formatDateTime(item.eventAt))}</small>
          </div>
        </div>
        <a class="primary-link muted-link" href="${escapeHtml(item.actionUrl || tabUrl('notifications', item.category))}">${escapeHtml(item.action)} →</a>
      </article>
    `).join('')
    : `<p class="empty">${escapeHtml(emptyText)}</p>`;
  const renderTicketCards = (entries, emptyText, ctaFallback = '查看案件') => entries.length
    ? entries.slice(0, 8).map(({ ticket, workflow }) => {
      const tone = statusTone(ticket.status);
      return `
        <article class="task-card category-repair ${escapeHtml(tone.className)} ${workflow.bucket === 'urgent' ? 'urgent-card' : ''}">
          <div class="task-main">
            <span class="icon">🛠️</span>
            <div>
              <div class="task-title">
                <strong><b>修繕</b>${escapeHtml(ticket.unit_label || '租屋物件')}</strong>
                <em>${escapeHtml(workflow.label || statusText(ticket.status, Number(ticket.completion_photo_count || 0)))}</em>
              </div>
              <p>${escapeHtml(ticket.description || ticket.category || '報修內容')}</p>
              <small>${escapeHtml(ticket.tenant_name || '房客')}・${escapeHtml(formatDateTime(ticket.updated_at || ticket.reported_at))}</small>
            </div>
          </div>
          <a class="primary-link" href="${escapeHtml(repairUrl(ticket.public_id))}">${escapeHtml(workflow.actionText || ctaFallback)} →</a>
        </article>
      `;
    }).join('')
    : `<p class="empty">${escapeHtml(emptyText)}</p>`;
  const urgentHtml = urgentTickets.length && showsRepairItems && currentTab !== 'notifications'
    ? `
      <section class="section emergency-section">
        <div class="section-head">
          <div>
            <h2>緊急案件</h2>
            <p>先確認安全處置，責任與費用稍後再補。</p>
          </div>
          <strong>${urgentTickets.length}</strong>
        </div>
        <div class="task-list">${renderTicketCards(filterRepairEntries(urgentTickets), '')}</div>
      </section>
    `
    : '';
  const urgentStrip = urgentTickets.length && showsRepairItems && currentTab === 'notifications'
    ? `<a class="urgent-strip" href="${escapeHtml(tabUrl('mine'))}">⚠️ 有 ${urgentTickets.length} 件緊急案件需要先處理</a>`
    : '';
  const repairTodoHtml = myTickets.length
    ? renderTicketCards(filterRepairEntries(myTickets), '')
    : '';
  const contextTodoHtml = currentContextItems.length
    ? renderContextCards(currentContextItems, '')
    : '';
  const todoHtml = currentCategory === 'repair'
    ? (repairTodoHtml || renderEmptyState('目前沒有輪到房東處理的修繕。'))
    : currentCategory === 'all'
      ? ((repairTodoHtml || '') + (contextTodoHtml || '') || renderEmptyState('目前沒有輪到房東處理的待辦。'))
      : (contextTodoHtml || renderEmptyState(`目前沒有「${categoryMeta(currentCategory).label}」待處理事項。`));
  const repairProgressHtml = progressTickets.length
    ? renderTicketCards(filterRepairEntries(progressTickets), '', '查看案件')
    : '';
  // 非修繕待辦只會出現在「待我處理」。進行中專門呈現尚未結案、
  // 正在等待房客／預約／專業判斷的修繕案件，避免同一工作重複出現。
  const progressHtml = currentCategory === 'repair'
    ? (repairProgressHtml || renderEmptyState('目前沒有進行中的修繕案件。'))
    : currentCategory === 'all'
      ? (repairProgressHtml || renderEmptyState('目前沒有進行中的修繕案件。'))
      : renderEmptyState(`「${categoryMeta(currentCategory).label}」沒有進行中的修繕案件。`);
  const repairUpdateEvents = recentUpdates.map((update) => ({
    category: 'repair',
    title: `${update.unit_label || '租屋物件'}・${update.update_type || '修繕狀態更新'}`,
    message: update.message_text || update.description || statusText(update.to_status),
    actorName: update.actor_name || '系統',
    eventAt: update.created_at,
    repairPublicId: update.repair_public_id,
    tone: statusTone(update.to_status || update.repair_status),
  }));
  const databaseEvents = notificationEvents.map((event) => ({
    category: event.category,
    title: `${event.unitLabel || '租屋物件'}・${event.title}`,
    message: event.message,
    actorName: event.delivery_status === 'sent' ? '系統通知' : '系統紀錄',
    eventAt: event.eventAt,
    repairPublicId: event.entity_type === 'repair_ticket' ? event.entity_id : '',
    actionUrl: event.actionUrl,
    tone: statusTone(event.category === 'repair' ? 'reported' : event.category === 'billing' ? 'need_info' : 'accepted'),
  }));
  const allNotificationEntries = [...repairUpdateEvents, ...databaseEvents];
  const filteredUpdates = allNotificationEntries
    .filter((event) => currentCategory === 'all' || event.category === currentCategory)
    .sort((left, right) => String(right.eventAt || '').localeCompare(String(left.eventAt || '')));
  const updateHtml = filteredUpdates.length
    ? filteredUpdates.slice(0, 16).map((update) => {
      const tone = statusTone(update.to_status || update.repair_status);
      const href = update.actionUrl || (update.repairPublicId ? repairUrl(update.repairPublicId) : tabUrl('notifications', update.category));
      return `
        <a class="notice-row category-${escapeHtml(update.category)} ${escapeHtml((update.tone || tone).className)}" href="${escapeHtml(href)}">
          <span class="notice-icon">${escapeHtml(categoryMeta(update.category).icon)}</span>
          <div>
            <strong><b>${escapeHtml(categoryMeta(update.category).label)}</b>${escapeHtml(update.title)}</strong>
            <p>${escapeHtml(shortTaskText(update.message, 70))}</p>
            <small>${escapeHtml(update.actorName || '系統')}｜${escapeHtml(formatDateTime(update.eventAt))}</small>
          </div>
        </a>
      `;
    }).join('')
    : `<p class="empty">${escapeHtml(categoryEmptyText('目前沒有近期通知。'))}</p>`;
  const contextualPendingCounts = {
    question: Number(overview.pendingLandlordQuestionCount || 0),
    viewing: Number(overview.upcomingShowingCount || 0),
    handover: Number(overview.pendingInspectionConfirmationCount || 0),
    contract: Number(overview.activeIntentionCount || 0) + Number(overview.pendingSignatureCount || 0),
    billing: Number(overview.dueChargeReminderCount || 0),
    other: 0,
  };
  const countEntriesByCategory = (entries) => entries.reduce((counts, entry) => {
    const key = String(entry.category || 'other');
    counts[key] = Number(counts[key] || 0) + 1;
    return counts;
  }, {});
  const currentCategoryCounts = currentTab === 'notifications'
    ? countEntriesByCategory(allNotificationEntries)
    : currentTab === 'progress'
      ? { repair: progressTickets.length }
      : { repair: myTickets.length, ...contextualPendingCounts };
  const categoryCount = (key) => key === 'all'
    ? Object.values(currentCategoryCounts).reduce((total, count) => total + Number(count || 0), 0)
    : Number(currentCategoryCounts[key] || 0);
  const mineCount = myTickets.length + Object.values(contextualPendingCounts)
    .reduce((total, count) => total + Number(count || 0), 0);
  const categoryOptions = categories.map((item) => `
    <option value="${escapeHtml(item.key)}"${currentCategory === item.key ? ' selected' : ''}>${escapeHtml(item.label)}${categoryCount(item.key) ? `（${categoryCount(item.key)}）` : ''}</option>
  `).join('');
  const repairArchiveLink = currentTab === 'notifications' && currentCategory === 'repair'
    ? `<a class="repair-category-link" href="${escapeHtml(activeUrl)}">🛠️ 修繕案件・進行中與歷史</a>`
    : '';
  const sectionContent = ({
    mine: `
      <section class="section">
        <h2>待我處理</h2>
        <p>只顯示現在輪到你操作的事項。</p>
        <div class="task-list">${todoHtml}</div>
      </section>
    `,
    progress: `
      <section class="section">
        <h2>進行中</h2>
          <p>正在等待房客補件／確認、修好照片回傳、專業判斷或預約回覆的案件。</p>
        <div class="task-list">${progressHtml}</div>
      </section>
    `,
    notifications: `
      <section class="section">
        <h2>通知紀錄</h2>
        <p>最近事件；不一定代表現在需要你操作。</p>
        <div class="notice-list">${updateHtml}</div>
      </section>
    `,
  })[currentTab];

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>通知與待辦中心</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    .page{max-width:760px;margin:auto;padding:10px 12px 32px}
    .hero{border-radius:16px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:13px 14px}
    .hero p{margin:0 0 3px;color:#CBD5E1;font-size:11px}
    .hero h1{margin:0;font-size:19px;line-height:1.25}
    .task-hub{margin-top:9px;border:1px solid #E5E7EB;border-radius:16px;background:#fff;padding:11px}
    .summary{display:flex;gap:14px;margin:0 2px 8px}
    .summary-card{display:flex;align-items:baseline;gap:5px;background:transparent;padding:0}
    .summary-card span{color:#64748B;font-size:12px}
    .summary-card strong{font-size:18px;line-height:1}
    .tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;margin:8px 0;padding:3px;border-radius:13px;background:#E5E7EB}
    .tabs a{border-radius:10px;color:#334155;text-align:center;text-decoration:none;padding:7px 3px;font-size:13px;font-weight:900}
    .tabs a.active{background:#1F2937;color:#fff;box-shadow:0 8px 18px rgba(15,23,42,.12)}
    .category-filter{display:flex;align-items:center;gap:8px;margin:8px 0 10px;color:#64748B;font-size:12px;font-weight:800}.category-filter select{min-width:128px;border:1px solid #D8DEE8;border-radius:999px;background:#fff;color:#334155;padding:7px 28px 7px 11px;font:inherit;font-weight:800}.repair-category-link{display:inline-flex;align-items:center;border:1px solid #BFDBFE;border-radius:999px;background:#EFF6FF;color:#1D4ED8;text-decoration:none;padding:7px 10px;font-size:12px;font-weight:900;white-space:nowrap}
    .urgent-strip{display:block;margin:7px 0;border:1px solid #FCA5A5;border-radius:12px;background:#FFF7F7;color:#B91C1C;text-decoration:none;padding:8px 10px;font-size:13px;font-weight:900}
    .section{border:1px solid #E5E7EB;border-radius:15px;background:#fff;padding:12px;margin-top:8px}
    .section h2{margin:0;font-size:17px;line-height:1.25}
    .section>p,.section-head p{margin:3px 0 9px;color:#64748B;font-size:12px;line-height:1.4}
    .section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
    .section-head strong{min-width:32px;height:32px;border-radius:999px;background:#FEE2E2;color:#B91C1C;display:grid;place-items:center;font-size:15px}
    .emergency-section{border-color:#FCA5A5;background:#FFF7F7}
    .task-list,.notice-list{display:grid;gap:7px}
    .task-card{border:1px solid #E5E7EB;border-radius:13px;padding:9px;background:#fff}
    .urgent-card{border-color:#F87171}
    .task-main{display:flex;gap:8px}
    .task-main>div{min-width:0;flex:1}
    .icon,.notice-icon{width:32px;height:32px;border-radius:10px;background:#F1F5F9;display:grid;place-items:center;flex:0 0 32px;font-size:16px}
    .task-title{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
    .task-title strong{font-size:14px;line-height:1.35}.task-title strong b,.notice-row strong b{display:inline-block;margin-right:5px;color:#64748B;font-size:11px;font-weight:800}
    .task-title em{font-style:normal;border-radius:999px;background:#F1F5F9;color:#334155;font-size:10px;font-weight:800;padding:3px 7px;white-space:nowrap}
    .urgent-card .task-title em{background:#FEE2E2;color:#B91C1C}
    .task-card p,.notice-row p{margin:3px 0;color:#334155;line-height:1.35;font-size:13px}
    .task-card small,.notice-row small{color:#94A3B8;font-size:11px}
    .primary-link{display:block;margin-top:7px;border-radius:10px;background:#1F2937;color:#fff;text-align:center;text-decoration:none;font-size:13px;padding:8px;font-weight:900}
    .urgent-card .primary-link{background:#B91C1C}
    .notice-row{display:flex;gap:8px;border:1px solid #E5E7EB;border-radius:13px;background:#fff;color:#111827;text-decoration:none;padding:9px}
    .notice-row strong{font-size:13px;line-height:1.35}
    .empty{margin:0;border-radius:12px;background:#F8FAFC;color:#64748B;padding:12px;font-size:13px}
    .tone-red{border-color:#FECACA}
    .tone-amber{border-color:#FED7AA}
    .tone-purple{border-color:#DDD6FE}
    .tone-green{border-color:#A7F3D0}
    .tone-blue{border-color:#BFDBFE}
    .category-question{--category:#7C3AED;--category-soft:#F3E8FF;--category-border:#DDD6FE}
    .category-viewing{--category:#2563EB;--category-soft:#DBEAFE;--category-border:#BFDBFE}
    .category-handover{--category:#0891B2;--category-soft:#CFFAFE;--category-border:#A5F3FC}
    .category-contract{--category:#D97706;--category-soft:#FEF3C7;--category-border:#FED7AA}
    .category-repair{--category:#2563EB;--category-soft:#EFF6FF;--category-border:#BFDBFE}
    .category-billing{--category:#059669;--category-soft:#D1FAE5;--category-border:#A7F3D0}
    .category-other{--category:#475569;--category-soft:#E2E8F0;--category-border:#CBD5E1}
    .task-card[class*="category-"],.notice-row[class*="category-"]{border-color:var(--category-border,#E5E7EB)}
    .task-card[class*="category-"] .icon,.notice-row[class*="category-"] .notice-icon{background:var(--category-soft,#F1F5F9)}
    .task-card[class*="category-"] .task-title strong b,.notice-row[class*="category-"] strong b{color:var(--category,#64748B)}
    @media(max-width:640px){
      .page{padding:0 0 28px}
      .hero{border-radius:0;padding:13px 14px}
      .task-hub{margin:8px 10px 0;padding:10px;border-radius:15px}
      .summary,.tabs,.category-filter,.urgent-strip{margin-left:0;margin-right:0}
      .section{border:0;border-top:1px solid #E5E7EB;border-radius:0;margin-top:7px;padding:12px 0 0}
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <p>房東端｜LINE 只做通知，完整處理到外部頁</p>
      <h1>通知與待辦中心</h1>
    </header>
    <div class="task-hub">
      <div class="summary">
        <div class="summary-card"><span>待我處理</span><strong>${mineCount}</strong></div>
        <div class="summary-card"><span>進行中</span><strong>${progressTickets.length}</strong></div>
        <div class="summary-card"><span>緊急</span><strong>${urgentTickets.length}</strong></div>
      </div>
      <nav class="tabs" aria-label="通知與待辦分類">
        <a class="${currentTab === 'mine' ? 'active' : ''}" href="${escapeHtml(tabUrl('mine'))}">待我處理</a>
        <a class="${currentTab === 'progress' ? 'active' : ''}" href="${escapeHtml(tabUrl('progress'))}">進行中</a>
        <a class="${currentTab === 'notifications' ? 'active' : ''}" href="${escapeHtml(tabUrl('notifications'))}">通知紀錄</a>
      </nav>
      <form class="category-filter" method="get" action="/landlord/tasks" aria-label="待辦事件類別">
        <input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}">
        ${scope ? `<input type="hidden" name="scope" value="${escapeHtml(scope)}">` : ''}
        <input type="hidden" name="tab" value="${escapeHtml(currentTab)}">
        <label for="category">顯示類別</label>
        <select id="category" name="category" onchange="this.form.submit()">${categoryOptions}</select>
        ${repairArchiveLink}
      </form>
      ${urgentStrip}
      ${urgentHtml}
      ${sectionContent}
    </div>
  </main>
</body>
</html>`;
}

function shortTaskText(value, max = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '狀態更新';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeFileName(fileName) {
  return String(fileName || 'repair-upload')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, 180);
}

function repairExternalUrl(pathname) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const liffId = process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
  if (process.env.REPAIR_USE_MINIAPP_URLS === 'true' && liffId) {
    return `https://miniapp.line.me/${encodeURIComponent(liffId)}${normalizedPath}`;
  }
  const baseUrl = (process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${baseUrl}${normalizedPath}`;
}

function listRepairAssetsForUnit(db, rentalUnitId) {
  return db.prepare(`
    SELECT id, asset_name, asset_type, source_type, source_id
    FROM rental_unit_assets
    WHERE rental_unit_id = ?
      AND status = 'active'
    ORDER BY
      CASE asset_type
        WHEN 'appliance' THEN 0
        WHEN 'plumbing' THEN 1
        WHEN 'electrical' THEN 2
        WHEN 'fixture' THEN 3
        WHEN 'furniture' THEN 4
        WHEN 'surface' THEN 5
        WHEN 'service' THEN 6
        ELSE 9
      END,
      asset_name
  `).all(rentalUnitId);
}

async function saveWebRepairUpload(db, input = {}) {
  const dataUrl = String(input.dataUrl || '');
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error('照片格式不正確，請重新選擇檔案。');
  const mimeType = match[1] || input.mimeType || 'application/octet-stream';
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('照片內容是空的。');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('單張照片請小於 8MB。');
  const uploadDir = path.join(path.resolve(__dirname, '..', '..'), 'uploads', 'repair-web');
  const ext = path.extname(input.name || '') || (mimeType === 'image/png' ? '.png' : '.jpg');
  const savedName = safeFileName(`repair-web-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  const { provider, storage } = createFileStorage({ localRoot: uploadDir, prefix: 'private' });
  const stored = await storage.put(savedName, buffer, { contentType: mimeType });
  return repairRepository.addFile(db, {
    storageKey: storageKeyForStored(stored, provider),
    storageProvider: provider,
    originalName: safeFileName(input.name || savedName),
    mimeType,
    sizeBytes: buffer.length,
    sha256Hash: sha256(buffer),
    createdByUserId: input.createdByUserId || null,
  });
}

async function saveWebRepairUploadAsync(db, input = {}) {
  const dataUrl = String(input.dataUrl || '');
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error('照片格式不正確，請重新選擇檔案。');
  const mimeType = match[1] || input.mimeType || 'application/octet-stream';
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('照片內容是空的。');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('單張照片請小於 8MB。');
  const uploadDir = path.join(path.resolve(__dirname, '..', '..'), 'uploads', 'repair-web');
  const ext = path.extname(input.name || '') || (mimeType === 'image/png' ? '.png' : '.jpg');
  const savedName = safeFileName(`repair-web-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  const { provider, storage } = createFileStorage({ localRoot: uploadDir, prefix: 'private' });
  const stored = await storage.put(savedName, buffer, { contentType: mimeType });
  return repairRepositoryAsync.addFile(db, {
    storageKey: storageKeyForStored(stored, provider), storageProvider: provider,
    originalName: safeFileName(input.name || savedName), mimeType, sizeBytes: buffer.length,
    sha256Hash: sha256(buffer), createdByUserId: input.createdByUserId || null,
  });
}

async function createCloudRepairTicket(req, res) {
  const lineUserId = String(req.body.lineUserId || '').trim();
  return withV2Driver(async (db) => {
    const identity = await repairRepositoryAsync.getLineIdentity(db, lineUserId);
    if (!identity) return res.status(404).json({ ok: false, error: '找不到你的 LINE 身分綁定。' });
    const lease = await repairRepositoryAsync.findActiveTenantLease(db, identity.user_id);
    if (!lease) return res.status(404).json({ ok: false, error: '目前找不到你正在承租中的租約。' });
    const problemCondition = String(req.body.problemCondition || req.body.failureReason || '').trim();
    const description = String(req.body.description || '').trim();
    const baseDescription = description || problemCondition;
    if (!baseDescription) return res.status(400).json({ ok: false, error: '請先選擇問題狀況或補充說明。' });
    const files = Array.isArray(req.body.files) ? req.body.files.slice(0, 8) : [];
    const assetIdRaw = String(req.body.assetId || '').trim();
    const otherAssetName = String(req.body.otherAssetName || '').trim();
    const assets = await repairRepositoryAsync.listRepairAssetsForUnit(db, lease.rental_unit_id);
    const selectedAsset = /^\d+$/.test(assetIdRaw) ? assets.find((asset) => Number(asset.id) === Number(assetIdRaw)) : null;
    const finalDescription = assetIdRaw === 'other' && otherAssetName
      ? `其他家具／設備：${otherAssetName}\n${baseDescription}` : baseDescription;
    const tenantPreference = ['tenant_self_repair', 'landlord_repair', 'no_preference'].includes(req.body.tenantPreference)
      ? req.body.tenantPreference : 'no_preference';
    const tenantPreferenceLabel = ({ tenant_self_repair: '房客有自修意願', landlord_repair: '希望房東安排修理', no_preference: '尚未表達處理意願' })[tenantPreference];
    const usageContext = ['normal_use', 'after_cleaning', 'after_moving', 'impact_or_pet', 'unknown'].includes(req.body.usageContext) ? req.body.usageContext : 'unknown';
    const damageTiming = ['just_now', 'within_week', 'long_term', 'move_in_existing', 'unknown'].includes(req.body.damageTiming) ? req.body.damageTiming : 'unknown';
    const moveInEvidence = await repairRepositoryAsync.findLeaseMoveInInspectionEvidence(db, { leaseId: lease.lease_id, rentalUnitId: lease.rental_unit_id });
    const originalConditionLabel = selectedAsset ? `「${selectedAsset.asset_name}」${moveInEvidence.status === 'available' ? `可參考入住前點交照片（${moveInEvidence.imageCount} 張）` : '尚無可比對的入住前照片'}` : moveInEvidence.label;
    const usageContextLabel = ({ normal_use: '正常使用中突然異常', after_cleaning: '清潔或保養後發生', after_moving: '搬動或移動後發生', impact_or_pet: '外力、小孩或寵物造成可能', unknown: '不確定使用情境' })[usageContext];
    const damageTimingLabel = ({ just_now: '剛發現／近期發生', within_week: '一週內逐漸發生', long_term: '使用一段時間後發現', move_in_existing: '入住時已存在', unknown: '不確定發生時間' })[damageTiming];
    const evidenceContextText = [`使用情境：${usageContextLabel}`, `損壞時間：${damageTimingLabel}`, `原始物況：${originalConditionLabel}`].join('\n');
    const enrichedDescription = [finalDescription, evidenceContextText].filter(Boolean).join('\n');
    const initialRisk = inferRepairRisk(enrichedDescription);
    if (!files.length && initialRisk.priority !== 'urgent') return res.status(400).json({ ok: false, error: '請至少上傳 1 張損壞照片。' });
    const owner = (await repairRepositoryAsync.listLandlordRecipients(db, lease.rental_unit_id))[0];
    const damageType = inferRepairDamageType(enrichedDescription);
    const fallbackAsset = selectedAsset || await repairRepositoryAsync.findRepairAssetForDescription(db, { rentalUnitId: lease.rental_unit_id, description: enrichedDescription });
    const rule = await repairRepositoryAsync.findLeaseRepairRule(db, { leaseId: lease.lease_id, rentalUnitId: lease.rental_unit_id, assetId: fallbackAsset?.id || null, damageType });
    const ticket = await repairRepositoryAsync.createRepairTicket(db, {
      leaseId: lease.lease_id, rentalUnitId: lease.rental_unit_id, category: '一般報修', description: enrichedDescription,
      assetId: fallbackAsset?.id || null, damageType, tenantPreference, reportedByUserId: identity.user_id,
      assignedOwnerUserId: owner?.user_id || null,
    });
    const update = await repairRepositoryAsync.addRepairUpdate(db, {
      repairTicketId: ticket.id, updateType: 'message',
      messageText: `房客透過外部頁建立報修單。\n房客處理意願：${tenantPreferenceLabel}\n${evidenceContextText}`,
      createdByUserId: identity.user_id,
    });
    for (const fileInput of files) {
      const file = await saveWebRepairUploadAsync(db, { ...fileInput, createdByUserId: identity.user_id });
      await repairRepositoryAsync.linkFileToRepairUpdate(db, { fileId: file.id, repairUpdateId: update.id, purpose: 'damage_photo' });
    }
    const analysis = buildRepairAssistantAnalysis({ description: enrichedDescription, photoCount: files.length, unitLabel: lease.unit_label, asset: fallbackAsset || null, rule, tenantPreference, moveInEvidence });
    await db.run(`UPDATE repair_tickets SET cause_classification = ?, updated_at = ${db.dialect.utcNow()} WHERE id = ?`, [analysis.causeClassification || 'unknown', ticket.id]);
    await repairRepositoryAsync.createRepairAiAssessment(db, {
      repairTicketId: ticket.id, leaseId: lease.lease_id, assetId: fallbackAsset?.id || null,
      leaseRepairRuleId: rule?.rule_origin === 'lease_rule' ? rule.id : null,
      rentalUnitRepairRuleDefaultId: rule?.rule_origin === 'unit_default' ? rule.id : null,
      riskLevel: analysis.assessment.riskLevel, ruleMatchStatus: analysis.assessment.ruleMatchStatus,
      evidenceStatus: analysis.assessment.evidenceStatus, causeClassification: analysis.assessment.causeClassification,
      liabilityParty: analysis.assessment.liabilityParty, recommendedDispatchParty: analysis.assessment.recommendedDispatchParty,
      recommendedPayerParty: analysis.assessment.recommendedPayerParty, responsibilityGuess: analysis.assessment.responsibilityGuess,
      recommendedExecutor: analysis.assessment.recommendedExecutor, recommendedPayer: analysis.assessment.recommendedPayer,
      confidence: analysis.assessment.confidence, legalBasisSummary: analysis.legalBasis, contractBasisSummary: analysis.contractBasis,
      missingInfo: analysis.missing, ruleRefs: analysis.ruleRefs, rawResult: analysis,
    });
    await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', messageText: analysis.recordText, createdByUserId: identity.user_id });
    const context = await repairRepositoryAsync.getRepairContext(db, ticket.public_id) || ticket;
    await notifyLandlordsForNewRepair(db, lineClient, context, { unitLabel: lease.unit_label, tenantName: identity.display_name_cache || '房客', tenantRepairPreference: tenantPreferenceLabel });
    return res.json({ ok: true, ticketPublicId: ticket.public_id,
      redirectUrl: `/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&created=1`,
      externalUrl: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&created=1`) });
  });
}

function tenantRepairNewPage({ lineUserId, lease, assets, moveInEvidence }) {
  const assetOptions = assets.map((asset) => `
    <label class="choice">
      <input type="radio" name="assetId" value="${escapeHtml(asset.id)}" data-asset-name="${escapeHtml(asset.asset_name)}" data-asset-type="${escapeHtml(asset.asset_type)}">
      <span class="asset-tile">
        <strong>${escapeHtml(asset.asset_name)}</strong>
        <small>${escapeHtml(({
          appliance: '家電',
          furniture: '家具',
          fixture: '固定設備',
          plumbing: '水/瓦斯',
          electrical: '電力設備',
          surface: '牆面地板',
          service: '服務設備',
          other: '其他',
        })[asset.asset_type] || asset.asset_type)}</small>
      </span>
    </label>
  `).join('');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>新增報修 - ${escapeHtml(lease.unit_label || '租屋物件')}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:760px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:20px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:26px}.section{padding:16px 14px;border-top:1px solid #F1F5F9}.section h2{margin:0 0 10px;font-size:24px}.hint{color:#64748B;font-size:14px;line-height:1.55;margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.asset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.choice{display:block}.choice input{position:absolute;opacity:0;pointer-events:none}.choice span{display:block;border:1px solid #D7DDE7;border-radius:14px;padding:10px 12px;background:#fff;min-height:48px}.asset-grid .asset-tile{min-height:48px;display:flex;flex-direction:column;justify-content:center;text-align:left;padding:9px 11px;overflow:hidden}.choice input:checked+span{border-color:#1F2937;background:#F8FAFC;box-shadow:inset 0 0 0 1px #1F2937}.choice strong{display:block;font-size:16px}.asset-grid .choice strong{max-width:100%;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.choice small{display:block;margin-top:3px;color:#64748B}.asset-grid .choice small{font-size:11px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.field{display:grid;gap:8px;margin-top:12px}.field label{font-weight:800}.field textarea,.field input[type=text]{width:100%;border:1px solid #CBD5E1;border-radius:14px;padding:12px;font:inherit}.field textarea{min-height:108px;resize:vertical}.upload{border:2px dashed #CBD5E1;border-radius:18px;padding:16px;background:#F8FAFC}.preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin-top:10px}.preview img{width:100%;height:96px;object-fit:cover;border-radius:12px;border:1px solid #E5E7EB}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px 16px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.secondary{background:#E5E7EB;color:#111827}.status{margin-top:12px;color:#64748B;font-size:14px;line-height:1.55}.error{color:#B91C1C}.success{color:#047857}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:14px 16px}.hero h1{font-size:23px}.section{padding:13px 12px}.section h2{font-size:20px}.hint{font-size:13px;margin-bottom:10px}.asset-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.asset-grid .asset-tile{min-height:44px;border-radius:12px;padding:8px 10px}.asset-grid .choice strong{font-size:14px}.asset-grid .choice small{font-size:10px}}
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:760px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:20px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:26px}.section{padding:16px 14px;border-top:1px solid #F1F5F9}.section h2{margin:0 0 10px;font-size:24px}.hint{color:#64748B;font-size:14px;line-height:1.55;margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.asset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.choice{display:block}.choice input{position:absolute;opacity:0;pointer-events:none}.choice span{display:block;border:1px solid #D7DDE7;border-radius:14px;padding:10px 12px;background:#fff;min-height:48px}.asset-grid .asset-tile{min-height:42px;display:flex;flex-direction:column;justify-content:center;text-align:left;padding:8px 10px;overflow:hidden}.choice input:checked+span{border-color:#1F2937;background:#F8FAFC;box-shadow:inset 0 0 0 1px #1F2937}.choice strong{display:block;font-size:16px}.asset-grid .choice strong{max-width:100%;font-size:14px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.choice small{display:block;margin-top:3px;color:#64748B}.asset-grid .choice small{font-size:10px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.suggestion-panel{margin-top:12px;padding:12px;border:1px solid #E5E7EB;border-radius:16px;background:#F8FAFC}.suggestion-title{margin:0 0 8px;color:#334155;font-size:13px;font-weight:800}.reason-chips{display:flex;flex-wrap:wrap;gap:8px}.chip-btn{border:1px solid #CBD5E1;border-radius:999px;background:#fff;color:#1F2937;padding:8px 11px;font:inherit;font-size:13px;font-weight:800}.chip-btn:active,.chip-btn.selected{background:#1F2937;color:#fff;border-color:#1F2937}.field{display:grid;gap:8px;margin-top:12px}.field label{font-weight:800}.field textarea,.field input[type=text]{width:100%;border:1px solid #CBD5E1;border-radius:14px;padding:12px;font:inherit}.field textarea{min-height:108px;resize:vertical}.upload{border:2px dashed #CBD5E1;border-radius:18px;padding:16px;background:#F8FAFC}.preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin-top:10px}.preview img{width:100%;height:96px;object-fit:cover;border-radius:12px;border:1px solid #E5E7EB}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px 16px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.secondary{background:#E5E7EB;color:#111827}.status{margin-top:12px;color:#64748B;font-size:14px;line-height:1.55}.error{color:#B91C1C}.success{color:#047857}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:14px 16px}.hero h1{font-size:23px}.section{padding:13px 12px}.section h2{font-size:20px}.hint{font-size:13px;margin-bottom:10px}.asset-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.asset-grid .asset-tile{min-height:40px;border-radius:12px;padding:7px 8px}.asset-grid .choice strong{font-size:13px}.asset-grid .choice small{font-size:10px}}@media(max-width:360px){.asset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>房客端報修表單</p>
        <h1>${escapeHtml(lease.unit_label || '租屋物件')}</h1>
      </header>
      <form id="repair-form">
        <input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}">
        <input type="hidden" id="problemCondition" name="problemCondition" value="">
        <input type="hidden" id="otherAssetName" name="otherAssetName" value="">
        <section class="section">
          <h2>1. 選壞掉的家具／設備</h2>
          <p class="hint">清單來自這間房的家具設備資料；找不到就選「其他」。</p>
          <div class="asset-grid">
            ${assetOptions}
            <label class="choice">
              <input type="radio" name="assetId" value="other" data-asset-name="其他" data-asset-type="other">
              <span class="asset-tile"><strong>其他</strong><small>清單沒有時選</small></span>
            </label>
          </div>
          <div class="suggestion-panel" id="reason-panel" hidden>
            <p class="suggestion-title" id="reason-title">常見故障原因</p>
            <div class="reason-chips" id="reason-chips"></div>
          </div>
          <div class="field" id="description-field">
            <label id="description-label" for="description">故障原因／補充說明</label>
            <textarea id="description" name="description" required placeholder="可先點上方常見故障原因；需要補充再寫，例如：今天開始、一直有異音"></textarea>
          </div>
        </section>
        <section class="section">
          <h2>2. 發生情境與時間</h2>
          <div class="field">
            <label>發生情境</label>
            <div class="grid">
              <label class="choice"><input type="radio" name="usageContext" value="normal_use" checked><span><strong>正常使用中</strong><small>突然異常或故障</small></span></label>
              <label class="choice"><input type="radio" name="usageContext" value="after_cleaning"><span><strong>清潔/保養後</strong><small>例如清濾網後漏水</small></span></label>
              <label class="choice"><input type="radio" name="usageContext" value="after_moving"><span><strong>搬動/移動後</strong><small>移動家具或設備後</small></span></label>
              <label class="choice"><input type="radio" name="usageContext" value="impact_or_pet"><span><strong>外力/寵物</strong><small>撞到、摔落、咬抓</small></span></label>
              <label class="choice"><input type="radio" name="usageContext" value="unknown"><span><strong>不確定</strong><small>需要補充判斷</small></span></label>
            </div>
          </div>
          <div class="field">
            <label>發現時間</label>
            <div class="grid">
              <label class="choice"><input type="radio" name="damageTiming" value="just_now" checked><span><strong>剛發現</strong><small>今天或最近發生</small></span></label>
              <label class="choice"><input type="radio" name="damageTiming" value="within_week"><span><strong>一週內</strong><small>近期逐漸發生</small></span></label>
              <label class="choice"><input type="radio" name="damageTiming" value="long_term"><span><strong>用一陣子後</strong><small>使用一段時間才壞</small></span></label>
              <label class="choice"><input type="radio" name="damageTiming" value="move_in_existing"><span><strong>入住時就有</strong><small>需比對點交紀錄</small></span></label>
              <label class="choice"><input type="radio" name="damageTiming" value="unknown"><span><strong>不確定</strong><small>稍後補充</small></span></label>
            </div>
          </div>
          <div class="field">
            <label>原始物況比對</label>
            <div class="upload" id="move-in-evidence" aria-live="polite"><strong>請先選擇設備</strong><p class="hint">系統會顯示同一租約、已確認入住前點交中，這項設備的原始照片。</p></div>
          </div>
        </section>
        <section class="section">
          <h2>3. 你的處理意願</h2>
          <div class="grid">
            <label class="choice"><input type="radio" name="tenantPreference" value="tenant_self_repair"><span><strong>我願意代為處理</strong><small>不代表同意自付，仍依合約與房東確認</small></span></label>
            <label class="choice"><input type="radio" name="tenantPreference" value="landlord_repair"><span><strong>希望房東處理</strong><small>由房東或師傅處理</small></span></label>
            <label class="choice"><input type="radio" name="tenantPreference" value="no_preference" checked><span><strong>不確定</strong><small>請系統/房東判斷</small></span></label>
          </div>
        </section>
        <section class="section">
          <h2>4. 上傳損壞照片</h2>
          <div class="upload">
            <input id="photos" type="file" accept="image/*" multiple>
            <p class="hint" id="photo-hint">至少 1 張，可多選。每張照片會一起保存成報修證據。</p>
            <p class="hint" id="urgent-notice" hidden style="color:#B91C1C;font-weight:800">已選擇明確安全危險：可先建立緊急案件並聯絡房東，照片可在危險解除後補上。</p>
            <div class="preview" id="preview"></div>
          </div>
          <div class="actions">
            <button class="btn" id="submit-button" type="submit">送出報修</button>
            <a class="btn secondary" href="/tenant/repairs?lineUserId=${encodeURIComponent(lineUserId)}" style="text-align:center;text-decoration:none">查看報修進度</a>
          </div>
          <p class="status" id="status"></p>
          <div class="submit-success" id="submit-success" hidden>
            <strong>報修已建立</strong>
            <span>已通知房東，正在開啟完整紀錄…</span>
          </div>
        </section>
      </form>
    </section>
  </main>
  <script src="/assets/compressImage.js"></script>
  <script>
    const form = document.querySelector('#repair-form');
    const photos = document.querySelector('#photos');
    const preview = document.querySelector('#preview');
    const statusEl = document.querySelector('#status');
    const submitSuccess = document.querySelector('#submit-success');
    const otherAssetName = document.querySelector('#otherAssetName');
    const descriptionLabel = document.querySelector('#description-label');
    const reasonPanel = document.querySelector('#reason-panel');
    const reasonTitle = document.querySelector('#reason-title');
    const reasonChips = document.querySelector('#reason-chips');
    const description = document.querySelector('#description');
    const problemCondition = document.querySelector('#problemCondition');
    const photoHint = document.querySelector('#photo-hint');
    const urgentNotice = document.querySelector('#urgent-notice');
    const submitButton = document.querySelector('#submit-button');
    const moveInEvidenceEl = document.querySelector('#move-in-evidence');
    const emergencyPattern = /(瓦斯味|聞到.{0,8}瓦斯|瓦斯.{0,8}(?:洩|漏)|漏氣|冒煙|火花|觸電|焦味|嚴重漏水|大量漏水|水管爆|淹水|無法關門|門鎖.{0,8}(?:壞|故障))/;
    function isEmergencyReport() {
      return emergencyPattern.test((problemCondition.value || '') + ' ' + (description.value || ''));
    }
    function syncEmergencyMode() {
      const urgent = isEmergencyReport();
      photos.required = !urgent;
      urgentNotice.hidden = !urgent;
      photoHint.textContent = urgent
        ? '安全優先：可先送出並聯絡房東，危險解除後再補照片。'
        : '至少 1 張，可多選。每張照片會一起保存成報修證據。';
      submitButton.textContent = urgent ? '立即建立緊急案件並聯絡房東' : '送出報修';
    }
    const reasonCatalog = {
      冰箱: ['不冷', '漏水', '異音', '門膠條鬆脫', '結霜異常'],
      冷氣: ['不冷', '漏水', '異音', '遙控器故障', '出風有異味'],
      洗衣機: ['無法排水', '漏水', '異音', '無法啟動', '脫水異常'],
      熱水器: ['不熱', '漏水', '點火失敗', '水溫不穩', '有瓦斯味'],
      電視: ['無畫面', '無聲音', '螢幕破裂', '遙控器故障', '訊號異常'],
      床: ['床架鬆動', '斷裂', '異音', '床墊塌陷'],
      沙發: ['破洞', '塌陷', '污損', '扶手鬆動'],
      衣櫃: ['門片脫落', '軌道卡住', '把手鬆脫', '板材變形'],
      陽台: ['排水不良', '漏水', '欄杆鬆動', '地面積水'],
      天然瓦斯: ['有瓦斯味', '無法點火', '管線異常', '開關故障'],
      網路: ['無法連線', '訊號不穩', '設備無電源'],
      第四台: ['無訊號', '畫面異常', '遙控器故障'],
      牆面與地板: ['牆面裂痕', '滲水', '地板隆起', '刮傷破損'],
      其他: ['無法正常使用', '破損', '異音', '漏水', '需要補充描述'],
    };
    function reasonsFor(assetName, assetType) {
      const name = String(assetName || '');
      const matched = Object.keys(reasonCatalog).find(key => name.includes(key));
      if (matched) return reasonCatalog[matched];
      if (assetType === 'appliance') return ['無法啟動', '異音', '漏水', '無法正常使用'];
      if (assetType === 'plumbing') return ['漏水', '堵塞', '異味', '水壓異常'];
      if (assetType === 'electrical') return ['無電', '接觸不良', '跳電', '冒煙或焦味'];
      if (assetType === 'surface') return reasonCatalog['牆面與地板'];
      return reasonCatalog['其他'];
    }
    function renderReasonChips(input) {
      const assetName = input.dataset.assetName || '此項目';
      const reasons = reasonsFor(assetName, input.dataset.assetType || '');
      reasonTitle.textContent = assetName === '其他' ? '常見故障原因' : assetName + '常見故障原因';
      reasonChips.innerHTML = '';
      reasons.forEach(reason => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chip-btn';
        button.textContent = reason;
          button.addEventListener('click', () => {
            reasonChips.querySelectorAll('.chip-btn').forEach(el => el.classList.remove('selected'));
            button.classList.add('selected');
            problemCondition.value = reason;
            if (!description.value.trim()) {
              description.value = assetName === '其他' ? reason : assetName + reason;
          } else if (!description.value.includes(reason)) {
            description.value = description.value.trim() + '；' + reason;
          }
          syncEmergencyMode();
          description.focus();
        });
        reasonChips.appendChild(button);
      });
      reasonPanel.hidden = false;
    }
    function syncDescriptionLabel(input) {
      const isOther = input && input.value === 'other' && input.checked;
      descriptionLabel.textContent = isOther ? '其他項目與故障狀況' : '故障原因／補充說明';
      description.placeholder = isOther
        ? '例如：書桌抽屜卡住、窗簾拉不起來、門鎖轉不動'
        : '可先點上方常見故障原因；需要補充再寫，例如：今天開始、一直有異音';
    }
    function renderMoveInEvidence(result, assetName) {
      moveInEvidenceEl.replaceChildren();
      const title = document.createElement('strong');
      const detail = document.createElement('p');
      detail.className = 'hint';
      const evidence = result && Array.isArray(result.evidence) ? result.evidence : [];
      if (!evidence.length) {
        title.textContent = '這項設備尚無可比對的入住前照片';
        detail.textContent = assetName === '其他'
          ? '「其他」沒有既定設備對應；系統會保留本次照片，後續由房東或專業人員比對。'
          : '尚未找到同一租約、已確認入住前點交中名稱相符的照片；系統不會拿其他設備照片來猜測。';
        moveInEvidenceEl.append(title, detail);
        return;
      }
      title.textContent = '已找到「' + assetName + '」的入住前點交照片（' + evidence.length + ' 張）';
      detail.textContent = '以下為已確認點交的原始物況，僅供本次報修比對；不會取代本次損壞照片。';
      const preview = document.createElement('div');
      preview.className = 'preview';
      evidence.forEach((item) => {
        const link = document.createElement('a');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.style.color = '#1D4ED8';
        link.style.fontSize = '12px';
        const image = document.createElement('img');
        image.src = item.url;
        image.alt = assetName + ' 入住前點交照片';
        const caption = document.createElement('span');
        caption.textContent = item.caption || '查看原始照片';
        link.append(image, caption);
        preview.appendChild(link);
      });
      moveInEvidenceEl.append(title, detail, preview);
    }
    async function loadMoveInEvidence(input) {
      const assetName = input.dataset.assetName || '其他';
      if (!input.checked || input.value === 'other') {
        renderMoveInEvidence({ evidence: [] }, assetName);
        return;
      }
      moveInEvidenceEl.textContent = '正在載入這項設備的入住前點交照片…';
      try {
        const lineUserId = form.elements.lineUserId.value;
        const response = await fetch('/tenant/repairs/new/move-in-evidence?lineUserId=' + encodeURIComponent(lineUserId) + '&assetId=' + encodeURIComponent(input.value));
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '載入失敗');
        renderMoveInEvidence(result, assetName);
      } catch (error) {
        renderMoveInEvidence({ evidence: [] }, assetName);
      }
    }
    function deriveOtherAssetName(value) {
      return String(value || '')
        .split(/[，,、；;。\\n]/)[0]
        .trim()
        .slice(0, 24);
    }
    document.querySelectorAll('input[name="assetId"]').forEach(input => {
      input.addEventListener('change', () => {
        syncDescriptionLabel(input);
        if (input.checked) {
          renderReasonChips(input);
          loadMoveInEvidence(input);
        }
      });
      // 行動瀏覽器有時會先更新 radio 的視覺狀態、後送出 change；click 時也同步渲染，
      // 避免使用者已選設備卻看不到常見故障原因。
      input.addEventListener('click', () => {
        window.setTimeout(() => {
          if (input.checked) {
            syncDescriptionLabel(input);
            renderReasonChips(input);
            loadMoveInEvidence(input);
          }
        }, 0);
      });
    });
    const initiallySelectedAsset = document.querySelector('input[name="assetId"]:checked');
    if (initiallySelectedAsset) {
      syncDescriptionLabel(initiallySelectedAsset);
      renderReasonChips(initiallySelectedAsset);
    }
    description.addEventListener('input', syncEmergencyMode);
    syncEmergencyMode();
    photos.addEventListener('change', () => {
      preview.innerHTML = '';
      [...photos.files].slice(0, 8).forEach(file => {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        preview.appendChild(img);
      });
    });
    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('讀取照片失敗'));
        reader.readAsDataURL(file);
      });
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      statusEl.className = 'status';
      statusEl.textContent = '正在送出報修…';
      try {
        const fd = new FormData(form);
        const selectedAsset = document.querySelector('input[name="assetId"]:checked');
        if (selectedAsset && selectedAsset.value === 'other') {
          otherAssetName.value = deriveOtherAssetName(description.value) || '其他項目';
        } else {
          otherAssetName.value = '';
        }
        const selectedFiles = [...photos.files].slice(0, 8);
        if (!selectedFiles.length && !isEmergencyReport()) throw new Error('請至少上傳 1 張照片。');
        const files = [];
        for (const file of selectedFiles) {
          const upload = await compressImage(file);
          files.push({ name: upload.name, mimeType: upload.type, dataUrl: await readAsDataUrl(upload) });
        }
        const response = await fetch('/tenant/repairs/new', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            lineUserId: fd.get('lineUserId'),
            assetId: fd.get('assetId'),
            otherAssetName: otherAssetName.value,
            problemCondition: fd.get('problemCondition'),
            description: fd.get('description'),
            usageContext: fd.get('usageContext'),
            damageTiming: fd.get('damageTiming'),
            tenantPreference: fd.get('tenantPreference'),
            files,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '送出失敗');
        statusEl.className = 'status success';
        statusEl.textContent = '報修已建立，已通知房東。正在開啟完整紀錄…';
        if (submitSuccess) submitSuccess.hidden = false;
        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) submitButton.disabled = true;
        window.setTimeout(() => {
          window.location.replace(result.redirectUrl || ('/tenant/repairs?lineUserId=' + encodeURIComponent(fd.get('lineUserId'))));
        }, 900);
      } catch (error) {
        if (submitSuccess) submitSuccess.hidden = true;
        statusEl.className = 'status error';
        statusEl.textContent = error.message;
      }
    });
  </script>
</body>
</html>`;
}

function recordedRepairFacts(description) {
  const text = String(description || '');
  const find = (label) => {
    const match = text.match(new RegExp(`(?:^|\\n)(?:補件)?${label}：([^\\n]+)`));
    return match ? match[1].trim() : '';
  };
  return {
    usageContext: find('使用情境'),
    damageTiming: find('損壞時間') || find('發生時間'),
  };
}

function tenantRepairSupplementPage({ ticket, mode = 'supplement', lineUserId = '', updates = [] }) {
  const isNegotiation = mode === 'negotiate';
  const isCompletion = mode === 'completion';
  const recordedFacts = recordedRepairFacts(ticket.description);
  const reportedCost = Number.isFinite(Number(ticket.tenant_reported_cost_amount))
    ? Number(ticket.tenant_reported_cost_amount)
    : '';
  const hasNegotiatedProposal = updates.some((update) => /^(房東提出補充依據／不同處理方案|AI 協商轉述：房東回覆|房東回覆協商：)/.test(String(update.message_text || '').trim()));
  const canAcceptProposal = isNegotiation && (String(ticket.liability_status || '') === 'proposed' || hasNegotiatedProposal);
  const acceptanceHtml = canAcceptProposal ? `<section class="section"><div class="card"><strong>接受目前方案</strong><p class="hint" style="margin:8px 0 0">會保存你的接受回覆並通知房東。若這是房客責任／費用方案，才會接著由房東選擇實際修繕方式；不會直接扣款或結案。</p><form method="post" action="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/accept-proposal"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><div class="actions"><button class="btn" type="submit">接受目前方案</button></div></form></div></section>` : '';
  const title = isNegotiation ? '協商修繕條件' : isCompletion ? '上傳修繕完成資料' : '補充報修資料';
  const hint = isNegotiation
    ? '請說明你不同意的原因、可接受的處理方式、金額或希望房東補充的資訊。'
    : isCompletion
      ? '請上傳修好後照片，並附上維修結果、報價或收據；房東會在外部頁確認或退回。'
      : '請補充損壞原因、發生時間、使用情境，或上傳更多照片/附件。';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} - ${escapeHtml(ticket.unit_label || '租屋物件')}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:720px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:18px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:24px}.section{padding:16px 14px;border-top:1px solid #F1F5F9}.card{border:1px solid #E5E7EB;border-radius:16px;background:#F8FAFC;padding:12px}.row{display:grid;grid-template-columns:88px 1fr;gap:10px;margin:6px 0;color:#475569}.row strong{color:#111827}.hint{color:#64748B;font-size:14px;line-height:1.55;margin:0 0 12px}.field{display:grid;gap:8px;margin-top:12px}.field label{font-weight:800}.field textarea,.field input{width:100%;border:1px solid #CBD5E1;border-radius:14px;padding:12px;font:inherit;background:#fff}.field textarea{min-height:132px;resize:vertical}.choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.choice{border:1px solid #CBD5E1;border-radius:13px;padding:11px 10px;background:#fff;text-align:left;font:inherit;color:#334155;cursor:pointer}.choice.selected{border-color:#1F2937;background:#1F2937;color:#fff;font-weight:800}.upload{border:2px dashed #CBD5E1;border-radius:18px;padding:16px;background:#F8FAFC}.preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin-top:10px}.preview img{width:100%;height:96px;object-fit:cover;border-radius:12px;border:1px solid #E5E7EB}.thread{display:grid;gap:10px}.thread-item{border-left:3px solid #64748B;padding:10px 12px;background:#F8FAFC;border-radius:0 12px 12px 0}.thread-meta{display:flex;justify-content:space-between;gap:12px;font-size:13px}.thread-meta time{color:#64748B;white-space:nowrap}.thread-message{margin-top:7px;font-size:14px;line-height:1.6;white-space:pre-wrap}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px 16px;font:inherit;font-weight:800;background:#1F2937;color:#fff;text-align:center;text-decoration:none}.btn.secondary{background:#E5E7EB;color:#111827}.status{margin-top:12px;color:#64748B;font-size:14px;line-height:1.55}.error{color:#B91C1C}.success{color:#047857}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:14px 16px}.section{padding:13px 12px}.hero h1{font-size:22px}.choice-grid{grid-template-columns:1fr}.thread-meta{display:block}.thread-meta time{display:block;margin-top:3px}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>${escapeHtml(ticket.unit_label || '租屋物件')}</p>
        <h1>${escapeHtml(title)}</h1>
      </header>
      <section class="section">
        <div class="card">
          <div class="row"><span>報修單</span><strong>${escapeHtml(ticket.public_id)}</strong></div>
          <div class="row"><span>目前狀態</span><strong>${escapeHtml(statusText(ticket.status))}</strong></div>
          <div class="row"><span>報修內容</span><strong>${escapeHtml(ticket.description || '尚無描述')}</strong></div>
        </div>
      </section>
      ${tenantAiAssessmentHtml(ticket)}
      ${isNegotiation ? `<section class="section"><h2>協商與異議歷程</h2><p class="hint">先確認雙方先前提出的理由與方案，再送出這次回覆。</p>${repairNegotiationHistoryHtml(updates)}</section>` : ''}
      ${acceptanceHtml}
      <form id="supplement-form">
        <input type="hidden" name="mode" value="${escapeHtml(mode)}">
        <input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}">
        <section class="section">
          <p class="hint">${escapeHtml(hint)}每一則都會保存到完整紀錄，送出後會通知房東。</p>
          ${isNegotiation || isCompletion ? '' : `
          <div class="card">
            <strong>已記錄的資料</strong>
            <div class="row"><span>使用情境</span><strong>${escapeHtml(recordedFacts.usageContext || '尚未填寫')}</strong></div>
            <div class="row"><span>發生時間</span><strong>${escapeHtml(recordedFacts.damageTiming || '尚未填寫')}</strong></div>
            <p class="hint" style="margin:8px 0 0">以下只需填寫新增或更正的資訊；不填會沿用已記錄的內容。</p>
          </div>
          <div class="field">
            <label>補充發生情境（選填）</label>
            <input type="hidden" name="usageContext" value="unknown">
            <div class="choice-grid" data-choice-group="usageContext">
              <button type="button" class="choice" data-value="normal_use">正常使用中發生</button>
              <button type="button" class="choice" data-value="after_cleaning">清潔／保養後發生</button>
              <button type="button" class="choice" data-value="after_moving">搬動／拆裝後發生</button>
              <button type="button" class="choice" data-value="impact_or_pet">外力／寵物／小孩造成</button>
              <button type="button" class="choice" data-value="unknown">不確定</button>
            </div>
          </div>
          <div class="field">
            <label for="damageTiming">補充發生時間（選填）</label>
            <input id="damageTiming" name="damageTiming" type="datetime-local">
            <p class="hint">不知道確切時間可以留空；未填會保留上方已記錄的時間。</p>
          </div>`}
          <div class="field">
            <label for="message">${escapeHtml(isNegotiation ? '協商內容' : isCompletion ? '維修結果／收據說明（選填）' : '補充說明')}</label>
            <textarea id="message" name="message" placeholder="${escapeHtml(isNegotiation ? '例如：我認為這是自然故障，入住時就有異音，希望房東派修。' : isCompletion ? '例如：已更換零件，附上修好後照片與收據。' : '例如：昨天晚上開始漏水，正常使用中突然發生，附上近照。')}"></textarea>
          </div>
          ${isCompletion ? `
          <div class="field">
            <label for="reportedCostAmount">本次實付／請款金額（元，選填）</label>
            <input id="reportedCostAmount" name="reportedCostAmount" inputmode="numeric" type="number" min="0" value="${escapeHtml(reportedCost)}" placeholder="例如：1200">
            <p class="hint">由實際處理的人填寫。這是本次申報金額，房東確認修復、附件與付款方式後，才會成為最終結算。</p>
          </div>` : ''}
        </section>
        <section class="section">
          <h2>上傳照片或附件</h2>
          <div class="upload">
            <input id="files" type="file" accept="image/*,video/*,.pdf" multiple>
            <p class="hint">${isCompletion ? '請至少上傳一張修好後照片；收據、報價或維修說明可一併附上。' : '可不上傳，但若是補資料，建議至少補一張照片或影片。'}</p>
            <div class="preview" id="preview"></div>
          </div>
          <div class="actions">
            <button class="btn" type="submit">${isCompletion ? '送出修好證據並通知房東' : '送出並通知房東'}</button>
            <a class="btn secondary" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}">回完整紀錄</a>
          </div>
          <p class="status" id="status"></p>
        </section>
      </form>
    </section>
  </main>
  <script src="/assets/compressImage.js"></script>
  <script>
    const form = document.querySelector('#supplement-form');
    const input = document.querySelector('#files');
    const preview = document.querySelector('#preview');
    const statusEl = document.querySelector('#status');
    document.querySelectorAll('[data-choice-group]').forEach(group => {
      const field = form.querySelector('[name="' + group.dataset.choiceGroup + '"]');
      group.querySelectorAll('[data-value]').forEach(button => {
        button.addEventListener('click', () => {
          field.value = button.dataset.value;
          group.querySelectorAll('[data-value]').forEach(item => item.classList.toggle('selected', item === button));
        });
      });
    });
    input.addEventListener('change', () => {
      preview.innerHTML = '';
      [...input.files].slice(0, 8).forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        preview.appendChild(img);
      });
    });
    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('讀取附件失敗'));
        reader.readAsDataURL(file);
      });
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      statusEl.className = 'status';
      statusEl.textContent = '正在送出…';
      try {
        const fd = new FormData(form);
        const files = [];
        for (const file of [...input.files].slice(0, 8)) {
          const upload = await compressImage(file);
          files.push({ name: upload.name, mimeType: upload.type, dataUrl: await readAsDataUrl(upload) });
        }
        const response = await fetch('/tenant/repairs/${encodeURIComponent(ticket.public_id)}/supplement', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lineUserId: fd.get('lineUserId'), mode: fd.get('mode'), message: fd.get('message'), usageContext: fd.get('usageContext'), damageTiming: fd.get('damageTiming'), reportedCostAmount: fd.get('reportedCostAmount'), files }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || '送出失敗');
        statusEl.className = 'status success';
        statusEl.textContent = '已送出並通知房東，正在開啟完整紀錄…';
        window.location.href = result.redirectUrl || '/tenant/repairs/${encodeURIComponent(ticket.public_id)}';
      } catch (error) {
        statusEl.className = 'status error';
        statusEl.textContent = error.message;
      }
    });
  </script>
</body>
</html>`;
}

router.get('/tenant/repairs/new/move-in-evidence', (req, res) => {
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  const assetId = Number(req.query.assetId);
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity || !Number.isInteger(assetId) || assetId <= 0) {
    return res.status(400).json({ ok: false, error: '缺少有效的設備或 LINE 身分。' });
  }

  const lease = repairRepository.findActiveTenantLease(db, identity.user_id);
  if (!lease) return res.status(404).json({ ok: false, error: '找不到目前租約。' });
  const evidence = repairRepository.listLeaseMoveInEvidenceForAsset(db, {
    leaseId: lease.lease_id,
    rentalUnitId: lease.rental_unit_id,
    assetId,
  });
  const rootDir = path.resolve(__dirname, '..', '..');
  const availableEvidence = evidence.filter((item) => {
    if (item.storage_provider !== 'local') return false;
    const absolutePath = path.resolve(rootDir, item.storage_key || '');
    return absolutePath.startsWith(`${rootDir}${path.sep}`) && fs.existsSync(absolutePath);
  });
  return res.json({
    ok: true,
    evidence: availableEvidence.map((item) => ({
      url: `/tenant/repairs/move-in-evidence/${encodeURIComponent(item.file_public_id)}?lineUserId=${encodeURIComponent(lineUserId)}`,
      caption: [item.area_label, item.item_label, item.evidence_note].filter(Boolean).join('／'),
    })),
  });
});

router.get('/tenant/repairs/move-in-evidence/:filePublicId', (req, res) => {
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  const today = new Date().toISOString().slice(0, 10);
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity) return res.status(401).send('unauthorized');
  const file = db.prepare(`
    SELECT f.*
    FROM files f
    JOIN inspection_evidence ie ON ie.file_id = f.id AND ie.evidence_type = 'photo'
    JOIN inspection_items ii ON ii.id = ie.inspection_item_id
    JOIN inspection_checklists ic
      ON ic.id = ii.inspection_checklist_id
     AND ic.checklist_type = 'move_in'
     AND ic.status = 'confirmed'
    JOIN lease_parties lp
      ON lp.lease_id = ic.lease_id
     AND lp.user_id = ?
     AND lp.party_role = 'tenant'
     AND (lp.effective_until IS NULL OR lp.effective_until >= ?)
    WHERE f.public_id = ?
      AND f.status = 'active'
      AND f.storage_provider = 'local'
    LIMIT 1
  `).get(identity.user_id, today, req.params.filePublicId);
  if (!file) return res.status(404).send('file not found');
  const rootDir = path.resolve(__dirname, '..', '..');
  const absolutePath = path.resolve(rootDir, file.storage_key);
  if (!absolutePath.startsWith(`${rootDir}${path.sep}`)) return res.status(403).send('forbidden');
  if (!fs.existsSync(absolutePath)) return res.status(404).send('file not found');
  res.set('Cache-Control', 'private, no-store');
  return res.type(file.mime_type || 'application/octet-stream').sendFile(absolutePath);
});

router.get('/tenant/repairs/new', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      const lineUserId = String(req.query.lineUserId || '').trim();
      if (!lineUserId) return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 一鍵報修入口開啟。</p>');
      return await withV2Driver(async (db) => {
        const identity = await repairRepositoryAsync.getLineIdentity(db, lineUserId);
        if (!identity) return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
        const lease = await repairRepositoryAsync.findActiveTenantLease(db, identity.user_id);
        if (!lease) return res.status(404).send('<h1>目前找不到你正在承租中的租約</h1><p>請先確認 LINE 身分是否已綁定到租約。</p>');
        const [assets, moveInEvidence] = await Promise.all([
          repairRepositoryAsync.listRepairAssetsForUnit(db, lease.rental_unit_id),
          repairRepositoryAsync.findLeaseMoveInInspectionEvidence(db, { leaseId: lease.lease_id, rentalUnitId: lease.rental_unit_id }),
        ]);
        return res.send(tenantRepairNewPage({ lineUserId, lease, assets, moveInEvidence }));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  if (!lineUserId) return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 一鍵報修入口開啟。</p>');
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity) return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
  const lease = repairRepository.findActiveTenantLease(db, identity.user_id);
  if (!lease) return res.status(404).send('<h1>目前找不到你正在承租中的租約</h1><p>請先確認 LINE 身分是否已綁定到租約。</p>');
  const assets = listRepairAssetsForUnit(db, lease.rental_unit_id);
  const moveInEvidence = repairRepository.findLeaseMoveInInspectionEvidence(db, {
    leaseId: lease.lease_id,
    rentalUnitId: lease.rental_unit_id,
  });
  return res.send(tenantRepairNewPage({ lineUserId, lease, assets, moveInEvidence }));
});

router.post('/tenant/repairs/new', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') return await createCloudRepairTicket(req, res);
    const db = getDb();
    const lineUserId = String(req.body.lineUserId || '').trim();
    const identity = repairRepository.getLineIdentity(db, lineUserId);
    if (!identity) return res.status(404).json({ ok: false, error: '找不到你的 LINE 身分綁定。' });
    const lease = repairRepository.findActiveTenantLease(db, identity.user_id);
    if (!lease) return res.status(404).json({ ok: false, error: '目前找不到你正在承租中的租約。' });
    const problemCondition = String(req.body.problemCondition || req.body.failureReason || '').trim();
    const description = String(req.body.description || '').trim();
    const baseDescription = description || problemCondition;
    if (!baseDescription) return res.status(400).json({ ok: false, error: '請先選擇問題狀況或補充說明。' });
    const files = Array.isArray(req.body.files) ? req.body.files.slice(0, 8) : [];

    const assetIdRaw = String(req.body.assetId || '').trim();
    const otherAssetName = String(req.body.otherAssetName || '').trim();
    const selectedAsset = /^\d+$/.test(assetIdRaw)
      ? listRepairAssetsForUnit(db, lease.rental_unit_id).find((asset) => Number(asset.id) === Number(assetIdRaw))
      : null;
    const finalDescription = assetIdRaw === 'other' && otherAssetName
      ? `其他家具／設備：${otherAssetName}\n${baseDescription}`
      : baseDescription;
    const tenantPreference = ['tenant_self_repair', 'landlord_repair', 'no_preference'].includes(req.body.tenantPreference)
      ? req.body.tenantPreference
      : 'no_preference';
    const tenantPreferenceLabel = ({
      tenant_self_repair: '房客有自修意願',
      landlord_repair: '希望房東安排修理',
      no_preference: '尚未表達處理意願',
    })[tenantPreference];
    const usageContext = ['normal_use', 'after_cleaning', 'after_moving', 'impact_or_pet', 'unknown'].includes(req.body.usageContext)
      ? req.body.usageContext
      : 'unknown';
    const damageTiming = ['just_now', 'within_week', 'long_term', 'move_in_existing', 'unknown'].includes(req.body.damageTiming)
      ? req.body.damageTiming
      : 'unknown';
    const moveInEvidence = repairRepository.findLeaseMoveInInspectionEvidence(db, {
      leaseId: lease.lease_id,
      rentalUnitId: lease.rental_unit_id,
    });
    const selectedMoveInEvidence = selectedAsset
      ? repairRepository.listLeaseMoveInEvidenceForAsset(db, {
        leaseId: lease.lease_id,
        rentalUnitId: lease.rental_unit_id,
        assetId: selectedAsset.id,
      })
      : [];
    const originalConditionLabel = selectedAsset
      ? (selectedMoveInEvidence.length
        ? `已找到「${selectedAsset.asset_name}」入住前點交照片（${selectedMoveInEvidence.length} 張）`
        : `「${selectedAsset.asset_name}」尚無可比對的入住前照片`)
      : moveInEvidence.label;
    const usageContextLabel = ({
      normal_use: '正常使用中突然異常',
      after_cleaning: '清潔或保養後發生',
      after_moving: '搬動或移動後發生',
      impact_or_pet: '外力、小孩或寵物造成可能',
      unknown: '不確定使用情境',
    })[usageContext];
    const damageTimingLabel = ({
      just_now: '剛發現／近期發生',
      within_week: '一週內逐漸發生',
      long_term: '使用一段時間後發現',
      move_in_existing: '入住時已存在',
      unknown: '不確定發生時間',
    })[damageTiming];
    const evidenceContextText = [
      `使用情境：${usageContextLabel}`,
      `損壞時間：${damageTimingLabel}`,
      `原始物況：${originalConditionLabel}`,
    ].join('\n');
    const enrichedDescription = [finalDescription, evidenceContextText].filter(Boolean).join('\n');
    const initialRisk = inferRepairRisk(enrichedDescription);
    if (!files.length && initialRisk.priority !== 'urgent') {
      return res.status(400).json({ ok: false, error: '請至少上傳 1 張損壞照片。' });
    }
    const owner = repairRepository.listLandlordRecipients(db, lease.rental_unit_id)[0];
    const damageType = inferRepairDamageType(enrichedDescription);
    const fallbackAsset = selectedAsset || repairRepository.findRepairAssetForDescription(db, {
      rentalUnitId: lease.rental_unit_id,
      description: enrichedDescription,
    });
    const rule = repairRepository.findLeaseRepairRule(db, {
      leaseId: lease.lease_id,
      rentalUnitId: lease.rental_unit_id,
      assetId: fallbackAsset && fallbackAsset.id,
      damageType,
    });
    const ticket = repairRepository.createRepairTicket(db, {
      leaseId: lease.lease_id,
      rentalUnitId: lease.rental_unit_id,
      category: '一般報修',
      description: enrichedDescription,
      assetId: fallbackAsset && fallbackAsset.id,
      damageType,
      tenantPreference,
      reportedByUserId: identity.user_id,
      assignedOwnerUserId: owner && owner.user_id,
    });
    const update = repairRepository.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      messageText: `房客透過外部頁建立報修單。\n房客處理意願：${tenantPreferenceLabel}\n${evidenceContextText}`,
      createdByUserId: identity.user_id,
    });
    for (const fileInput of files) {
      const file = await saveWebRepairUpload(db, { ...fileInput, createdByUserId: identity.user_id });
      repairRepository.linkFileToRepairUpdate(db, { fileId: file.id, repairUpdateId: update.id, purpose: 'damage_photo' });
    }
    const analysis = buildRepairAssistantAnalysis({
      description: enrichedDescription,
      photoCount: files.length,
      unitLabel: lease.unit_label,
      asset: fallbackAsset || null,
      rule,
      tenantPreference,
      moveInEvidence,
    });
    db.prepare(`
      UPDATE repair_tickets
      SET cause_classification = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(analysis.causeClassification || 'unknown', ticket.id);
    repairRepository.createRepairAiAssessment(db, {
      repairTicketId: ticket.id,
      leaseId: lease.lease_id,
      assetId: fallbackAsset && fallbackAsset.id,
      leaseRepairRuleId: rule?.rule_origin === 'lease_rule' ? rule.id : null,
      rentalUnitRepairRuleDefaultId: rule?.rule_origin === 'unit_default' ? rule.id : null,
      riskLevel: analysis.assessment.riskLevel,
      ruleMatchStatus: analysis.assessment.ruleMatchStatus,
      evidenceStatus: analysis.assessment.evidenceStatus,
      causeClassification: analysis.assessment.causeClassification,
      liabilityParty: analysis.assessment.liabilityParty,
      recommendedDispatchParty: analysis.assessment.recommendedDispatchParty,
      recommendedPayerParty: analysis.assessment.recommendedPayerParty,
      responsibilityGuess: analysis.assessment.responsibilityGuess,
      recommendedExecutor: analysis.assessment.recommendedExecutor,
      recommendedPayer: analysis.assessment.recommendedPayer,
      confidence: analysis.assessment.confidence,
      legalBasisSummary: analysis.legalBasis,
      contractBasisSummary: analysis.contractBasis,
      missingInfo: analysis.missing,
      ruleRefs: analysis.ruleRefs,
      rawResult: analysis,
    });
    repairRepository.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      messageText: analysis.recordText,
      createdByUserId: identity.user_id,
    });
    const context = repairRepository.getRepairContext(db, ticket.public_id) || ticket;
    await notifyLandlords(db, lineClient, context, {
      unitLabel: lease.unit_label,
      tenantName: identity.display_name_cache || '房客',
      tenantRepairPreference: tenantPreferenceLabel,
      fallbackLineUserId: lineUserId,
    });
    if (analysis.assessment.riskLevel === 'urgent') {
      const landlordPhone = String(context.landlord_phone || '').trim();
      await notifyTenant(db, lineClient, context, tenantRepairStatusCard({
        title: '緊急安全事件：請先聯絡房東',
        tag: '緊急',
        ticket: context,
        lines: [
          '系統已建立案件並通知房東。請先停止使用相關設備、遠離危險區域。',
          '危險解除前不等待責任或費用判斷；可立即聯絡房東或開啟安全指引。',
        ],
        actions: [
          ...(landlordPhone ? [{
            type: 'button', style: 'primary', height: 'sm', color: '#B91C1C',
            action: { type: 'uri', label: '立即撥打房東', uri: `tel:${landlordPhone.replace(/[^0-9+]/g, '')}` },
          }] : []),
          {
            type: 'button', height: 'sm',
            action: {
              type: 'uri', label: '傳訊息給房東',
              uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(context.public_id)}/contact-landlord?lineUserId=${encodeURIComponent(lineUserId)}`),
            },
          },
          {
            type: 'button', height: 'sm',
            action: {
              type: 'uri', label: '查看安全指引',
              uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(context.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&created=1`),
            },
          },
        ],
      }), `urgent_repair_${ticket.public_id}`);
    }
    return res.json({
      ok: true,
      ticketPublicId: ticket.public_id,
      redirectUrl: `/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&created=1`,
      externalUrl: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&created=1`),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/tenant/repairs/:publicId/supplement', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      return await withV2Driver(async (db) => {
        const lineUserId = String(req.query.lineUserId || '').trim();
        const [ticket, identity] = await Promise.all([
          repairRepositoryAsync.getRepairContext(db, req.params.publicId), repairRepositoryAsync.getLineIdentity(db, lineUserId),
        ]);
        if (!ticket) return res.status(404).send('<h1>找不到此報修紀錄</h1>');
        if (!identity || Number(identity.user_id) !== Number(ticket.tenant_user_id || ticket.reported_by_user_id)) return res.status(403).send('<h1>沒有此案件的房客權限</h1><p>請從 LINE 通知或報修進度開啟。</p>');
        const mode = ['negotiate', 'completion'].includes(req.query.mode) ? req.query.mode : 'supplement';
        const updates = mode === 'negotiate' ? await repairRepositoryAsync.listRepairUpdates(db, ticket.public_id, 100) : [];
        return res.send(tenantRepairSupplementPage({ ticket, mode, lineUserId, updates }));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const ticket = repairRepository.getRepairContext(db, req.params.publicId);
  const lineUserId = String(req.query.lineUserId || '').trim();
  const identity = lineUserId ? repairRepository.getLineIdentity(db, lineUserId) : null;
  if (!ticket) return res.status(404).send('<h1>找不到此報修紀錄</h1>');
  if (!identity || Number(identity.user_id) !== Number(ticket.tenant_user_id || ticket.reported_by_user_id)) {
    return res.status(403).send('<h1>沒有此案件的房客權限</h1><p>請從 LINE 通知或報修進度開啟。</p>');
  }
  const mode = ['negotiate', 'completion'].includes(req.query.mode) ? req.query.mode : 'supplement';
  return res.send(tenantRepairSupplementPage({
    ticket,
    mode,
    lineUserId,
    updates: mode === 'negotiate' ? repairRepository.listRepairUpdates(db, ticket.public_id, 100) : [],
  }));
});

router.post('/tenant/repairs/:publicId/accept-proposal', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudTenantRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const updates = await repairRepositoryAsync.listRepairUpdates(db, ticket.public_id, 100);
        const negotiated = repairNegotiationUpdates(updates).some((update) => /^(房東提出補充依據／不同處理方案|AI 協商轉述：房東回覆|房東回覆協商：)/.test(String(update.message_text || '').trim()));
        const acceptsLiability = String(ticket.liability_status || '') === 'proposed';
        if (!acceptsLiability && !negotiated) return res.status(409).send('<h1>目前沒有可接受的責任方案</h1>');
        if (acceptsLiability) await repairRepositoryAsync.changeRepairStatus(db, { ticketPublicId: ticket.public_id, toStatus: 'accepted', messageText: '房客接受目前責任／費用方案；後續由房東選擇修繕方式。', createdByUserId: identity.user_id });
        else await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', messageText: '房客接受目前協商方向；請房東確認後續處理方式。', createdByUserId: identity.user_id });
        const updated = acceptsLiability ? await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, liabilityStatus: 'confirmed', repairStatus: 'awaiting_execution', actionOwner: 'landlord', waitingOn: 'none' }) : await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        await notifyLandlordsForRepairUpdate(db, lineClient, updated, { eventKey: 'tenant_response_accept', title: '房客接受目前協商方向' });
        return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&proposalAccepted=1`);
      });
    }
    const db = getDb();
    const ticket = repairRepository.getRepairContext(db, req.params.publicId);
    const lineUserId = String(req.body.lineUserId || '').trim();
    const identity = lineUserId ? repairRepository.getLineIdentity(db, lineUserId) : null;
    if (!ticket || !identity || Number(identity.user_id) !== Number(ticket.tenant_user_id || ticket.reported_by_user_id)) {
      return res.status(403).send('<h1>沒有此案件的房客權限</h1><p>請從 LINE 通知或報修進度開啟。</p>');
    }
    const negotiationUpdates = repairNegotiationUpdates(repairRepository.listRepairUpdates(db, ticket.public_id, 100));
    const hasNegotiatedProposal = negotiationUpdates.some((update) => /^(房東提出補充依據／不同處理方案|AI 協商轉述：房東回覆|房東回覆協商：)/.test(String(update.message_text || '').trim()));
    const acceptsLiabilityProposal = String(ticket.liability_status || '') === 'proposed';
    if (!acceptsLiabilityProposal && !hasNegotiatedProposal) {
      return res.status(409).send('<h1>目前沒有可接受的責任方案</h1><p>請回案件查看最新協商內容。</p>');
    }
    repairRepository.changeRepairStatus(db, {
      ticketPublicId: ticket.public_id,
      toStatus: acceptsLiabilityProposal ? 'accepted' : ticket.status,
      messageText: acceptsLiabilityProposal
        ? '房客於外部協商頁接受目前責任／費用方案；後續由房東選擇修繕方式。'
        : '房客於外部協商頁接受目前協商方向；實際責任、費用與修繕安排仍以雙方後續確認為準。',
      createdByUserId: identity.user_id,
    });
    if (!acceptsLiabilityProposal) {
      repairRepository.addRepairUpdate(db, {
        repairTicketId: ticket.id,
        updateType: 'message',
        messageText: '房客接受目前協商方向；請房東在案件頁確認後續實際處理方式。',
        createdByUserId: identity.user_id,
      });
    }
    const updatedTicket = acceptsLiabilityProposal
      ? repairRepository.updateRepairWorkflowState(db, {
        ticketPublicId: ticket.public_id,
        liabilityStatus: 'confirmed',
        repairStatus: 'awaiting_execution',
        actionOwner: 'landlord',
        waitingOn: 'none',
      })
      : (repairRepository.getRepairContext(db, ticket.public_id) || ticket);
    await notifyLandlordsRepairUpdate(db, lineClient, updatedTicket, {
      unitLabel: updatedTicket.unit_label,
      tenantName: updatedTicket.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: lineUserId,
    }, 'tenant_response_accept');
    return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&proposalAccepted=1`);
  } catch (error) {
    return next(error);
  }
});

function supplementUsageContextLabel(value) {
  return ({
    normal_use: '正常使用中突然異常',
    after_cleaning: '清潔或保養後發生',
    after_moving: '搬動或移動後發生',
    impact_or_pet: '外力、小孩或寵物造成可能',
    unknown: '不確定使用情境',
  })[value] || '不確定使用情境';
}

function reassessRepairAfterTenantSupplement(db, ticket, supplement = {}) {
  const usageContext = ['normal_use', 'after_cleaning', 'after_moving', 'impact_or_pet', 'unknown'].includes(supplement.usageContext)
    ? supplement.usageContext
    : 'unknown';
  const damageTiming = String(supplement.damageTiming || '').trim();
  const supplementFacts = [
    usageContext !== 'unknown' ? `補件使用情境：${supplementUsageContextLabel(usageContext)}` : '',
    damageTiming ? `補件發生時間：${damageTiming}` : '',
    supplement.message ? `補件說明：${supplement.message}` : '',
  ].filter(Boolean).join('\n');
  const description = [ticket.description || '', supplementFacts].filter(Boolean).join('\n');
  if (supplementFacts) {
    db.prepare('UPDATE repair_tickets SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(description, ticket.id);
  }
  const asset = ticket.asset_id
    ? listRepairAssetsForUnit(db, ticket.rental_unit_id).find((item) => Number(item.id) === Number(ticket.asset_id))
    : repairRepository.findRepairAssetForDescription(db, { rentalUnitId: ticket.rental_unit_id, description });
  const moveInEvidence = repairRepository.findLeaseMoveInInspectionEvidence(db, {
    leaseId: ticket.lease_id,
    rentalUnitId: ticket.rental_unit_id,
  });
  const damageType = inferRepairDamageType(description);
  const rule = repairRepository.findLeaseRepairRule(db, {
    leaseId: ticket.lease_id,
    rentalUnitId: ticket.rental_unit_id,
    assetId: asset && asset.id,
    damageType,
  });
  const files = repairRepository.listRepairFiles(db, ticket.public_id);
  const analysis = buildRepairAssistantAnalysis({
    description,
    photoCount: files.length,
    unitLabel: ticket.unit_label,
    asset: asset || null,
    rule,
    tenantPreference: ticket.tenant_preference || 'no_preference',
    moveInEvidence,
  });
  db.prepare('UPDATE repair_tickets SET cause_classification = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(analysis.causeClassification || 'unknown', ticket.id);
  repairRepository.createRepairAiAssessment(db, {
    repairTicketId: ticket.id,
    leaseId: ticket.lease_id,
    assetId: asset && asset.id,
    leaseRepairRuleId: rule?.rule_origin === 'lease_rule' ? rule.id : null,
    rentalUnitRepairRuleDefaultId: rule?.rule_origin === 'unit_default' ? rule.id : null,
    riskLevel: analysis.assessment.riskLevel,
    ruleMatchStatus: analysis.assessment.ruleMatchStatus,
    evidenceStatus: analysis.assessment.evidenceStatus,
    causeClassification: analysis.assessment.causeClassification,
    liabilityParty: analysis.assessment.liabilityParty,
    recommendedDispatchParty: analysis.assessment.recommendedDispatchParty,
    recommendedPayerParty: analysis.assessment.recommendedPayerParty,
    responsibilityGuess: analysis.assessment.responsibilityGuess,
    recommendedExecutor: analysis.assessment.recommendedExecutor,
    recommendedPayer: analysis.assessment.recommendedPayer,
    confidence: analysis.assessment.confidence,
    legalBasisSummary: analysis.legalBasis,
    contractBasisSummary: analysis.contractBasis,
    missingInfo: analysis.missing,
    ruleRefs: analysis.ruleRefs,
    rawResult: analysis,
  });
  repairRepository.addRepairUpdate(db, {
    repairTicketId: ticket.id,
    updateType: 'message',
    messageText: `系統已依房客補件重新初判。\n${analysis.recordText}`,
    createdByUserId: ticket.tenant_user_id || null,
  });
  // 補件不是只寫一則紀錄：要把案件交回正確的下一步。
  // 證據仍不足時維持等待房客；資料已足夠時才交回房東處理。
  const evidenceStillInsufficient = analysis.assessment.evidenceStatus !== 'sufficient';
  repairRepository.changeRepairStatus(db, {
    ticketPublicId: ticket.public_id,
    // repair_tickets.status 保留既有流程狀態；是否仍待房客補件由
    // action_owner / waiting_on 表示，不能寫入舊的 need_info enum。
    toStatus: 'reported',
    messageText: evidenceStillInsufficient
      ? '房客已補件，但目前仍缺少判斷所需資料；請依最新缺件項目繼續補充或送專業人員判斷。'
      : '房客補件後資料已更新，案件已交回房東查看最新初判與安排下一步。',
    createdByUserId: ticket.tenant_user_id || null,
  });
  repairRepository.updateRepairWorkflowState(db, {
    ticketPublicId: ticket.public_id,
    actionOwner: evidenceStillInsufficient ? 'tenant' : 'landlord',
    waitingOn: evidenceStillInsufficient ? 'tenant' : 'none',
  });
  return analysis;
}

router.post('/tenant/repairs/:publicId/supplement', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withV2Driver(async (db) => {
        const lineUserId = String(req.body.lineUserId || '').trim();
        const [ticket, identity] = await Promise.all([
          repairRepositoryAsync.getRepairContext(db, req.params.publicId), repairRepositoryAsync.getLineIdentity(db, lineUserId),
        ]);
        if (!ticket) return res.status(404).json({ ok: false, error: '找不到此報修紀錄。' });
        if (!identity || Number(identity.user_id) !== Number(ticket.tenant_user_id || ticket.reported_by_user_id)) return res.status(403).json({ ok: false, error: '沒有此案件的房客權限，請從 LINE 通知或報修進度重新開啟。' });
        const mode = ['negotiate', 'completion'].includes(req.body.mode) ? req.body.mode : 'supplement';
        const message = String(req.body.message || '').trim();
        const usageContext = String(req.body.usageContext || 'unknown').trim();
        const damageTiming = String(req.body.damageTiming || '').trim();
        const reportedCostAmount = String(req.body.reportedCostAmount || '').trim();
        const files = Array.isArray(req.body.files) ? req.body.files.slice(0, 8) : [];
        const hasCompletionPhoto = files.some((file) => String(file.mimeType || '').toLowerCase().startsWith('image/'));
        if (mode === 'completion' && !hasCompletionPhoto) return res.status(400).json({ ok: false, error: '請至少上傳一張修好後照片。' });
        if (!message && !files.length && mode === 'supplement' && usageContext === 'unknown' && !damageTiming) return res.status(400).json({ ok: false, error: '請至少輸入一段說明，或上傳照片/附件。' });
        const updateMessage = mode === 'negotiate' ? `房客協商說明：${message || '房客補充附件，請查看附件。'}`
          : mode === 'completion' ? `房客已上傳修繕完成資料：${message || '請查看修好後照片或附件。'}${reportedCostAmount ? `\n房客申報金額：NT$ ${Number(reportedCostAmount).toLocaleString('zh-TW')}` : ''}`
            : [`房客補充說明：${message || '房客補充附件，請查看附件。'}`, usageContext !== 'unknown' ? `補件使用情境：${supplementUsageContextLabel(usageContext)}` : '', damageTiming ? `補件發生時間：${damageTiming}` : ''].filter(Boolean).join('\n');
        const update = await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', messageText: updateMessage, createdByUserId: identity.user_id });
        for (const fileInput of files) {
          const file = await saveWebRepairUploadAsync(db, { ...fileInput, createdByUserId: identity.user_id });
          await repairRepositoryAsync.linkFileToRepairUpdate(db, { fileId: file.id, repairUpdateId: update.id, purpose: mode === 'completion' ? 'completion_photo' : 'supplement' });
        }
        const analysis = mode === 'supplement' ? await reassessRepairAfterTenantSupplementAsync(db, ticket, { message, usageContext, damageTiming }) : null;
        if (mode === 'completion') {
          await repairRepositoryAsync.recordTenantReportedRepairCost(db, { ticketPublicId: ticket.public_id, reportedCostAmount });
          await repairRepositoryAsync.changeRepairStatus(db, { ticketPublicId: ticket.public_id, toStatus: 'landlord_completed', messageText: reportedCostAmount ? `房客已回傳修好資料，並申報 NT$ ${Number(reportedCostAmount).toLocaleString('zh-TW')}，等待房東確認。` : '房客已回傳修好資料，等待房東確認。', createdByUserId: identity.user_id });
          await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, repairStatus: 'completed', repairVerificationStatus: 'pending', actionOwner: 'landlord', waitingOn: 'landlord' });
        }
        const context = await repairRepositoryAsync.getRepairContext(db, ticket.public_id) || ticket;
        await notifyLandlordsForRepairUpdate(db, lineClient, context, { eventKey: mode === 'negotiate' ? `tenant_repair_negotiation_${update.public_id}` : mode === 'completion' ? `tenant_repair_completion_${update.public_id}` : `tenant_repair_supplement_${update.public_id}`,
          title: mode === 'negotiate' ? '💬 房客回覆協商方案' : mode === 'completion' ? '📸 房客回傳修好資料' : '📝 房客補充報修資料',
          subtitle: '請到外部頁查看完整紀錄並處理', tag: mode === 'negotiate' ? '協商' : '房東端', summary: updateMessage });
        return res.json({ ok: true, redirectUrl: `/tenant/repairs/${encodeURIComponent(ticket.public_id)}?saved=1&lineUserId=${encodeURIComponent(lineUserId)}` });
      });
    }
    const db = getDb();
    const ticket = repairRepository.getRepairContext(db, req.params.publicId);
    if (!ticket) return res.status(404).json({ ok: false, error: '找不到此報修紀錄。' });

    const lineUserId = String(req.body.lineUserId || '').trim();
    const identity = lineUserId ? repairRepository.getLineIdentity(db, lineUserId) : null;
    if (!identity || Number(identity.user_id) !== Number(ticket.tenant_user_id || ticket.reported_by_user_id)) {
      return res.status(403).json({ ok: false, error: '沒有此案件的房客權限，請從 LINE 通知或報修進度重新開啟。' });
    }

    const mode = ['negotiate', 'completion'].includes(req.body.mode) ? req.body.mode : 'supplement';
    const message = String(req.body.message || '').trim();
    const usageContext = String(req.body.usageContext || 'unknown').trim();
    const damageTiming = String(req.body.damageTiming || '').trim();
    const reportedCostAmount = String(req.body.reportedCostAmount || '').trim();
    const files = Array.isArray(req.body.files) ? req.body.files.slice(0, 8) : [];
    const hasCompletionPhoto = files.some((file) => String(file.mimeType || '').toLowerCase().startsWith('image/'));
    if (mode === 'completion' && !hasCompletionPhoto) {
      return res.status(400).json({ ok: false, error: '請至少上傳一張修好後照片。' });
    }
    if (mode === 'completion' && reportedCostAmount && (!Number.isFinite(Number(reportedCostAmount)) || Number(reportedCostAmount) < 0)) {
      return res.status(400).json({ ok: false, error: '請輸入正確的申報金額。' });
    }
    if (!message && !files.length && mode === 'supplement' && usageContext === 'unknown' && !damageTiming) {
      return res.status(400).json({ ok: false, error: '請至少輸入一段說明，或上傳照片/附件。' });
    }

    const update = repairRepository.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      messageText: mode === 'negotiate'
        ? `房客協商說明：${message || '房客補充附件，請查看附件。'}`
        : mode === 'completion'
          ? [
            `房客已上傳修繕完成資料：${message || '請查看修好後照片或附件。'}`,
            reportedCostAmount ? `房客申報金額：NT$ ${Number(reportedCostAmount).toLocaleString('zh-TW')}` : '',
          ].filter(Boolean).join('\n')
        : [
          `房客補充說明：${message || '房客補充附件，請查看附件。'}`,
          usageContext !== 'unknown' ? `補件使用情境：${supplementUsageContextLabel(usageContext)}` : '',
          damageTiming ? `補件發生時間：${damageTiming}` : '',
        ].filter(Boolean).join('\n'),
      createdByUserId: identity.user_id,
    });
    for (const fileInput of files) {
      const file = await saveWebRepairUpload(db, { ...fileInput, createdByUserId: identity.user_id });
      repairRepository.linkFileToRepairUpdate(db, { fileId: file.id, repairUpdateId: update.id, purpose: mode === 'completion' ? 'completion_photo' : 'supplement' });
    }

    const analysis = mode === 'supplement'
      ? reassessRepairAfterTenantSupplement(db, ticket, { message, usageContext, damageTiming })
      : null;
    if (mode === 'completion') {
      repairRepository.recordTenantReportedRepairCost(db, {
        ticketPublicId: ticket.public_id,
        reportedCostAmount,
      createdByUserId: identity.user_id,
      });
      repairRepository.changeRepairStatus(db, {
        ticketPublicId: ticket.public_id,
        toStatus: 'landlord_completed',
        messageText: reportedCostAmount
          ? `房客已於外部頁回傳修好後照片，並申報 NT$ ${Number(reportedCostAmount).toLocaleString('zh-TW')}，等待房東確認。`
          : '房客已於外部頁回傳修好後照片，等待房東確認。',
        createdByUserId: ticket.tenant_user_id || null,
      });
      // 房客（自修／代修）完成後，交回房東查驗；上傳不代表可以結案。
      repairRepository.updateRepairWorkflowState(db, {
        ticketPublicId: ticket.public_id,
        repairStatus: 'completed',
        repairVerificationStatus: 'pending',
        actionOwner: 'landlord',
        waitingOn: 'landlord',
      });
    }
    const context = repairRepository.getRepairContext(db, ticket.public_id) || ticket;
    // 協商不是一般補件：房東必須收到可直接回覆的通知卡。統一走
    // notifyLandlordsRepairUpdate，讓外部頁與 LINE 文字流程都有相同的「回覆協商」入口。
    await notifyLandlordsRepairUpdate(db, lineClient, context, {
      unitLabel: context.unit_label,
      tenantName: context.tenant_name || '房客',
      fallbackLineUserId: lineUserId,
      messageText: mode === 'negotiate'
        ? `房客協商說明：${message || '房客補充附件，請查看附件。'}`
        : mode === 'completion'
          ? reportedCostAmount
            ? `房客已回傳修好資料，並申報 NT$ ${Number(reportedCostAmount).toLocaleString('zh-TW')}。`
            : '房客已回傳修好資料，請查看照片、收據或說明。'
          : `房客補件已保存；目前結果：${analysis?.assessment?.evidenceStatus === 'sufficient' ? '證據較完整' : '仍需補充或專業判斷'}`,
      latestNegotiationText: mode === 'negotiate' ? message : '',
      notificationKey: mode === 'negotiate' ? `tenant_repair_negotiation_${update.public_id}` : '',
    }, mode === 'negotiate' ? 'tenant_repair_negotiation' : mode === 'completion' ? 'tenant_repair_completion_uploaded' : 'tenant_repair_reassessed');

    return res.json({
      ok: true,
      redirectUrl: `/tenant/repairs/${encodeURIComponent(ticket.public_id)}?saved=1&lineUserId=${encodeURIComponent(lineUserId)}`,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/tenant/repairs', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      const lineUserId = String(req.query.lineUserId || '').trim();
      if (!lineUserId) return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 報修進度卡片開啟。</p>');
      return await withV2Driver(async (db) => {
        const identity = await repairRepositoryAsync.getLineIdentity(db, lineUserId);
        if (!identity) return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
        const tickets = await repairRepositoryAsync.listTenantRepairTickets(db, identity.user_id, 50);
        return res.send(repairHistoryListPage({ title: '報修進度', eyebrow: '進行中的報修', subtitle: `共 ${tickets.length} 筆；最新更新的案件會排在最上方。`, tickets, lineUserId, status: 'open' }));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  if (!lineUserId) {
    return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 報修進度卡片開啟。</p>');
  }
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity) {
    return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
  }
  const tickets = repairRepository.listTenantRepairTickets(db, identity.user_id, 50);
  res.send(repairHistoryListPage({
    title: '報修進度',
    eyebrow: '進行中的報修',
    subtitle: `共 ${tickets.length} 筆；最新更新的案件會排在最上方。`,
    tickets,
    lineUserId,
    status: 'open',
    audience: 'tenant',
  }));
});

router.get('/tenant/repairs/history', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      const lineUserId = String(req.query.lineUserId || '').trim();
      if (!lineUserId) return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 報修進度卡片開啟。</p>');
      return await withV2Driver(async (db) => {
        const identity = await repairRepositoryAsync.getLineIdentity(db, lineUserId);
        if (!identity) return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
        const tickets = await repairRepositoryAsync.listTenantRepairTickets(db, identity.user_id, 50, { history: true });
        return res.send(repairHistoryListPage({ title: '完整報修紀錄', eyebrow: '已結案報修', subtitle: `共 ${tickets.length} 筆已結案案件。`, tickets, lineUserId, status: 'history' }));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  if (!lineUserId) {
    return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 報修歷史卡片開啟。</p>');
  }
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity) {
    return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
  }
  const tickets = repairRepository.listTenantRepairHistoryTickets(db, identity.user_id, 50);
  res.send(repairHistoryListPage({
    title: '報修歷史',
    eyebrow: '已結案報修',
    subtitle: `共 ${tickets.length} 筆；點選單筆可查看照片與完整處理歷程。`,
    tickets,
    lineUserId,
    status: 'history',
    audience: 'tenant',
  }));
});

router.get('/landlord/tasks', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      const lineUserId = String(req.query.lineUserId || '').trim();
      return await withV2Driver(async (db) => {
        const identity = await repairRepositoryAsync.getLineIdentity(db, lineUserId);
        if (!identity) return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
        const baseTickets = await repairRepositoryAsync.listLandlordRepairActiveTickets(db, identity.user_id, { limit: 20 });
        const activeTickets = await Promise.all(baseTickets.map(async (ticket) => ({ ...ticket, ...(await repairRepositoryAsync.getRepairContext(db, ticket.public_id) || {}) })));
        const recentUpdates = await db.all(`SELECT ru.update_type, ru.message_text, ru.created_at, rt.public_id AS repair_public_id, rt.status AS repair_status, ru.to_status, r.unit_label, COALESCE(up.display_name, li.display_name_cache, '系統') AS actor_name FROM repair_updates ru JOIN repair_tickets rt ON rt.id=ru.repair_ticket_id JOIN rental_units r ON r.id=rt.rental_unit_id LEFT JOIN user_profiles up ON up.user_id=ru.created_by_user_id LEFT JOIN line_identities li ON li.user_id=ru.created_by_user_id JOIN property_owners po ON po.property_id=r.property_id AND (po.rental_unit_id IS NULL OR po.rental_unit_id=r.id) WHERE po.owner_user_id=? ORDER BY ru.created_at DESC, ru.id DESC LIMIT 10`, [identity.user_id]);
        const rows = await db.all(`SELECT n.event_type,n.entity_type,n.entity_id,n.payload_json,n.created_at,nd.status AS delivery_status,nd.sent_at FROM notification_deliveries nd JOIN notifications n ON n.id=nd.notification_id WHERE nd.recipient_user_id=? ORDER BY COALESCE(nd.sent_at,n.created_at) DESC,n.id DESC LIMIT 80`, [identity.user_id]);
        const notificationEvents = rows.map((row) => { const payload = parseJsonObject(row.payload_json); const category = notificationCategory(row.event_type, payload); return { ...row, payload, category, title: payload.title || notificationTitle(row.event_type, category), unitLabel: payload.unitLabel || '租屋物件', message: payload.message || payload.subtitle || notificationTitle(row.event_type, category), eventAt: row.sent_at || row.created_at, actionUrl: row.entity_type === 'repair_ticket' ? `/landlord/repairs/${encodeURIComponent(row.entity_id)}?lineUserId=${encodeURIComponent(lineUserId)}` : safeNotificationActionUrl(payload.actionUrl || payload.action_url) }; });
        return res.send(landlordTaskCenterPage({ activeTickets, recentUpdates, notificationEvents, overview: {}, lineUserId, scope: '', tab: String(req.query.tab || 'mine'), category: String(req.query.category || 'all') }));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  const allowDemoScope = req.query.scope === 'demo_all' && process.env.NODE_ENV !== 'production';
  if (!lineUserId) {
    return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 通知與待辦卡片開啟。</p>');
  }
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity) {
    return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
  }
  const ownerUserId = allowDemoScope ? null : identity.user_id;
  const baseTickets = repairRepository.listLandlordRepairActiveTickets(db, ownerUserId, {
    limit: 20,
  });
  const activeTickets = baseTickets
    .map((ticket) => repairRepository.getRepairContext(db, ticket.public_id) || ticket)
    .map((ticket) => ({ ...ticket, ...baseTickets.find((base) => base.public_id === ticket.public_id) }));
  const recentUpdates = repairRepository.listLandlordRecentRepairUpdates(db, ownerUserId, {
    limit: 10,
  });
  const overview = dashboardRepository.getDashboardOverview(db, { lineUserId });
  const notificationEvents = listLandlordNotificationEvents(db, {
    lineUserId,
    // Demo 全覽仍要保留目前登入者曾收到的歷史通知；不然像續約提醒這類
    // 只以 recipient_user_id 留存的既有事件會被錯誤地隱藏。
    userId: identity.user_id,
    limit: 80,
  });
  res.send(landlordTaskCenterPage({
    activeTickets,
    recentUpdates,
    notificationEvents,
    overview,
    lineUserId,
    scope: allowDemoScope ? 'demo_all' : '',
    tab: String(req.query.tab || 'mine'),
    category: String(req.query.category || 'all'),
  }));
});

router.get('/landlord/repairs', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      const lineUserId = String(req.query.lineUserId || '').trim(); const unitId = req.query.unitId ? Number(req.query.unitId) : null; const mode = req.query.status === 'open' ? 'open' : 'history';
      return await withV2Driver(async (db) => {
        const identity = await repairRepositoryAsync.getLineIdentity(db, lineUserId);
        if (!identity) return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
        const tickets = await repairRepositoryAsync.listLandlordRepairActiveTickets(db, identity.user_id, { unitId, limit: 50, history: mode === 'history' });
        return res.send(repairHistoryListPage({ title: mode === 'open' ? '正在報修' : '修繕歷史', eyebrow: mode === 'open' ? '房東端未結案報修' : '房東端已結案報修', subtitle: `共 ${tickets.length} 筆；點選可查看完整紀錄。`, tickets, lineUserId, status: mode, audience: 'landlord' }));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  const unitId = req.query.unitId ? Number(req.query.unitId) : null;
  const mode = req.query.status === 'open' ? 'open' : 'history';
  const allowDemoScope = req.query.scope === 'demo_all' && process.env.NODE_ENV !== 'production';
  if (!lineUserId) {
    return res.status(400).send('<h1>缺少 LINE 身分參數</h1><p>請從 LINE 修繕歷史卡片開啟。</p>');
  }
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity) {
    return res.status(404).send('<h1>找不到你的 LINE 身分綁定</h1>');
  }
  const ownerUserId = allowDemoScope ? null : identity.user_id;
  const units = mode === 'open'
    ? repairRepository.listLandlordRepairActiveUnits(db, ownerUserId)
    : repairRepository.listLandlordRepairHistoryUnits(db, ownerUserId);
  const allowedUnitIds = new Set(units.map((unit) => Number(unit.id)));
  const selectedUnitId = unitId && allowedUnitIds.has(unitId) ? unitId : null;
  const tickets = mode === 'open'
    ? repairRepository.listLandlordRepairActiveTickets(db, ownerUserId, {
      unitId: selectedUnitId,
      limit: 50,
    })
    : repairRepository.listLandlordRepairHistoryTickets(db, ownerUserId, {
      unitId: selectedUnitId,
      limit: 50,
    });
  const selectedUnit = units.find((unit) => Number(unit.id) === selectedUnitId);
  const pageTitle = mode === 'open' ? '正在報修' : '修繕歷史';
  const pageEyebrow = selectedUnit ? selectedUnit.unit_label : (mode === 'open' ? '房東端未結案報修' : '房東端已結案報修');
  const pageSubtitle = selectedUnit
    ? `${selectedUnit.unit_label} 共 ${tickets.length} 筆；可點單筆查看完整紀錄。`
    : `共 ${tickets.length} 筆；可先選房源，再查看單筆完整紀錄。`;
  res.send(repairHistoryListPage({
    title: '修繕歷史',
    eyebrow: selectedUnit ? selectedUnit.unit_label : '房東端已結案報修',
    subtitle: selectedUnit
      ? `${selectedUnit.unit_label} 共 ${tickets.length} 筆；點選單筆可查看完整紀錄。`
      : `共 ${tickets.length} 筆；可先選房源，再查看單筆完整紀錄。`,
    tickets,
    ...{ title: pageTitle, eyebrow: pageEyebrow, subtitle: pageSubtitle },
    units,
    selectedUnitId,
    lineUserId,
    scope: allowDemoScope ? 'demo_all' : '',
    status: mode,
    audience: 'landlord',
  }));
});

function legacyLandlordRepairDetailPage({ ticket, files, updates, lineUserId, scope }) {
  const damageCount = files.filter((file) => file.purpose === 'damage_photo').length;
  const supplementCount = files.filter((file) => file.purpose === 'supplement').length;
  const completionCount = files.filter((file) => file.purpose === 'completion_photo').length;
  const action = (next, label, description, tone = '') => `
    <form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/decision">
      <input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <button class="decision ${escapeHtml(tone)}" type="submit">
        <strong><span>${escapeHtml(label)}</span><b>點選</b></strong>
        <span>${escapeHtml(description)}</span>
      </button>
    </form>
  `;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>處理報修 - ${escapeHtml(ticket.unit_label || ticket.public_id)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:860px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:22px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:26px;line-height:1.25}.hero .id{margin-top:8px;color:#E5E7EB;font-size:12px;word-break:break-all}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.summary{display:grid;gap:10px}.summary-card,.panel{border:1px solid #E5E7EB;border-radius:18px;background:#fff;padding:14px}.summary-card{background:#F8FAFC}.row{display:grid;grid-template-columns:92px 1fr;gap:10px;margin:7px 0;font-size:14px}.row span{color:#64748B}.row strong{color:#111827}.muted{color:#64748B;font-size:14px;line-height:1.6}.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.media{margin:0;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden;background:#fff}.media img,.media video{display:block;width:100%;max-height:320px;object-fit:contain;background:#F1F5F9}.media figcaption{padding:8px 10px;color:#64748B;font-size:12px}.actions{display:grid;gap:12px}.decision{width:100%;border:2px solid #1F2937;border-radius:18px;padding:16px 18px;text-align:left;background:#fff;color:#111827;font:inherit;cursor:pointer;box-shadow:0 6px 0 rgba(15,23,42,.12);transition:.15s transform,.15s box-shadow}.decision:active{transform:translateY(2px);box-shadow:0 3px 0 rgba(15,23,42,.12)}.decision.primary{background:#1F2937;color:#fff;border-color:#1F2937}.decision.warn{background:#FFF7ED;color:#9A3412;border-color:#FB923C}.decision.danger{background:#FEF2F2;color:#991B1B;border-color:#F87171}.decision.info{background:#EFF6FF;color:#1D4ED8;border-color:#60A5FA}.decision.neutral{background:#F8FAFC;color:#334155;border-color:#64748B}.decision strong{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:17px}.decision strong b{display:inline-flex;align-items:center;justify-content:center;min-width:58px;border-radius:999px;background:#1F2937;color:#fff;font-size:12px;padding:5px 10px}.decision.primary strong b{background:#fff;color:#1F2937}.decision.info strong b{background:#1D4ED8;color:#fff}.decision.warn strong b{background:#C2410C;color:#fff}.decision.neutral strong b{background:#334155;color:#fff}.decision>span{display:block;margin-top:7px;font-size:13px;opacity:.84;line-height:1.5}.subgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.timeline{display:grid;gap:12px}.event{display:grid;grid-template-columns:22px 1fr;gap:10px}.dot{width:18px;height:18px;border-radius:999px;background:#1F2937;margin-top:5px}.event-card{border:1px solid #E5E7EB;border-radius:14px;padding:12px;background:#fff}.event-meta{display:flex;justify-content:space-between;gap:8px;font-size:13px}.event-meta time{color:#94A3B8;font-size:12px}.event-card p{white-space:pre-wrap;line-height:1.55;color:#334155;font-size:14px}.back{display:inline-flex;margin-top:12px;color:#E5E7EB;text-decoration:none;font-size:13px}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:20px 16px}.subgrid{grid-template-columns:1fr}.row{grid-template-columns:78px 1fr}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>房東端報修處理</p>
        <h1>${escapeHtml(ticket.unit_label || '報修案件')}</h1>
        <div class="id">${escapeHtml(ticket.public_id)}</div>
        <a class="back" href="/landlord/repairs?lineUserId=${encodeURIComponent(lineUserId)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}&status=open">返回正在報修</a>
      </header>
      <section class="section summary">
        <div class="summary-card">
          <div class="row"><span>房客</span><strong>${escapeHtml(ticket.tenant_name || '房客')}</strong></div>
          <div class="row"><span>狀態</span><strong>${escapeHtml(statusText(ticket.status, completionCount))}</strong></div>
          <div class="row"><span>通報時間</span><strong>${escapeHtml(formatDateTime(ticket.reported_at))}</strong></div>
          <div class="row"><span>報修內容</span><strong>${escapeHtml(ticket.description || '尚未提供')}</strong></div>
          <div class="row"><span>照片</span><strong>損壞 ${damageCount} 張；補充 ${supplementCount} 張；修好後 ${completionCount} 張</strong></div>
        </div>
      </section>
      <section class="section">
        <h2>處理方向</h2>
        <p class="muted">先決定誰修，再決定誰付錢；涉及房客付款時會先通知房客確認或協商，不會直接扣款。</p>
        <div class="actions">
          <div class="panel">
            <h3>房東派修</h3>
            <p class="muted">由房東或師傅處理；適合設備老舊、自然損壞、需要專業維修，或房東要掌控修繕品質。</p>
            <div class="subgrid">
              ${action('in_progress', '房東派修・房東付', '房東或師傅處理，費用預設由房東負擔；適合自然耗損或正常使用故障。', 'primary')}
              ${action('tenant_pays_landlord_repair', '房東派修・房客付', '房東安排師傅，但費用擬向房客收取；需保留報價、收據，並等房客確認條件。', 'warn')}
            </div>
          </div>
          <div class="panel">
            <h3>房客自修</h3>
            <p class="muted">由房客自行處理；修好後必須回傳照片。若由房東負擔費用，請房客保留收據、統編或匯款資料方便報帳。</p>
            <div class="subgrid">
              ${action('tenant_self_repair', '房客自修・房東付', '房客先自行處理；修好後回傳照片，並保留收據／統編／付款證明給房東確認。', 'info')}
              ${action('tenant_pays', '房客自修・房客付', '初判為房客故意、過失或不當使用時使用；房客需確認條件，可接受、協商或補充說明。', 'warn')}
            </div>
          </div>
          ${action('need_info', '請房客補資料', '資訊不足時使用：請補照片、影片、損壞時間或使用情境；暫不判斷誰修、誰負擔。', 'neutral')}
        </div>
      </section>
      <section class="section">
        <h2>損壞照片</h2>
        <div class="media-grid">${mediaHtml(files, 'damage_photo')}</div>
      </section>
      <section class="section">
        <h2>補充附件</h2>
        <div class="media-grid">${mediaHtml(files, 'supplement')}</div>
      </section>
      <section class="section">
        <h2>修好後照片</h2>
        <div class="media-grid">${mediaHtml(files, 'completion_photo')}</div>
      </section>
      <section class="section">
        <h2>處理紀錄</h2>
        <div class="timeline">${timelineHtml(updates, files)}</div>
      </section>
    </section>
  </main>
</body>
</html>`;
}

function ruleDecisionNext(ticket) {
  const liability = ticket.ai_liability_party || ticket.liability_party || ticket.ai_responsibility_guess || ticket.responsibility_guess;
  const dispatch = effectiveDispatchParty(ticket);
  const payer = ticket.ai_recommended_payer_party || ticket.ai_recommended_payer || ticket.payer_party;
  if (liability === 'tenant' || payer === 'tenant') return 'tenant_pays';
  if (dispatch === 'tenant') return 'tenant_self_repair';
  if (dispatch === 'landlord' || dispatch === 'vendor') return 'in_progress';
  return 'need_info';
}

// AI 提供的是建議；案件一旦選定實際執行者，後續頁面一律以本案選擇為準。
function effectiveDispatchParty(ticket = {}) {
  const stored = String(ticket.dispatch_party || ticket.repair_executor || '').toLowerCase();
  if (['landlord', 'tenant', 'vendor'].includes(stored)) return stored;
  return String(ticket.ai_recommended_dispatch_party || ticket.recommended_dispatch_party || ticket.ai_recommended_executor || '').toLowerCase();
}

function ruleDecisionLabel(ticket) {
  const next = ruleDecisionNext(ticket);
  return ({
    in_progress: '依規則：房東處理',
    tenant_self_repair: '依規則：同意房客代修',
    tenant_pays: '依規則：通知房客確認責任',
    need_info: '依規則：先補資料',
  })[next] || '依規則處理';
}

function repairRuleSourceLabel(ticket) {
  const pathValue = String(ticket.ai_rule_source_clause_path || '').trim();
  if (!pathValue) return '尚未對應到明確規則來源';
  const parts = pathValue.split(':');
  if (/^(contract|lease|clause|article)$/i.test(parts[0] || '')) {
    return `合約條款：${pathValue}`;
  }
  if (parts[0] === 'unit-default') {
    return `房源預設修繕規則：${ticket.asset_name || '此房源設備'}`;
  }
  if (parts[0] === 'asset') {
    const assetName = parts[1] || ticket.asset_name || '此設備';
    const scenario = ({
      natural_wear: '自然耗損／正常故障',
      normal_use: '正常使用故障',
      tenant_fault: '房客可歸責情境',
      malicious_damage: '故意破壞情境',
      unknown: '原因不明保守處理',
    })[parts[2]] || parts[2] || '修繕情境';
    return `簽約／點交房源規則：${assetName}／${scenario}`;
  }
  if (parts[0] === 'system') return `簽約採用修繕基準：住宅租賃法定／定型化契約規則（${pathValue}）`;
  return pathValue;
}

function repairRuleBasisText(ticket) {
  const source = repairRuleSourceLabel(ticket);
  const summary = ticket.ai_contract_basis_summary || ticket.ai_legal_basis_summary || '';
  if (!summary) return source;
  return `${source}。${summary}`;
}

function aiGuessText(ticket) {
  if (ticket.ai_liability_party === 'none') {
    const payer = ticket.ai_recommended_payer_party || ticket.ai_recommended_payer;
    return payer === 'landlord' ? '房東修繕／負擔' : '無可歸責方';
  }
  if (ticket.ai_liability_party) {
    return ({
      landlord: '房東可歸責',
      tenant: '房客可歸責',
      shared: '雙方分攤',
      third_party: '第三方可歸責',
      pending: '待確認',
      review_required: '需要補資料',
    })[ticket.ai_liability_party] || '尚未判定';
  }
  return ({
    landlord: '房東修繕／負擔',
    tenant: '房客可歸責',
    shared: '雙方分攤',
    review_required: '需要補資料',
    insufficient_info: '資訊不足',
  })[ticket.ai_responsibility_guess] || '尚未判定';
}

function aiExecutorText(ticket) {
  const value = effectiveDispatchParty(ticket);
  return ({
    landlord: '房東處理',
    tenant: '房客處理',
    vendor: '師傅／廠商處理',
    building_management: '管委會處理',
    review_required: '待確認',
  })[value] || '待確認';
}

function aiPayerText(ticket) {
  const value = ticket.ai_recommended_payer_party || ticket.ai_recommended_payer;
  return ({
    landlord: '房東負擔',
    tenant: '房客負擔',
    shared: '雙方分攤',
    third_party: '第三方負擔',
    review_required: '待確認',
  })[value] || '待確認';
}

function aiLiabilityText(ticket) {
  const value = ticket.ai_liability_party || ticket.liability_party || ticket.ai_responsibility_guess;
  return ({
    none: '無可歸責方（屬修繕義務）',
    landlord: '房東可歸責',
    tenant: '房客可歸責',
    shared: '雙方分攤',
    third_party: '第三方可歸責',
    pending: '責任待確認',
    review_required: '責任待確認',
    insufficient_info: '資訊不足，責任待確認',
  })[value] || '責任待確認';
}

function aiAssessmentSummary(ticket, missing = []) {
  const ruleStatus = String(ticket.ai_rule_match_status || 'not_evaluated');
  const evidenceStatus = String(ticket.ai_evidence_status || 'insufficient');
  const liability = ticket.ai_liability_party || ticket.liability_party || ticket.ai_responsibility_guess || '';
  const dispatch = ticket.ai_recommended_dispatch_party || ticket.ai_recommended_executor || ticket.dispatch_party || ticket.repair_executor || '';
  const payer = ticket.ai_recommended_payer_party || ticket.ai_recommended_payer || ticket.payer_party || '';
  const hasMissing = missing.length > 0 || evidenceStatus === 'insufficient';
  // 只信任 assessment 儲存的結構化結果；不可從條款文字裡看到「房客可歸責」
  // 就把仍在等待證據的條件式規則誤顯示為房客已經有責。

  if (ruleStatus === 'missing') {
    return {
      tone: 'warn',
      title: '目前租約沒有明確對應規則',
      body: '這不是房東可以自由決定責任，而是本案需要建立例外處理紀錄；若之後成為固定規則，仍要走補充約定。',
    };
  }
  if (ruleStatus === 'conflicting') {
    return {
      tone: 'warn',
      title: '規則衝突，暫不判定責任',
      body: '租約、附件或房源規則可能互相衝突，應先人工確認哪一條有效，再重新判斷。',
    };
  }
  if (evidenceStatus === 'disputed') {
    return {
      tone: 'warn',
      title: '雙方或證據有異議，責任未定',
      body: '目前重點是保存異議與補充依據，不應直接定案扣款或結案。',
    };
  }
  if (hasMissing) {
    return {
      tone: 'neutral',
      title: '責任尚未判定',
      body: '目前照片或描述不足以判斷自然故障、人為損壞或原始物況差異；請先補證據或送專業人員判斷。系統不會因條款文字而先認定任何一方有責。',
    };
  }
  if (liability === 'none' && payer === 'landlord') {
    return {
      tone: 'ok',
      title: '規則結果：房東修繕／房東負擔',
      body: '這表示本案較像自然故障或正常使用造成的修繕義務；不是判定房東造成損壞。',
    };
  }
  if (liability === 'tenant' || payer === 'tenant') {
    return {
      tone: 'warn',
      title: '規則結果：偏向房客可歸責／房客負擔',
      body: '系統已有較明確規則與證據，但仍應通知房客確認；房客可接受、補件或提出異議。',
    };
  }
  return {
    tone: 'neutral',
    title: '系統已有初判，但仍需人工確認下一步',
    body: '請依下方系統建議執行，或補充新依據後重新判斷。',
  };
}

function tenantAiAssessmentHtml(ticket) {
  const missing = safeJsonArray(ticket.ai_missing_info_json);
  const summary = aiAssessmentSummary(ticket, missing);
  return `<section class="section">
    <h2>合約／AI 初判</h2>
    <div class="stat" style="border-color:#CBD5E1;background:#fff;padding:16px">
      <h3 style="margin:0 0 12px;font-size:18px">${escapeHtml(ticket.asset_name || '尚未對應到家具／設備')} <span style="display:inline-block;padding:4px 9px;border-radius:999px;background:#EEF2FF;color:#3730A3;font-size:12px;vertical-align:middle">${escapeHtml(aiGuessText(ticket))}</span></h3>
      <div style="margin:10px 0 14px;padding:13px;border:1px solid ${summary.tone === 'ok' ? '#86EFAC' : summary.tone === 'warn' ? '#FDBA74' : '#93C5FD'};border-radius:16px;background:${summary.tone === 'ok' ? '#F0FDF4' : summary.tone === 'warn' ? '#FFF8F1' : '#EFF6FF'}">
        <strong style="display:block;font-size:17px">${escapeHtml(summary.title)}</strong>
        <span style="display:block;margin-top:5px;color:#475569;line-height:1.6">${escapeHtml(summary.body)}</span>
      </div>
      <div style="display:grid;grid-template-columns:92px 1fr;gap:9px 10px;font-size:14px;line-height:1.55"><span style="color:#64748B">可歸責方</span><strong>${escapeHtml(aiLiabilityText(ticket))}</strong><span style="color:#64748B">處理</span><strong>${escapeHtml(aiExecutorText(ticket))}</strong><span style="color:#64748B">費用</span><strong>${escapeHtml(aiPayerText(ticket))}</strong><span style="color:#64748B">依據</span><strong>${escapeHtml(repairRuleSourceLabel(ticket))}</strong><span style="color:#64748B">待補</span><strong>${escapeHtml(missing.length ? missing.join('、') : '無')}</strong></div>
      <div style="margin-top:12px;padding:11px 12px;border:1px solid #E5E7EB;border-radius:14px;background:#F8FAFC;color:#334155;font-size:13px;line-height:1.6">${escapeHtml(ticket.ai_contract_basis_summary || ticket.ai_legal_basis_summary || '目前尚無可直接套用的規則，需補資料或由雙方協商確認。')}</div>
    </div>
    <p class="muted" style="margin-bottom:0">這是依目前報修資料與租約規則產生的初判，不是最終扣款、責任承認或結案。</p>
  </section>`;
}

function normalizeRepairActionState(ticket, missing = []) {
  const ruleMatchStatus = String(ticket?.ai_rule_match_status || 'not_evaluated');
  const evidenceStatus = String(ticket?.ai_evidence_status || 'insufficient');
  const causeClassification = ticket?.ai_cause_classification || ticket?.cause_classification || 'unknown';
  const liabilityParty = ticket?.ai_liability_party || ticket?.liability_party || ticket?.ai_responsibility_guess || 'pending';
  // dispatch_party 是本案已選定的實際執行者；只有真正選定的角色才覆蓋 AI／規則建議。
  // 舊資料的 review_required 只是尚未決定，不能遮蔽已存在的建議。
  const storedDispatchParty = String(ticket?.dispatch_party || ticket?.repair_executor || '').toLowerCase();
  const dispatchParty = ['landlord', 'tenant', 'vendor'].includes(storedDispatchParty)
    ? storedDispatchParty
    : (ticket?.ai_recommended_dispatch_party || ticket?.ai_recommended_executor || 'review_required');
  const payerParty = ticket?.ai_recommended_payer_party || ticket?.ai_recommended_payer || ticket?.payer_party || 'review_required';
  const tenantPreference = ticket?.tenant_preference || 'no_preference';
  const safetyRisk = ticket?.ai_safety_risk || ticket?.safety_risk || ticket?.ai_risk_level || ticket?.risk_level || ticket?.priority || 'normal';
  const ticketStatus = String(ticket?.status || '');
  const repairStatus = ticket?.repair_status || ticketStatus || 'reported';
  const appointmentStatus = ticket?.appointment_status || 'not_required';
  const repairVerificationStatus = ticket?.repair_verification_status || 'pending';
  const safetyStatus = ticket?.safety_status || (safetyRisk === 'urgent' ? 'urgent_detected' : 'normal');
  const actionOwner = ticket?.action_owner || 'landlord';
  const waitingOn = ticket?.waiting_on || 'none';
  const liabilityStatus = ticket?.liability_status || 'pending';
  const settlementStatus = ticket?.settlement_status || 'pending';
  // 舊案件有些只更新了工單顯示狀態（tenant_confirmed），沒有同步寫入
  // case_status。這兩種資料都代表已結案，避免頁面再顯示一次「完成結案」。
  const legacyClosedStatus = ['tenant_confirmed', 'landlord_confirmed'].includes(ticketStatus);
  const caseStatus = ticket?.case_status || (legacyClosedStatus ? 'closed' : 'open');
  const completionPhotoCount = Number(ticket?.completion_photo_count || 0);
  const missingItems = Array.isArray(missing) ? missing.filter(Boolean) : [];

  return {
    ruleMatchStatus,
    evidenceStatus,
    causeClassification,
    liabilityParty,
    dispatchParty,
    payerParty,
    tenantPreference,
    safetyRisk,
    repairStatus,
    appointmentStatus,
    repairVerificationStatus,
    safetyStatus,
    actionOwner,
    waitingOn,
    liabilityStatus,
    settlementStatus,
    caseStatus,
    completionPhotoCount,
    missingItems,
    evidenceReady: evidenceStatus === 'sufficient' && missingItems.length === 0,
    ruleReady: ruleMatchStatus === 'matched' || ruleMatchStatus === 'needs_review',
    urgent: ['urgent', 'urgent_detected', 'emergency_action_in_progress'].includes(safetyStatus) || safetyRisk === 'urgent',
    repairCompleted: repairStatus === 'completed' || repairStatus === 'landlord_completed' || repairStatus === 'repair_completed',
    caseClosed: caseStatus === 'closed'
      || legacyClosedStatus
      || repairStatus === 'tenant_confirmed'
      || repairStatus === 'landlord_confirmed'
      || repairStatus === 'cancelled',
  };
}

function resolveAllowedRepairActions(ticket, missing = []) {
  const state = normalizeRepairActionState(ticket, missing);
  const actions = [];
  const add = (key, label, description, tone = 'neutral') => actions.push({ key, label, description, tone });
  const hasLandlordPayer = state.payerParty === 'landlord';
  const hasTenantPayer = state.payerParty === 'tenant' || state.liabilityParty === 'tenant';
  const tenantWantsToHandle = state.tenantPreference === 'tenant_self_repair';
  const executionPending = ['pending', 'review_required', 'insufficient_info', 'unknown'].includes(state.liabilityParty)
    || ['pending', 'review_required', 'unknown'].includes(state.dispatchParty)
    || ['pending', 'review_required', 'unknown'].includes(state.payerParty);

  if (state.caseClosed) {
    return {
      state,
      intro: '此報修案件已結案或取消；LINE 與本頁只保留完整紀錄，不再提供責任或費用操作。',
      actions,
    };
  }

  if (state.appointmentStatus === 'reschedule_requested' && !state.repairCompleted) {
    return {
      state,
      intro: '房客已提出改期需求。此案件會維持在等待排程狀態；待可用時段協調功能接入後，再由雙方選擇新的時間，不需要重新建立修繕案件。',
      actions,
    };
  }

  if (state.repairCompleted) {
    if (state.completionPhotoCount > 0) {
      const completedByLandlordOrVendor = state.dispatchParty === 'landlord' || state.dispatchParty === 'vendor';
      const settlementResolved = ['completed', 'not_required', 'waived'].includes(state.settlementStatus);
      if (completedByLandlordOrVendor && state.repairVerificationStatus !== 'confirmed') {
        return {
          state,
          intro: state.repairVerificationStatus === 'disputed'
            ? '房客已回報修繕結果仍有問題。請查看完整紀錄；確認需要補修後，再重新安排修繕。'
            : '房東或廠商已上傳修好資料，已通知房客從外部頁查驗。房客確認前不能進入結算或結案。',
          actions: state.repairVerificationStatus === 'disputed'
            ? [{ key: 'confirm_landlord_repair', label: '確認補修並重新安排', description: '確認需要再次處理後，重新提出修繕時間；不會直接結案。', tone: 'warn' }]
            : [],
        };
      }
      if (!settlementResolved) {
        add('settle_repair', completedByLandlordOrVendor ? '確認費用結算' : '確認修好與費用', completedByLandlordOrVendor
          ? '房客已確認修復結果；請填寫實際金額與付款狀態。符合全部關案條件後才能結案。'
          : '查看修好照片、收據／報價與房客申報金額；確認後才能保存最終結算。', 'completion');
        if (!completedByLandlordOrVendor) {
          add('reopen', '退回需重新處理', '修復結果、附件或費用資料有問題時退回；房客會收到重新處理通知。', 'danger');
        }
        return {
          state,
          intro: completedByLandlordOrVendor
            ? '房客已確認修復結果，費用待結算。請填寫實際金額與付款狀態；此時仍不會自動結案。'
            : '修繕已完成，費用待結算。請先確認修復結果與實際金額／付款狀態，不能直接結案。',
          actions,
        };
      }
      add('landlord_confirmed', completedByLandlordOrVendor ? '完成結案' : '確認完成並結案', completedByLandlordOrVendor
        ? '房客已確認修復結果，且費用紀錄已完成；確認後才可結案。'
        : '僅確認修繕結果已完成；如仍有責任或費用爭議，應先處理結算，不要直接結案。', 'primary');
      if (!completedByLandlordOrVendor) {
        add('reopen', '退回需重新處理', '修復結果、附件或費用資料有問題時退回；房客會收到重新處理通知。', 'danger');
      }
      return {
        state,
        intro: completedByLandlordOrVendor
          ? '房客已確認修復結果，且費用紀錄已完成；確認後即可結案。'
          : '目前是修繕完成待房東確認。這一步只確認修繕結果，不代表自動完成責任或費用結算。',
        actions,
      };
    }
    const handlerIsTenant = state.dispatchParty === 'tenant' || state.tenantPreference === 'tenant_self_repair';
    if (handlerIsTenant) {
      add('ask_tenant_supplement', '請房客回傳修好照片', '修繕已標記完成，但尚未看到修好後照片；請房客補上照片後再確認。', 'primary');
    } else {
      add('landlord_completion_upload', '上傳修繕完成資料', '由房東或安排的廠商上傳至少一張修好後照片；可一併附收據、報價、維修說明與實際金額。', 'completion');
    }
    return {
      state,
      intro: handlerIsTenant
        ? '目前已標記修繕完成，但缺少修好後照片；先請房客補修復證據，不直接結案。'
        : '目前已標記修繕完成，但缺少修好後照片；請由房東或安排的廠商回傳修復證據，不直接結案。',
      actions,
    };
  }

  // 房東／廠商的修繕執行不能只停在「已安排」。房客確認到場時間後，
  // 下一步必須讓實際處理者回傳修好照片與費用證據，而不是先把案件改成完成。
  const landlordOrVendorHandlesRepair = state.dispatchParty === 'landlord' || state.dispatchParty === 'vendor';
  const appointmentConfirmed = state.appointmentStatus === 'confirmed'
    || String(ticket.latest_appointment_message || '').includes('已確認可配合');
  if (landlordOrVendorHandlesRepair && (state.repairStatus === 'in_progress' || appointmentConfirmed)) {
    add('landlord_completion_upload', '上傳修繕完成資料', '請由房東或安排的廠商上傳修好後照片；可一併附收據、報價、維修說明與實際金額。送出後才會進入費用結算。', 'completion');
    return {
      state,
      intro: '修繕時間已確認或已開始處理。完成維修後請上傳修繕完成資料；上傳不等於直接結案，仍需確認費用。',
      actions,
    };
  }

  if (state.urgent) {
    add('vendor_judgement', '立即安全處置／專業檢查', '天然瓦斯、熱水器、漏電、冒煙、嚴重漏水等安全事件先處理風險，再談責任與費用。', 'primary');
    add('confirm_landlord_repair', '先行修繕／約時間', '先恢復安全或基本使用；不代表任何一方承認責任或最終費用。', 'info');
    add('ask_tenant_supplement', '補充安全資料', '補照片、影片、發生時間與現場狀態，保存為後續重新判斷依據。');
    return {
      state,
      intro: '此案被標示為安全優先事件，先做安全處置；責任與費用要等風險控制與證據補齊後再判斷。',
      actions,
    };
  }

  if (state.evidenceStatus === 'disputed') {
    add('landlord_negotiate:dispute', '補充依據／提出異議', '雙方對規則、證據或費用有不同意見；可補充依據重新判斷，或提出方案通知對方回覆。');
    return {
      state,
      intro: '目前案件存在異議，重點是保存不同意見與補充依據，不是直接定案。',
      actions,
    };
  }

  if (state.ruleMatchStatus === 'conflicting') {
    add('landlord_negotiate:manual_review', '送人工確認', '租約正文、附件或房源規則可能衝突；先確認哪條有效，再重新套用規則。');
    if (!state.evidenceReady) {
      add('ask_tenant_supplement', '請房客補件', '同時缺少照片、時間、使用情境或原始物況時，先補證據，不直接判責任。');
    }
    return {
      state,
      intro: state.evidenceReady
        ? '目前是規則衝突，不是責任決定階段；請先送人工確認。'
        : '目前同時有規則衝突與證據不足，兩個問題要分開處理。',
      actions,
    };
  }

  if (state.ruleMatchStatus === 'missing') {
    if (state.evidenceReady) {
      add('landlord_negotiate:case_exception', '建立本案例外處理', '租約未找到對應規則；只處理本次案件，不會自動修改原租約。', 'primary');
    } else {
      add('ask_tenant_supplement', '先請房客補件', '租約規則缺口可以先記錄，但目前證據仍不足，不宜直接談責任方案。', 'primary');
      add('vendor_judgement', '送維修人員判斷', '請師傅或專業人員確認原因；判斷結果保存後再決定是否進例外處理。', 'info');
      add('landlord_negotiate:case_exception', '記錄規則缺口', '先留下此設備／情境缺少規則的紀錄，但不直接形成責任或費用方案。');
    }
    return {
      state,
      intro: state.evidenceReady
        ? '目前證據足夠，但租約沒有找到對應規則；可建立本案例外處理。'
        : '目前租約缺少規則，而且證據也不足；先補證據，再處理本案例外方案。',
      actions,
    };
  }

  if (!state.evidenceReady || state.ruleMatchStatus === 'not_evaluated') {
    add('ask_tenant_supplement', '請房客補件', '請房客補照片、影片、損壞時間、使用情境或原始物況說明；補完後再重新套用規則。', 'primary');
    add('vendor_judgement', '送維修人員判斷', '先請師傅／專業人員確認損壞原因；判斷結果會保存到修繕紀錄，再決定責任。', 'info');
    add('confirm_landlord_repair', '先行修繕／約時間', '若影響居住或安全，可先安排修繕；不代表任何一方已承認責任或最終費用。');
    return {
      state,
      intro: '目前還不是責任決定階段。請先補證據或送專業判斷；如需先恢復使用，可先行安排修繕，但責任與費用仍待確認。',
      actions,
    };
  }

  if (hasTenantPayer) {
    if (state.liabilityStatus === 'confirmed' || String(ticket.status || '') === 'accepted') {
      add('choose_tenant_liability_execution', '選擇修繕方式', '房客已接受本次費用負擔方向。請選擇由房東安排修繕，或授權房客自行修繕；此選擇不會改變房客負擔費用。', 'primary');
      return {
        state,
        intro: '房客已接受本次處理方向。現在只需決定「誰實際修」，責任與費用方向不會因此改變。',
        actions,
      };
    }
    add('confirm_tenant_liability', '通知房客確認處理方案', '依目前規則與證據提出房客負擔方案；房客可接受、補件或提出異議，不會直接定案扣款。', 'warn');
    return {
      state,
      intro: '目前規則與證據偏向房客可能需負擔；房東是在通知房客確認方案，不是單方扣款。',
      actions,
    };
  }

  if (hasLandlordPayer && tenantWantsToHandle) {
    add('tenant_self_repair', '同意房客代為處理', '費用仍依目前規則由房東負擔；房客修好後需回傳照片與收據／付款資料供房東確認。', 'info');
    add('confirm_landlord_repair', '房東安排修繕／約時間', '房東或師傅處理；維持目前房東修繕／負擔的規則結果。', 'primary');
    return {
      state,
      intro: '系統結果偏向房東修繕／負擔；房客願意代為處理只影響「誰修」，不會讓房客變成付款方。',
      actions,
    };
  }

  if (hasLandlordPayer || state.dispatchParty === 'landlord' || state.dispatchParty === 'vendor') {
    add('confirm_landlord_repair', '安排修繕／約時間', '依目前規則：房東安排修繕並先不向房客主張費用。', 'primary');
    return {
      state,
      intro: '目前已有可套用的規則與證據；請先安排並確認修繕時間。時間確認或實際開始處理後，才會開放上傳修繕完成資料。',
      actions,
    };
  }

  if (executionPending) {
    add('ask_tenant_supplement', '請房客補件', '請房客補照片、影片、損壞時間、使用情境或原始物況說明；補完後再重新套用規則。', 'primary');
    add('vendor_judgement', '送維修人員判斷', '先請師傅／專業人員確認損壞原因；判斷結果會保存到修繕紀錄，再決定責任。', 'info');
    return {
      state,
      intro: '系統已有初步整理，但責任、處理者或費用仍待確認；先補證據或交由專業判斷，不直接讓房東選責任答案。',
      actions,
    };
  }

  return {
    state,
    intro: '目前系統還沒有明確的執行方向，請先補充依據或交由人工確認。',
    actions,
  };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function repairExceptionMode(ticket, explicitMode = '') {
  const allowed = new Set(['case_exception', 'manual_review', 'dispute', 'landlord_evidence']);
  if (allowed.has(explicitMode)) return explicitMode;
  const ruleStatus = String(ticket?.ai_rule_match_status || 'not_evaluated');
  const evidenceStatus = String(ticket?.ai_evidence_status || 'insufficient');
  if (evidenceStatus === 'disputed') return 'dispute';
  if (ruleStatus === 'conflicting') return 'manual_review';
  if (ruleStatus === 'missing') return 'case_exception';
  return 'landlord_evidence';
}

function repairExceptionConfig(mode) {
  const configs = {
    case_exception: {
      title: '本案例外處理',
      eyebrow: '規則缺口',
      actionLabel: '建立本案例外處理',
      actionDescription: '目前租約未找到對應規則；提出本案處理方案並通知房客，但不會自動修改原租約。',
      reasonLabel: '例外處理原因',
      messageLabel: '本案處理方案',
      submitLabel: '送出本案方案並通知房客',
      defaultReason: 'rule_missing',
      updateTitle: '房東提出本案例外處理',
      notice: '目前租約未找到對應規則。以下內容只處理本次報修，不會自動修改原租約或房源規則。',
      hint: '請留下這次案件為什麼需要例外處理，以及希望房客確認的本案方案。房客尚未接受前，責任與費用都仍是待確認。',
      success: '已建立本案例外處理提案，並保存到完整紀錄。',
      notifyTenant: true,
    },
    manual_review: {
      title: '規則衝突待確認',
      eyebrow: '人工確認',
      actionLabel: '送人工確認',
      actionDescription: '租約正文、附件或房源規則可能衝突；先保存人工檢查紀錄，不直接通知成為雙方協議。',
      reasonLabel: '衝突確認原因',
      messageLabel: '人工確認說明',
      submitLabel: '保存人工確認紀錄',
      defaultReason: 'rule_conflicting',
      updateTitle: '房東送人工確認',
      notice: '租約正文、附件或房源規則存在不一致時，應先人工檢查哪一條有效；這一步不會直接通知房客形成協議。',
      hint: '請記錄目前看到的規則衝突、需要誰確認，以及暫不判定責任的原因。',
      success: '已保存人工確認紀錄，尚未通知房客形成協議。',
      notifyTenant: false,
    },
    dispute: {
      title: '補充依據／提出異議',
      eyebrow: '重新判斷或協商',
      actionLabel: '補充依據／提出異議',
      actionDescription: '可補充新證據要求重新判斷，或提出不同的修繕、費用方案與理由，通知房客回覆。',
      reasonLabel: '提出原因',
      messageLabel: '補充依據／處理方案說明',
      submitLabel: '送出並通知房客',
      defaultReason: 'landlord_evidence',
      updateTitle: '房東提出補充依據／不同處理方案',
      notice: '內容只作為重新判斷或雙方協商依據；不會直接成立責任、扣款或結案。',
      hint: '可補充照片、師傅意見或原始物況；若不採用系統初判，請寫明可接受的修繕方式、費用方向與理由。',
      success: '已保存內容並通知房客回覆，雙方往來會保留在案件完整紀錄。',
      notifyTenant: true,
    },
    landlord_evidence: {
      title: '補充依據並重新判斷',
      eyebrow: '補充證據',
      actionLabel: '補充依據並重新判斷',
      actionDescription: '房東提供新證據或理由；只保存為重新 assessment 的依據，不直接改責任或費用結果。',
      reasonLabel: '補充依據類型',
      messageLabel: '補充依據說明',
      submitLabel: '保存補充依據',
      defaultReason: 'landlord_evidence',
      updateTitle: '房東補充依據並請重新判斷',
      notice: '這一步只新增證據與理由，供後續重新套用規則；不會直接改責任、結案或通知成為協議。',
      hint: '請補充照片、維修判斷、原始物況、使用情境或其他可影響判斷的依據。',
      success: '已保存補充依據，後續可用於重新判斷。',
      notifyTenant: false,
    },
  };
  return configs[mode] || configs.landlord_evidence;
}

function repairExceptionSavedMessage(saved) {
  if (!saved) return '';
  return repairExceptionConfig(saved === '1' ? 'landlord_evidence' : saved).success;
}

function landlordDecisionSavedMessage(decision) {
  return ({
    confirm_landlord_repair: '請先建立修繕預約：選處理者、到場時間與備註，再通知房客確認。',
    schedule_created: '已建立修繕預約並通知房客。這只是修繕安排，不代表責任或費用已結清。',
    settlement_saved: '已確認修復結果並保存費用結算。若沒有其他待處理事項，現在可回到案件頁完成結案。',
    tenant_self_repair: '已同意房客代為處理。房客修好後需回傳照片與收據／付款資料，房東確認後才會結案。',
    confirm_tenant_liability: '已通知房客確認處理方案。房客接受後仍需安排修繕或費用結算；房客也可以補件或提出異議。',
    vendor_judgement: '已記錄為等待維修人員判斷。請保存師傅判斷、報價或照片，之後再重新套用規則。',
    ask_tenant_supplement: '已請房客補件。房客補充照片、時間、使用情境或原始物況後，系統會保留紀錄供重新判斷。',
  })[decision] || '';
}

function landlordRepairSchedulePage({ ticket, lineUserId, scope, returnTo = '', slots = [] }) {
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const returnQuery = new URLSearchParams({ lineUserId });
  if (scope) returnQuery.set('scope', scope);
  if (taskReturnUrl) returnQuery.set('returnTo', taskReturnUrl);
  const returnUrl = `/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${returnQuery.toString()}`;
  const sharedSlotOptions = slots.length
    ? slots.map((slot) => `<label class="choice"><input type="radio" name="slotPublicId" value="${escapeHtml(slot.public_id)}" required><span><strong>${escapeHtml(formatDateTime(slot.starts_at))}${slot.ends_at ? ` - ${escapeHtml(formatDateTime(slot.ends_at))}` : ''}</strong><small>房東已開放的可配合時段；選定後會保留給這筆修繕，房客再確認或改期。</small></span></label>`).join('')
    : `<div class="notice"><strong>目前沒有可用時段。</strong><br>請先到看房時段管理新增房東可配合時間；新增後回到本頁即可選作修繕預約。</div>`;
  const availabilityUrl = `/landlordManage?lineUserId=${encodeURIComponent(lineUserId)}`;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>安排修繕 - ${escapeHtml(ticket.unit_label || ticket.public_id)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:760px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:22px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.hint{color:#64748B;font-size:14px;line-height:1.6}.card{border:1px solid #E5E7EB;border-radius:18px;background:#F8FAFC;padding:14px}.row{display:grid;grid-template-columns:88px 1fr;gap:10px;margin:8px 0;font-size:14px}.row span{color:#64748B}.row strong{color:#111827}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.choice{display:block}.choice input{position:absolute;opacity:0;pointer-events:none}.choice span{display:block;border:1px solid #D7DDE7;border-radius:16px;padding:13px;background:#fff;min-height:78px}.choice input:checked+span{border-color:#1F2937;background:#F8FAFC;box-shadow:inset 0 0 0 1px #1F2937}.choice strong{display:block;font-size:16px}.choice small{display:block;margin-top:5px;color:#64748B;line-height:1.45}.field{display:grid;gap:8px;margin-top:14px}.field label{font-weight:800}.field input,.field textarea{width:100%;border:1px solid #CBD5E1;border-radius:14px;padding:12px;font:inherit;background:#fff}.field textarea{min-height:96px;resize:vertical}.quick-notes{display:flex;flex-wrap:wrap;gap:8px}.quick-notes button{border:1px solid #CBD5E1;border-radius:999px;padding:7px 10px;background:#fff;color:#334155;font:inherit;font-size:13px;font-weight:700}.quick-notes button:active{background:#E2E8F0}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px 16px;font:inherit;font-weight:800;background:#1F2937;color:#fff;text-align:center;text-decoration:none}.btn.secondary{background:#E5E7EB;color:#111827}.notice{padding:12px 14px;border-radius:16px;background:#EFF6FF;border:1px solid #93C5FD;color:#1D4ED8;font-size:14px;line-height:1.6}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:18px 16px}.grid{grid-template-columns:1fr}.row{grid-template-columns:78px 1fr}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>修繕執行層</p>
        <h1>安排修繕時間</h1>
      </header>
      <section class="section">
        <div class="card">
          <div class="row"><span>房源</span><strong>${escapeHtml(ticket.unit_label || '租屋物件')}</strong></div>
          <div class="row"><span>報修單</span><strong>${escapeHtml(ticket.public_id)}</strong></div>
          <div class="row"><span>內容</span><strong>${escapeHtml(ticket.description || '尚未提供')}</strong></div>
        </div>
        <p class="hint">這一步只是在約定修繕執行方式與到場時間；不代表責任或費用已結清。</p>
      </section>
      <section class="section">
        <form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/schedule">
          <input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}">
          <input type="hidden" name="scope" value="${escapeHtml(scope)}">
          <input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}">
          <h2>1. 誰來處理</h2>
          <div class="grid">
            <label class="choice"><input type="radio" name="handlerType" value="landlord" checked><span><strong>房東本人處理</strong><small>房東自行到場或親自處理。</small></span></label>
            <label class="choice"><input type="radio" name="handlerType" value="vendor"><span><strong>維修人員／廠商</strong><small>安排師傅到場；可填廠商名稱與電話。</small></span></label>
          </div>
          <div class="field">
            <label for="vendorName">處理者／廠商名稱</label>
            <input id="vendorName" name="vendorName" type="text" placeholder="例如：王先生、XX 水電、房東本人">
          </div>
          <div class="field">
            <label for="vendorPhone">電話（選填）</label>
            <input id="vendorPhone" name="vendorPhone" type="text" placeholder="例如：09xx-xxx-xxx">
          </div>
          <h2 style="margin-top:18px">2. 選擇房東可配合時段</h2>
          <div class="grid">${sharedSlotOptions}</div>
          ${slots.length ? '' : `<div class="actions"><a class="btn secondary" href="${escapeHtml(availabilityUrl)}">前往管理可用時段</a></div>`}
          <div class="field">
            <label for="note">備註</label>
            <div class="quick-notes">
              <button type="button" data-note="需房客在場">需房客在場</button>
              <button type="button" data-note="師傅會先電話聯絡">師傅先電話聯絡</button>
              <button type="button" data-note="可由管理室協助開門">管理室協助開門</button>
            </div>
            <textarea id="note" name="note" placeholder="例如：需房客在場、可否開門、師傅會先電話聯絡。"></textarea>
          </div>
          <div class="notice">時段與看房預約共用。送出後會通知房客確認；房客若希望改期，原時段會釋出，並由房客從同一批可用時段重新選擇。</div>
          <div class="actions">
            ${slots.length ? '<button class="btn" type="submit">建立預約並通知房客</button>' : ''}
            <a class="btn secondary" href="${escapeHtml(returnUrl)}">← 返回案件詳情</a>
          </div>
        </form>
      </section>
    </section>
  </main>
  <script>
    document.querySelectorAll('[data-note]').forEach((button) => {
      button.addEventListener('click', () => {
        const note = document.getElementById('note');
        const addition = button.dataset.note || '';
        if (!note || !addition) return;
        if (!note.value.includes(addition)) note.value = note.value ? \`\${note.value}；\${addition}\` : addition;
        note.focus();
      });
    });
  </script>
</body>
</html>`;
}

function tenantLiabilityExecutionPage({ ticket, lineUserId, scope, returnTo = '' }) {
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const query = new URLSearchParams({ lineUserId });
  if (scope) query.set('scope', scope);
  if (taskReturnUrl) query.set('returnTo', taskReturnUrl);
  const returnUrl = `/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>選擇修繕方式</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:720px;margin:auto;padding:18px 14px 40px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:13px 14px;border:1px solid #FCD34D;background:#FFFBEB;border-radius:15px;color:#92400E;line-height:1.6}.options{display:grid;gap:12px;margin-top:14px}.option{display:block;border:1px solid #CBD5E1;border-radius:17px;padding:15px;background:#fff;cursor:pointer}.option input{position:absolute;opacity:0}.option:has(input:checked){border-color:#1F2937;background:#F8FAFC;box-shadow:inset 0 0 0 1px #1F2937}.option strong{display:block;font-size:17px}.option small{display:block;margin-top:7px;color:#64748B;line-height:1.55}.actions{display:grid;gap:10px;margin-top:18px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff;text-align:center;text-decoration:none}.btn.secondary{background:#E5E7EB;color:#111827}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border:0;border-radius:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>修繕執行層</p><h1>選擇這次怎麼修</h1></header><section class="section"><div class="notice"><strong>房客已接受本次費用負擔方向。</strong><br>這一步只決定誰實際處理修繕；不會改變房客已接受的責任或付款方向。</div><p>案件：${escapeHtml(ticket.unit_label || ticket.public_id)}</p><form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/execution"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="scope" value="${escapeHtml(scope)}"><input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}"><div class="options"><label class="option"><input type="radio" name="dispatchParty" value="landlord" checked><strong>房東安排修繕</strong><small>由房東本人或安排廠商處理；下一步會建立到場時間，費用仍由房客負擔。</small></label><label class="option"><input type="radio" name="dispatchParty" value="tenant"><strong>授權房客自行修繕</strong><small>房客自行找人修或購買零件；修好後需從外部頁回傳照片、收據／報價與說明，費用仍由房客負擔。</small></label></div><div class="actions"><button class="btn" type="submit">確認修繕方式</button><a class="btn secondary" href="${escapeHtml(returnUrl)}">← 返回案件詳情</a></div></form></section></section></main></body></html>`;
}

function tenantRepairAppointmentPage({ ticket, event, lineUserId, saved = '', slots = [] }) {
  const isConfirmed = event.status === 'scheduled' && ticket.appointment_status === 'confirmed';
  const isReschedule = event.status === 'reschedule_requested';
  const slotOptions = slots.length
    ? slots.map((slot) => `<label class="slot"><input type="radio" name="slotPublicId" value="${escapeHtml(slot.public_id)}"><span>${escapeHtml(formatDateTime(slot.starts_at))}${slot.ends_at ? ` - ${escapeHtml(formatDateTime(slot.ends_at))}` : ''}</span></label>`).join('')
    : '<p class="slot-empty">目前房東尚未提供其他可選時段。你可以留下留言，或稍後再回來選擇。</p>';
  const savedNotice = saved === 'accept'
    ? '已回覆可配合此時段，房東已收到通知。'
    : saved === 'reschedule'
      ? '已送出改期需求與留言；案件會等待可用時段協調功能接入後，再安排新的時間。'
      : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>回覆修繕預約</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:680px;margin:auto;padding:18px 14px 40px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.card{border:1px solid #E5E7EB;border-radius:16px;background:#F8FAFC;padding:14px}.row{display:grid;grid-template-columns:84px 1fr;gap:10px;margin:8px 0;font-size:14px}.row span{color:#64748B}.row strong{line-height:1.55}.notice{padding:12px 14px;border-radius:14px;background:#ECFDF5;border:1px solid #86EFAC;color:#047857;line-height:1.55}.choice{display:grid;gap:10px}.choice label,.slot{display:block;border:1px solid #CBD5E1;border-radius:15px;padding:13px;background:#fff;font-weight:800}.choice input,.slot input{margin-right:8px}.field{display:grid;gap:7px;margin-top:14px}.field label{font-weight:800}.field input,.field textarea{width:100%;border:1px solid #CBD5E1;border-radius:13px;padding:12px;font:inherit}.field textarea{min-height:96px}.slot-panel{margin-top:14px;padding:14px;border:1px solid #93C5FD;border-radius:16px;background:#EFF6FF}.slot-panel[hidden]{display:none}.slot-panel h2{margin:0;font-size:17px}.slot-panel p{color:#1D4ED8;line-height:1.55}.slots{display:grid;gap:9px;margin-top:12px}.slot{background:#fff}.slot-empty{margin:12px 0 0}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.secondary{display:block;text-align:center;text-decoration:none;background:#E5E7EB;color:#111827}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>修繕預約</p><h1>回覆到場時間</h1></header><section class="section"><div class="card"><div class="row"><span>房源</span><strong>${escapeHtml(ticket.unit_label || '租屋物件')}</strong></div><div class="row"><span>處理方式</span><strong>${escapeHtml(event.title || '房東安排修繕')}</strong></div><div class="row"><span>預約時段</span><strong>${escapeHtml(formatDateTime(event.starts_at))} - ${escapeHtml(formatDateTime(event.ends_at))}</strong></div><div class="row"><span>目前狀態</span><strong>${isConfirmed ? '你已確認可配合' : isReschedule ? '已提出改期需求，等待房東重新安排' : '等待你回覆'}</strong></div></div>${savedNotice ? `<p class="notice" style="margin-top:12px">${escapeHtml(savedNotice)}</p>` : ''}</section><section class="section">${isConfirmed || isReschedule ? '<p class="notice">目前回覆已保存。若情況改變，可回到完整案件紀錄查看後續通知。</p>' : `<form method="post" action="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/appointment"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="eventPublicId" value="${escapeHtml(event.public_id)}"><div class="choice"><label><input type="radio" name="response" value="accept" checked>時間可以</label><label><input type="radio" name="response" value="reschedule">希望改時間</label></div><section id="reschedule-slots" class="slot-panel" hidden><h2>選擇房東可配合的新時段</h2><p>直接選一個時段再送出即可；系統會同時釋出原時段並保留新時段。</p><div class="slots">${slotOptions}</div></section><div class="field"><label for="message">給房東的留言（選填）</label><textarea id="message" name="message" placeholder="例如：平日白天需要提前通知，管理室可協助開門。"></textarea></div><div class="actions"><button id="appointment-submit" class="btn" type="submit">送出預約回覆</button></div></form><script>const reschedule=document.querySelector('input[value="reschedule"]');const accept=document.querySelector('input[value="accept"]');const panel=document.querySelector('#reschedule-slots');const submit=document.querySelector('#appointment-submit');const slots=[...document.querySelectorAll('[name="slotPublicId"]')];function sync(){const changing=reschedule.checked;panel.hidden=!changing;slots.forEach(input=>input.required=changing);submit.textContent=changing?'確認新修繕時間':'送出預約回覆';}reschedule.addEventListener('change',sync);accept.addEventListener('change',sync);sync();</script>`}</section><section class="section"><a class="btn secondary" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}">← 返回案件紀錄</a></section></section></main></body></html>`;
}

function landlordRepairSettlementPage({ ticket, lineUserId, scope, returnTo = '', saved = '' }) {
  const completedByLandlordOrVendor = ['landlord', 'vendor'].includes(effectiveDispatchParty(ticket));
  if (completedByLandlordOrVendor) {
    return landlordHandledRepairSettlementPageV2({ ticket, lineUserId, scope, returnTo, saved });
  }
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const backQuery = new URLSearchParams({ lineUserId });
  if (scope) backQuery.set('scope', scope);
  if (taskReturnUrl) backQuery.set('returnTo', taskReturnUrl);
  const tenantReportedCost = Number(ticket.tenant_reported_cost_amount);
  const reportedCostNotice = Number.isFinite(tenantReportedCost)
    ? `<p class="notice" style="background:#EFF6FF;color:#1D4ED8">房客申報金額：NT$ ${tenantReportedCost.toLocaleString('zh-TW')}。請核對修好照片與收據／報價後，再填寫下方最終實際修繕金額。</p>`
    : '';
  const completionNotice = `${reportedCostNotice}${saved ? '<p class="notice">已保存費用結算。若修好照片也已確認，現在可以回案件頁完成結案。</p>' : ''}`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>確認修復與費用</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:700px;margin:auto;padding:18px 14px 42px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:12px 14px;border-radius:14px;background:#FEF3C7;color:#92400E;line-height:1.55}.field{display:grid;gap:7px;margin-top:14px}.field label{font-weight:800}.field input,.field textarea,.field select{width:100%;border:1px solid #CBD5E1;border-radius:13px;padding:12px;font:inherit;background:#fff}.field textarea{min-height:86px}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.secondary{display:block;text-align:center;text-decoration:none;background:#E5E7EB;color:#111827}.check{display:flex;gap:9px;align-items:flex-start;margin-top:16px;line-height:1.55}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>修繕完成後</p><h1>確認修復與費用結算</h1></header><section class="section"><p class="notice">修好不等於已結案。請先確認修復結果、實際金額與付款狀態；完成後才可回案件頁結案。</p>${completionNotice}</section><section class="section"><form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/settlement"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="scope" value="${escapeHtml(scope)}"><input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}"><div class="field"><label for="actualCostAmount">實際修繕金額（元）</label><input id="actualCostAmount" name="actualCostAmount" inputmode="numeric" type="number" min="0" value="${escapeHtml(ticket.actual_cost_amount || '')}" placeholder="若不需要付款可留空"></div><div class="field"><label for="tenantLiabilityAmount">房客應負擔金額（元）</label><input id="tenantLiabilityAmount" name="tenantLiabilityAmount" inputmode="numeric" type="number" min="0" value="${escapeHtml(ticket.tenant_liability_amount || '')}" placeholder="沒有房客負擔請留空"></div><div class="field"><label for="paymentSettlementMethod">付款方式</label><select id="paymentSettlementMethod" name="paymentSettlementMethod"><option value="none">不需要／尚無付款</option><option value="direct_pay">直接支付</option><option value="tenant_prepay_reimburse">房客代墊後請款</option><option value="rent_deduction">租金折抵（需有合法依據）</option><option value="other">其他</option></select></div><div class="field"><label for="settlementStatus">結算狀態</label><select id="settlementStatus" name="settlementStatus"><option value="completed">已完成結算</option><option value="not_required">不需要結算</option><option value="waived">本案免除結算</option></select></div><div class="field"><label for="note">結算說明（選填）</label><textarea id="note" name="note" placeholder="例如：師傅收據已上傳；房東已直接支付。"></textarea></div><label class="check"><input name="repairVerified" type="checkbox" value="yes" required><span>我已查看修好後照片／修復結果。此勾選只確認修復與結算，不改變原租約規則。</span></label><div class="actions"><button class="btn" type="submit">保存結算並回案件確認</button><a class="btn secondary" href="/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${backQuery.toString()}">← 返回案件詳情</a></div></form></section></section></main></body></html>`;
}

// 房東／廠商自己完成的案件，不應套用「房客回傳 → 房東確認或退回」的流程。
// 這裡只補齊存證與費用紀錄，再由房東結案；房客會收到結果通知。
function landlordHandledRepairSettlementPage({ ticket, lineUserId, scope, returnTo = '', saved = '' }) {
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const backQuery = new URLSearchParams({ lineUserId });
  if (scope) backQuery.set('scope', scope);
  if (taskReturnUrl) backQuery.set('returnTo', taskReturnUrl);
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>費用結算與結案</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:700px;margin:auto;padding:18px 14px 42px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:12px 14px;border-radius:14px;background:#ECFDF5;border:1px solid #86EFAC;color:#047857;line-height:1.55}.field{display:grid;gap:7px;margin-top:14px}.field label{font-weight:800}.field input,.field textarea,.field select{width:100%;border:1px solid #CBD5E1;border-radius:13px;padding:12px;font:inherit;background:#fff}.field textarea{min-height:86px}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.secondary{display:block;text-align:center;text-decoration:none;background:#E5E7EB;color:#111827}.check{display:flex;gap:9px;align-items:flex-start;margin-top:16px;line-height:1.55}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>房東／廠商已完成修繕</p><h1>費用結算與結案</h1></header><section class="section"><p class="notice">修好照片與附件已由房東／廠商回傳。這裡只需保存實際金額與付款狀態後結案；不會退回給房客重新確認。</p>${saved ? '<p class="notice">費用結算已保存，現在可回案件頁完成結案。</p>' : ''}</section><section class="section"><form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/settlement"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="scope" value="${escapeHtml(scope)}"><input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}"><div class="field"><label for="actualCostAmount">實際修繕金額（元）</label><input id="actualCostAmount" name="actualCostAmount" inputmode="numeric" type="number" min="0" value="${escapeHtml(ticket.actual_cost_amount || '')}" placeholder="沒有額外費用可填 0"></div><div class="field"><label for="paymentSettlementMethod">付款方式</label><select id="paymentSettlementMethod" name="paymentSettlementMethod"><option value="direct_pay">房東／廠商直接支付</option><option value="none">不需要付款</option><option value="other">其他</option></select></div><div class="field"><label for="settlementStatus">結算狀態</label><select id="settlementStatus" name="settlementStatus"><option value="completed">已完成結算</option><option value="not_required">不需要結算</option><option value="waived">本案免除結算</option></select></div><div class="field"><label for="note">費用／維修說明（選填）</label><textarea id="note" name="note" placeholder="例如：房東本人修復，無額外費用；或師傅收據已上傳並直接支付。"></textarea></div><label class="check"><input name="repairVerified" type="checkbox" value="yes" required><span>我已確認房東／廠商上傳的修好證據，並確認上述費用紀錄。</span></label><div class="actions"><button class="btn" type="submit">保存費用並回案件結案</button><a class="btn secondary" href="/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${backQuery.toString()}">← 返回案件詳情</a></div></form></section></section></main></body></html>`;
}

function landlordHandledRepairSettlementPageV2({ ticket, lineUserId, scope, returnTo = '', saved = '' }) {
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const backQuery = new URLSearchParams({ lineUserId });
  if (scope) backQuery.set('scope', scope);
  if (taskReturnUrl) backQuery.set('returnTo', taskReturnUrl);
  const tenantVerified = String(ticket.repair_verification_status || 'pending') === 'confirmed';
  const savedNotice = saved ? '<p class="notice">費用結算已保存；現在可回案件頁完成結案。</p>' : '';
  const waitingNotice = !tenantVerified
    ? '<section class="section"><p class="notice wait">房東／廠商已上傳修好資料，仍在等待房客查驗。房客確認已修復後，才可填寫費用並結案。</p><a class="btn secondary" href="/landlord/repairs/' + encodeURIComponent(ticket.public_id) + '?' + backQuery.toString() + '">← 返回案件詳情</a></section>'
    : '';
  const form = tenantVerified ? `<section class="section"><form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/settlement"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="scope" value="${escapeHtml(scope)}"><input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}"><div class="field"><label for="actualCostAmount">實際修繕金額（元）</label><input id="actualCostAmount" name="actualCostAmount" inputmode="numeric" type="number" min="0" value="${escapeHtml(ticket.actual_cost_amount || '')}" placeholder="沒有額外費用可填 0"></div><div class="field"><label for="paymentSettlementMethod">付款方式</label><select id="paymentSettlementMethod" name="paymentSettlementMethod"><option value="direct_pay">房東／廠商直接支付</option><option value="none">不需要付款</option><option value="other">其他</option></select></div><div class="field"><label for="settlementStatus">結算狀態</label><select id="settlementStatus" name="settlementStatus"><option value="completed">已完成結算</option><option value="not_required">不需要結算</option><option value="waived">本案免除結算</option></select></div><div class="field"><label for="note">費用／維修說明（選填）</label><textarea id="note" name="note" placeholder="例如：房東本人修復，無額外費用；或師傅收據已上傳並直接支付。"></textarea></div><div class="actions"><button class="btn" type="submit">保存費用並回案件結案</button><a class="btn secondary" href="/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${backQuery.toString()}">← 返回案件詳情</a></div></form></section>` : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>費用結算與結案</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:700px;margin:auto;padding:18px 14px 42px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:12px 14px;border-radius:14px;background:#ECFDF5;border:1px solid #86EFAC;color:#047857;line-height:1.55}.notice.wait{background:#EFF6FF;border-color:#93C5FD;color:#1D4ED8}.field{display:grid;gap:7px;margin-top:14px}.field label{font-weight:800}.field input,.field textarea,.field select{width:100%;border:1px solid #CBD5E1;border-radius:13px;padding:12px;font:inherit;background:#fff}.field textarea{min-height:86px}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.secondary{display:block;text-align:center;text-decoration:none;background:#E5E7EB;color:#111827}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>房東／廠商已完成修繕</p><h1>費用結算與結案</h1></header><section class="section"><p class="notice">${tenantVerified ? '房客已查驗並確認修繕結果。請填寫實際金額與付款狀態後，回案件頁完成結案。' : '修好資料已送出，等待房客查驗修繕結果。'}</p>${savedNotice}</section>${waitingNotice}${form}</section></main></body></html>`;
}

function landlordRepairCompletionPage({ ticket, lineUserId, scope, returnTo = '' }) {
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const backQuery = new URLSearchParams({ lineUserId });
  if (scope) backQuery.set('scope', scope);
  if (taskReturnUrl) backQuery.set('returnTo', taskReturnUrl);
  const completionUrl = `/landlord/repairs/${encodeURIComponent(ticket.public_id)}/completion`;
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>上傳修繕完成資料</title><style>
*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:700px;margin:auto;padding:18px 14px 42px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:12px 14px;border-radius:14px;background:#EFF6FF;color:#1D4ED8;line-height:1.55}.field{display:grid;gap:7px;margin-top:14px}.field label{font-weight:800}.field input,.field textarea{width:100%;border:1px solid #CBD5E1;border-radius:13px;padding:12px;font:inherit;background:#fff}.field textarea{min-height:94px}.upload{border:2px dashed #CBD5E1;border-radius:14px;padding:14px;background:#F8FAFC}.preview{margin-top:8px;color:#64748B;font-size:13px}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.secondary{display:block;text-align:center;text-decoration:none;background:#E5E7EB;color:#111827}.status{margin-top:12px;color:#64748B;font-size:14px}.error{color:#B91C1C}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}}
</style></head><body><main class="page"><section class="shell">
<header class="hero"><p>${escapeHtml(ticket.unit_label || '租屋物件')}</p><h1>上傳修繕完成資料</h1></header>
<section class="section"><p class="notice">請由房東本人或安排的維修人員上傳至少一張修好後照片；可一併附收據、報價與維修說明。送出後會通知房客，接著再確認費用與結案。</p>
<form id="completion-form"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="scope" value="${escapeHtml(scope)}"><input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}">
<div class="field"><label for="completionFiles">修好後照片（至少 1 張）</label><div class="upload"><input id="completionFiles" type="file" accept="image/*,.pdf,.doc,.docx" multiple required><div id="filePreview" class="preview">可附收據／報價檔案，但至少需要一張照片。</div></div></div>
<div class="field"><label for="actualCostAmount">實際修繕金額（元，選填）</label><input id="actualCostAmount" type="number" min="0" inputmode="numeric" placeholder="尚未取得金額可留空"></div>
<div class="field"><label for="message">維修說明（選填）</label><textarea id="message" placeholder="例如：已更換零件；收據已附上。"></textarea></div>
<div class="actions"><button class="btn" type="submit">送出修好證據並通知房客</button><a class="btn secondary" href="/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${backQuery.toString()}">← 返回案件詳情</a></div><p id="status" class="status"></p></form></section>
</section></main><script src="/assets/compressImage.js"></script><script>
const form=document.getElementById('completion-form');
const filesInput=document.getElementById('completionFiles');
const preview=document.getElementById('filePreview');
const status=document.getElementById('status');
function readFile(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,mimeType:file.type,dataUrl:reader.result});reader.onerror=()=>reject(new Error('檔案讀取失敗'));reader.readAsDataURL(file);});}
filesInput.addEventListener('change',()=>{const files=Array.from(filesInput.files||[]);preview.textContent=files.length?('已選 '+files.length+' 個檔案：'+files.map(file=>file.name).join('、')):'可附收據／報價檔案，但至少需要一張照片。';});
form.addEventListener('submit',async event=>{event.preventDefault();const files=Array.from(filesInput.files||[]);if(!files.some(file=>(file.type||'').startsWith('image/'))){status.className='status error';status.textContent='請至少選擇一張修好後照片。';return;}try{status.className='status';status.textContent='正在上傳…';const payload={lineUserId:form.lineUserId.value,scope:form.scope.value,returnTo:form.returnTo.value,actualCostAmount:document.getElementById('actualCostAmount').value,message:document.getElementById('message').value,files:await Promise.all(files.map(async file=>readFile(await compressImage(file))))};const response=await fetch('${completionUrl}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(result.error||'送出失敗');location.href=result.redirectUrl;}catch(error){status.className='status error';status.textContent=error.message||'送出失敗，請稍後再試。';}});
</script></body></html>`;
}

function landlordRepairDetailPage({ ticket, files, updates, lineUserId, scope, identity = null, returnTo = '', exceptionSaved = false, decisionSaved = '' }) {
  const damageCount = files.filter((file) => file.purpose === 'damage_photo').length;
  const supplementCount = files.filter((file) => file.purpose === 'supplement').length;
  const completionCount = files.filter((file) => file.purpose === 'completion_photo').length;
  const missing = safeJsonArray(ticket.ai_missing_info_json);
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const fallbackReturnUrl = `/landlord/repairs?lineUserId=${encodeURIComponent(lineUserId)}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}&status=open`;
  const backUrl = taskReturnUrl || fallbackReturnUrl;
  const action = (next, label, description, tone = '') => {
    const styles = {
      completion: { button: 'background:#ECFDF5;color:#047857;border-color:#6EE7B7', arrow: 'background:#047857;color:#fff' },
      danger: { button: 'background:#FFFBEB;color:#B45309;border-color:#FCD34D', arrow: 'background:#B45309;color:#fff' },
    }[tone] || {};
    return `
    <form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/decision">
      <input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      <input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <button class="decision ${escapeHtml(tone)}" type="submit" style="${styles.button || ''}">
        <span class="arrow" style="${styles.arrow || ''}">→</span>
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(description)}</small>
      </button>
    </form>
  `;
  };
  const assessmentSummary = aiAssessmentSummary(ticket, missing);
  const allowed = resolveAllowedRepairActions({ ...ticket, completion_photo_count: completionCount }, missing);
  const actionIntro = allowed.intro;
  const actionListHtml = allowed.actions
    .map((item) => action(item.key, item.label, item.description, item.tone))
    .join('') || '<p class="muted empty">目前沒有需要房東操作的下一步；請查看完整紀錄。</p>';
  const shouldShowActions = !decisionSaved;
  // 舊案件可能只留下 legacy status；結案畫面仍必須完全不顯示待結算提示。
  const isClosedCase = allowed.state.caseClosed
    || String(ticket.case_status || '') === 'closed'
    || String(ticket.status || '') === 'tenant_confirmed';
  const closedCaseSection = `<section class="section closed-case">
        <h2>案件已結案</h2>
        <div class="closed-summary">
          <strong>✓ 修繕、查驗與費用紀錄已完成</strong>
          <span>${ticket.closed_at ? `結案時間：${escapeHtml(formatDateTime(ticket.closed_at))}。` : '此案件已完成結案，不再提供下一步操作。'} 可繼續查看照片與完整紀錄。</span>
        </div>
      </section>`;
  const tenantReportedCost = Number(ticket.tenant_reported_cost_amount);
  const completedByLandlordOrVendor = ['landlord', 'vendor'].includes(effectiveDispatchParty(ticket));
  const completionReadyNotice = !isClosedCase && allowed.state.repairCompleted && completionCount > 0
    ? completedByLandlordOrVendor
      ? `<div class="flash info">房東／廠商已回傳 ${completionCount} 張修好後照片。請查看下方照片與附件，再填寫費用結算並完成結案。</div>`
      : `<div class="flash info">房客已回傳 ${completionCount} 張修好後照片${Number.isFinite(tenantReportedCost) ? `，並申報 NT$ ${tenantReportedCost.toLocaleString('zh-TW')}` : ''}。請查看下方照片與附件，再選擇確認修好與費用，或退回需重新處理。</div>`
    : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>處理報修 - ${escapeHtml(ticket.unit_label || ticket.public_id)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:860px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:22px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:26px;line-height:1.25}.hero .id{margin-top:8px;color:#E5E7EB;font-size:12px;word-break:break-all}.back{display:inline-flex;align-items:center;justify-content:center;margin-top:12px;padding:9px 14px;border-radius:999px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);color:#fff;text-decoration:none;font-size:13px;font-weight:800}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.section h2{margin:0 0 10px;font-size:20px}.muted{color:#64748B;font-size:14px;line-height:1.65}.flash{margin:14px 16px 0;padding:12px 14px;border-radius:16px;background:#ECFDF5;border:1px solid #A7F3D0;color:#047857;font-size:14px;font-weight:800;line-height:1.55}.flash.info{background:#EFF6FF;border-color:#93C5FD;color:#1D4ED8}.card{border:1px solid #E5E7EB;border-radius:18px;background:#F8FAFC;padding:14px}.row{display:grid;grid-template-columns:96px 1fr;gap:10px;margin:8px 0;font-size:14px}.row span{color:#64748B}.row strong{color:#111827}.rule{border-color:#CBD5E1;background:#fff}.rule h3{margin:0 0 8px;font-size:17px}.rule .badge{display:inline-flex;border-radius:999px;background:#EEF2FF;color:#3730A3;font-size:12px;font-weight:800;padding:4px 10px;margin-left:8px}.assessment-summary{margin:10px 0 12px;border-radius:16px;padding:12px 13px;border:1px solid #CBD5E1;background:#F8FAFC}.assessment-summary strong{display:block;font-size:16px;line-height:1.35;color:#111827}.assessment-summary span{display:block;margin-top:4px;color:#475569;font-size:13px;line-height:1.55}.assessment-summary.ok{background:#F0FDF4;border-color:#86EFAC}.assessment-summary.info{background:#EFF6FF;border-color:#93C5FD}.assessment-summary.warn{background:#FFF8F1;border-color:#FDBA74}.assessment-summary.neutral{background:#F8FAFC;border-color:#CBD5E1}.basis{margin-top:10px;padding:10px 12px;border-radius:14px;background:#F8FAFC;border:1px solid #E5E7EB;color:#334155;font-size:13px;line-height:1.6}.closed-case{background:#F0FDF4}.closed-summary{display:grid;gap:5px;border:1px solid #86EFAC;border-radius:16px;background:#fff;padding:13px;color:#047857}.closed-summary strong{font-size:16px}.closed-summary span{font-size:13px;line-height:1.55}.actions{display:grid;gap:9px}.decision{position:relative;width:100%;border:1px solid #D8DEE8;border-radius:15px;padding:13px 48px 13px 14px;text-align:left;background:#fff;color:#111827;font:inherit;cursor:pointer;box-shadow:none;transition:.15s transform,.15s border-color,.15s background}.decision:active{transform:translateY(1px)}.decision.primary{background:#1F2937;color:#fff;border-color:#1F2937}.decision.info{background:#F8FBFF;color:#1D4ED8;border-color:#93C5FD}.decision.warn{background:#FFF8F1;color:#9A3412;border-color:#FDBA74}.decision.neutral{background:#F8FAFC;color:#334155;border-color:#CBD5E1}.decision strong{display:block;font-size:16px;line-height:1.35}.decision small{display:block;margin-top:4px;font-size:12px;line-height:1.45;opacity:.82}.decision .arrow{position:absolute;right:13px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;background:#1F2937;color:#fff;font-size:16px;font-weight:900}.decision.primary .arrow{background:#fff;color:#1F2937}.decision.info .arrow{background:#1D4ED8;color:#fff}.decision.warn .arrow{background:#C2410C;color:#fff}.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.media{margin:0;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden;background:#fff}.media img,.media video{display:block;width:100%;max-height:320px;object-fit:contain;background:#F1F5F9}.media figcaption{padding:8px 10px;color:#64748B;font-size:12px}.timeline{display:grid;gap:12px}.event{display:grid;grid-template-columns:22px 1fr;gap:10px}.dot{width:18px;height:18px;border-radius:999px;background:#1F2937;margin-top:5px}.event-card{border:1px solid #E5E7EB;border-radius:14px;padding:12px;background:#fff}.event-meta{display:flex;justify-content:space-between;gap:8px;font-size:13px}.event-meta time{color:#94A3B8;font-size:12px}.event-card p{white-space:pre-wrap;line-height:1.55;color:#334155;font-size:14px}.empty{padding:14px;border-radius:14px;background:#F8FAFC}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:20px 16px}.row{grid-template-columns:82px 1fr}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>房東端報修處理</p>
        <h1>${escapeHtml(ticket.unit_label || '租屋物件')}</h1>
        <div class="id">${escapeHtml(ticket.public_id)}</div>
        <div class="id">目前身分：房東 · ${escapeHtml((identity && identity.display_name_cache) || '已綁定 LINE 身分')}</div>
        <a class="back" href="${escapeHtml(backUrl)}">${taskReturnUrl ? '← 返回通知與待辦' : '← 返回正在報修'}</a>
      </header>
      ${exceptionSaved ? `<div class="flash">${escapeHtml(repairExceptionSavedMessage(exceptionSaved))}</div>` : ''}
      ${decisionSaved && !isClosedCase && landlordDecisionSavedMessage(decisionSaved) ? `<div class="flash info">${escapeHtml(landlordDecisionSavedMessage(decisionSaved))}</div>` : ''}
      ${completionReadyNotice}

      <section class="section">
        <div class="card">
          <div class="row"><span>房客</span><strong>${escapeHtml(ticket.tenant_name || '房客')}</strong></div>
          <div class="row"><span>狀態</span><strong>${escapeHtml(statusText(ticket.status, completionCount))}</strong></div>
          <div class="row"><span>通報時間</span><strong>${escapeHtml(formatDateTime(ticket.reported_at))}</strong></div>
          <div class="row"><span>報修內容</span><strong>${escapeHtml(ticket.description || '尚未提供')}</strong></div>
          <div class="row"><span>照片</span><strong>損壞 ${damageCount} 張；補充 ${supplementCount} 張；修好後 ${completionCount} 張</strong></div>
        </div>
      </section>

      <section class="section">
        <h2>合約 / AI 初判</h2>
        <div class="card rule">
          <h3>${escapeHtml(ticket.asset_name || '尚未對應到家具／設備')}<span class="badge">${escapeHtml(aiGuessText(ticket))}</span></h3>
          <div class="assessment-summary ${escapeHtml(assessmentSummary.tone)}">
            <strong>${escapeHtml(assessmentSummary.title)}</strong>
            <span>${escapeHtml(assessmentSummary.body)}</span>
          </div>
          <div class="row"><span>可歸責方</span><strong>${escapeHtml(aiLiabilityText(ticket))}</strong></div>
          <div class="row"><span>處理</span><strong>${escapeHtml(aiExecutorText(ticket))}</strong></div>
          <div class="row"><span>費用</span><strong>${escapeHtml(aiPayerText(ticket))}</strong></div>
          <div class="row"><span>依據</span><strong>${escapeHtml(repairRuleSourceLabel(ticket))}</strong></div>
          <div class="row"><span>待補</span><strong>${escapeHtml(missing.length ? missing.join('、') : '無')}</strong></div>
          <div class="basis">${escapeHtml(ticket.ai_contract_basis_summary || ticket.ai_legal_basis_summary || '目前沒有可直接套用的租約規則，需補資料或建立例外處理紀錄。')}</div>
        </div>
        <p class="muted">系統會先依租約／修繕規則判斷；資訊不足時先補資料，真的例外才留下協商紀錄。</p>
      </section>

      ${isClosedCase ? closedCaseSection : shouldShowActions ? `<section class="section">
        <h2>系統建議下一步</h2>
        <p class="muted">${escapeHtml(actionIntro)}</p>
        <div class="actions">
          ${actionListHtml}
          ${String(ticket.status || '') === 'reported' ? action('landlord_negotiate:dispute', '補充依據／提出異議', '可補充新證據重新判斷；若不採用系統初判，可提出不同修繕或費用方案，通知房客接受、補充或提出異議。', 'neutral') : ''}
        </div>
      </section>` : `<section class="section">
        <h2>已執行下一步</h2>
        <p class="muted">上方藍色訊息是這次操作結果；請等待對方回覆、補件或依完整紀錄追蹤後續狀態。</p>
      </section>`}

      <section class="section"><h2>損壞照片</h2><div class="media-grid">${mediaHtml(files, 'damage_photo')}</div></section>
      <section class="section"><h2>補充附件</h2><div class="media-grid">${mediaHtml(files, 'supplement')}</div></section>
      <section class="section"><h2>修好後照片與費用附件</h2><p class="muted">房客自修時由房客上傳修好照片、收據／報價與說明；房東或廠商處理時，由房東在費用結算頁確認最終金額與付款。</p><div class="media-grid">${mediaHtml(files, 'completion_photo')}</div></section>
      <section class="section"><h2>完整紀錄</h2><div class="timeline">${timelineHtml(updates, files)}</div></section>
    </section>
  </main>
</body>
</html>`;
}

function repairNegotiationUpdates(updates = []) {
  return updates.filter((update) => {
    const message = String(update.message_text || '').trim();
    // 「AI 協商摘要」是案件初判，不是雙方說話內容；協商頁只留真正往來。
    return /^(房東進入異議處理|房東提出補充依據／不同處理方案|房客協商說明：|AI 協商轉述：|房東回覆協商：|房客提出異議：|房東接受目前協商方向|房客於外部協商頁接受目前)/.test(message);
  });
}

function repairNegotiationHistoryHtml(updates = []) {
  const relevant = repairNegotiationUpdates(updates);
  if (!relevant.length) return '<p class="hint">目前尚無先前的協商或異議內容；你送出的第一則方案會從這裡開始保留。</p>';
  return `<div class="thread">${relevant.map((update) => `
    <article class="thread-item">
      <div class="thread-meta"><strong>${escapeHtml(update.actor_name || '系統')}</strong><time>${escapeHtml(formatDateTime(update.created_at))}</time></div>
      <div class="thread-message">${escapeHtml(update.message_text || '').replace(/\n/g, '<br>')}</div>
    </article>`).join('')}</div>`;
}

function landlordRepairExceptionPage({ ticket, updates = [], lineUserId, scope, mode, returnTo = '' }) {
  const pageMode = repairExceptionMode(ticket, mode);
  const config = repairExceptionConfig(pageMode);
  const taskReturnUrl = safeLandlordTaskReturnUrl(returnTo);
  const returnQuery = new URLSearchParams({ lineUserId });
  if (scope) returnQuery.set('scope', scope);
  if (taskReturnUrl) returnQuery.set('returnTo', taskReturnUrl);
  const returnUrl = `/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${returnQuery.toString()}`;
  const reasonOption = (value, label) => `<option value="${escapeHtml(value)}"${value === config.defaultReason ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const hasTenantProposal = repairNegotiationUpdates(updates).some((update) => /^(房客協商說明：|AI 協商轉述：房客表示|房客提出異議：)/.test(String(update.message_text || '').trim()));
  const acceptanceHtml = hasTenantProposal ? `<section class="section"><div class="card"><strong>接受房客目前協商方向</strong><p class="hint" style="margin:8px 0 0">只會保存「接受此協商方向」並通知房客；不會直接改責任、費用或修繕方式。</p><form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/accept-negotiation"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="scope" value="${escapeHtml(scope)}"><input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}"><div class="actions"><button class="btn" type="submit">接受目前方案</button></div></form></div></section>` : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(config.title)} - ${escapeHtml(ticket.unit_label || ticket.public_id)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:760px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:22px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px;line-height:1.25}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.hint{color:#64748B;font-size:14px;line-height:1.6}.card{border:1px solid #E5E7EB;border-radius:18px;background:#F8FAFC;padding:14px}.row{display:grid;grid-template-columns:88px 1fr;gap:10px;margin:8px 0;font-size:14px}.row span{color:#64748B}.row strong{color:#111827}.field{display:grid;gap:8px;margin-top:14px}.field label{font-weight:800}.field select,.field textarea{width:100%;border:1px solid #CBD5E1;border-radius:14px;padding:12px;font:inherit;background:#fff}.field textarea{min-height:128px;resize:vertical}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px 16px;font:inherit;font-weight:800;background:#1F2937;color:#fff;text-align:center;text-decoration:none}.btn.secondary{background:#E5E7EB;color:#111827}.notice{padding:12px 14px;border-radius:16px;background:#FFF7ED;border:1px solid #FDBA74;color:#9A3412;font-size:14px;line-height:1.6}.thread{display:grid;gap:10px}.thread-item{border-left:3px solid #64748B;padding:10px 12px;background:#F8FAFC;border-radius:0 12px 12px 0}.thread-meta{display:flex;justify-content:space-between;gap:12px;font-size:13px}.thread-meta time{color:#64748B;white-space:nowrap}.thread-message{margin-top:7px;font-size:14px;line-height:1.6;white-space:pre-wrap}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.hero{padding:18px 16px}.row{grid-template-columns:78px 1fr}.thread-meta{display:block}.thread-meta time{display:block;margin-top:3px}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>${escapeHtml(config.eyebrow)}</p>
        <h1>${escapeHtml(config.title)}</h1>
      </header>
      <section class="section">
        <div class="card">
          <div class="row"><span>報修單</span><strong>${escapeHtml(ticket.public_id)}</strong></div>
          <div class="row"><span>房客</span><strong>${escapeHtml(ticket.tenant_name || '房客')}</strong></div>
          <div class="row"><span>內容</span><strong>${escapeHtml(ticket.description || '尚未提供')}</strong></div>
        </div>
        <p class="hint">${escapeHtml(config.hint)}</p>
        <div class="notice">${escapeHtml(config.notice)}</div>
      </section>
      ${tenantAiAssessmentHtml(ticket)}
      <section class="section">
        <h2>協商與異議歷程</h2>
        <p class="hint">請先確認雙方先前提出的理由與方案，再送出本次回覆。</p>
        ${repairNegotiationHistoryHtml(updates)}
      </section>
      ${acceptanceHtml}
      <section class="section">
        <form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/exception">
          <input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}">
          <input type="hidden" name="scope" value="${escapeHtml(scope)}">
          <input type="hidden" name="returnTo" value="${escapeHtml(taskReturnUrl)}">
          <input type="hidden" name="mode" value="${escapeHtml(pageMode)}">
          <div class="field">
            <label for="reason">${escapeHtml(config.reasonLabel)}</label>
            <select id="reason" name="reason">
              ${reasonOption('rule_missing', '租約／房源規則沒有對應條款')}
              ${reasonOption('rule_conflicting', '規則或附件內容衝突')}
              ${reasonOption('landlord_evidence', '房東有補充依據或證據')}
              ${reasonOption('landlord_dispute', '房東不同意系統初判，提出不同處理方案')}
              ${reasonOption('tenant_dispute', '房客提出異議，需要回覆')}
              ${reasonOption('other', '其他例外狀況')}
            </select>
          </div>
          <div class="field">
            <label for="message">${escapeHtml(config.messageLabel)}</label>
            <textarea id="message" name="message" required placeholder="例如：目前合約沒有列到此設備，本案先由房東安排檢查；若維修人員判斷為人為損壞，再通知雙方確認費用。"></textarea>
          </div>
          <div class="actions">
            <button class="btn" type="submit">${escapeHtml(config.submitLabel)}</button>
            <a class="btn secondary" href="${escapeHtml(returnUrl)}">取消，返回案件</a>
          </div>
        </form>
      </section>
    </section>
  </main>
</body>
</html>`;
}

function getLandlordRepairIdentity(req, res) {
  const db = getDb();
  const body = req.body || {};
  const lineUserId = String(req.query.lineUserId || body.lineUserId || '').trim();
  const scope = String(req.query.scope || body.scope || '').trim();
  if (!lineUserId) {
    res.status(400).send('<h1>缺少 LINE 使用者資訊</h1><p>請從 LINE 卡片重新開啟。</p>');
    return null;
  }
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity) {
    res.status(404).send('<h1>找不到 LINE 綁定身分</h1>');
    return null;
  }
  return { db, lineUserId, scope, identity, allowDemoScope: scope === 'demo_all' && process.env.NODE_ENV !== 'production' };
}

function landlordAdoptRecommendationPage({ ticket, action, lineUserId, scope }) {
  const query = new URLSearchParams({ lineUserId });
  if (scope) query.set('scope', scope);
  const returnUrl = `/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>採用目前建議</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:680px;margin:auto;padding:18px 14px 40px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 7px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:13px 14px;border:1px solid #86EFAC;border-radius:16px;background:#F0FDF4;color:#166534;line-height:1.6}.card{margin-top:14px;padding:14px;border:1px solid #E5E7EB;border-radius:16px;background:#F8FAFC}.card strong{display:block;font-size:17px}.card p{margin:8px 0 0;color:#475569;line-height:1.6}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px 16px;font:inherit;font-weight:800;background:#1F2937;color:#fff;text-align:center;text-decoration:none}.btn.secondary{background:#E5E7EB;color:#111827}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border:0;border-radius:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>${escapeHtml(ticket.unit_label || '租屋物件')}</p><h1>採用目前建議</h1></header><section class="section"><div class="notice">系統建議只會決定下一步，不會直接扣款、承認責任或結案。</div><div class="card"><strong>${escapeHtml(action.label)}</strong><p>${escapeHtml(action.description)}</p></div><form method="post" action="/landlord/repairs/${encodeURIComponent(ticket.public_id)}/decision"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><input type="hidden" name="scope" value="${escapeHtml(scope)}"><input type="hidden" name="next" value="${escapeHtml(action.key)}"><div class="actions"><button class="btn" type="submit">採用建議並繼續</button><a class="btn secondary" href="${escapeHtml(returnUrl)}">返回案件</a></div></form></section></section></main></body></html>`;
}

router.get('/landlord/repairs/:publicId/adopt-recommendation', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try { return await withCloudLandlordRepair(req, res, async ({ ticket, lineUserId }) => {
      const action = resolveAllowedRepairActions(ticket, safeJsonArray(ticket.ai_missing_info_json)).actions[0];
      if (!action || String(action.key || '').startsWith('landlord_negotiate')) return res.status(409).send('<h1>目前沒有可直接採用的建議</h1>');
      return res.send(landlordAdoptRecommendationPage({ ticket, action, lineUserId, scope: '' }));
    }); } catch (error) { return next(error); }
  }
  const ctx = getLandlordRepairIdentity(req, res);
  if (!ctx) return;
  const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
    return res.status(403).send('<h1>沒有此報修單權限</h1>');
  }
  const action = resolveAllowedRepairActions(ticket, safeJsonArray(ticket.ai_missing_info_json)).actions[0];
  if (!action || String(action.key || '').startsWith('landlord_negotiate')) {
    return res.status(409).send('<h1>目前沒有可直接採用的建議</h1><p>請回到案件查看最新狀態或補充依據。</p>');
  }
  return res.send(landlordAdoptRecommendationPage({ ticket, action, lineUserId: ctx.lineUserId, scope: ctx.scope }));
});

router.get('/landlord/repairs/:publicId', (req, res) => {
  if (driverMode() === 'mysql') {
    return withV2Driver(async (db) => {
      const lineUserId = String(req.query.lineUserId || '').trim();
      const identity = await repairRepositoryAsync.getLineIdentity(db, lineUserId);
      if (!lineUserId) return res.status(400).send('<h1>缺少 LINE 使用者資訊</h1><p>請從 LINE 卡片重新開啟。</p>');
      if (!identity) return res.status(404).send('<h1>找不到 LINE 綁定身分</h1>');
      const ticket = await repairRepositoryAsync.getRepairContext(db, req.params.publicId);
      if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
      if (!await repairRepositoryAsync.canManageRepairTicket(db, ticket.public_id, identity.user_id)) return res.status(403).send('<h1>沒有此報修單權限</h1>');
      const [files, updates] = await Promise.all([
        repairRepositoryAsync.listRepairFiles(db, ticket.public_id),
        repairRepositoryAsync.listRepairUpdates(db, ticket.public_id, 100),
      ]);
      return res.send(landlordRepairDetailPage({ ticket, files, updates, lineUserId, scope: '', identity,
        returnTo: safeLandlordTaskReturnUrl(req.query.returnTo), exceptionSaved: String(req.query.exceptionSaved || '') }));
    }).catch((error) => res.status(500).send(`<h1>讀取案件失敗</h1><p>${escapeHtml(error.message)}</p>`));
  }
  const ctx = getLandlordRepairIdentity(req, res);
  if (!ctx) return;
  const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
    return res.status(403).send('<h1>沒有此報修單權限</h1>');
  }
  const files = repairRepository.listRepairFiles(ctx.db, ticket.public_id);
  const updates = repairRepository.listRepairUpdates(ctx.db, ticket.public_id, 100);
  return res.send(landlordRepairDetailPage({
    ticket,
    files,
    updates,
    lineUserId: ctx.lineUserId,
    scope: ctx.scope,
    identity: ctx.identity,
    returnTo: safeLandlordTaskReturnUrl(req.query.returnTo),
    exceptionSaved: String(req.query.exceptionSaved || ''),
    decisionSaved: String(req.query.decisionSaved || ''),
  }));
});

router.post('/landlord/repairs/:publicId/decision', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudLandlordRepair(req, res, async ({ ticket, lineUserId }) => {
        const nextAction = String(req.body.next || '').trim(); const query = new URLSearchParams({ lineUserId });
        if (nextAction === 'landlord_negotiate' || nextAction.startsWith('landlord_negotiate:')) { query.set('mode', repairExceptionMode(ticket, nextAction.split(':')[1] || '')); return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/exception?${query}`); }
        const pathByAction = { confirm_landlord_repair: 'schedule', choose_tenant_liability_execution: 'execution', settle_repair: 'settlement', landlord_completion_upload: 'completion' };
        if (pathByAction[nextAction]) return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/${pathByAction[nextAction]}?${query}`);
        if (nextAction === 'landlord_confirmed') return res.status(409).send('<h1>請先完成修繕、查驗與費用結算，再結案。</h1>');
        return res.status(400).send('<h1>找不到可執行的處理方式</h1>');
      });
    }
    const ctx = getLandlordRepairIdentity(req, res);
    if (!ctx) return;
    const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
      return res.status(403).send('<h1>沒有此報修單權限</h1>');
    }
    const requestedNext = String(req.body.next || '').trim();
    const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
    if (requestedNext === 'landlord_negotiate' || requestedNext.startsWith('landlord_negotiate:')) {
      const requestedMode = requestedNext.includes(':') ? requestedNext.split(':')[1] : '';
      const mode = repairExceptionMode(ticket, requestedMode);
      const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
      if (ctx.scope) query.set('scope', ctx.scope);
      query.set('mode', mode);
      if (returnTo) query.set('returnTo', returnTo);
      return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/exception?${query.toString()}`);
    }
    if (requestedNext === 'confirm_landlord_repair') {
      const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
      if (ctx.scope) query.set('scope', ctx.scope);
      if (returnTo) query.set('returnTo', returnTo);
      return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/schedule?${query.toString()}`);
    }
    if (requestedNext === 'choose_tenant_liability_execution') {
      const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
      if (ctx.scope) query.set('scope', ctx.scope);
      if (returnTo) query.set('returnTo', returnTo);
      return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/execution?${query.toString()}`);
    }
    if (requestedNext === 'settle_repair') {
      const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
      if (ctx.scope) query.set('scope', ctx.scope);
      if (returnTo) query.set('returnTo', returnTo);
      return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/settlement?${query.toString()}`);
    }
    if (requestedNext === 'landlord_completion_upload') {
      const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
      if (ctx.scope) query.set('scope', ctx.scope);
      if (returnTo) query.set('returnTo', returnTo);
      return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/completion?${query.toString()}`);
    }
    if (requestedNext === 'landlord_confirmed') {
      const repairComplete = String(ticket.repair_status || '') === 'completed';
      // 早期案件只保存 AI 的「無可歸責方」，沒有同步寫入 workflow 欄位；
      // 房東按結案時才以既有的原始判定補齊，不批次改動任何歷史案件。
      const legacyNoLiability = String(ticket.liability_status || '') === 'pending'
        && String(ticket.ai_liability_party || '') === 'none';
      const legacyCompletedAppointment = repairComplete && String(ticket.appointment_status || '') === 'scheduled';
      if (legacyNoLiability || legacyCompletedAppointment) {
        repairRepository.updateRepairWorkflowState(ctx.db, {
          ticketPublicId: ticket.public_id,
          ...(legacyNoLiability ? { liabilityStatus: 'not_required' } : {}),
          ...(legacyCompletedAppointment ? { appointmentStatus: 'completed' } : {}),
        });
      }
      const liabilityResolved = ['confirmed', 'not_required'].includes(String(ticket.liability_status || 'pending')) || legacyNoLiability;
      const settlementResolved = ['completed', 'not_required', 'waived'].includes(String(ticket.settlement_status || 'pending'));
      const verificationResolved = ['confirmed', 'not_required'].includes(String(ticket.repair_verification_status || 'pending'));
      const safetyResolved = ['normal', 'risk_contained'].includes(String(ticket.safety_status || 'normal'));
      const appointmentResolved = ['not_required', 'completed', 'cancelled'].includes(String(ticket.appointment_status || 'not_required')) || legacyCompletedAppointment;
      if (!(repairComplete && liabilityResolved && settlementResolved && verificationResolved && safetyResolved && appointmentResolved && String(ticket.waiting_on || 'none') === 'none')) {
        return res.status(409).send('<h1>尚未符合結案條件</h1><p>修繕、另一方查驗、費用結算、安全狀態與預約都完成後，才能結案。</p>');
      }
    }
    const nextStatus = ({
      rule_decision: ruleDecisionNext(ticket),
      confirm_tenant_liability: 'tenant_pays',
      vendor_judgement: 'vendor_judgement',
      ask_tenant_supplement: 'need_info',
    })[requestedNext] || requestedNext;
    await handleRepairPostback({
      source: { userId: ctx.lineUserId },
      postback: {
        data: `action=repair_update&id=${encodeURIComponent(ticket.public_id)}&next=${encodeURIComponent(nextStatus)}${ctx.scope ? `&scope=${encodeURIComponent(ctx.scope)}` : ''}`,
      },
    }, lineClient);
    if (requestedNext === 'landlord_confirmed') {
      repairRepository.updateRepairWorkflowState(ctx.db, {
        ticketPublicId: ticket.public_id,
        actionOwner: 'none',
        waitingOn: 'none',
        caseStatus: 'closed',
      });
    }
    const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
    if (ctx.scope) query.set('scope', ctx.scope);
    if (returnTo) query.set('returnTo', returnTo);
    query.set('saved', '1');
    query.set('decisionSaved', requestedNext);
    return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`);
  } catch (err) {
    return next(err);
  }
});

router.get('/landlord/repairs/:publicId/execution', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try { return await withCloudLandlordRepair(req, res, async ({ ticket, lineUserId }) => res.send(tenantLiabilityExecutionPage({ ticket, lineUserId, scope: '', returnTo: safeLandlordTaskReturnUrl(req.query.returnTo) }))); }
    catch (error) { return next(error); }
  }
  const ctx = getLandlordRepairIdentity(req, res);
  if (!ctx) return;
  const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
    return res.status(403).send('<h1>沒有此報修單權限</h1>');
  }
  return res.send(tenantLiabilityExecutionPage({
    ticket,
    lineUserId: ctx.lineUserId,
    scope: ctx.scope,
    returnTo: safeLandlordTaskReturnUrl(req.query.returnTo),
  }));
});

router.post('/landlord/repairs/:publicId/execution', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const dispatchParty = String(req.body.dispatchParty || '') === 'tenant' ? 'tenant' : 'landlord';
        if (dispatchParty === 'landlord') {
          await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, liabilityStatus: 'confirmed', dispatchParty: 'landlord', repairStatus: 'awaiting_execution', appointmentStatus: 'pending_schedule', actionOwner: 'landlord', waitingOn: 'none' });
          return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/schedule?lineUserId=${encodeURIComponent(lineUserId)}`);
        }
        await repairRepositoryAsync.changeRepairStatus(db, { ticketPublicId: ticket.public_id, toStatus: 'accepted', messageText: '房東已授權房客自行修繕；房客需回傳修好照片、收據／報價與說明。', createdByUserId: identity.user_id });
        await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, liabilityStatus: 'confirmed', dispatchParty: 'tenant', repairStatus: 'awaiting_execution', appointmentStatus: 'not_required', actionOwner: 'tenant', waitingOn: 'tenant' });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        await notifyTenantForRepairUpdate(db, lineClient, updated, tenantRepairStatusCard({ title: '房東已授權你自行修繕', tag: '自行修繕', ticket: updated, lines: ['費用方向：依已確認方案處理。', '修好後請到外部頁回傳修好照片、收據／報價與維修說明。'], actions: [{ type: 'button', style: 'primary', height: 'sm', color: '#1F2937', action: { type: 'uri', label: '前往回傳修好資料', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(updated.public_id)}?lineUserId=${encodeURIComponent(updated.tenant_line_user_id || '')}`) } }] }), 'tenant_self_repair_authorized');
        return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&decisionSaved=tenant_self_repair`);
      });
    }
    const ctx = getLandlordRepairIdentity(req, res);
    if (!ctx) return;
    const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
      return res.status(403).send('<h1>沒有此報修單權限</h1>');
    }
    const dispatchParty = String(req.body.dispatchParty || '') === 'tenant' ? 'tenant' : 'landlord';
    const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
    if (dispatchParty === 'landlord') {
      repairRepository.updateRepairWorkflowState(ctx.db, {
        ticketPublicId: ticket.public_id,
        liabilityStatus: 'confirmed',
        dispatchParty: 'landlord',
        repairStatus: 'awaiting_execution',
        appointmentStatus: 'pending_schedule',
        actionOwner: 'landlord',
        waitingOn: 'none',
      });
      const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
      if (ctx.scope) query.set('scope', ctx.scope);
      if (returnTo) query.set('returnTo', returnTo);
      return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}/schedule?${query.toString()}`);
    }

    repairRepository.changeRepairStatus(ctx.db, {
      ticketPublicId: ticket.public_id,
      // `tenant_self_repair` is represented by workflow fields below.  The
      // legacy status column only accepts its original lifecycle values.
      toStatus: 'accepted',
      messageText: '房東已授權房客自行修繕；房客需回傳修好照片、收據／報價與說明，費用仍依已確認方案由房客負擔。',
      createdByUserId: ctx.identity.user_id,
    });
    repairRepository.updateRepairWorkflowState(ctx.db, {
      ticketPublicId: ticket.public_id,
      liabilityStatus: 'confirmed',
      dispatchParty: 'tenant',
      repairStatus: 'awaiting_execution',
      appointmentStatus: 'not_required',
      actionOwner: 'tenant',
      waitingOn: 'tenant',
    });
    const updatedTicket = repairRepository.getRepairContext(ctx.db, ticket.public_id) || ticket;
    await notifyTenant(ctx.db, lineClient, updatedTicket, tenantRepairStatusCard({
      title: '房東已授權你自行修繕',
      tag: '自行修繕',
      ticket: updatedTicket,
      lines: [
        '費用方向：依已確認方案由房客負擔。',
        '修好後請到外部頁回傳修好照片、收據／報價與維修說明。',
      ],
      actions: [{
        type: 'button', style: 'primary', height: 'sm', color: '#1F2937',
        action: {
          type: 'uri', label: '前往回傳修好資料',
          uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(updatedTicket.public_id)}?lineUserId=${encodeURIComponent(updatedTicket.tenant_line_user_id || '')}`),
        },
      }],
    }), 'tenant_self_repair_authorized');
    const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
    if (ctx.scope) query.set('scope', ctx.scope);
    if (returnTo) query.set('returnTo', returnTo);
    query.set('decisionSaved', 'tenant_self_repair');
    return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`);
  } catch (error) {
    return next(error);
  }
});

router.get('/landlord/repairs/:publicId/schedule', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try { return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId }) => res.send(landlordRepairSchedulePage({ ticket, lineUserId, scope: '', returnTo: safeLandlordTaskReturnUrl(req.query.returnTo), slots: await repairRepositoryAsync.listAvailableSlotsForRepair(db, ticket.id) }))); }
    catch (error) { return next(error); }
  }
  const ctx = getLandlordRepairIdentity(req, res);
  if (!ctx) return;
  const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
    return res.status(403).send('<h1>沒有此報修單權限</h1>');
  }
  return res.send(landlordRepairSchedulePage({
    ticket,
    lineUserId: ctx.lineUserId,
    scope: ctx.scope,
    returnTo: safeLandlordTaskReturnUrl(req.query.returnTo),
    slots: repairRepository.listAvailableSlotsForRepair(ctx.db, ticket.id),
  }));
});

router.post('/landlord/repairs/:publicId/schedule', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const handlerType = ['landlord', 'vendor'].includes(String(req.body.handlerType || '')) ? String(req.body.handlerType) : 'landlord';
        const vendorName = String(req.body.vendorName || '').trim(); const vendorPhone = String(req.body.vendorPhone || '').trim(); const note = String(req.body.note || '').trim(); const slotPublicId = String(req.body.slotPublicId || '').trim();
        if (!slotPublicId) return res.status(400).send('<h1>請先選擇一個房東可配合時段</h1>');
        let event;
        try { event = await repairRepositoryAsync.createRepairAppointmentFromSharedSlot(db, { title: `修繕預約：${ticket.unit_label || ticket.public_id}`, leaseId: ticket.lease_id, repairTicketId: ticket.id, slotPublicId }); }
        catch (error) { if (String(error.message).includes('slot unavailable')) return res.status(409).send('<h1>這個時段剛被其他預約選走</h1>'); throw error; }
        await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'appointment', fromStatus: ticket.status, toStatus: 'accepted', createdByUserId: identity.user_id, messageText: ['房東提出修繕預約', `處理方式：${handlerType === 'vendor' ? '維修人員／廠商處理' : '房東本人處理'}`, vendorName && `處理者：${vendorName}`, vendorPhone && `電話：${vendorPhone}`, `時間：${formatDateTime(event.starts_at)}${event.ends_at ? ` - ${formatDateTime(event.ends_at)}` : ''}`, note && `備註：${note}`, `預約事件：${event.public_id}`].filter(Boolean).join('\n') });
        if (!['tenant_confirmed', 'cancelled'].includes(ticket.status)) await repairRepositoryAsync.changeRepairStatus(db, { ticketPublicId: ticket.public_id, toStatus: 'accepted', messageText: '已建立修繕預約，等待房客確認時間。', createdByUserId: identity.user_id });
        await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, liabilityStatus: String(ticket.liability_status || '') === 'pending' && String(ticket.ai_liability_party || '') === 'none' ? 'not_required' : ticket.liability_status, dispatchParty: handlerType, repairStatus: 'awaiting_execution', appointmentStatus: 'proposed', actionOwner: 'tenant', waitingOn: 'tenant' });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        await notifyTenantForRepairUpdate(db, lineClient, updated, tenantRepairStatusCard({ title: '房東提出修繕時間', tag: '預約', ticket: updated, lines: [`時間：${formatDateTime(event.starts_at)}${event.ends_at ? ` - ${formatDateTime(event.ends_at)}` : ''}`, vendorName ? `處理者：${vendorName}` : '', '請開啟外部頁確認時間或提出改期。'].filter(Boolean), actions: [{ type: 'button', style: 'primary', height: 'sm', color: '#1F2937', action: { type: 'uri', label: '查看／回覆預約', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(updated.public_id)}/appointment?lineUserId=${encodeURIComponent(updated.tenant_line_user_id || '')}&event=${encodeURIComponent(event.public_id)}`) } }] }), `repair_appointment_${event.public_id}`);
        return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&decisionSaved=schedule_created`);
      });
    }
    const ctx = getLandlordRepairIdentity(req, res);
    if (!ctx) return;
    const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
      return res.status(403).send('<h1>沒有此報修單權限</h1>');
    }

    const requestedHandlerType = String(req.body.handlerType || 'landlord').trim();
    const handlerType = ['landlord', 'vendor'].includes(requestedHandlerType) ? requestedHandlerType : 'landlord';
    const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
    const handlerLabel = ({
      landlord: '房東本人處理',
      vendor: '維修人員／廠商處理',
    })[handlerType] || '房東安排處理';
    const vendorName = String(req.body.vendorName || '').trim();
    const vendorPhone = String(req.body.vendorPhone || '').trim();
    const note = String(req.body.note || '').trim();
    const slotPublicId = String(req.body.slotPublicId || '').trim();
    if (!slotPublicId) return res.status(400).send('<h1>請先選擇一個房東可配合時段</h1>');

    const title = `修繕預約：${ticket.unit_label || ticket.public_id}`;
    let event;
    try {
      event = repairRepository.createRepairAppointmentFromSharedSlot(ctx.db, {
        title,
        leaseId: ticket.lease_id,
        repairTicketId: ticket.id,
        slotPublicId,
      });
    } catch (error) {
      if (String(error.message || '').includes('slot unavailable')) {
        return res.status(409).send('<h1>這個時段剛被其他看房或修繕預約選走</h1><p>請返回後選擇另一個可用時段。</p>');
      }
      throw error;
    }
    repairRepository.addRepairUpdate(ctx.db, {
      repairTicketId: ticket.id,
      updateType: 'appointment',
      fromStatus: ticket.status,
      toStatus: 'accepted',
      messageText: [
        '房東提出修繕預約',
        `處理方式：${handlerLabel}`,
        vendorName ? `處理者：${vendorName}` : '',
        vendorPhone ? `電話：${vendorPhone}` : '',
        `時間：${formatDateTime(event.starts_at)}${event.ends_at ? ` - ${formatDateTime(event.ends_at)}` : ''}`,
        note ? `備註：${note}` : '',
        `預約事件：${event.public_id}`,
      ].filter(Boolean).join('\n'),
      createdByUserId: ctx.identity.user_id,
    });
    if (!['tenant_confirmed', 'cancelled'].includes(ticket.status)) {
      repairRepository.changeRepairStatus(ctx.db, {
        ticketPublicId: ticket.public_id,
        toStatus: 'accepted',
        messageText: '已建立修繕預約，等待房客確認時間；責任與費用仍依後續紀錄處理。',
        createdByUserId: ctx.identity.user_id,
      });
    }
    repairRepository.updateRepairWorkflowState(ctx.db, {
      ticketPublicId: ticket.public_id,
      liabilityStatus: String(ticket.liability_status || '') === 'pending'
        && String(ticket.ai_liability_party || '') === 'none'
        ? 'not_required'
        : ticket.liability_status,
      dispatchParty: handlerType,
      repairStatus: 'awaiting_execution',
      appointmentStatus: 'proposed',
      actionOwner: 'tenant',
      waitingOn: 'tenant',
    });

    const updatedTicket = repairRepository.getRepairContext(ctx.db, ticket.public_id) || ticket;
    await notifyTenant(ctx.db, lineClient, updatedTicket, tenantRepairStatusCard({
      title: '房東提出修繕時間',
      tag: '預約',
      ticket: updatedTicket,
      lines: [
        `處理方式：${handlerLabel}`,
        vendorName ? `處理者：${vendorName}` : '',
        vendorPhone ? `電話：${vendorPhone}` : '',
        `時間：${formatDateTime(event.starts_at)}${event.ends_at ? ` - ${formatDateTime(event.ends_at)}` : ''}`,
        note ? `備註：${note}` : '',
        '請開啟外部頁確認時間或提出改期；可一併留下可配合時段與留言。',
      ].filter(Boolean),
      actions: [
        {
          type: 'button', style: 'primary', height: 'sm', color: '#1F2937',
          action: {
            type: 'uri',
            label: '查看／回覆預約',
            uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(updatedTicket.public_id)}/appointment?lineUserId=${encodeURIComponent(updatedTicket.tenant_line_user_id || '')}&event=${encodeURIComponent(event.public_id)}`),
          },
        },
      ],
    }), `repair_appointment_${event.public_id}`);

    const query = new URLSearchParams({ lineUserId: ctx.lineUserId, decisionSaved: 'schedule_created' });
    if (ctx.scope) query.set('scope', ctx.scope);
    if (returnTo) query.set('returnTo', returnTo);
    return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`);
  } catch (error) {
    return next(error);
  }
});

router.get('/landlord/repairs/:publicId/completion', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try { return await withCloudLandlordRepair(req, res, async ({ ticket, lineUserId }) => res.send(landlordRepairCompletionPage({ ticket, lineUserId, scope: '', returnTo: safeLandlordTaskReturnUrl(req.query.returnTo) }))); }
    catch (error) { return next(error); }
  }
  const ctx = getLandlordRepairIdentity(req, res);
  if (!ctx) return;
  const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
    return res.status(403).send('<h1>沒有此報修單權限</h1>');
  }
  return res.send(landlordRepairCompletionPage({
    ticket,
    lineUserId: ctx.lineUserId,
    scope: ctx.scope,
    returnTo: safeLandlordTaskReturnUrl(req.query.returnTo),
  }));
});

router.post('/landlord/repairs/:publicId/completion', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const uploads = Array.isArray(req.body.files) ? req.body.files.slice(0, 8) : [];
        const images = uploads.filter((file) => String(file?.mimeType || '').startsWith('image/'));
        if (!images.length) return res.status(400).json({ ok: false, error: '請至少上傳一張修好後照片' });
        const rawActualCost = String(req.body.actualCostAmount ?? '').trim();
        if (rawActualCost && (!Number.isFinite(Number(rawActualCost)) || Number(rawActualCost) < 0)) return res.status(400).json({ ok: false, error: '實際修繕金額格式不正確' });
        const message = String(req.body.message || '').trim();
        const update = await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', fromStatus: ticket.status, toStatus: 'landlord_completed', createdByUserId: identity.user_id, messageText: ['房東／維修人員已上傳修繕完成資料。', message, rawActualCost && `實際修繕金額：NT$ ${Number(rawActualCost).toLocaleString('zh-TW')}`].filter(Boolean).join('\n') });
        for (const upload of uploads) { const file = await saveWebRepairUploadAsync(db, { ...upload, createdByUserId: identity.user_id }); await repairRepositoryAsync.linkFileToRepairUpdate(db, { fileId: file.id, repairUpdateId: update.id, purpose: 'completion_photo' }); }
        await repairRepositoryAsync.changeRepairStatus(db, { ticketPublicId: ticket.public_id, toStatus: 'landlord_completed', messageText: '房東／維修人員已回傳修好後資料，等待房客查驗。', createdByUserId: identity.user_id });
        await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, repairStatus: 'completed', appointmentStatus: ticket.appointment_status === 'confirmed' ? 'completed' : ticket.appointment_status, repairVerificationStatus: 'pending', actionOwner: 'tenant', waitingOn: 'tenant' });
        let updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        if (rawActualCost) updated = await repairRepositoryAsync.recordRepairSettlement(db, { ticketPublicId: ticket.public_id, actualCostAmount: rawActualCost, tenantLiabilityAmount: ticket.tenant_liability_amount, paymentSettlementMethod: ticket.payment_settlement_method || 'none', settlementStatus: 'pending', note: ticket.settlement_note || '', messageText: '已暫存實際修繕金額，待確認費用結算。', createdByUserId: identity.user_id });
        await notifyTenantForRepairUpdate(db, lineClient, updated, tenantRepairStatusCard({ title: '房東已上傳修繕完成資料', tag: '待查驗', ticket: updated, lines: [`已上傳 ${images.length} 張修好後照片。`, '請先查驗修繕結果；確認或回報問題後才會進入費用結算。'], actions: [{ type: 'button', style: 'primary', height: 'sm', color: '#2563EB', action: { type: 'uri', label: '查看並確認修繕結果', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}/verify?lineUserId=${encodeURIComponent(updated.tenant_line_user_id || '')}`) } }] }), `landlord_completion_uploaded_${ticket.public_id}_${Date.now()}`);
        return res.json({ ok: true, redirectUrl: `/landlord/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&completionUploaded=1` });
      });
    }
    const ctx = getLandlordRepairIdentity(req, res);
    if (!ctx) return;
    const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
    if (!ticket) return res.status(404).json({ ok: false, error: '找不到報修單' });
    if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
      return res.status(403).json({ ok: false, error: '沒有此報修單權限' });
    }

    const uploads = Array.isArray(req.body.files) ? req.body.files.slice(0, 8) : [];
    const imageUploads = uploads.filter((file) => String(file?.mimeType || '').startsWith('image/'));
    if (!imageUploads.length) {
      return res.status(400).json({ ok: false, error: '請至少上傳一張修好後照片' });
    }
    const rawActualCost = String(req.body.actualCostAmount ?? '').trim();
    if (rawActualCost && (!Number.isFinite(Number(rawActualCost)) || Number(rawActualCost) < 0)) {
      return res.status(400).json({ ok: false, error: '實際修繕金額格式不正確' });
    }
    const message = String(req.body.message || '').trim();
    const update = repairRepository.addRepairUpdate(ctx.db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      fromStatus: ticket.status,
      toStatus: 'landlord_completed',
      messageText: [
        '房東／維修人員已上傳修繕完成資料。',
        message,
        rawActualCost ? `實際修繕金額：NT$ ${Number(rawActualCost).toLocaleString('zh-TW')}` : '',
      ].filter(Boolean).join('\n'),
      createdByUserId: ctx.identity.user_id,
    });
    for (const upload of uploads) {
      const file = await saveWebRepairUpload(ctx.db, {
        ...upload,
        createdByUserId: ctx.identity.user_id,
      });
      repairRepository.linkFileToRepairUpdate(ctx.db, {
        fileId: file.id,
        repairUpdateId: update.id,
        purpose: 'completion_photo',
      });
    }
    const changed = repairRepository.changeRepairStatus(ctx.db, {
      ticketPublicId: ticket.public_id,
      toStatus: 'landlord_completed',
      messageText: '房東／維修人員已回傳修好後照片與附件，等待房客查驗修復結果。',
      createdByUserId: ctx.identity.user_id,
    });
    repairRepository.updateRepairWorkflowState(ctx.db, {
      ticketPublicId: ticket.public_id,
      repairStatus: 'completed',
      appointmentStatus: ticket.appointment_status === 'confirmed' ? 'completed' : ticket.appointment_status,
      repairVerificationStatus: 'pending',
      actionOwner: 'tenant',
      waitingOn: 'tenant',
    });
    let updatedTicket = repairRepository.getRepairContext(ctx.db, ticket.public_id) || { ...ticket, ...changed };
    if (rawActualCost) {
      updatedTicket = repairRepository.recordRepairSettlement(ctx.db, {
        ticketPublicId: ticket.public_id,
        actualCostAmount: rawActualCost,
        tenantLiabilityAmount: ticket.tenant_liability_amount,
        paymentSettlementMethod: ticket.payment_settlement_method || 'none',
        settlementStatus: 'pending',
        note: ticket.settlement_note || '',
        messageText: '已暫存實際修繕金額，待確認費用結算。',
        createdByUserId: ctx.identity.user_id,
      });
    }
    await notifyTenant(ctx.db, lineClient, updatedTicket, tenantRepairStatusCard({
      title: '房東已上傳修繕完成資料',
      tag: '待結算',
      ticket: updatedTicket,
      lines: [
        `已上傳 ${imageUploads.length} 張修好後照片。`,
        rawActualCost ? `目前填列實際修繕金額：NT$ ${Number(rawActualCost).toLocaleString('zh-TW')}` : '費用尚待確認。',
        '請先查驗修繕結果；確認或回報問題後，才會進入費用結算與結案。',
      ],
      actions: [{
        type: 'button', style: 'primary', height: 'sm', color: '#2563EB',
        action: {
          type: 'uri', label: '查看並確認修繕結果',
          uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}/verify?lineUserId=${encodeURIComponent(updatedTicket.tenant_line_user_id || '')}`),
        },
      }],
    }), `landlord_completion_uploaded_${ticket.public_id}_${Date.now()}`);
    const query = new URLSearchParams({ lineUserId: ctx.lineUserId });
    if (ctx.scope) query.set('scope', ctx.scope);
    const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
    if (returnTo) query.set('returnTo', returnTo);
    query.set('completionUploaded', '1');
    return res.json({
      ok: true,
      redirectUrl: `/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/landlord/repairs/:publicId/settlement', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      return await withCloudLandlordRepair(req, res, async ({ ticket, lineUserId }) => {
        const page = landlordRepairSettlementPage({ ticket, lineUserId, scope: '', returnTo: safeLandlordTaskReturnUrl(req.query.returnTo), saved: String(req.query.saved || '') });
        return res.send(page.replaceAll('完成後才可回案件頁結案。', '符合關案條件時，送出後會直接結案。').replaceAll('現在可回案件頁完成結案。', '本案已直接完成結案。').replaceAll('保存費用並回案件結案', '保存費用並完成結案').replaceAll('保存結算並回案件確認', '保存結算並完成結案'));
      });
    } catch (error) { return next(error); }
  }
  const ctx = getLandlordRepairIdentity(req, res);
  if (!ctx) return;
  const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
    return res.status(403).send('<h1>沒有此報修單權限</h1>');
  }
  const page = landlordRepairSettlementPage({
    ticket,
    lineUserId: ctx.lineUserId,
    scope: ctx.scope,
    returnTo: safeLandlordTaskReturnUrl(req.query.returnTo),
    saved: String(req.query.saved || ''),
  });
  // 結算送出時會依關案條件直接結案；舊模板的「回案件頁結案」不能再誤導使用者。
  return res.send(page
    .replaceAll('完成後才可回案件頁結案。', '符合關案條件時，送出後會直接結案。')
    .replaceAll('現在可回案件頁完成結案。', '本案已直接完成結案。')
    .replaceAll('保存費用並回案件結案', '保存費用並完成結案')
    .replaceAll('保存結算並回案件確認', '保存結算並完成結案'));
});

router.post('/landlord/repairs/:publicId/settlement', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const dispatchParty = effectiveDispatchParty(ticket);
        const tenantMustVerify = dispatchParty !== 'tenant';
        if (tenantMustVerify && String(ticket.repair_verification_status || 'pending') !== 'confirmed') return res.status(409).send('<h1>等待房客查驗修繕結果</h1>');
        if (!tenantMustVerify && String(req.body.repairVerified || '') !== 'yes') return res.status(400).send('<h1>請先確認修復結果</h1>');
        const settled = await repairRepositoryAsync.recordRepairSettlement(db, { ticketPublicId: ticket.public_id, actualCostAmount: req.body.actualCostAmount, tenantLiabilityAmount: req.body.tenantLiabilityAmount, paymentSettlementMethod: String(req.body.paymentSettlementMethod || 'none'), settlementStatus: String(req.body.settlementStatus || 'pending'), note: String(req.body.note || '').trim(), messageText: '房東已更新費用結算。', createdByUserId: identity.user_id });
        await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, repairVerificationStatus: 'confirmed', liabilityStatus: String(ticket.liability_status || '') === 'pending' && String(ticket.ai_liability_party || '') === 'none' ? 'not_required' : ticket.liability_status, appointmentStatus: String(ticket.repair_status || '') === 'completed' && String(ticket.appointment_status || '') === 'scheduled' ? 'completed' : ticket.appointment_status, actionOwner: 'none', waitingOn: 'none' });
        const after = await repairRepositoryAsync.getRepairContext(db, ticket.public_id) || settled;
        const canClose = String(after.repair_status || '') === 'completed' && ['confirmed', 'not_required'].includes(String(after.liability_status || 'pending')) && ['completed', 'not_required', 'waived'].includes(String(after.settlement_status || 'pending')) && ['confirmed', 'not_required'].includes(String(after.repair_verification_status || 'pending')) && ['normal', 'risk_contained'].includes(String(after.safety_status || 'normal')) && ['not_required', 'completed', 'cancelled'].includes(String(after.appointment_status || 'not_required')) && String(after.waiting_on || 'none') === 'none';
        if (canClose) { await repairRepositoryAsync.changeRepairStatus(db, { ticketPublicId: ticket.public_id, toStatus: 'tenant_confirmed', messageText: '房東已確認案件結案。', createdByUserId: identity.user_id }); await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, actionOwner: 'none', waitingOn: 'none', caseStatus: 'closed' }); }
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id) || after;
        await notifyTenantForRepairUpdate(db, lineClient, updated, tenantRepairStatusCard({ title: canClose ? '本案已完成結案' : '修繕結果與費用已更新', tag: canClose ? '已結案' : '結算', ticket: updated, lines: [updated.actual_cost_amount != null ? `實際修繕金額：NT$ ${Number(updated.actual_cost_amount).toLocaleString('zh-TW')}` : '', updated.tenant_liability_amount != null ? `房客應負擔：NT$ ${Number(updated.tenant_liability_amount).toLocaleString('zh-TW')}` : '', '請開啟完整紀錄查看處理與結算資訊。'].filter(Boolean), actions: [{ type: 'button', style: 'primary', height: 'sm', color: '#1F2937', action: { type: 'uri', label: '查看案件', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(updated.public_id)}?lineUserId=${encodeURIComponent(updated.tenant_line_user_id || '')}`) } }] }), `repair_settlement_${ticket.public_id}_${Date.now()}`);
        return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&decisionSaved=${canClose ? 'closed' : 'settlement_saved'}`);
      });
    }
    const ctx = getLandlordRepairIdentity(req, res);
    if (!ctx) return;
    const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
      return res.status(403).send('<h1>沒有此報修單權限</h1>');
    }
    const dispatchParty = effectiveDispatchParty(ticket);
    const tenantMustVerify = dispatchParty !== 'tenant';
    if (tenantMustVerify && String(ticket.repair_verification_status || 'pending') !== 'confirmed') {
      return res.status(409).send('<h1>等待房客查驗修繕結果</h1><p>房東／廠商上傳修好資料後，須由房客確認已修復或回報問題，才能進入費用結算。</p>');
    }
    if (!tenantMustVerify && String(req.body.repairVerified || '') !== 'yes') {
      return res.status(400).send('<h1>請先確認修復結果</h1><p>房客自行修繕時，房東確認修好資料後才能保存費用結算。</p>');
    }
    const settled = repairRepository.recordRepairSettlement(ctx.db, {
      ticketPublicId: ticket.public_id,
      actualCostAmount: req.body.actualCostAmount,
      tenantLiabilityAmount: req.body.tenantLiabilityAmount,
      paymentSettlementMethod: String(req.body.paymentSettlementMethod || 'none'),
      settlementStatus: String(req.body.settlementStatus || 'pending'),
      note: String(req.body.note || '').trim(),
      messageText: '房東已更新費用結算。',
      createdByUserId: ctx.identity.user_id,
    });
    repairRepository.updateRepairWorkflowState(ctx.db, {
      ticketPublicId: ticket.public_id,
      repairVerificationStatus: 'confirmed',
      liabilityStatus: String(ticket.liability_status || '') === 'pending'
        && String(ticket.ai_liability_party || '') === 'none'
        ? 'not_required'
        : ticket.liability_status,
      // 舊預約資料使用 scheduled；修好資料已回傳時，視為該次到場已完成。
      appointmentStatus: String(ticket.repair_status || '') === 'completed'
        && String(ticket.appointment_status || '') === 'scheduled'
        ? 'completed'
        : ticket.appointment_status,
      actionOwner: 'none',
      waitingOn: 'none',
    });
    const afterSettlement = repairRepository.getRepairContext(ctx.db, ticket.public_id) || settled;
    const canCloseImmediately = String(afterSettlement.repair_status || '') === 'completed'
      && ['confirmed', 'not_required'].includes(String(afterSettlement.liability_status || 'pending'))
      && ['completed', 'not_required', 'waived'].includes(String(afterSettlement.settlement_status || 'pending'))
      && ['confirmed', 'not_required'].includes(String(afterSettlement.repair_verification_status || 'pending'))
      && ['normal', 'risk_contained'].includes(String(afterSettlement.safety_status || 'normal'))
      && ['not_required', 'completed', 'cancelled'].includes(String(afterSettlement.appointment_status || 'not_required'))
      && String(afterSettlement.waiting_on || 'none') === 'none';
    if (canCloseImmediately) {
      await handleRepairPostback({
        source: { userId: ctx.lineUserId },
        postback: { data: `action=repair_update&id=${encodeURIComponent(ticket.public_id)}&next=landlord_confirmed${ctx.scope ? `&scope=${encodeURIComponent(ctx.scope)}` : ''}` },
      }, lineClient);
      repairRepository.updateRepairWorkflowState(ctx.db, {
        ticketPublicId: ticket.public_id,
        actionOwner: 'none',
        waitingOn: 'none',
        caseStatus: 'closed',
      });
      const query = new URLSearchParams({ lineUserId: ctx.lineUserId, decisionSaved: 'closed' });
      if (ctx.scope) query.set('scope', ctx.scope);
      const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
      if (returnTo) query.set('returnTo', returnTo);
      return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`);
    }
    await notifyTenant(ctx.db, lineClient, settled, tenantRepairStatusCard({
      title: '修繕結果與費用已更新',
      tag: '結算',
      ticket: settled,
      lines: [
        '房東已確認修復結果，並更新本案費用結算狀態。',
        settled.actual_cost_amount != null ? `實際修繕金額：NT$ ${Number(settled.actual_cost_amount).toLocaleString('zh-TW')}` : '',
        settled.tenant_liability_amount != null ? `房客應負擔：NT$ ${Number(settled.tenant_liability_amount).toLocaleString('zh-TW')}` : '',
        '請開啟完整紀錄查看處理與結算資訊。',
      ].filter(Boolean),
    }), `repair_settlement_${ticket.public_id}_${Date.now()}`);
    const query = new URLSearchParams({ lineUserId: ctx.lineUserId, decisionSaved: 'settlement_saved' });
    if (ctx.scope) query.set('scope', ctx.scope);
    const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
    if (returnTo) query.set('returnTo', returnTo);
    return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`);
  } catch (error) {
    return next(error);
  }
});

router.get('/landlord/repairs/:publicId/exception', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try { return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId }) => res.send(landlordRepairExceptionPage({ ticket, updates: await repairRepositoryAsync.listRepairUpdates(db, ticket.public_id, 100), lineUserId, scope: '', mode: String(req.query.mode || ''), returnTo: safeLandlordTaskReturnUrl(req.query.returnTo) }))); }
    catch (error) { return next(error); }
  }
  const ctx = getLandlordRepairIdentity(req, res);
  if (!ctx) return;
  const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
    return res.status(403).send('<h1>沒有此報修單權限</h1>');
  }
  return res.send(landlordRepairExceptionPage({
    ticket,
    updates: repairRepository.listRepairUpdates(ctx.db, ticket.public_id, 100),
    lineUserId: ctx.lineUserId,
    scope: ctx.scope,
    mode: String(req.query.mode || ''),
    returnTo: safeLandlordTaskReturnUrl(req.query.returnTo),
  }));
});

router.post('/landlord/repairs/:publicId/exception', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const mode = repairExceptionMode(ticket, String(req.body.mode || req.query.mode || ''));
        const config = repairExceptionConfig(mode); const reason = String(req.body.reason || config.defaultReason || 'other').trim(); const message = String(req.body.message || '').trim();
        if (!message) return res.status(400).send(`<h1>請輸入說明</h1><p>${escapeHtml(config.title)}必須留下原因。</p>`);
        const reasonLabel = ({ rule_missing: '租約／房源規則沒有對應條款', rule_conflicting: '規則或附件內容衝突', landlord_evidence: '房東有補充依據或證據', landlord_dispute: '房東不同意系統初判，提出不同處理方案', tenant_dispute: '房客提出異議，需要回覆', other: '其他例外狀況' })[reason] || '其他例外狀況';
        await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', messageText: `${config.updateTitle}\n原因：${reasonLabel}\n說明：${message}`, createdByUserId: identity.user_id });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        if (config.notifyTenant) await notifyTenantForRepairUpdate(db, lineClient, updated, tenantRepairStatusCard({ title: config.updateTitle, tag: mode === 'case_exception' ? '本案' : '異議', ticket: updated, lines: [`原因：${reasonLabel}`, `說明：${message}`, '這不是最終扣款或結案，內容已保存到完整紀錄。'], actions: [{ type: 'button', style: 'primary', height: 'sm', color: '#1F2937', action: { type: 'uri', label: '前往回覆協商', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(updated.public_id)}/supplement?mode=negotiate&lineUserId=${encodeURIComponent(updated.tenant_line_user_id || '')}`) } }] }), `landlord_exception_${mode}_${Date.now()}`);
        return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&exceptionSaved=${encodeURIComponent(mode)}`);
      });
    }
    const ctx = getLandlordRepairIdentity(req, res);
    if (!ctx) return;
    const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
      return res.status(403).send('<h1>沒有此報修單權限</h1>');
    }

    const mode = repairExceptionMode(ticket, String(req.body.mode || req.query.mode || ''));
    const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
    const config = repairExceptionConfig(mode);
    const reason = String(req.body.reason || config.defaultReason || 'other').trim();
    const message = String(req.body.message || '').trim();
    if (!message) {
      return res.status(400).send(`<h1>請輸入說明</h1><p>${escapeHtml(config.title)}必須留下原因，才能保存到完整紀錄。</p>`);
    }
    const reasonLabel = ({
      rule_missing: '租約／房源規則沒有對應條款',
      rule_conflicting: '規則或附件內容衝突',
      landlord_evidence: '房東有補充依據或證據',
      landlord_dispute: '房東不同意系統初判，提出不同處理方案',
      tenant_dispute: '房客提出異議，需要回覆',
      other: '其他例外狀況',
    })[reason] || '其他例外狀況';

    repairRepository.addRepairUpdate(ctx.db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      messageText: `${config.updateTitle}\n原因：${reasonLabel}\n說明：${message}`,
      createdByUserId: ctx.identity.user_id,
    });

    const context = repairRepository.getRepairContext(ctx.db, ticket.public_id) || ticket;
    if (config.notifyTenant) {
      await notifyTenant(ctx.db, lineClient, context, tenantRepairStatusCard({
        title: config.updateTitle,
        tag: mode === 'case_exception' ? '本案' : '異議',
        ticket: context,
        lines: [
          `原因：${reasonLabel}`,
          `說明：${message}`,
          '這不是最終扣款或結案，系統已將內容保存到完整紀錄。',
        ],
        actions: mode === 'dispute' ? [
          {
            type: 'button', style: 'primary', height: 'sm', color: '#1F2937',
            action: { type: 'uri', label: '前往回覆協商', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(context.public_id)}/supplement?mode=negotiate&lineUserId=${encodeURIComponent(context.tenant_line_user_id || '')}`) },
          },
          {
            type: 'button', height: 'sm',
            action: { type: 'uri', label: '查看案件', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(context.public_id)}?lineUserId=${encodeURIComponent(context.tenant_line_user_id || '')}`) },
          },
        ] : [],
      }), `landlord_exception_${mode}_${Date.now()}`);
    }

    const query = new URLSearchParams({ lineUserId: ctx.lineUserId, exceptionSaved: mode });
    if (ctx.scope) query.set('scope', ctx.scope);
    if (returnTo) query.set('returnTo', returnTo);
    return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`);
  } catch (error) {
    return next(error);
  }
});

router.post('/landlord/repairs/:publicId/accept-negotiation', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudLandlordRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const updates = await repairRepositoryAsync.listRepairUpdates(db, ticket.public_id, 100);
        if (!repairNegotiationUpdates(updates).some((update) => /^(房客協商說明：|AI 協商轉述：房客表示|房客提出異議：)/.test(String(update.message_text || '').trim()))) return res.status(409).send('<h1>目前沒有可接受的房客協商方案</h1>');
        await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', messageText: '房東接受目前協商方向；實際責任、費用與修繕安排仍以雙方後續確認為準。', createdByUserId: identity.user_id });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        await notifyTenantForRepairUpdate(db, lineClient, updated, tenantRepairStatusCard({ title: '房東接受目前協商方向', tag: '協商', ticket: updated, lines: ['房東已接受你目前提出的協商方向。', '後續安排會再保存到案件紀錄。'], actions: [{ type: 'button', style: 'primary', height: 'sm', color: '#1F2937', action: { type: 'uri', label: '前往回覆協商', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(updated.public_id)}/supplement?mode=negotiate&lineUserId=${encodeURIComponent(updated.tenant_line_user_id || '')}`) } }] }), `landlord_accept_negotiation_${ticket.public_id}_${Date.now()}`);
        return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&decisionSaved=negotiation_accepted`);
      });
    }
    const ctx = getLandlordRepairIdentity(req, res);
    if (!ctx) return;
    const ticket = repairRepository.getRepairContext(ctx.db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!ctx.allowDemoScope && !repairRepository.canManageRepairTicket(ctx.db, ticket.public_id, ctx.identity.user_id)) {
      return res.status(403).send('<h1>沒有此報修單權限</h1>');
    }
    const hasTenantProposal = repairNegotiationUpdates(repairRepository.listRepairUpdates(ctx.db, ticket.public_id, 100))
      .some((update) => /^(房客協商說明：|AI 協商轉述：房客表示|房客提出異議：)/.test(String(update.message_text || '').trim()));
    if (!hasTenantProposal) return res.status(409).send('<h1>目前沒有可接受的房客協商方案</h1>');
    repairRepository.addRepairUpdate(ctx.db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      messageText: '房東接受目前協商方向；實際責任、費用與修繕安排仍以雙方後續確認為準。',
      createdByUserId: ctx.identity.user_id,
    });
    const context = repairRepository.getRepairContext(ctx.db, ticket.public_id) || ticket;
    await notifyTenant(ctx.db, lineClient, context, tenantRepairStatusCard({
      title: '房東接受目前協商方向',
      tag: '協商',
      ticket: context,
      lines: [
        '房東已接受你目前提出的協商方向。',
        '這不會直接改責任、費用或修繕方式；後續安排會再保存到案件紀錄。',
      ],
      actions: [
        { type: 'button', style: 'primary', height: 'sm', color: '#1F2937', action: { type: 'uri', label: '前往回覆協商', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(context.public_id)}/supplement?mode=negotiate&lineUserId=${encodeURIComponent(context.tenant_line_user_id || '')}`) } },
        { type: 'button', height: 'sm', action: { type: 'uri', label: '查看案件', uri: repairExternalUrl(`/tenant/repairs/${encodeURIComponent(context.public_id)}?lineUserId=${encodeURIComponent(context.tenant_line_user_id || '')}`) } },
      ],
    }), `landlord_accept_negotiation_${ticket.public_id}_${Date.now()}`);
    const query = new URLSearchParams({ lineUserId: ctx.lineUserId, decisionSaved: 'negotiation_accepted' });
    if (ctx.scope) query.set('scope', ctx.scope);
    const returnTo = safeLandlordTaskReturnUrl(req.body.returnTo);
    if (returnTo) query.set('returnTo', returnTo);
    return res.redirect(`/landlord/repairs/${encodeURIComponent(ticket.public_id)}?${query.toString()}`);
  } catch (error) {
    return next(error);
  }
});

router.get('/tenant/repairs/:publicId/verify', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      return await withCloudTenantRepair(req, res, async ({ db, ticket, lineUserId }) => {
        const files = await repairRepositoryAsync.listRepairFiles(db, ticket.public_id, 'completion_photo');
        const photos = mediaHtml(files, 'completion_photo');
        return res.send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>查驗修繕結果</title></head><body><main class="page"><section class="shell"><header class="hero"><p>${escapeHtml(ticket.unit_label || '租屋物件')}</p><h1>查驗修繕結果</h1></header><section class="section"><p>請確認修好照片與說明；確認後才進入費用結算。</p><div class="media-grid">${photos}</div><form method="post"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><textarea name="note" placeholder="補充說明（選填）"></textarea><button name="result" value="confirmed">確認已修復</button><button name="result" value="disputed">修繕結果有問題</button></form></section></section></main></body></html>`);
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const ticket = repairRepository.getRepairContext(db, req.params.publicId);
  const lineUserId = String(req.query.lineUserId || '').trim();
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  if (!identity || Number(identity.user_id) !== Number(ticket.reported_by_user_id)) {
    return res.status(403).send('<h1>沒有此案件的房客權限</h1>');
  }
  const files = repairRepository.listRepairFiles(db, ticket.public_id, 'completion_photo');
  const photos = mediaHtml(files, 'completion_photo');
  return res.send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>查驗修繕結果</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:720px;margin:auto;padding:18px 14px 44px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:12px 14px;border-radius:14px;background:#EFF6FF;color:#1D4ED8;line-height:1.55}.field{display:grid;gap:7px;margin-top:14px}.field textarea{width:100%;min-height:96px;border:1px solid #CBD5E1;border-radius:13px;padding:12px;font:inherit}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff}.btn.danger{background:#B91C1C}.btn.secondary{display:block;text-align:center;text-decoration:none;background:#E5E7EB;color:#111827}.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.media{margin:0;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden}.media img{display:block;width:100%;max-height:300px;object-fit:contain;background:#F1F5F9}.media figcaption{padding:8px;color:#64748B;font-size:12px}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>${escapeHtml(ticket.unit_label || '租屋物件')}</p><h1>查驗修繕結果</h1></header><section class="section"><div class="notice">房東／廠商已上傳修好資料。請查看照片與說明；確認修好後才會進入費用結算，回報有問題則會通知房東補修。</div></section><section class="section"><h2>修好後照片</h2><div class="media-grid">${photos}</div></section><section class="section"><form method="post" action="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/verify"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><div class="field"><label for="note">補充說明（選填）</label><textarea id="note" name="note" placeholder="若修繕結果有問題，請說明仍有哪些狀況。"></textarea></div><div class="actions"><button class="btn" name="result" value="confirmed" type="submit">確認已修復</button><button class="btn danger" name="result" value="disputed" type="submit">修繕結果有問題</button><a class="btn secondary" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}">← 返回完整紀錄</a></div></form></section></section></main></body></html>`);
});

router.post('/tenant/repairs/:publicId/verify', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudTenantRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const result = String(req.body.result || '') === 'confirmed' ? 'confirmed' : 'disputed';
        const note = String(req.body.note || '').trim();
        await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, repairVerificationStatus: result, actionOwner: result === 'disputed' ? 'landlord' : 'none', waitingOn: result === 'disputed' ? 'landlord' : 'payment', disputeScope: result === 'disputed' ? 'repair_result' : null });
        await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', fromStatus: ticket.status, toStatus: ticket.status, createdByUserId: identity.user_id, messageText: result === 'confirmed' ? `房客已確認修繕結果。${note ? ` 補充：${note}` : ''}` : `房客回報修繕結果仍有問題。${note || '請房東查看並確認是否需要補修。'}` });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        await notifyLandlordsForRepairUpdate(db, lineClient, updated, { eventKey: result === 'confirmed' ? 'tenant_repair_verified' : 'tenant_repair_result_disputed', title: result === 'confirmed' ? '房客已確認修繕結果' : '房客回報修繕結果有問題' });
        return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?verified=${result}&lineUserId=${encodeURIComponent(lineUserId)}`);
      });
    }
    const db = getDb();
    const ticket = repairRepository.getRepairContext(db, req.params.publicId);
    const lineUserId = String(req.body.lineUserId || '').trim();
    const identity = repairRepository.getLineIdentity(db, lineUserId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!identity || Number(identity.user_id) !== Number(ticket.reported_by_user_id)) return res.status(403).send('<h1>沒有此案件的房客權限</h1>');
    const result = String(req.body.result || '') === 'confirmed' ? 'confirmed' : 'disputed';
    const note = String(req.body.note || '').trim();
    repairRepository.updateRepairWorkflowState(db, {
      ticketPublicId: ticket.public_id,
      repairVerificationStatus: result,
      actionOwner: 'landlord',
      waitingOn: 'none',
      disputeScope: result === 'disputed' ? 'repair_result' : null,
    });
    repairRepository.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      fromStatus: ticket.status,
      toStatus: ticket.status,
      messageText: result === 'confirmed'
        ? `房客已確認修繕結果。${note ? ` 補充：${note}` : ''}`
        : `房客回報修繕結果仍有問題。${note || '請房東查看並確認是否需要補修。'}`,
      createdByUserId: identity.user_id,
    });
    const updated = repairRepository.getRepairContext(db, ticket.public_id) || ticket;
    await notifyLandlordsRepairUpdate(db, lineClient, updated, { unitLabel: updated.unit_label, tenantName: updated.tenant_name || '房客', fallbackLineUserId: lineUserId }, result === 'confirmed' ? 'tenant_repair_verified' : 'tenant_repair_result_disputed');
    return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?verified=${result}&lineUserId=${encodeURIComponent(lineUserId)}`);
  } catch (error) { return next(error); }
});

function tenantRepairSharedSlotPage({ ticket, lineUserId, slots }) {
  const slotOptions = slots.length
    ? slots.map((slot) => `<label class="slot"><input type="radio" name="slotPublicId" value="${escapeHtml(slot.public_id)}" required><span>${escapeHtml(formatDateTime(slot.starts_at))}${slot.ends_at ? ` - ${escapeHtml(formatDateTime(slot.ends_at))}` : ''}</span></label>`).join('')
    : '<p class="notice">目前房東尚未提供可選時段。請稍後再查看，或透過聯絡房東說明你的可配合時間。</p>';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>選擇新的修繕時間</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:680px;margin:auto;padding:18px 14px 40px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:22px;overflow:hidden}.hero{padding:22px;background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff}.hero p{margin:0 0 6px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:12px 14px;border-radius:14px;background:#EFF6FF;border:1px solid #93C5FD;color:#1D4ED8;line-height:1.55}.slots{display:grid;gap:10px;margin-top:14px}.slot{display:flex;gap:10px;align-items:center;border:1px solid #CBD5E1;border-radius:14px;padding:13px;background:#fff;font-weight:800}.slot input{width:18px;height:18px}.actions{display:grid;gap:10px;margin-top:16px}.btn{border:0;border-radius:14px;padding:14px;font:inherit;font-weight:800;background:#1F2937;color:#fff;text-align:center;text-decoration:none}.btn.secondary{background:#E5E7EB;color:#111827}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}}</style></head><body><main class="page"><section class="shell"><header class="hero"><p>修繕預約改期</p><h1>選擇房東可配合時段</h1></header><section class="section"><p class="notice">這些時段和看房預約共用；選定後會立即占用，其他看房或修繕案件不能再選同一時段。</p>${slots.length ? `<form method="post" action="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/reschedule-slots"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><div class="slots">${slotOptions}</div><div class="actions"><button class="btn" type="submit">確認新修繕時間</button></div></form>` : slotOptions}<div class="actions"><a class="btn secondary" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}">← 返回案件紀錄</a></div></section></section></main></body></html>`;
}

router.get('/tenant/repairs/:publicId/appointment', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      return await withCloudTenantRepair(req, res, async ({ db, ticket, lineUserId }) => {
        const event = await repairRepositoryAsync.getRepairAppointmentEvent(db, ticket.id, String(req.query.event || ''));
        if (!event) return res.status(404).send('<h1>找不到修繕預約</h1>');
        const slots = event.status === 'scheduled' && ticket.appointment_status !== 'confirmed'
          ? await repairRepositoryAsync.listAvailableSlotsForRepair(db, ticket.id) : [];
        return res.send(tenantRepairAppointmentPage({ ticket, event, lineUserId, saved: String(req.query.saved || ''), slots })
          .replaceAll('已提出改期需求，等待房東重新安排', '已提出改期需求，等待可用時段協調')
          .replaceAll('房東會重新安排並通知你。', '後續將由可用時段協調功能通知你。'));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const ticket = repairRepository.getRepairContext(db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  const lineUserId = String(req.query.lineUserId || '').trim();
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity || Number(identity.user_id) !== Number(ticket.reported_by_user_id)) {
    return res.status(403).send('<h1>沒有此預約的房客權限</h1><p>請從房東傳送的預約通知重新開啟。</p>');
  }
  const event = repairRepository.getRepairAppointmentEvent(db, ticket.id, String(req.query.event || ''));
  if (!event) return res.status(404).send('<h1>找不到修繕預約</h1>');
  const page = tenantRepairAppointmentPage({
    ticket,
    event,
    lineUserId,
    saved: String(req.query.saved || ''),
    slots: event.status === 'scheduled' && ticket.appointment_status !== 'confirmed'
      ? repairRepository.listAvailableSlotsForRepair(db, ticket.id)
      : [],
  });
  return res.send(page
    .replaceAll('已提出改期需求，等待房東重新安排', '已提出改期需求，等待可用時段協調')
    .replaceAll('房東會重新安排並通知你。', '後續將由可用時段協調功能通知你。'));
});

router.post('/tenant/repairs/:publicId/appointment', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudTenantRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const eventPublicId = String(req.body.eventPublicId || '').trim();
        const response = String(req.body.response || '') === 'accept' ? 'accept' : 'reschedule';
        const slotPublicId = String(req.body.slotPublicId || '').trim();
        if (response === 'reschedule' && !slotPublicId) return res.status(400).send('<h1>請先選擇房東可配合的新時段</h1>');
        let event;
        try {
          event = response === 'reschedule'
            ? await repairRepositoryAsync.rescheduleRepairAppointmentToSharedSlot(db, { repairTicketId: ticket.id, leaseId: ticket.lease_id, eventPublicId, slotPublicId, title: `修繕預約：${ticket.unit_label || ticket.public_id}` })
            : await repairRepositoryAsync.respondToRepairAppointmentEvent(db, { repairTicketId: ticket.id, eventPublicId, response });
        } catch (error) {
          if (String(error.message).includes('slot unavailable')) return res.status(409).send('<h1>此時段剛被其他預約選走</h1>');
          throw error;
        }
        await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, repairStatus: 'awaiting_execution', appointmentStatus: 'confirmed', actionOwner: 'none', waitingOn: 'appointment_time', disputeScope: null });
        await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'appointment', fromStatus: ticket.status, toStatus: ticket.status, createdByUserId: identity.user_id, messageText: response === 'accept' ? '房客確認可配合目前修繕時段。' : `房客已選定新的修繕時間：${event.starts_at}${event.ends_at ? ` - ${event.ends_at}` : ''}` });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        await notifyLandlordsForRepairUpdate(db, lineClient, updated, { eventKey: response === 'accept' ? 'tenant_appointment_accept' : 'tenant_appointment_rescheduled', title: '房客已回覆修繕預約' });
        return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&appointmentSelected=1`);
      });
    }
    const db = getDb();
    const ticket = repairRepository.getRepairContext(db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    const lineUserId = String(req.body.lineUserId || '').trim();
    const identity = repairRepository.getLineIdentity(db, lineUserId);
    if (!identity || Number(identity.user_id) !== Number(ticket.reported_by_user_id)) {
      return res.status(403).send('<h1>沒有此預約的房客權限</h1>');
    }
    const eventPublicId = String(req.body.eventPublicId || '').trim();
    const response = String(req.body.response || '').trim() === 'accept' ? 'accept' : 'reschedule';
    const message = String(req.body.message || '').trim();
    const slotPublicId = String(req.body.slotPublicId || '').trim();
    if (response === 'reschedule' && !slotPublicId) {
      return res.status(400).send('<h1>請先選擇房東可配合的新時段</h1><p>選擇後系統才會釋出原本時段。</p>');
    }
    let event;
    try {
      event = response === 'reschedule'
        ? repairRepository.rescheduleRepairAppointmentToSharedSlot(db, {
          repairTicketId: ticket.id,
          leaseId: ticket.lease_id,
          eventPublicId,
          slotPublicId,
          title: `修繕預約：${ticket.unit_label || ticket.public_id}`,
        })
        : repairRepository.respondToRepairAppointmentEvent(db, {
          repairTicketId: ticket.id,
          eventPublicId,
          response,
        });
    } catch (error) {
      if (String(error.message || '').includes('slot unavailable')) {
        return res.status(409).send('<h1>此時段剛被其他預約選走</h1><p>請返回後選擇其他房東可配合時段；原本預約仍保留。</p>');
      }
      throw error;
    }
    repairRepository.updateRepairWorkflowState(db, {
      ticketPublicId: ticket.public_id,
      repairStatus: 'awaiting_execution',
      appointmentStatus: 'confirmed',
      actionOwner: 'none',
      waitingOn: 'appointment_time',
      disputeScope: null,
    });
    const responseText = response === 'accept'
      ? '房客確認可配合目前修繕時段。'
      : `房客已從房東可配合時段選定新的修繕時間：${event.starts_at}${event.ends_at ? ` - ${event.ends_at}` : ''}${message ? `。留言：${message}` : ''}`;
    repairRepository.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'appointment',
      fromStatus: ticket.status,
      toStatus: ticket.status,
      messageText: responseText,
      createdByUserId: identity.user_id,
    });
    const updatedTicket = repairRepository.getRepairContext(db, ticket.public_id) || ticket;
    await notifyLandlordsRepairUpdate(db, lineClient, updatedTicket, {
      unitLabel: updatedTicket.unit_label,
      tenantName: updatedTicket.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: lineUserId,
    }, response === 'accept' ? 'tenant_appointment_accept' : 'tenant_appointment_rescheduled');
    if (response === 'reschedule') return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&appointmentSelected=1`);
    return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}/appointment?lineUserId=${encodeURIComponent(lineUserId)}&event=${encodeURIComponent(event.public_id)}&saved=accept`);
  } catch (error) {
    return next(error);
  }
});

router.get('/tenant/repairs/:publicId/reschedule-slots', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      return await withCloudTenantRepair(req, res, async ({ db, ticket, lineUserId }) => {
        if (String(ticket.appointment_status || '') !== 'reschedule_requested') return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}`);
        return res.send(tenantRepairSharedSlotPage({ ticket, lineUserId, slots: await repairRepositoryAsync.listAvailableSlotsForRepair(db, ticket.id) }));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const ticket = repairRepository.getRepairContext(db, req.params.publicId);
  if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
  const lineUserId = String(req.query.lineUserId || '').trim();
  const identity = repairRepository.getLineIdentity(db, lineUserId);
  if (!identity || Number(identity.user_id) !== Number(ticket.reported_by_user_id)) {
    return res.status(403).send('<h1>沒有此修繕預約的房客權限</h1>');
  }
  if (String(ticket.appointment_status || '') !== 'reschedule_requested') {
    return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}`);
  }
  return res.send(tenantRepairSharedSlotPage({
    ticket,
    lineUserId,
    slots: repairRepository.listAvailableSlotsForRepair(db, ticket.id),
  }));
});

router.post('/tenant/repairs/:publicId/reschedule-slots', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withCloudTenantRepair(req, res, async ({ db, ticket, lineUserId, identity }) => {
        const slotPublicId = String(req.body.slotPublicId || '').trim();
        if (!slotPublicId) return res.status(400).send('<h1>請選擇一個可配合時段</h1>');
        let event;
        try { event = await repairRepositoryAsync.createRepairAppointmentFromSharedSlot(db, { repairTicketId: ticket.id, leaseId: ticket.lease_id, slotPublicId, title: `修繕預約：${ticket.unit_label || ticket.public_id}` }); }
        catch (error) { if (String(error.message).includes('slot unavailable')) return res.status(409).send('<h1>此時段剛被其他預約選走</h1>'); throw error; }
        await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, repairStatus: 'awaiting_execution', appointmentStatus: 'confirmed', actionOwner: 'none', waitingOn: 'appointment_time', disputeScope: null });
        await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'appointment', createdByUserId: identity.user_id, messageText: `房客已選定新的修繕時間：${event.starts_at}${event.ends_at ? ` - ${event.ends_at}` : ''}` });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id);
        await notifyLandlordsForRepairUpdate(db, lineClient, updated, { eventKey: 'tenant_appointment_accept', title: '房客已確認新的修繕時間' });
        return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&appointmentSelected=1`);
      });
    }
    const db = getDb();
    const ticket = repairRepository.getRepairContext(db, req.params.publicId);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    const lineUserId = String(req.body.lineUserId || '').trim();
    const identity = repairRepository.getLineIdentity(db, lineUserId);
    if (!identity || Number(identity.user_id) !== Number(ticket.reported_by_user_id)) {
      return res.status(403).send('<h1>沒有此修繕預約的房客權限</h1>');
    }
    const slotPublicId = String(req.body.slotPublicId || '').trim();
    if (!slotPublicId) return res.status(400).send('<h1>請選擇一個可配合時段</h1>');
    let event;
    try {
      event = repairRepository.createRepairAppointmentFromSharedSlot(db, {
        repairTicketId: ticket.id,
        leaseId: ticket.lease_id,
        slotPublicId,
        title: `修繕預約：${ticket.unit_label || ticket.public_id}`,
      });
    } catch (error) {
      if (String(error.message || '').includes('slot unavailable')) {
        return res.status(409).send('<h1>此時段剛被其他預約選走</h1><p>請返回後選擇其他可用時段。</p>');
      }
      throw error;
    }
    repairRepository.updateRepairWorkflowState(db, {
      ticketPublicId: ticket.public_id,
      repairStatus: 'awaiting_execution',
      appointmentStatus: 'confirmed',
      actionOwner: 'none',
      waitingOn: 'appointment_time',
      disputeScope: null,
    });
    repairRepository.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'appointment',
      fromStatus: ticket.status,
      toStatus: ticket.status,
      messageText: `房客已從房東可用時段選定新的修繕時間：${event.starts_at}${event.ends_at ? ` - ${event.ends_at}` : ''}。`,
      createdByUserId: identity.user_id,
    });
    const updatedTicket = repairRepository.getRepairContext(db, ticket.public_id) || ticket;
    await notifyLandlordsRepairUpdate(db, lineClient, updatedTicket, {
      unitLabel: updatedTicket.unit_label,
      tenantName: updatedTicket.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: lineUserId,
    }, 'tenant_appointment_accept');
    return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&appointmentSelected=1`);
  } catch (error) {
    return next(error);
  }
});

function tenantContactLandlordPage(ticket, lineUserId) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>緊急聯絡房東</title><style>*{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:680px;margin:auto;padding:18px 14px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:20px;overflow:hidden}.hero{padding:22px;background:#7F1D1D;color:#fff}.hero h1{margin:0;font-size:25px}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.notice{padding:12px 14px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:14px;color:#991B1B;line-height:1.55}.field{display:grid;gap:8px;margin-top:14px;font-weight:800}.field textarea{min-height:130px;width:100%;padding:12px;border:1px solid #CBD5E1;border-radius:14px;font:inherit}.btn{width:100%;margin-top:16px;border:0;border-radius:14px;padding:14px;background:#1F2937;color:#fff;font:inherit;font-weight:800}.back{display:block;margin-top:10px;text-align:center;color:#475569;text-decoration:none}</style></head><body><main class="page"><section class="shell"><header class="hero"><h1>傳訊息給房東</h1></header><section class="section"><p class="notice">這則訊息會立即通知房東，並保留在本次緊急報修的完整紀錄。若有立即危險，請同時使用撥號或聯絡緊急專業人員。</p><form method="post"><input type="hidden" name="lineUserId" value="${escapeHtml(lineUserId)}"><label class="field">緊急情況／需要房東協助的內容<textarea name="message" required placeholder="例如：瓦斯味持續，已關閉總開關，請立即聯絡我。"></textarea></label><button class="btn" type="submit">送出並通知房東</button></form><a class="back" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}">返回案件紀錄</a></section></section></main></body></html>`;
}

// MySQL/TiDB 下不可再呼叫同步的 getLandlordRepairIdentity：它會偷偷開本機 SQLite，
// 造成「卡片收到、外頁卻說沒有權限」的分裂。所有報修動作共用這兩個驗證入口。
async function withCloudTenantRepair(req, res, fn) {
  const lineUserId = String(req.query.lineUserId || req.body?.lineUserId || '').trim();
  return withV2Driver(async (db) => {
    const [identity, ticket] = await Promise.all([
      repairRepositoryAsync.getLineIdentity(db, lineUserId),
      repairRepositoryAsync.getRepairContext(db, req.params.publicId),
    ]);
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!identity || Number(identity.user_id) !== Number(ticket.tenant_user_id || ticket.reported_by_user_id)) {
      return res.status(403).send('<h1>沒有此案件的房客權限</h1><p>請從 LINE 通知或報修進度開啟。</p>');
    }
    return fn({ db, lineUserId, identity, ticket });
  });
}

async function withCloudLandlordRepair(req, res, fn) {
  const lineUserId = String(req.query.lineUserId || req.body?.lineUserId || '').trim();
  return withV2Driver(async (db) => {
    const [identity, ticket] = await Promise.all([
      repairRepositoryAsync.getLineIdentity(db, lineUserId),
      repairRepositoryAsync.getRepairContext(db, req.params.publicId),
    ]);
    if (!lineUserId) return res.status(400).send('<h1>缺少 LINE 使用者資訊</h1>');
    if (!identity) return res.status(404).send('<h1>找不到 LINE 綁定身分</h1>');
    if (!ticket) return res.status(404).send('<h1>找不到報修單</h1>');
    if (!await repairRepositoryAsync.canManageRepairTicket(db, ticket.public_id, identity.user_id)) return res.status(403).send('<h1>沒有此報修單權限</h1>');
    return fn({ db, lineUserId, identity, ticket, scope: '' });
  });
}

router.get('/tenant/repairs/:publicId/contact-landlord', async (req, res, next) => {
  if (driverMode() === 'mysql') {
    try {
      return await withV2Driver(async (db) => {
        const lineUserId = String(req.query.lineUserId || '').trim();
        const [ticket, identity] = await Promise.all([repairRepositoryAsync.getRepairContext(db, req.params.publicId), repairRepositoryAsync.getLineIdentity(db, lineUserId)]);
        if (!ticket || !identity || Number(ticket.tenant_user_id || ticket.reported_by_user_id) !== Number(identity.user_id)) return res.status(403).send('<h1>無法開啟聯絡房東</h1><p>請從自己的緊急報修卡片重新開啟。</p>');
        return res.send(tenantContactLandlordPage(ticket, lineUserId));
      });
    } catch (error) { return next(error); }
  }
  const db = getDb();
  const lineUserId = String(req.query.lineUserId || '').trim();
  const ticket = repairRepository.getRepairContext(db, req.params.publicId);
  const identity = lineUserId ? repairRepository.getLineIdentity(db, lineUserId) : null;
  if (!ticket || !identity || Number(ticket.tenant_user_id || ticket.reported_by_user_id) !== Number(identity.user_id)) {
    return res.status(403).send('<h1>無法開啟聯絡房東</h1><p>請從自己的緊急報修卡片重新開啟。</p>');
  }
  return res.send(tenantContactLandlordPage(ticket, lineUserId));
});

router.post('/tenant/repairs/:publicId/contact-landlord', async (req, res, next) => {
  try {
    if (driverMode() === 'mysql') {
      return await withV2Driver(async (db) => {
        const lineUserId = String(req.body.lineUserId || '').trim();
        const message = String(req.body.message || '').trim();
        const [ticket, identity] = await Promise.all([repairRepositoryAsync.getRepairContext(db, req.params.publicId), repairRepositoryAsync.getLineIdentity(db, lineUserId)]);
        if (!ticket || !identity || Number(ticket.tenant_user_id || ticket.reported_by_user_id) !== Number(identity.user_id)) return res.status(403).send('<h1>沒有此案件權限</h1>');
        if (!message) return res.status(400).send('<h1>請輸入要傳給房東的內容</h1>');
        const update = await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', fromStatus: ticket.status, toStatus: ticket.status, messageText: `房客緊急訊息：${message}`, createdByUserId: identity.user_id });
        const updated = await repairRepositoryAsync.getRepairContext(db, ticket.public_id) || ticket;
        await notifyLandlordsForRepairUpdate(db, lineClient, updated, { eventKey: `urgent_tenant_contact_${update.public_id}`, title: '🚨 房客要求緊急聯絡', subtitle: '請立即開啟外部頁查看並聯絡房客。', tag: '緊急', summary: `房客緊急訊息：${message}` });
        return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&contactedLandlord=1`);
      });
    }
    const db = getDb();
    const lineUserId = String(req.body.lineUserId || '').trim();
    const message = String(req.body.message || '').trim();
    const ticket = repairRepository.getRepairContext(db, req.params.publicId);
    const identity = lineUserId ? repairRepository.getLineIdentity(db, lineUserId) : null;
    if (!ticket || !identity || Number(ticket.tenant_user_id || ticket.reported_by_user_id) !== Number(identity.user_id)) return res.status(403).send('<h1>沒有此案件權限</h1>');
    if (!message) return res.status(400).send('<h1>請輸入要傳給房東的內容</h1>');
    repairRepository.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'urgent_message', fromStatus: ticket.status, toStatus: ticket.status, messageText: `房客緊急訊息：${message}`, createdByUserId: identity.user_id });
    const updated = repairRepository.getRepairContext(db, ticket.public_id) || ticket;
    await notifyLandlordsRepairUpdate(db, lineClient, updated, { unitLabel: updated.unit_label, tenantName: updated.tenant_name || identity.display_name_cache || '房客', fallbackLineUserId: lineUserId, messageText: `房客緊急訊息：${message}` }, 'urgent_tenant_contact');
    return res.redirect(`/tenant/repairs/${encodeURIComponent(ticket.public_id)}?lineUserId=${encodeURIComponent(lineUserId)}&contactedLandlord=1`);
  } catch (error) { return next(error); }
});

async function renderTenantRepairDetail(req, res, preloaded = null) {
  const db = preloaded?.db || getDb();
  const ticket = preloaded?.ticket || repairRepository.getRepairContext(db, req.params.publicId);

  if (!ticket) {
    return res.status(404).send('<h1>找不到此報修紀錄</h1>');
  }

  const files = preloaded?.files || repairRepository.listRepairFiles(db, ticket.public_id);
  const updates = preloaded?.updates || repairRepository.listRepairUpdates(db, ticket.public_id, 100);
  const damageCount = files.filter((file) => file.purpose === 'damage_photo').length;
  const completionCount = files.filter((file) => file.purpose === 'completion_photo').length;
  const title = ticket.unit_label || '租屋物件';
  const created = String(req.query.created || '') === '1';
  const urgent = ['urgent', 'emergency'].includes(String(ticket.ai_risk_level || ticket.risk_level || ticket.priority || '').toLowerCase());
  const landlordPhone = String(ticket.landlord_phone || '').replace(/[^0-9+]/g, '');
  const tenantLineUserId = String(req.query.lineUserId || ticket.tenant_line_user_id || '').trim();
  const dispatchParty = effectiveDispatchParty(ticket);
  const tenantIsRepairHandler = String(ticket.status || '') === 'tenant_self_repair' || dispatchParty === 'tenant';
  const latestAppointment = ['proposed', 'reschedule_requested'].includes(String(ticket.appointment_status || ''))
    ? (preloaded?.latestAppointment !== undefined ? preloaded.latestAppointment : repairRepository.getRepairAppointmentEvent(db, ticket.id, ''))
    : null;
  const needsCompletionUpload = tenantIsRepairHandler
    && ['awaiting_execution', 'in_progress'].includes(String(ticket.repair_status || ''))
    && String(ticket.action_owner || '') === 'tenant'
    && completionCount === 0;
  const urgentContactHtml = urgent ? `<section class="section"><div class="stat" style="border-color:#FCA5A5;background:#FEF2F2"><strong style="color:#B91C1C">緊急安全事件：請先停止使用並遠離危險區域</strong><p class="muted" style="margin:7px 0 0">系統已通知房東；危險解除前不等待責任或費用判斷。</p>${landlordPhone ? `<a class="file-link" style="margin-top:10px;background:#B91C1C;color:#fff;border:0;text-align:center;font-weight:800" href="tel:${escapeHtml(landlordPhone)}">立即聯絡房東${ticket.landlord_name ? `（${escapeHtml(ticket.landlord_name)}）` : ''}</a>` : '<p class="muted" style="margin:7px 0 0">目前未提供房東電話，請先依安全指引聯絡緊急專業人員。</p>'}</div></section>` : '';
  const completionActionHtml = needsCompletionUpload ? `<section class="section"><div class="stat" style="border-color:#BFDBFE;background:#EFF6FF"><strong style="color:#1D4ED8">下一步：回傳修好後照片</strong><p class="muted" style="margin:7px 0 0">請上傳至少一張修好後照片；若有收據、報價或維修說明也可一併附上。房東確認後才會結案。</p><a class="file-link" style="margin-top:12px;background:#1F2937;color:#fff;border:0;text-align:center;font-weight:800" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/supplement?mode=completion&lineUserId=${encodeURIComponent(tenantLineUserId)}">回傳修好照片</a></div></section>` : '';
  const supplementItems = safeJsonArray(ticket.ai_missing_info_json);
  const needsSupplement = String(ticket.action_owner || '') === 'tenant'
    && String(ticket.waiting_on || '') === 'tenant'
    && String(ticket.appointment_status || '') !== 'proposed'
    && !tenantIsRepairHandler
    && String(ticket.liability_status || '') !== 'proposed'
    && String(ticket.repair_status || '') !== 'completed';
  const supplementActionHtml = needsSupplement ? `<section class="section"><div class="stat" style="border-color:#FBBF24;background:#FFFBEB"><strong style="color:#92400E">房東請你補充報修資料</strong><p class="muted" style="margin:7px 0 0">${supplementItems.length ? `請補充：${escapeHtml(supplementItems.join('、'))}。` : '請補充照片、發生時間、使用情境或其他可協助判斷的資料。'} 補件送出後，系統會重新整理案件初判並通知房東。</p><a class="file-link" style="margin-top:12px;background:#1F2937;color:#fff;border:0;text-align:center;font-weight:800" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/supplement?lineUserId=${encodeURIComponent(tenantLineUserId)}">前往補充資料</a></div></section>` : '';
  const appointmentActionHtml = String(ticket.appointment_status || '') === 'reschedule_requested'
    ? `<section class="section"><div class="stat" style="border-color:#93C5FD;background:#EFF6FF"><strong style="color:#1D4ED8">請從房東可用時段選擇新時間</strong><p class="muted" style="margin:7px 0 0">舊時段已釋出。選定後會沿用同一筆修繕預約，並同步占用該房東時段。</p><a class="file-link" style="margin-top:12px;background:#2563EB;color:#fff;border:0;text-align:center;font-weight:800" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/reschedule-slots?lineUserId=${encodeURIComponent(tenantLineUserId)}">查看可選時段</a></div></section>`
    : latestAppointment ? `<section class="section"><div class="stat" style="border-color:#93C5FD;background:#EFF6FF"><strong style="color:#1D4ED8">房東已提出修繕時間，請你回覆</strong><p class="muted" style="margin:7px 0 0">預約時段：${escapeHtml(formatDateTime(latestAppointment.starts_at))}${latestAppointment.ends_at ? ` - ${escapeHtml(formatDateTime(latestAppointment.ends_at))}` : ''}。可確認時間，或提出希望改期並留言。</p><a class="file-link" style="margin-top:12px;background:#2563EB;color:#fff;border:0;text-align:center;font-weight:800" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/appointment?lineUserId=${encodeURIComponent(tenantLineUserId)}&event=${encodeURIComponent(latestAppointment.public_id)}">查看／回覆預約</a></div></section>` : '';
  const ownerCompletionWaiting = completionCount > 0
    && String(ticket.repair_status || '') === 'completed'
    && String(ticket.repair_verification_status || 'pending') === 'pending'
    && !tenantIsRepairHandler;
  const completionWaitingHtml = ownerCompletionWaiting
    ? `<section class="section"><div class="stat" style="border-color:#BFDBFE;background:#EFF6FF"><strong style="color:#1D4ED8">房東已回傳修好資料，請你查驗</strong><p class="muted" style="margin:7px 0 0">請查看修好後照片與說明；確認已修復才會進入費用結算，若仍有問題可直接回報補修。</p><a class="file-link" style="margin-top:12px;background:#2563EB;color:#fff;border:0;text-align:center;font-weight:800" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/verify?lineUserId=${encodeURIComponent(tenantLineUserId)}">查看並確認修繕結果</a></div></section>`
    : '';
  const negotiationUpdates = repairNegotiationUpdates(updates);
  // 新建報修仍在等待房東查看時，不先把房客帶進協商；有責任方案／異議往來後才開放。
  const canTenantNegotiate = String(ticket.case_status || 'open') !== 'closed'
    && (negotiationUpdates.length > 0 || ['proposed', 'disputed'].includes(String(ticket.liability_status || '')));
  const tenantNegotiationHtml = canTenantNegotiate ? `<section class="section">
    <h2>協商與異議歷程</h2>
    <p class="muted">${negotiationUpdates.length ? '這裡只顯示雙方的方案、異議與回覆；AI 初判仍保留在下方完整處理歷史。' : '若你不同意系統初判或後續處理方案，可在這裡提出理由與可接受的做法。'}</p>
    ${repairNegotiationHistoryHtml(updates)}
    <a class="file-link" style="position:relative;margin-top:12px;padding:14px 48px 14px 14px;border-color:#D8DEE8;background:#fff;color:#111827" href="/tenant/repairs/${encodeURIComponent(ticket.public_id)}/supplement?mode=negotiate&lineUserId=${encodeURIComponent(tenantLineUserId)}"><strong style="display:block;font-size:16px">補充依據／提出異議</strong><span class="muted" style="display:block;margin-top:4px;font-size:12px;line-height:1.5">可補充新證據重新判斷；若不採用目前方案，可提出不同修繕或費用方向。</span><span style="position:absolute;right:13px;top:50%;transform:translateY(-50%);display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border-radius:999px;background:#1F2937;color:#fff;font-weight:900">→</span></a>
  </section>` : '';

  res.send(`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>報修紀錄 - ${escapeHtml(title)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#F8FAFC;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:820px;margin:auto;padding:18px 14px 40px}.shell{background:#fff;border:1px solid #E5E7EB;border-radius:20px;overflow:hidden;box-shadow:0 16px 42px rgba(15,23,42,.08)}.hero{background:linear-gradient(120deg,#1F2937,#3F4A2F);color:#fff;padding:22px}.hero p{margin:0 0 8px;color:#CBD5E1;font-size:13px}.hero h1{margin:0;font-size:24px;line-height:1.25}.hero .id{margin-top:8px;color:#E5E7EB;font-size:12px;word-break:break-all}.section{padding:18px 16px;border-top:1px solid #F1F5F9}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.stat{border:1px solid #E5E7EB;border-radius:14px;padding:12px;background:#F8FAFC}.stat span{display:block;color:#64748B;font-size:12px}.stat strong{display:block;margin-top:5px;font-size:15px}.muted{color:#64748B;font-size:14px}.empty{padding:12px;border-radius:12px;background:#F8FAFC}.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.media{margin:0;border:1px solid #E5E7EB;border-radius:14px;overflow:hidden;background:#fff}.media img,.media video{display:block;width:100%;max-height:360px;object-fit:contain;background:#F1F5F9}.media figcaption{padding:8px 10px;color:#64748B;font-size:12px}.file-link{display:block;padding:12px;border:1px solid #E5E7EB;border-radius:12px;text-decoration:none;color:#1F2937}.thread{display:grid;gap:10px}.thread-item{border-left:3px solid #64748B;padding:10px 12px;background:#F8FAFC;border-radius:0 12px 12px 0}.thread-meta{display:flex;justify-content:space-between;gap:12px;font-size:13px}.thread-meta time{color:#64748B;white-space:nowrap}.thread-message{margin-top:7px;font-size:14px;line-height:1.6}.timeline{display:grid;gap:14px}.event{display:grid;grid-template-columns:24px 1fr;gap:10px;position:relative}.event:before{content:"";position:absolute;left:11px;top:24px;bottom:-14px;width:1px;background:#E5E7EB}.event:last-child:before{display:none}.dot{width:24px;height:24px;border-radius:999px;background:#1F2937;margin-top:4px}.event-card{border:1px solid #E5E7EB;border-radius:14px;padding:12px;background:#fff;border-left-width:4px}.tone-blue .event-card{border-left-color:#2563EB}.tone-amber .event-card{border-left-color:#D97706}.tone-purple .event-card{border-left-color:#7C3AED}.tone-green .event-card{border-left-color:#059669}.tone-red .event-card{border-left-color:#DC2626}.tone-gray .event-card{border-left-color:#64748B}.event-meta{display:flex;justify-content:space-between;gap:8px;color:#111827;font-size:13px}.event-meta time{color:#94A3B8;font-size:12px}.event-card p{white-space:pre-wrap;line-height:1.55;color:#334155;font-size:14px}.pill{display:inline-block;margin-top:8px;padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700}.pill.tone-blue{background:#EFF6FF;color:#2563EB}.pill.tone-amber{background:#FFFBEB;color:#B45309}.pill.tone-purple{background:#F3E8FF;color:#7C3AED}.pill.tone-green{background:#ECFDF5;color:#047857}.pill.tone-red{background:#FEF2F2;color:#B91C1C}.pill.tone-gray{background:#F1F5F9;color:#334155}.mini-grid{margin-top:10px;display:grid;gap:8px}@media(max-width:640px){.page{padding:0}.shell{min-height:100vh;border-radius:0;border-width:0}.grid{grid-template-columns:1fr}.hero{padding:20px 16px}.thread-meta{display:block}.thread-meta time{display:block;margin-top:3px}}
  </style>
</head>
<body>
  <main class="page">
    <section class="shell">
      <header class="hero">
        <p>報修完整紀錄</p>
        <h1>${escapeHtml(title)}</h1>
        <div class="id">${escapeHtml(ticket.public_id)}</div>
      </header>
      ${created ? '<section class="section"><div class="stat" style="border-color:#86EFAC;background:#F0FDF4"><strong style="color:#047857">報修已建立，已通知房東</strong><p class="muted" style="margin:7px 0 0">後續處理、補件或修繕安排更新時，系統會再通知你。</p></div></section>' : ''}
      ${urgentContactHtml}
      <section class="section">
        <div class="grid">
          <div class="stat"><span>房客</span><strong>${escapeHtml(ticket.tenant_name || '房客')}</strong></div>
          <div class="stat"><span>狀態</span><strong>${escapeHtml(statusText(ticket.status, completionCount, ticket))}</strong></div>
          <div class="stat"><span>分類</span><strong>${escapeHtml(ticket.category || '一般報修')}</strong></div>
          <div class="stat"><span>通報時間</span><strong>${escapeHtml(formatDateTime(ticket.reported_at))}</strong></div>
        </div>
        <p class="muted">${escapeHtml(ticket.description || '尚無報修描述')}</p>
      </section>
      ${tenantAiAssessmentHtml(ticket)}
      ${completionActionHtml}
      ${supplementActionHtml}
      ${appointmentActionHtml}
      ${completionWaitingHtml}
      ${tenantNegotiationHtml}
      <section class="section">
        <h2>損壞照片</h2>
        <div class="media-grid">${mediaHtml(files, 'damage_photo')}</div>
      </section>
      <section class="section">
        <h2>修好後照片與費用附件</h2>
        <div class="media-grid">${mediaHtml(files, 'completion_photo')}</div>
      </section>
      <section class="section">
        <h2>處理歷史</h2>
        <div class="timeline">${timelineHtml(updates, files)}</div>
      </section>
    </section>
  </main>
</body>
</html>`);
}

async function reassessRepairAfterTenantSupplementAsync(db, ticket, supplement = {}) {
  const usageContext = ['normal_use', 'after_cleaning', 'after_moving', 'impact_or_pet', 'unknown'].includes(supplement.usageContext) ? supplement.usageContext : 'unknown';
  const damageTiming = String(supplement.damageTiming || '').trim();
  const facts = [usageContext !== 'unknown' ? `補件使用情境：${supplementUsageContextLabel(usageContext)}` : '', damageTiming ? `補件發生時間：${damageTiming}` : '', supplement.message ? `補件說明：${supplement.message}` : ''].filter(Boolean).join('\n');
  const description = [ticket.description || '', facts].filter(Boolean).join('\n');
  if (facts) await db.run(`UPDATE repair_tickets SET description=?, updated_at=${db.dialect.utcNow()} WHERE id=?`, [description, ticket.id]);
  const assets = await repairRepositoryAsync.listRepairAssetsForUnit(db, ticket.rental_unit_id);
  const asset = ticket.asset_id ? assets.find((item) => Number(item.id) === Number(ticket.asset_id)) : await repairRepositoryAsync.findRepairAssetForDescription(db, { rentalUnitId: ticket.rental_unit_id, description });
  const [moveInEvidence, files] = await Promise.all([
    repairRepositoryAsync.findLeaseMoveInInspectionEvidence(db, { leaseId: ticket.lease_id, rentalUnitId: ticket.rental_unit_id }),
    repairRepositoryAsync.listRepairFiles(db, ticket.public_id),
  ]);
  const damageType = inferRepairDamageType(description);
  const rule = await repairRepositoryAsync.findLeaseRepairRule(db, { leaseId: ticket.lease_id, rentalUnitId: ticket.rental_unit_id, assetId: asset?.id || null, damageType });
  const analysis = buildRepairAssistantAnalysis({ description, photoCount: files.length, unitLabel: ticket.unit_label, asset: asset || null, rule, tenantPreference: ticket.tenant_preference || 'no_preference', moveInEvidence });
  await db.run(`UPDATE repair_tickets SET cause_classification=?, updated_at=${db.dialect.utcNow()} WHERE id=?`, [analysis.causeClassification || 'unknown', ticket.id]);
  await repairRepositoryAsync.createRepairAiAssessment(db, {
    repairTicketId: ticket.id, leaseId: ticket.lease_id, assetId: asset?.id || null,
    leaseRepairRuleId: rule?.rule_origin === 'lease_rule' ? rule.id : null, rentalUnitRepairRuleDefaultId: rule?.rule_origin === 'unit_default' ? rule.id : null,
    riskLevel: analysis.assessment.riskLevel, ruleMatchStatus: analysis.assessment.ruleMatchStatus, evidenceStatus: analysis.assessment.evidenceStatus,
    causeClassification: analysis.assessment.causeClassification, liabilityParty: analysis.assessment.liabilityParty,
    recommendedDispatchParty: analysis.assessment.recommendedDispatchParty, recommendedPayerParty: analysis.assessment.recommendedPayerParty,
    responsibilityGuess: analysis.assessment.responsibilityGuess, recommendedExecutor: analysis.assessment.recommendedExecutor,
    recommendedPayer: analysis.assessment.recommendedPayer, confidence: analysis.assessment.confidence, legalBasisSummary: analysis.legalBasis,
    contractBasisSummary: analysis.contractBasis, missingInfo: analysis.missing, ruleRefs: analysis.ruleRefs, rawResult: analysis,
  });
  await repairRepositoryAsync.addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', messageText: `系統已依房客補件重新初判。\n${analysis.recordText}`, createdByUserId: ticket.tenant_user_id || ticket.reported_by_user_id });
  const insufficient = analysis.assessment.evidenceStatus !== 'sufficient';
  await repairRepositoryAsync.changeRepairStatus(db, { ticketPublicId: ticket.public_id, toStatus: 'reported',
    messageText: insufficient ? '房客已補件，但目前仍缺少判斷所需資料。' : '房客補件後資料已更新，案件已交回房東查看最新初判與安排下一步。',
    createdByUserId: ticket.tenant_user_id || ticket.reported_by_user_id });
  await repairRepositoryAsync.updateRepairWorkflowState(db, { ticketPublicId: ticket.public_id, actionOwner: insufficient ? 'tenant' : 'landlord', waitingOn: insufficient ? 'tenant' : 'none' });
  return analysis;
}

router.get('/tenant/repairs/:publicId', async (req, res, next) => {
  if (driverMode() !== 'mysql') return renderTenantRepairDetail(req, res);
  try {
    return await withV2Driver(async (db) => {
      const ticket = await repairRepositoryAsync.getRepairContext(db, req.params.publicId);
      if (!ticket) return res.status(404).send('<h1>找不到此報修紀錄</h1>');
      const [files, updates, latestAppointment] = await Promise.all([
        repairRepositoryAsync.listRepairFiles(db, ticket.public_id),
        repairRepositoryAsync.listRepairUpdates(db, ticket.public_id, 100),
        ['proposed', 'reschedule_requested'].includes(String(ticket.appointment_status || ''))
          ? repairRepositoryAsync.getRepairAppointmentEvent(db, ticket.id, '') : Promise.resolve(null),
      ]);
      return renderTenantRepairDetail(req, res, { db, ticket, files, updates, latestAppointment });
    });
  } catch (error) { return next(error); }
});

router.__test = {
  richMenuRepairEntryTarget,
  landlordRepairDetailPage,
  landlordRepairSchedulePage,
  landlordRepairWorkflow,
  resolveAllowedRepairActions,
  landlordInspectionActionUrl,
  landlordTaskCenterPage,
  listLandlordNotificationEvents,
};

module.exports = router;
