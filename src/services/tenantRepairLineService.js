const path = require('node:path');
const { openV2Database } = require('../database/v2Database');
const { downloadMessageContent } = require('./contentDownloadService');
const repairs = require('../repositories/v2RepairRepository');
const notifications = require('./v2NotificationEventService');
const { findTestLandlordLineUserId } = require('./testRoleService');
const dashboardPresenter = require('./dashboardLinePresenter');
const { buildRepairAssistantAnalysis, inferRepairDamageType } = require('./repairAiAssistant');

let dbInstance;

function getDb() {
  if (!dbInstance) {
    dbInstance = openV2Database({
      dbPath: process.env.V2_DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'ecs-neo-v2.sqlite'),
    });
  }
  return dbInstance;
}

function text(message) { return { type: 'text', text: message }; }

function messageQuickReply(label, value = label) {
  return {
    type: 'action',
    action: {
      type: 'message',
      label,
      text: value,
    },
  };
}

function repairFlowText(message, { includeComplete = false, includePreference = true } = {}) {
  return {
    type: 'text',
    text: message,
    quickReply: {
      items: [
        ...(includeComplete ? [messageQuickReply('完成報修')] : []),
        ...(includePreference ? [messageQuickReply('我想自修'), messageQuickReply('請房東修')] : []),
        messageQuickReply('取消'),
      ],
    },
  };
}

function parseRepairPreference(rawText) {
  const value = String(rawText || '').trim();
  if (['我想自修', '房客自修', '自己修', '我自己修'].includes(value)) {
    return { code: 'tenant_self_repair', label: '房客有自修意願' };
  }
  if (['請房東修', '請房東修理', '房東修理', '房東派修', '請房東處理'].includes(value)) {
    return { code: 'landlord_repair', label: '希望房東安排修理' };
  }
  return null;
}

function supplementFlowText(message) {
  return {
    type: 'text',
    text: message,
    quickReply: {
      items: [
        messageQuickReply('完成補充'),
        messageQuickReply('取消'),
      ],
    },
  };
}

function negotiationFlowText(message) {
  return {
    type: 'text',
    text: message,
    quickReply: {
      items: [
        messageQuickReply('完成協商'),
        messageQuickReply('取消'),
      ],
    },
  };
}

function landlordNegotiationFlowText(message) {
  return {
    type: 'text',
    text: message,
    quickReply: {
      items: [
        messageQuickReply('完成回覆'),
        messageQuickReply('取消'),
      ],
    },
  };
}

function cleanNegotiationText(value) {
  return String(value || '')
    .replace(/^AI 協商轉述：/, '')
    .replace(/^房客表示「/, '')
    .replace(/^房東回覆「/, '')
    .replace(/」。.*$/s, '')
    .trim();
}

function postback(label, data, style = 'secondary', color) {
  return {
    type: 'button',
    style,
    height: 'sm',
    color,
    action: { type: 'postback', label, data },
  };
}

function messageButton(label, message, style = 'secondary', color) {
  return {
    type: 'button',
    style,
    height: 'sm',
    color,
    action: {
      type: 'message',
      label,
      text: message,
    },
  };
}

function externalPageUrl(pathname) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const liffId = process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
  if (process.env.LINE_USE_MINIAPP_URLS !== 'false' && liffId) {
    return `https://miniapp.line.me/${encodeURIComponent(liffId)}${normalizedPath}`;
  }
  const baseUrl = (process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${baseUrl}${normalizedPath}`;
}

function repairRecordUrl(ticketPublicId, lineUserId = '') {
  const query = lineUserId ? `?lineUserId=${encodeURIComponent(lineUserId)}` : '';
  return externalPageUrl(`/tenant/repairs/${encodeURIComponent(ticketPublicId)}${query}`);
}

function repairSupplementUrl(ticketPublicId, mode = 'supplement', lineUserId = '') {
  const query = new URLSearchParams();
  if (['negotiate', 'completion'].includes(mode)) query.set('mode', mode);
  if (lineUserId) query.set('lineUserId', lineUserId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return externalPageUrl(`/tenant/repairs/${encodeURIComponent(ticketPublicId)}/supplement${suffix}`);
}

function repairNewUrl(lineUserId) {
  const query = lineUserId ? `?lineUserId=${encodeURIComponent(lineUserId)}` : '';
  return externalPageUrl(`/tenant/repairs/new${query}`);
}

function repairHistoryUrl(lineUserId) {
  const query = lineUserId ? `?lineUserId=${encodeURIComponent(lineUserId)}` : '';
  return externalPageUrl(`/tenant/repairs/history${query}`);
}

function dateText(value) {
  if (!value) return '-';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return String(value);
  return match[4] ? `${match[2]}/${match[3]} ${match[4]}:${match[5]}` : `${match[2]}/${match[3]}`;
}

function repairRuleSourceLabel(ticket = {}) {
  const pathValue = String(ticket.ai_rule_source_clause_path || '').trim();
  if (!pathValue) return '依據：尚未對應到明確規則來源';
  const parts = pathValue.split(':');
  if (/^(contract|lease|clause|article)$/i.test(parts[0] || '')) {
    return `依據：合約條款 ${pathValue}`;
  }
  if (parts[0] === 'unit-default') {
    return `依據：房源預設修繕規則（${ticket.asset_name || '此房源設備'}）`;
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
    return `依據：簽約／點交房源規則（${assetName}／${scenario}）`;
  }
  if (parts[0] === 'system') return `依據：簽約採用修繕基準（住宅租賃法定／定型化契約規則，${pathValue}）`;
  return `依據：${pathValue}`;
}

function repairBasisLine(ticket = {}) {
  const source = repairRuleSourceLabel(ticket);
  const summary = String(ticket.ai_contract_basis_summary || ticket.ai_legal_basis_summary || '').trim();
  if (!summary) return source;
  const compact = summary.length > 72 ? `${summary.slice(0, 72)}…` : summary;
  return `${source}｜${compact}`;
}

function uriButton(label, uri, style = 'secondary', color) {
  return {
    type: 'button',
    style,
    height: 'sm',
    color,
    action: { type: 'uri', label, uri },
  };
}

function repairNoticeCard({ icon = '🛠️', title, tag, lines = [], extraContents = [], actions = [], role = 'tenant' }) {
  const roleTone = role === 'landlord'
    ? { bg: '#F8FAFC', border: '#1F2937', tagBg: '#E5E7EB', tagColor: '#1F2937' }
    : { bg: '#FFFFFF', border: '#3F4A2F', tagBg: '#ECFDF5', tagColor: '#166534' };
  return {
    type: 'flex',
    altText: title || '報修通知',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        spacing: 'md',
        backgroundColor: roleTone.bg,
        borderColor: roleTone.border,
        borderWidth: '2px',
        cornerRadius: '18px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                width: '42px',
                height: '42px',
                cornerRadius: '10px',
                backgroundColor: '#F1F5F9',
                justifyContent: 'center',
                alignItems: 'center',
                contents: [{ type: 'text', text: icon, size: 'xl', align: 'center' }],
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                justifyContent: 'center',
                contents: [
                  {
                    type: 'box',
                    layout: 'horizontal',
                    spacing: 'sm',
                    alignItems: 'center',
                    contents: [
                      { type: 'text', text: title || '報修通知', weight: 'bold', size: 'md', color: '#111827', flex: 1, wrap: true },
                      ...(tag ? [{
                        type: 'box',
                        layout: 'vertical',
                        flex: 0,
                        backgroundColor: roleTone.tagBg,
                        cornerRadius: '999px',
                        paddingStart: '8px',
                        paddingEnd: '8px',
                        paddingTop: '2px',
                        paddingBottom: '2px',
                        contents: [{ type: 'text', text: tag, size: 'xxs', color: roleTone.tagColor, weight: 'bold' }],
                      }] : []),
                    ],
                  },
                  ...lines.filter(Boolean).map((line, index) => ({
                    type: 'text',
                    text: String(line),
                    size: index === 0 ? 'sm' : 'xs',
                    color: index === 0 ? '#475569' : '#64748B',
                    margin: index === 0 ? 'sm' : 'xs',
                    wrap: true,
                  })),
                ],
              },
            ],
          },
          ...extraContents,
        ],
      },
      ...(actions.length ? {
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: actions,
        },
      } : {}),
    },
  };
}

function repairTicketCard(ticket, context = {}) {
  const urgent = ticket.priority === 'urgent';
  return {
    type: 'flex',
    altText: `報修單 ${ticket.public_id}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        backgroundColor: urgent ? '#991B1B' : '#1F2937',
        contents: [
          { type: 'text', text: urgent ? '🚨 緊急報修' : '🛠️ 新報修單', color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: ticket.public_id, color: '#E5E7EB', size: 'xs', margin: 'xs' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: context.unitLabel || '租賃單位', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: `房客：${context.tenantName || '房客'}`, size: 'sm', color: '#475569' },
          { type: 'text', text: `分類：${ticket.category}`, size: 'sm', color: '#475569' },
          { type: 'text', text: ticket.description, size: 'sm', color: '#111827', wrap: true },
          { type: 'text', text: `狀態：${ticket.status}｜優先：${ticket.priority}`, size: 'xs', color: urgent ? '#B91C1C' : '#64748B' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          postback('受理派修', `action=repair_update&id=${encodeURIComponent(ticket.public_id)}&next=in_progress`, 'primary', '#0F766E'),
          postback('同意房客自修', `action=repair_update&id=${encodeURIComponent(ticket.public_id)}&next=tenant_self_repair`),
          postback('回傳修好證據', `action=repair_update&id=${encodeURIComponent(ticket.public_id)}&next=landlord_completed`),
        ],
      },
    },
  };
}

function repairStatusText(status, repair = {}) {
  if (status === 'landlord_completed') {
    return Number(repair.completion_photo_count || 0) > 0
      ? '修好照片已送出，待房東確認'
      : '房東標記已修復，待你回傳修好照片';
  }
  return {
    reported: '已送出',
    accepted: '已受理',
    in_progress: '處理中',
    tenant_confirmed: '已解決',
    reopened: '房客回報仍有問題',
    cancelled: '已取消',
  }[status] || status;
}

function findIdentityOrReply(db, lineUserId) {
  const identity = repairs.getLineIdentity(db, lineUserId);
  if (!identity) {
    return {
      error: '目前找不到你的 LINE 身分綁定。請先完成租屋／簽約流程，或請管理員協助綁定。',
    };
  }
  return { identity };
}

function handleRepairCommand(lineUserId) {
  return {
    handled: true,
    messages: [repairNoticeCard({
      icon: '🛠️',
      title: '一鍵報修',
      tag: '選功能',
      lines: [
        '新增報修：到外部頁選設備、描述問題、上傳損壞照片。',
        '報修進度：查看目前報修、補傳修好後照片，或開啟完整紀錄。',
      ],
      actions: [
        uriButton('新增報修', repairNewUrl(lineUserId), 'primary', '#1F2937'),
        messageButton('報修進度', '報修進度'),
      ],
    })],
  };
}

function handleRepairStartCommand(lineUserId) {
  const db = getDb();
  const { identity, error } = findIdentityOrReply(db, lineUserId);
  if (error) return { handled: true, messages: [text(error)] };

  const lease = repairs.findActiveTenantLease(db, identity.user_id);
  if (!lease) {
    return {
      handled: true,
      messages: [text('目前找不到你正在承租中的租約，因此還不能建立報修單。請先確認 LINE 身分是否已綁定到租約。')],
    };
  }

  repairs.startRepairSession(db, {
    lineIdentityId: identity.line_identity_id,
    leaseId: lease.lease_id,
    rentalUnitId: lease.rental_unit_id,
    flowType: 'repair_report',
    stepCode: 'await_description',
    context: { unitLabel: lease.unit_label },
    ttlMinutes: 45,
  });

  return {
    handled: true,
    messages: [repairNoticeCard({
      icon: '🛠️',
      title: '一鍵報修',
      tag: '先描述',
      lines: [
        lease.unit_label || '目前租賃單位',
        '先用一句話描述損壞狀況，例如：客廳插座接觸不良。',
        '接著上傳損壞照片；每張照片會建立一張可獨立追蹤的 TK 報修單。',
        '至少要有 1 張照片，才能完成報修。',
      ],
      actions: [
        messageButton('取消', '取消'),
      ],
    })],
  };
}

function tenantRepairWorkflow(ticket = {}) {
  const legacyStatus = String(ticket.status || '');
  const dispatchParty = String(
    ticket.dispatch_party
    || (legacyStatus === 'tenant_self_repair' ? 'tenant' : '')
    || (['landlord_completed', 'landlord_repair', 'repair_completed'].includes(legacyStatus) ? 'landlord' : '')
    || 'review_required',
  );
  const repairStatus = String(ticket.repair_status || (
    ['landlord_completed', 'repair_completed', 'tenant_confirmed'].includes(legacyStatus)
      ? 'completed'
      : ['accepted', 'in_progress', 'tenant_self_repair', 'tenant_pays', 'reopened'].includes(legacyStatus)
        ? 'awaiting_execution'
        : 'reported'
  ));
  const verificationStatus = String(ticket.repair_verification_status || (
    legacyStatus === 'tenant_confirmed' ? 'confirmed' : 'pending'
  ));
  const settlementStatus = String(ticket.settlement_status || (
    legacyStatus === 'tenant_confirmed' ? 'not_required' : 'pending'
  ));
  const closed = String(ticket.case_status || '') === 'closed' || legacyStatus === 'tenant_confirmed';
  const completionPhotoCount = Number(ticket.completion_photo_count || 0);
  const tenantIsRepairHandler = dispatchParty === 'tenant';
  const tenantNeedsCompletionUpload = !closed
    && tenantIsRepairHandler
    && ['awaiting_execution', 'in_progress'].includes(repairStatus)
    && completionPhotoCount === 0;
  const tenantNeedsVerification = !closed
    && !tenantIsRepairHandler
    && repairStatus === 'completed'
    && completionPhotoCount > 0
    && verificationStatus === 'pending';
  const settlementResolved = ['completed', 'not_required', 'waived'].includes(settlementStatus);

  return {
    closed,
    completionPhotoCount,
    dispatchParty,
    repairStatus,
    settlementResolved,
    settlementStatus,
    tenantIsRepairHandler,
    tenantNeedsCompletionUpload,
    tenantNeedsVerification,
    verificationStatus,
  };
}

function tenantRepairProgressText(ticket) {
  const workflow = tenantRepairWorkflow(ticket);
  if (workflow.closed) return '已結案';
  if (workflow.repairStatus === 'completed') {
    if (workflow.tenantNeedsVerification) return '房東已回傳修好資料，等待你查驗';
    if (workflow.verificationStatus === 'confirmed') {
      return workflow.settlementResolved ? '修繕與費用已完成，等待房東結案' : '修復結果已確認，費用待結算';
    }
    if (workflow.tenantIsRepairHandler) {
      return workflow.completionPhotoCount > 0 ? '修好資料已送出，等待房東查驗' : '等待你回傳修好資料';
    }
    return '修繕已完成，等待查驗結果';
  }
  if (['awaiting_execution', 'in_progress'].includes(workflow.repairStatus)) {
    return workflow.tenantIsRepairHandler
      ? '處理中，修好後請回傳資料'
      : '房東／廠商處理中，等待修好資料';
  }
  return ({
    reported: '已通報，等待房東決定',
    accepted: '房東已受理，等待安排修繕',
    reopened: '仍有問題，等待再次處理',
  })[ticket.status] || repairStatusText(ticket.status, ticket);
}

function tenantRepairNextStepText(ticket = {}) {
  const workflow = tenantRepairWorkflow(ticket);
  if (workflow.closed) return '已結案，完整照片與處理歷程請看完整紀錄。';
  if (workflow.tenantNeedsVerification) return '請查看房東回傳的修好資料，確認已修復或退回重新處理。';
  if (workflow.verificationStatus === 'confirmed') {
    return workflow.settlementResolved ? '等待房東完成結案。' : '修復結果已確認，等待費用結算。';
  }
  if (workflow.tenantNeedsCompletionUpload) return '修好後請回傳照片、收據或維修說明給房東查驗。';
  if (!workflow.tenantIsRepairHandler && ['awaiting_execution', 'in_progress'].includes(workflow.repairStatus)) {
    return '等待房東或維修廠商完成修繕；完成後你會收到查驗通知。';
  }
  const status = String(ticket.status || '');
  if (status === 'reported') return '房東決定後會通知你。';
  if (status === 'accepted') return '等待房東安排修繕或通知處理方式。';
  if (status === 'reopened') return '請補充說明或重新回傳修好後照片。';
  if (status === 'tenant_confirmed') return '已結案，完整照片與處理歷程請看完整紀錄。';
  return '請查看完整紀錄確認下一步。';
}

function tenantRepairInfoRow(label, value, color = '#334155') {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    margin: 'xs',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#94A3B8', flex: 0 },
      { type: 'text', text: value || '-', size: 'xs', color, wrap: true, flex: 1 },
    ],
  };
}

function tenantRepairIcon(ticket = {}) {
  const workflow = tenantRepairWorkflow(ticket);
  const status = String(ticket.status || '');
  if (workflow.closed) return '✅';
  if (workflow.repairStatus === 'completed') return workflow.verificationStatus === 'confirmed' ? '✅' : '📸';
  if (status === 'reopened') return '⚠️';
  if (['accepted', 'in_progress'].includes(status)) return '🛠️';
  return '🧰';
}

function tenantRepairIconRow(icon, title, description, badge) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'lg',
    spacing: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '40px',
        height: '40px',
        cornerRadius: '8px',
        backgroundColor: '#F1F5F9',
        justifyContent: 'center',
        alignItems: 'center',
        contents: [{ type: 'text', text: icon || '🛠️', size: 'xl', align: 'center', gravity: 'center' }],
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        justifyContent: 'center',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            spacing: 'sm',
            contents: [
              { type: 'text', text: title || '租屋物件', weight: 'bold', size: 'sm', color: '#111827', wrap: true, flex: 1 },
              ...(badge ? [badge] : []),
            ],
          },
          { type: 'text', text: description || '-', size: 'xs', color: '#64748B', margin: 'xs', wrap: true },
        ],
      },
    ],
  };
}

function compactRepairSummary(ticket = {}) {
  const text = String(ticket.description || ticket.category || '報修內容')
    .replace(/\s*(使用情境|損壞時間|原始物況)\s*：.*$/s, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 34 ? `${text.slice(0, 33)}…` : (text || '報修內容');
}

function tenantRepairStatusTag(ticket = {}) {
  const workflow = tenantRepairWorkflow(ticket);
  const status = String(ticket.status || '');
  if (workflow.closed) return { text: '已結案', color: '#059669', bg: '#D1FAE5' };
  if (workflow.repairStatus === 'completed' && workflow.verificationStatus === 'confirmed') {
    return workflow.settlementResolved
      ? { text: '待結案', color: '#047857', bg: '#D1FAE5' }
      : { text: '待結算', color: '#B45309', bg: '#FEF3C7' };
  }
  if (workflow.tenantNeedsVerification) return { text: '待你查驗', color: '#7C3AED', bg: '#EDE9FE' };
  if (workflow.tenantNeedsCompletionUpload) return { text: '待你回傳', color: '#2563EB', bg: '#DBEAFE' };
  if (status === 'reopened') {
    return { text: '需補修', color: '#B45309', bg: '#FEF3C7' };
  }
  if (status === 'landlord_completed') {
    return { text: '待確認', color: '#7C3AED', bg: '#EDE9FE' };
  }
  if (status === 'tenant_confirmed') {
    return { text: '已結案', color: '#059669', bg: '#D1FAE5' };
  }
  if (['accepted', 'in_progress'].includes(status)) {
    return { text: '處理中', color: '#D97706', bg: '#FEF3C7' };
  }
  if (status === 'reported') {
    return { text: '待房東', color: '#2563EB', bg: '#DBEAFE' };
  }
  return { text: repairStatusText(status, ticket), color: '#475569', bg: '#F1F5F9' };
}

function tenantRepairStatusBadge(ticket = {}) {
  const tag = tenantRepairStatusTag(ticket);
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    paddingAll: '4px',
    paddingStart: '10px',
    paddingEnd: '10px',
    cornerRadius: '999px',
    backgroundColor: tag.bg,
    contents: [{ type: 'text', text: tag.text || '-', size: 'xxs', color: tag.color, weight: 'bold', align: 'center' }],
  };
}

function repairProgressStep(ticket = {}) {
  const workflow = tenantRepairWorkflow(ticket);
  const status = String(ticket.status || '');
  if (workflow.closed || (workflow.repairStatus === 'completed' && workflow.verificationStatus === 'confirmed')) return 4;
  if (workflow.repairStatus === 'completed') return 3;
  if (['accepted', 'in_progress', 'reopened'].includes(status)) return 2;
  if (status === 'reported') return 1;
  return 0;
}

function repairStepTone(step) {
  return ({
    1: { color: '#2563EB', bg: '#DBEAFE' },
    2: { color: '#D97706', bg: '#FEF3C7' },
    3: { color: '#7C3AED', bg: '#EDE9FE' },
    4: { color: '#059669', bg: '#D1FAE5' },
  })[step] || { color: '#94A3B8', bg: '#F1F5F9' };
}

function repairProgressBar(ticket = {}) {
  const current = repairProgressStep(ticket);
  const labels = ['通報', '處理', '回傳', '確認'];
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'xs',
    margin: 'sm',
    contents: labels.map((label, index) => {
      const step = index + 1;
      const done = current >= step;
      const active = current === step && current < labels.length;
      const tone = repairStepTone(step);
      return {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        alignItems: 'center',
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '18px',
            height: '18px',
            cornerRadius: '999px',
            backgroundColor: done ? tone.color : '#FFFFFF',
            borderColor: done ? tone.color : '#CBD5E1',
            borderWidth: '1px',
            justifyContent: 'center',
            alignItems: 'center',
            contents: [
              {
                type: 'text',
                text: done ? '✓' : '○',
                size: 'xxs',
                align: 'center',
                color: done ? '#FFFFFF' : '#CBD5E1',
                weight: 'bold',
              },
            ],
          },
          {
            type: 'text',
            text: label,
            size: 'xxs',
            align: 'center',
            color: done ? tone.color : '#94A3B8',
            weight: active ? 'bold' : 'regular',
          },
        ],
      };
    }),
  };
}

function tenantRepairStatusCard({ title, tag, ticket, lines = [], actions = [] }) {
  return repairNoticeCard({
    icon: '🛠️',
    title,
    tag,
    lines: [
      ticket.unit_label || '租屋物件',
      `狀態：${tenantRepairProgressText(ticket)}`,
      ...lines,
    ],
    extraContents: [
      tenantRepairInfoRow('下一步', tenantRepairNextStepText(ticket), '#1F2937'),
    ],
    actions,
  });
}

function tenantRepairProgressCard(tickets = [], options = {}) {
  const isHistory = options.mode === 'history';
  // LINE 只作為最近狀態摘要；所有操作統一交給外部完整紀錄頁。
  const previewTickets = tickets.slice(0, 3);
  const contents = [
    { type: 'text', text: isHistory ? '🧾 報修歷史' : '🛠️ 報修進度', weight: 'bold', size: 'lg', color: '#111827' },
    {
      type: 'text',
      text: isHistory
        ? '先顯示最近 3 筆；全部歷史請開完整歷史頁。'
        : '先顯示最近 3 筆；補件、預約、查驗與新增報修都在完整外部頁處理。',
      size: 'xs',
      color: '#64748B',
      wrap: true,
      margin: 'xs',
    },
    { type: 'separator', margin: 'md' },
  ];

  if (!previewTickets.length) {
    contents.push(tenantRepairIconRow(
      '🧰',
      isHistory ? '目前沒有報修歷史' : '目前沒有進行中的報修',
      isHistory ? '已結案的修繕會收在這裡。' : '如果有新損壞，請回一鍵報修選「新增報修」。',
    ));
  }

  previewTickets.forEach((ticket) => {
    const meta = [
      isHistory ? `結案 ${dateText(ticket.updated_at)}` : `更新 ${dateText(ticket.updated_at || ticket.reported_at)}`,
      `損壞 ${ticket.damage_photo_count || 0}`,
      `修好 ${ticket.completion_photo_count || 0}`,
    ].join('｜');
    const description = isHistory
      ? `${compactRepairSummary(ticket)}\n已結案｜${meta}`
      : `${compactRepairSummary(ticket)}\n${tenantRepairProgressText(ticket)}｜${meta}`;
    contents.push(tenantRepairIconRow(
      tenantRepairIcon(ticket),
      ticket.unit_label || '租屋物件',
      description,
      tenantRepairStatusBadge(ticket),
    ));
  });

  return {
    type: 'flex',
    altText: isHistory ? '報修歷史' : '報修進度',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#F8FAFC',
        paddingAll: '18px',
        contents,
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          uriButton(
            isHistory ? '查看完整修繕歷史' : '查看完整報修紀錄',
            isHistory
              ? (options.historyUrl || repairHistoryUrl(options.lineUserId))
              : externalPageUrl(`/tenant/repairs?lineUserId=${encodeURIComponent(options.lineUserId || '')}`),
            'primary',
            '#1F2937',
          ),
        ],
      },
    },
  };
}

function handleRepairProgressCommand(lineUserId) {
  const db = getDb();
  const { identity, error } = findIdentityOrReply(db, lineUserId);
  if (error) return { handled: true, messages: [text(error)] };
  const tickets = repairs.listTenantRepairTickets(db, identity.user_id, 5);
  return { handled: true, messages: [tenantRepairProgressCard(tickets, { lineUserId })] };
}

function handleRepairHistoryCommand(lineUserId) {
  const db = getDb();
  const { identity, error } = findIdentityOrReply(db, lineUserId);
  if (error) return { handled: true, messages: [text(error)] };
  const tickets = repairs.listTenantRepairHistoryTickets(db, identity.user_id, 10);
  return {
    handled: true,
    messages: [tenantRepairProgressCard(tickets, {
      mode: 'history',
      lineUserId,
      historyUrl: repairHistoryUrl(lineUserId),
    })],
  };
}

async function handleRepairProgressCommandAsync(db, lineUserId) {
  const asyncRepairs = require('../repositories/v2RepairRepositoryAsync');
  const identity = await asyncRepairs.getLineIdentity(db, lineUserId);
  if (!identity) {
    return { handled: true, messages: [text('目前找不到你的 LINE 身分綁定。請先完成租屋／簽約流程，或請管理員協助綁定。')] };
  }
  const tickets = await asyncRepairs.listTenantRepairTickets(db, identity.user_id, 5);
  return { handled: true, messages: [tenantRepairProgressCard(tickets, { lineUserId })] };
}

async function handleRepairHistoryCommandAsync(db, lineUserId) {
  const asyncRepairs = require('../repositories/v2RepairRepositoryAsync');
  const identity = await asyncRepairs.getLineIdentity(db, lineUserId);
  if (!identity) {
    return { handled: true, messages: [text('目前找不到你的 LINE 身分綁定。請先完成租屋／簽約流程，或請管理員協助綁定。')] };
  }
  const tickets = await asyncRepairs.listTenantRepairTickets(db, identity.user_id, 10, { history: true });
  return {
    handled: true,
    messages: [tenantRepairProgressCard(tickets, {
      mode: 'history',
      lineUserId,
      historyUrl: repairHistoryUrl(lineUserId),
    })],
  };
}

function useCloudRepairDriver() {
  return String(process.env.V2_DB_DRIVER || 'sqlite').trim().toLowerCase() === 'mysql';
}

function handleRepairProgressCommandConfigured(lineUserId) {
  if (!useCloudRepairDriver()) return handleRepairProgressCommand(lineUserId);
  const { withV2Driver } = require('../database/v2Driver');
  return withV2Driver((db) => handleRepairProgressCommandAsync(db, lineUserId));
}

function handleRepairHistoryCommandConfigured(lineUserId) {
  if (!useCloudRepairDriver()) return handleRepairHistoryCommand(lineUserId);
  const { withV2Driver } = require('../database/v2Driver');
  return withV2Driver((db) => handleRepairHistoryCommandAsync(db, lineUserId));
}

function cancelActiveRepairSessionForLineUser(lineUserId, reason = 'interrupted_by_command') {
  const db = getDb();
  const identity = repairs.getLineIdentity(db, lineUserId);
  if (!identity) return false;
  const session = repairs.getActiveRepairSession(db, identity.line_identity_id);
  if (!session) return false;
  return repairs.finishRepairSession(db, session.publicId, reason);
}

function ticketLabel(ticket) {
  return `${ticket.public_id.slice(0, 13)}｜${repairStatusText(ticket.status)}`;
}

function resolveLandlordRecipientsForRepair(recipients, ticket, context = {}) {
  const hasRealRecipient = recipients.some((recipient) => (
    recipient.line_user_id && !String(recipient.line_user_id).includes('DEMO')
  ));
  if (hasRealRecipient || process.env.NODE_ENV === 'production') return recipients;

  const fallbackLineUserId = findTestLandlordLineUserId() || context.fallbackLineUserId || '';
  if (!fallbackLineUserId || String(fallbackLineUserId).includes('DEMO')) return recipients;

  const owner = recipients[0] || {};
  return [{
    user_id: owner.user_id || ticket.assigned_owner_user_id || null,
    line_identity_id: owner.line_identity_id || null,
    line_user_id: fallbackLineUserId,
    scope: 'demo_all',
  }];
}

async function notifyLandlords(db, lineClient, ticket, context) {
  let recipients = repairs.listLandlordRecipients(db, ticket.rental_unit_id);
  recipients = resolveLandlordRecipientsForRepair(recipients, ticket, context);
  for (const recipient of recipients) {
    const card = dashboardPresenter.dashboardRepairDetailCard({
      ...ticket,
      unit_label: context.unitLabel,
      tenant_name: context.tenantName,
      tenant_repair_preference: context.tenantRepairPreference,
      files: repairs.listRepairFiles(db, ticket.public_id),
    }, recipient.scope || context.scope, recipient.line_user_id, {
      title: context.eventTitle || '🛠️ 房客完成報修送出',
      subtitle: context.eventSubtitle || '房東端通知｜請處理並查看',
      tag: '房東端',
      // 新報修只是事件通知。房東應先在外部頁看完完整描述、照片與初判依據，
      // 再決定採用、補證據或提出協商；不要在通知卡上直接跳過閱讀階段。
      enableRecommendationChoices: false,
    });
    await notifications.recordNotificationDelivery({
      db,
      lineClient,
      message: card,
      notification: {
        publicId: `notif-${context.notificationEventKey || 'repair-reported'}-${ticket.public_id}`,
        eventType: context.notificationEventKey || 'repair_reported',
        entityType: 'repair_ticket',
        entityId: ticket.public_id,
        templateCode: 'line_repair_ticket',
        payload: {
          ticketPublicId: ticket.public_id,
          unitLabel: context.unitLabel,
          tenantName: context.tenantName,
          status: ticket.status,
        },
      },
      recipient: {
        userId: recipient.user_id,
        lineIdentityId: recipient.line_identity_id,
        lineUserId: recipient.line_user_id,
      },
      idempotencyKey: `${context.notificationEventKey || 'repair_reported'}:${ticket.public_id}:landlord:${recipient.user_id}:line`,
    }).catch((err) => console.error('Failed to notify repair ticket landlord:', err.message));
  }
}

async function notifyLandlordsRepairUpdate(db, lineClient, ticket, context, eventKey) {
  let recipients = repairs.listLandlordRecipients(db, ticket.rental_unit_id);
  recipients = resolveLandlordRecipientsForRepair(recipients, ticket, context);
  const fullTicket = {
    ...ticket,
    unit_label: context.unitLabel,
    tenant_name: context.tenantName,
    tenant_repair_preference: context.tenantRepairPreference,
    latest_negotiation_text: context.latestNegotiationText || '',
    files: repairs.listRepairFiles(db, ticket.public_id),
  };
  const notificationText = ({
    repair_report_completed: {
      title: '🛠️ 房客完成報修送出',
      subtitle: '房東端通知｜新報修已送出，請處理並查看',
      tag: '房東端',
    },
    completion_photo_uploaded: {
      title: '📸 房客回傳修好照片',
      subtitle: '請到外部頁查看照片並確認完成或退回',
      tag: '房東端',
    },
    tenant_response_accept: {
      title: '✅ 房客接受目前處理方案',
      subtitle: '房客已同意目前方向，仍需安排修繕或確認實際金額',
      tag: '房東端',
    },
    tenant_response_reject: {
      title: '⚠️ 房客不同意修繕條件',
      subtitle: '需要再協商責任、費用或處理方式',
      tag: '房東端',
    },
    tenant_response_supplement: {
      title: '📝 房客要補充資料',
      subtitle: '房客表示會補充說明或附件，請留意後續通知',
      tag: '房東端',
    },
    tenant_response_negotiate: {
      title: '💬 房客要求協商',
      subtitle: '房客不同意原條件，想再協商責任、費用或處理方式',
      tag: '房東端',
    },
    tenant_negotiation_text: {
      title: '💬 房客協商說明',
      subtitle: '房客已提出協商內容，請到外部頁查看完整紀錄',
      tag: '房東端',
    },
    tenant_negotiation_file: {
      title: '📎 房客協商附件',
      subtitle: '房客已補上協商照片或附件，請到外部頁查看完整紀錄',
      tag: '房東端',
    },
    tenant_repair_negotiation: {
      title: '💬 房客回覆協商方案',
      subtitle: '房客已回覆方案或提出不同意見；請開啟外部頁回覆，所有來回都會保存到案件紀錄',
      tag: '協商',
    },
    tenant_supplement_text: {
      title: '📝 房客補充說明',
      subtitle: '房客已補充文字說明，請到外部頁查看完整紀錄',
      tag: '房東端',
    },
    tenant_supplement_file: {
      title: '📎 房客補充附件',
      subtitle: '房客已補充照片或附件，請到外部頁查看完整紀錄',
      tag: '房東端',
    },
    tenant_appointment_accept: {
      title: '📅 房客確認修繕時間',
      subtitle: '房客可以配合目前時段，可依預約安排修繕',
      tag: '房東端',
    },
    tenant_appointment_reschedule: {
      title: '📅 房客希望改期',
      subtitle: '請重新提出修繕到場時間',
      tag: '房東端',
    },
    tenant_appointment_rescheduled: {
      title: '📅 房客已選定新的修繕時間',
      subtitle: '新時段已確認，可依預約安排修繕',
      tag: '房東端',
    },
    tenant_appointment_reschedule_preference: {
      title: '📅 房客補充改期時段',
      subtitle: '房客已提供偏好時段，請重新安排修繕時間',
      tag: '房東端',
    },
    urgent_tenant_contact: {
      title: '🚨 房客要求緊急聯絡',
      subtitle: '房客已從緊急報修案件發出聯絡提醒，請立即查看並聯絡房客。',
      tag: '緊急',
    },
  })[eventKey] || {
    title: '🛠️ 報修狀態更新',
    subtitle: '報修案件有新進度，請到外部頁查看',
    tag: '房東端',
  };
  // 同一案件可有多次協商往來。eventKey 描述事件種類，notificationKey
  // 則可指向某一則實際回覆，避免後續訊息被 notification 的去重機制吞掉。
  const notificationKey = String(context.notificationKey || eventKey);
  for (const recipient of recipients) {
    const card = dashboardPresenter.dashboardRepairDetailCard(
      fullTicket,
      recipient.scope || context.scope,
      recipient.line_user_id,
      {
        ...notificationText,
        summary: context.messageText || undefined,
        negotiationText: context.latestNegotiationText || '',
        enableNegotiationReply: ['tenant_response_negotiate', 'tenant_negotiation_text', 'tenant_negotiation_file'].includes(eventKey)
          || String(eventKey || '').includes('negotiate')
          || String(eventKey || '').includes('negotiation'),
      },
    );
    await notifications.recordNotificationDelivery({
      db,
      lineClient,
      message: card,
      notification: {
        publicId: `notif-repair-${notificationKey}-${ticket.public_id}`,
        eventType: 'repair_status_updated',
        entityType: 'repair_ticket',
        entityId: ticket.public_id,
        templateCode: 'line_repair_status',
        payload: {
          ticketPublicId: ticket.public_id,
          unitLabel: context.unitLabel,
          tenantName: context.tenantName,
          status: ticket.status,
          eventKey,
        },
      },
      recipient: {
        userId: recipient.user_id,
        lineIdentityId: recipient.line_identity_id,
        lineUserId: recipient.line_user_id,
      },
      idempotencyKey: `repair_${notificationKey}:${ticket.public_id}:landlord:${recipient.user_id}:line`,
    }).catch((err) => console.error('Failed to notify repair update landlord:', err.message));
  }
}

async function notifyTenant(db, lineClient, context, message, idempotencySuffix) {
  if (!context || (!context.tenant_user_id && !context.tenant_line_identity_id)) return;
  await notifications.recordNotificationDelivery({
    db,
    lineClient,
    message,
    notification: {
      publicId: `notif-repair-tenant-${context.public_id}-${idempotencySuffix}`,
      eventType: 'repair_status_updated',
      entityType: 'repair_ticket',
      entityId: context.public_id,
      templateCode: 'line_repair_status',
      payload: {
        ticketPublicId: context.public_id,
        unitLabel: context.unit_label,
        status: context.status,
        statusText: repairStatusText(context.status, context),
      },
    },
    recipient: {
      userId: context.tenant_user_id,
      lineIdentityId: context.tenant_line_identity_id,
      lineUserId: context.tenant_line_user_id,
    },
    idempotencyKey: `repair_status:${context.public_id}:${idempotencySuffix}:tenant:${context.tenant_user_id || context.tenant_line_identity_id}:line`,
  }).catch((err) => console.error('Failed to notify repair tenant:', err.message));
}

function createTicketFromSession(db, session, identity, description, imageIndex = null) {
  const owner = repairs.listLandlordRecipients(db, session.rentalUnitId)[0];
  const tenantPreference = session.context.tenantRepairPreference || 'no_preference';
  const damageType = inferRepairDamageType(description);
  const asset = repairs.findRepairAssetForDescription(db, {
    rentalUnitId: session.rentalUnitId,
    description,
  });
  const rule = repairs.findLeaseRepairRule(db, {
    leaseId: session.leaseId,
    rentalUnitId: session.rentalUnitId,
    assetId: asset && asset.id,
    damageType,
  });
  const ticket = repairs.createRepairTicket(db, {
    leaseId: session.leaseId,
    rentalUnitId: session.rentalUnitId,
    category: '一般報修',
    description,
    assetId: asset && asset.id,
    damageType,
    tenantPreference,
    reportedByUserId: identity.user_id,
    assignedOwnerUserId: owner && owner.user_id,
  });
  const update = repairs.addRepairUpdate(db, {
    repairTicketId: ticket.id,
    updateType: 'message',
    messageText: '房客建立報修單',
    createdByUserId: identity.user_id,
  });
  const analysis = buildRepairAssistantAnalysis({
    description,
    photoCount: Number(session.context.pendingPhotoCount || imageIndex || 1),
    unitLabel: session.context.unitLabel,
    asset,
    rule,
    tenantPreference,
  });
  db.prepare(`
    UPDATE repair_tickets
    SET cause_classification = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(analysis.causeClassification || 'unknown', ticket.id);
  repairs.createRepairAiAssessment(db, {
    repairTicketId: ticket.id,
    leaseId: session.leaseId,
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
  repairs.addRepairUpdate(db, {
    repairTicketId: ticket.id,
    updateType: 'message',
    messageText: analysis.recordText,
    createdByUserId: identity.user_id,
  });
  if (session.context.tenantRepairPreferenceLabel) {
    repairs.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'message',
      messageText: `房客處理意願：${session.context.tenantRepairPreferenceLabel}`,
      createdByUserId: identity.user_id,
    });
  }
  return { ticket, update };
}

async function saveLineContentAsFile({ db, event, userId }) {
  const message = event.message;
  const downloaded = await downloadMessageContent({
    messageId: message.id,
    messageType: message.type,
    fileName: message.fileName,
    groupId: `repair-${event.source.userId || 'unknown'}`,
  });
  const file = repairs.addFile(db, {
    storageKey: downloaded.filePath,
    storageProvider: downloaded.storageProvider,
    originalName: downloaded.fileName,
    mimeType: downloaded.mimeType,
    sizeBytes: downloaded.size,
    sha256Hash: downloaded.hash,
    createdByUserId: userId,
  });
  return file;
}

async function attachLineContentToUpdate({ db, event, updateId, userId, purpose }) {
  const file = await saveLineContentAsFile({ db, event, userId });
  repairs.linkFileToRepairUpdate(db, { fileId: file.id, repairUpdateId: updateId, purpose });
  return file;
}

async function createTicketsFromPendingFiles({ db, session, identity, description, lineClient, fallbackLineUserId }) {
  const pendingFileIds = Array.isArray(session.context.pendingDamageFileIds)
    ? session.context.pendingDamageFileIds.filter(Boolean)
    : [];
  const ticketPublicIds = [];

  for (let index = 0; index < pendingFileIds.length; index += 1) {
    const { ticket, update } = createTicketFromSession(db, session, identity, description, index + 1);
    repairs.linkFileToRepairUpdate(db, { fileId: pendingFileIds[index], repairUpdateId: update.id, purpose: 'damage_photo' });
    ticketPublicIds.push(ticket.public_id);
  }

  return ticketPublicIds;
}

async function handleActiveRepairSession(event, messageType, payload = {}, lineClient) {
  const db = getDb();
  const lineUserId = event.source && event.source.userId;
  const { identity } = findIdentityOrReply(db, lineUserId);
  if (!identity) return { handled: false, messages: [] };
  const session = repairs.getActiveRepairSession(db, identity.line_identity_id);
  if (!session) return { handled: false, messages: [] };

  const rawText = String(payload.text || '').trim();
  if (messageType === 'text' && rawText === '取消') {
    repairs.finishRepairSession(db, session.publicId, 'cancelled');
    return { handled: true, messages: [text('已取消這次報修流程。')] };
  }

  if (session.flowType === 'urgent_repair_contact' && session.stepCode === 'await_message') {
    const ticket = repairs.getRepairContext(db, session.context.ticketPublicId);
    if (!ticket || Number(ticket.tenant_user_id || ticket.reported_by_user_id) !== Number(identity.user_id)) {
      repairs.finishRepairSession(db, session.publicId, 'missing_ticket');
      return { handled: true, messages: [text('找不到這筆緊急報修，聯絡流程已結束。')] };
    }
    if (messageType !== 'text' || !rawText) {
      return { handled: true, messages: [text('請直接輸入要告知房東的緊急情況；也可以輸入「取消」結束。')] };
    }
    repairs.addRepairUpdate(db, {
      repairTicketId: ticket.id,
      updateType: 'urgent_message',
      fromStatus: ticket.status,
      toStatus: ticket.status,
      messageText: `房客緊急訊息：${rawText}`,
      createdByUserId: identity.user_id,
    });
    const updatedTicket = repairs.getRepairContext(db, ticket.public_id) || ticket;
    await notifyLandlordsRepairUpdate(db, lineClient, updatedTicket, {
      unitLabel: updatedTicket.unit_label,
      tenantName: updatedTicket.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: lineUserId,
      messageText: `房客緊急訊息：${rawText}`,
    }, 'urgent_tenant_contact');
    repairs.finishRepairSession(db, session.publicId, 'message_sent');
    return { handled: true, messages: [text('已把你的緊急訊息傳給房東，並保存到這筆報修紀錄。')] };
  }

  if (
    session.flowType === 'repair_close'
    && session.stepCode === 'await_tenant_confirmation'
    && session.context.mode === 'landlord_negotiation'
  ) {
    const ticket = repairs.getRepairContext(db, session.context.ticketPublicId);
    if (!ticket) {
      repairs.finishRepairSession(db, session.publicId, 'missing_ticket');
      return { handled: true, messages: [text('找不到這張報修單，房東協商回覆流程已結束。')] };
    }
    const allowDemoAction = session.context.scope === 'demo_all' && process.env.NODE_ENV !== 'production';
    if (!allowDemoAction && !repairs.canManageRepairTicket(db, ticket.public_id, identity.user_id)) {
      repairs.finishRepairSession(db, session.publicId, 'forbidden');
      return { handled: true, messages: [text('你沒有這張報修單的回覆權限。')] };
    }
    if (messageType === 'text' && rawText === '完成回覆') {
      repairs.finishRepairSession(db, session.publicId, 'completed');
      return { handled: true, messages: [text('已結束房東協商回覆流程。後續房客回覆會再通知你。')] };
    }
    if (messageType === 'text') {
      const update = repairs.addRepairUpdate(db, {
        repairTicketId: ticket.id,
        updateType: 'message',
        messageText: `AI 協商轉述：房東回覆「${rawText}」。請房客確認條件，或繼續協商。`,
        createdByUserId: identity.user_id,
      });
      await notifyTenant(db, lineClient, ticket, tenantRepairStatusCard({
        title: '房東回覆協商',
        tag: '協商',
        ticket,
        lines: [
          `報修單：${ticket.public_id}`,
          `房東回覆：${rawText}`,
          '請到外部頁查看完整往來並回覆；所有方案、接受或異議都會保存到案件紀錄。',
        ],
        actions: [
          tenantRepairResponseButton(ticket.public_id, 'negotiate', '前往回覆協商', 'primary', '#1F2937', ticket.tenant_line_user_id),
          repairRecordButton(ticket.public_id),
        ],
      }), `landlord_negotiation_text_${Date.now()}`);
      repairs.advanceRepairSession(db, {
        publicId: session.publicId,
        context: session.context,
        ttlMinutes: 45,
      });
      return { handled: true, messages: [landlordNegotiationFlowText('已把協商回覆通知房客。可繼續回覆，或按「完成回覆」結束。')] };
    }
    if (['image', 'video', 'file'].includes(messageType)) {
      const update = repairs.addRepairUpdate(db, {
        repairTicketId: ticket.id,
        updateType: 'photo',
        messageText: '房東協商附件',
        createdByUserId: identity.user_id,
      });
      await attachLineContentToUpdate({ db, event, updateId: update.id, userId: identity.user_id, purpose: 'supplement' });
      await notifyTenant(db, lineClient, ticket, tenantRepairStatusCard({
        title: '房東補上協商附件',
        tag: '協商',
        ticket,
        lines: [
          `報修單：${ticket.public_id}`,
          '房東已補上協商附件，請到完整紀錄查看。',
        ],
        actions: [
          tenantRepairResponseButton(ticket.public_id, 'negotiate', '前往回覆協商', 'primary', '#1F2937', ticket.tenant_line_user_id),
          repairRecordButton(ticket.public_id),
        ],
      }), `landlord_negotiation_file_${Date.now()}`);
      repairs.advanceRepairSession(db, {
        publicId: session.publicId,
        context: session.context,
        ttlMinutes: 45,
      });
      return { handled: true, messages: [landlordNegotiationFlowText('已把協商附件通知房客。可繼續補充，或按「完成回覆」結束。')] };
    }
    return { handled: true, messages: [landlordNegotiationFlowText('請輸入要回覆給房客的協商內容，或上傳附件；完成後按「完成回覆」。')] };
  }

  if (
    session.flowType === 'repair_close'
    && session.stepCode === 'await_tenant_confirmation'
    && ['supplement', 'negotiation'].includes(session.context.mode)
  ) {
    const isNegotiation = session.context.mode === 'negotiation';
    const doneText = isNegotiation ? '完成協商' : '完成補充';
    const flowText = isNegotiation ? negotiationFlowText : supplementFlowText;
    const ticket = repairs.getRepairContext(db, session.context.ticketPublicId);
    if (!ticket) {
      repairs.finishRepairSession(db, session.publicId, 'missing_ticket');
      return { handled: true, messages: [text(`找不到這張報修單，${isNegotiation ? '協商' : '補充'}流程已結束。`)] };
    }
    if (ticket.tenant_user_id !== identity.user_id) {
      repairs.finishRepairSession(db, session.publicId, 'forbidden');
      return { handled: true, messages: [text(`你沒有這張報修單的${isNegotiation ? '協商' : '補充'}權限。`)] };
    }
    if (messageType === 'text' && rawText === doneText) {
      repairs.finishRepairSession(db, session.publicId, 'completed');
      return { handled: true, messages: [text(`已結束${isNegotiation ? '協商' : '補充'}流程。後續房東回覆會再通知你。`)] };
    }

    if (messageType === 'text') {
      const update = repairs.addRepairUpdate(db, {
        repairTicketId: ticket.id,
        updateType: 'message',
        messageText: isNegotiation
          ? `AI 協商轉述：房客表示「${rawText}」。請房東重新評估責任、費用或處理方式。`
          : `房客補充說明：${rawText}`,
        createdByUserId: identity.user_id,
      });
      await notifyLandlordsRepairUpdate(db, lineClient, ticket, {
        unitLabel: ticket.unit_label,
        tenantName: ticket.tenant_name || identity.display_name_cache || '房客',
        scope: session.context.scope,
        fallbackLineUserId: lineUserId,
        latestNegotiationText: isNegotiation ? rawText : '',
        notificationKey: isNegotiation ? `tenant_negotiation_text_${update.public_id}` : '',
      }, isNegotiation ? 'tenant_negotiation_text' : 'tenant_supplement_text');
      repairs.advanceRepairSession(db, {
        publicId: session.publicId,
        context: session.context,
        ttlMinutes: 45,
      });
      return { handled: true, messages: [flowText(`已${isNegotiation ? '送出協商說明' : '補充說明'}並通知房東。可繼續${isNegotiation ? '協商' : '補充'}，或按「${doneText}」結束。`)] };
    }

    if (['image', 'video', 'file'].includes(messageType)) {
      const update = repairs.addRepairUpdate(db, {
        repairTicketId: ticket.id,
        updateType: 'photo',
        messageText: isNegotiation ? '房客協商附件' : '房客補充附件',
        createdByUserId: identity.user_id,
      });
      await attachLineContentToUpdate({ db, event, updateId: update.id, userId: identity.user_id, purpose: 'supplement' });
      await notifyLandlordsRepairUpdate(db, lineClient, ticket, {
        unitLabel: ticket.unit_label,
        tenantName: ticket.tenant_name || identity.display_name_cache || '房客',
        scope: session.context.scope,
        fallbackLineUserId: lineUserId,
        notificationKey: isNegotiation ? `tenant_negotiation_file_${update.public_id}` : '',
      }, isNegotiation ? 'tenant_negotiation_file' : 'tenant_supplement_file');
      repairs.advanceRepairSession(db, {
        publicId: session.publicId,
        context: session.context,
        ttlMinutes: 45,
      });
      return { handled: true, messages: [flowText(`已${isNegotiation ? '送出協商附件' : '補充附件'}並通知房東。可繼續${isNegotiation ? '協商' : '補充'}，或按「${doneText}」結束。`)] };
    }

    return { handled: true, messages: [flowText(`請傳文字、照片、影片或檔案${isNegotiation ? '協商' : '補充資料'}；完成後按「${doneText}」。`)] };
  }

  if (session.flowType === 'repair_report') {
    if (session.stepCode === 'await_description') {
      const preference = parseRepairPreference(rawText);
      if (messageType === 'text' && preference) {
        repairs.advanceRepairSession(db, {
          publicId: session.publicId,
          context: {
            ...session.context,
            tenantRepairPreference: preference.code,
            tenantRepairPreferenceLabel: preference.label,
          },
          ttlMinutes: 45,
        });
        return { handled: true, messages: [repairFlowText(`已記錄你的意願：${preference.label}。接著請用一句話描述損壞狀況，或上傳損壞照片。`)] };
      }

      if (['image', 'video', 'file'].includes(messageType)) {
        const file = await saveLineContentAsFile({ db, event, userId: identity.user_id });
        const pendingDamageFileIds = [
          ...(Array.isArray(session.context.pendingDamageFileIds) ? session.context.pendingDamageFileIds : []),
          file.id,
        ];
        repairs.advanceRepairSession(db, {
          publicId: session.publicId,
          context: {
            ...session.context,
            pendingDamageFileIds,
            pendingPhotoCount: pendingDamageFileIds.length,
          },
          ttlMinutes: 45,
        });
        return {
          handled: true,
          messages: [{
            ...repairNoticeCard({
              icon: '📸',
              title: '已收到損壞照片',
              tag: `${pendingDamageFileIds.length} 張`,
              lines: [
                session.context.unitLabel || '目前租賃單位',
                '請再用一句話描述損壞狀況。',
                '例如：滑鼠壞掉、客廳插座接觸不良。',
              ],
            }),
            quickReply: repairFlowText('').quickReply,
          }],
        };
      }

      if (messageType !== 'text' || !rawText) {
        return { handled: true, messages: [repairFlowText('可以先用一句話描述損壞狀況，也可以先上傳損壞照片。')] };
      }

      const pendingTicketPublicIds = await createTicketsFromPendingFiles({
        db,
        session,
        identity,
        description: rawText,
          lineClient,
          fallbackLineUserId: lineUserId,
        });

      if (pendingTicketPublicIds.length) {
        repairs.advanceRepairSession(db, {
          publicId: session.publicId,
          stepCode: 'collecting_photos',
          context: {
            ...session.context,
            description: rawText,
            photoCount: pendingTicketPublicIds.length,
            ticketPublicIds: pendingTicketPublicIds,
            pendingDamageFileIds: [],
            pendingPhotoCount: 0,
          },
          ttlMinutes: 45,
        });
        return { handled: true, messages: [repairFlowText(`已用剛才的 ${pendingTicketPublicIds.length} 張照片建立 ${pendingTicketPublicIds.length} 張 TK。可繼續上傳照片，或按「完成報修」。`, { includeComplete: true })] };
      }

      repairs.advanceRepairSession(db, {
        publicId: session.publicId,
        stepCode: 'collecting_photos',
        context: { ...session.context, description: rawText, photoCount: 0, ticketPublicIds: [] },
        ttlMinutes: 45,
      });
      return {
        handled: true,
        messages: [{
          ...repairNoticeCard({
            icon: '📸',
            title: '請上傳損壞照片',
            tag: '必填',
            lines: [
              session.context.unitLabel || '目前租賃單位',
              `報修內容：${rawText}`,
              '可連續上傳多張照片；每張照片會建立一張 TK。',
              '傳完後按「完成報修」。',
            ],
          }),
          quickReply: repairFlowText('', { includeComplete: true }).quickReply,
        }],
      };
    }

    if (session.stepCode === 'collecting_photos') {
      const preference = parseRepairPreference(rawText);
      if (messageType === 'text' && preference) {
        repairs.advanceRepairSession(db, {
          publicId: session.publicId,
          context: {
            ...session.context,
            tenantRepairPreference: preference.code,
            tenantRepairPreferenceLabel: preference.label,
          },
          ttlMinutes: 45,
        });
        return { handled: true, messages: [repairFlowText(`已記錄你的意願：${preference.label}。可繼續上傳照片，或按「完成報修」。`, { includeComplete: true })] };
      }

      if (['image', 'video', 'file'].includes(messageType)) {
        const photoCount = Number(session.context.photoCount || 0) + 1;
        const { ticket, update } = createTicketFromSession(db, session, identity, session.context.description, photoCount);
        await attachLineContentToUpdate({ db, event, updateId: update.id, userId: identity.user_id, purpose: 'damage_photo' });
        const ticketPublicIds = [...(session.context.ticketPublicIds || []), ticket.public_id];
        repairs.advanceRepairSession(db, {
          publicId: session.publicId,
          context: { ...session.context, photoCount, ticketPublicIds },
          ttlMinutes: 45,
        });
        return { handled: true, messages: [repairFlowText(`已建立 ${ticketLabel(ticket)}。可繼續上傳照片，或按「完成報修」。`, { includeComplete: true })] };
      }

      if (messageType === 'text' && rawText === '完成報修') {
        let ticketPublicIds = session.context.ticketPublicIds || [];
        if (!ticketPublicIds.length) {
        return {
          handled: true,
          messages: [{
            ...repairNoticeCard({
              icon: '📸',
              title: '還缺損壞照片',
              tag: '照片必填',
              lines: [
                session.context.unitLabel || '目前租賃單位',
                '請至少上傳 1 張損壞照片，再按「完成報修」。',
                '這樣房東端才會看到可存證的報修卡。',
              ],
            }),
            quickReply: repairFlowText('', { includeComplete: true }).quickReply,
          }],
        };
      }
        repairs.finishRepairSession(db, session.publicId, 'completed');
        for (const ticketPublicId of ticketPublicIds) {
          const ticket = repairs.getRepairContext(db, ticketPublicId);
          if (!ticket) continue;
          await notifyLandlords(db, lineClient, ticket, {
            unitLabel: ticket.unit_label || session.context.unitLabel,
            tenantName: identity.display_name_cache || '房客',
            tenantRepairPreference: session.context.tenantRepairPreferenceLabel || '',
            fallbackLineUserId: lineUserId,
          });
        }
        return {
          handled: true,
          messages: [repairNoticeCard({
            icon: '✅',
            title: '報修已送出',
            tag: '房客端',
            lines: [
              `共建立 ${ticketPublicIds.length} 張 TK。`,
              '房東端會收到獨立通知卡，後續進度會在「租屋通知」與報修進度中追蹤。',
            ],
            actions: [
              messageButton('報修進度', '報修進度', 'primary', '#3F4A2F'),
            ],
          })],
        };
      }

      return { handled: true, messages: [repairFlowText('可繼續上傳照片，或按「完成報修」。', { includeComplete: true })] };
    }
  }

  if (session.flowType === 'repair_close') {
    const ticket = repairs.getRepairContext(db, session.context.ticketPublicId);
    if (!ticket) {
      repairs.finishRepairSession(db, session.publicId, 'missing_ticket');
      return { handled: true, messages: [text('找不到這張報修單，流程已結束。')] };
    }

    if (session.stepCode === 'await_completion_photo') {
      if (!['image', 'video', 'file'].includes(messageType)) {
        return { handled: true, messages: [text('結案前請先上傳修好後的照片。')] };
      }
      const update = repairs.addRepairUpdate(db, {
        repairTicketId: ticket.id,
        updateType: 'photo',
        messageText: '修復後照片',
        createdByUserId: identity.user_id,
      });
      await attachLineContentToUpdate({ db, event, updateId: update.id, userId: identity.user_id, purpose: 'completion_photo' });
      const updated = repairs.changeRepairStatus(db, {
        ticketPublicId: ticket.public_id,
        toStatus: 'landlord_completed',
        messageText: '房客已上傳修好後照片，等待房東確認。',
        createdByUserId: identity.user_id,
      });
      repairs.finishRepairSession(db, session.publicId, 'completed');
      await notifyLandlordsRepairUpdate(db, lineClient, updated, {
        unitLabel: ticket.unit_label,
        tenantName: ticket.tenant_name || identity.display_name_cache || '房客',
        fallbackLineUserId: lineUserId,
      }, 'completion_photo_uploaded');
      return {
        handled: true,
        messages: [tenantRepairStatusCard({
          title: '修好照片已送出',
          tag: '待房東確認',
          ticket: {
            ...ticket,
            status: updated.status,
            completion_photo_count: Number(ticket.completion_photo_count || 0) + 1,
          },
          lines: [
            `報修單：${ticket.public_id}`,
            '房東確認後，這張報修單才會正式結案。',
          ],
          actions: [repairRecordButton(ticket.public_id, 'primary', '#1F2937')],
        })],
      };
    }

    if (session.stepCode === 'await_tenant_confirmation' && messageType === 'text') {
      if (/^(OK|Ok|ok|已解決|好了|確認OK)$/.test(rawText)) {
        repairs.confirmRepair(db, { ticketPublicId: ticket.public_id, confirmedByUserId: identity.user_id, result: 'resolved' });
        repairs.finishRepairSession(db, session.publicId, 'completed');
        return { handled: true, messages: [text(`已結案：${ticket.public_id}。修復照片與確認紀錄已保存。`)] };
      }
      if (/仍有問題|沒好|未解決|不OK/.test(rawText)) {
        repairs.confirmRepair(db, { ticketPublicId: ticket.public_id, confirmedByUserId: identity.user_id, result: 'still_has_problem', note: rawText });
        repairs.finishRepairSession(db, session.publicId, 'reopened');
        return { handled: true, messages: [text(`已重新開啟：${ticket.public_id}。房東待辦會繼續顯示這張報修單。`)] };
      }
      return { handled: true, messages: [text('請回覆「OK」結案，或回覆「仍有問題」。')] };
    }
  }

  return { handled: false, messages: [] };
}

function startTenantCloseFlow(db, ticket, tenantLineUserId, message) {
  const identity = repairs.getLineIdentity(db, tenantLineUserId);
  if (!identity) return;
  repairs.startRepairSession(db, {
    lineIdentityId: identity.line_identity_id,
    repairTicketId: ticket.id,
    leaseId: ticket.lease_id,
    rentalUnitId: ticket.rental_unit_id,
    flowType: 'repair_close',
    stepCode: 'await_completion_photo',
    context: { ticketPublicId: ticket.public_id },
    ttlMinutes: 60,
  });
  return message;
}

async function handleRepairPostback(event, lineClient) {
  const params = new URLSearchParams(String(event.postback && event.postback.data || ''));
  const action = params.get('action');
  if (!['repair_update', 'repair_landlord_negotiate'].includes(action)) return { handled: false, messages: [] };
  const db = getDb();
  const identity = repairs.getLineIdentity(db, event.source && event.source.userId);
  if (!identity) return { handled: true, messages: [text('找不到操作者身分。')] };
  const ticketPublicId = params.get('id');
  const next = params.get('next');
  const allowDemoAction = params.get('scope') === 'demo_all' && process.env.NODE_ENV !== 'production';
  const context = repairs.getRepairContext(db, ticketPublicId);
  if (!context) return { handled: true, messages: [text('找不到這張報修單。')] };
  if (!allowDemoAction && !repairs.canManageRepairTicket(db, ticketPublicId, identity.user_id)) {
    return { handled: true, messages: [text('你沒有這張報修單的處理權限。')] };
  }

  if (action === 'repair_landlord_negotiate') {
    repairs.startRepairSession(db, {
      lineIdentityId: identity.line_identity_id,
      repairTicketId: context.id,
      leaseId: context.lease_id,
      rentalUnitId: context.rental_unit_id,
      flowType: 'repair_close',
      stepCode: 'await_tenant_confirmation',
      context: {
        ticketPublicId,
        mode: 'landlord_negotiation',
        scope: params.get('scope') || '',
      },
      ttlMinutes: 45,
    });
    return {
      handled: true,
      messages: [repairNoticeCard({
        icon: '💬',
        title: '回覆房客協商',
        tag: '房東端',
        role: 'landlord',
        lines: [
          context.unit_label || '報修案件',
          `報修單：${ticketPublicId}`,
          '請直接輸入要回覆給房客的協商內容，例如：可由房客先找人修，5000 元內憑收據報帳。',
          '每一則回覆都會通知房客並保存到完整紀錄。',
        ],
        actions: [
          messageButton('完成回覆', '完成回覆', 'primary', '#1F2937'),
          messageButton('取消', '取消'),
        ],
      })],
    };
  }

  // 房東本人或廠商修好時，必須由處理端回傳照片與憑證；不能直接把
  // 案件改成完成，或錯誤要求房客補修好照片。
  if (next === 'landlord_completed') {
    const query = new URLSearchParams({ lineUserId: String(event.source?.userId || '') });
    if (params.get('scope')) query.set('scope', params.get('scope'));
    return {
      handled: true,
      messages: [tenantRepairStatusCard({
        title: '回傳修好證據',
        tag: '外部處理',
        ticket: context,
        lines: [
          '請由房東本人或安排的維修人員上傳至少一張修好後照片。',
          '可一併附收據、報價、維修說明與實際金額；送出後會通知房客。',
        ],
        actions: [{
          type: 'button', style: 'primary', height: 'sm', color: '#1F2937',
          action: {
            type: 'uri',
            label: '前往回傳證據',
            uri: externalPageUrl(`/landlord/repairs/${encodeURIComponent(ticketPublicId)}/completion?${query.toString()}`),
          },
        }],
      })],
    };
  }

  if (!['in_progress', 'tenant_self_repair', 'tenant_pays', 'need_info', 'vendor_judgement', 'landlord_completed', 'landlord_confirmed', 'reopen'].includes(next)) {
    return { handled: true, messages: [text('這個報修狀態操作不支援。')] };
  }

  if (next === 'landlord_confirmed') {
    const settlementResolved = ['completed', 'not_required', 'waived'].includes(String(context.settlement_status || ''));
    if (!settlementResolved) {
      return {
        handled: true,
        messages: [text('修繕完成後仍需先確認費用結算，不能直接結案。請從外部案件頁選「確認修復並處理費用」，完成後再確認結案。')],
      };
    }
    const updated = repairs.confirmRepair(db, {
      ticketPublicId,
      confirmedByUserId: identity.user_id,
      result: 'resolved',
      note: '房東確認修繕完成。',
    });
    const updatedContext = repairs.getRepairContext(db, ticketPublicId) || { ...context, ...updated };
    await notifyTenant(db, lineClient, updatedContext, tenantRepairStatusCard({
      title: '報修已結案',
      tag: '已完成',
      // 網頁路由會在此後同步 workflow 的 case_status；推播本身先以結案狀態
      // 組卡，避免房客收到「還在等待房東結案」這種已過時的文案。
      ticket: { ...updatedContext, status: 'tenant_confirmed', case_status: 'closed' },
      lines: [
        `報修單：${ticketPublicId}`,
        '房東已確認修繕完成。',
        '損壞照片、修好後照片與確認紀錄都已保存。',
      ],
      actions: [repairRecordButton(ticketPublicId, 'primary', '#1F2937')],
    }), 'landlord_confirmed');
    return { handled: true, messages: [text(`已確認完成：${ticketPublicId}。修繕紀錄已保存。`)] };
  }

  if (next === 'reopen') {
    const updated = repairs.confirmRepair(db, {
      ticketPublicId,
      confirmedByUserId: identity.user_id,
      result: 'still_has_problem',
      note: '房東退回修繕結案，需再處理。',
    });
    const updatedContext = repairs.getRepairContext(db, ticketPublicId) || { ...context, ...updated };
    await notifyTenant(db, lineClient, updatedContext, tenantRepairStatusCard({
      title: '報修被退回',
      tag: '需再處理',
      ticket: { ...updatedContext, status: 'reopened' },
      lines: [
        `報修單：${ticketPublicId}`,
        '房東退回這張報修單，請再補充或重新處理。',
        '處理後請再上傳修好後照片。',
      ],
      actions: [
        tenantCloseStartButton(ticketPublicId, '回傳照片'),
        repairRecordButton(ticketPublicId),
      ],
    }), 'reopened_by_landlord');
    if (context.tenant_line_user_id) {
      startTenantCloseFlow(db, updated, context.tenant_line_user_id);
    }
    return { handled: true, messages: [text(`已退回：${ticketPublicId}。房客端會重新進入修繕回報流程。`)] };
  }

  if (next === 'tenant_pays' || next === 'need_info') {
    const analysis = buildRepairAssistantAnalysis({
      description: context.description,
      photoCount: context.damage_photo_count,
      unitLabel: context.unit_label,
    });
    const isTenantPays = next === 'tenant_pays';
    const note = isTenantPays
      ? '房東提出：此案件可能需由房客負擔，請房客確認或進入協商。'
      : '房東請房客補充資料，需提供更多描述、照片或使用情境後再判斷。';
    // This action is an actual hand-off, not merely a LINE notification.
    // Persist it first so the tenant web page knows whether to show the
    // supplement card or the responsibility-confirmation card.
    repairs.changeRepairStatus(db, {
      ticketPublicId,
      // `repair_tickets.status` is the legacy lifecycle field.  Keep its
      // value within the database enum; the detailed hand-off lives in the
      // workflow fields written below.
      toStatus: isTenantPays ? 'accepted' : 'reported',
      messageText: `${note}\n${analysis.recordText}`,
      createdByUserId: identity.user_id,
    });
    const handedOffContext = repairs.updateRepairWorkflowState(db, {
      ticketPublicId,
      liabilityStatus: isTenantPays ? 'proposed' : undefined,
      repairStatus: 'reported',
      actionOwner: 'tenant',
      waitingOn: 'tenant',
      caseStatus: 'open',
    });
    const tenantMessage = tenantRepairStatusCard({
      title: isTenantPays ? '房東提出修繕責任協商' : '房東請你補充報修資料',
      tag: isTenantPays ? '待確認' : '補資料',
      ticket: handedOffContext,
      lines: isTenantPays ? [
        `報修單：${ticketPublicId}`,
        '房東認為此案件可能需要由房客負擔，請確認是否接受。',
        repairBasisLine(handedOffContext),
        '若不同意，可按「我要協商」或補充原因；系統會保存協商紀錄。',
      ] : [
        `報修單：${ticketPublicId}`,
        '房東需要更多資訊，請補充損壞原因、發生時間、是否可正常使用，或再補照片。',
        repairBasisLine(handedOffContext),
      ],
      actions: isTenantPays ? [
        tenantRepairResponseButton(ticketPublicId, 'accept', '接受目前處理方案', 'primary', '#1F2937', handedOffContext.tenant_line_user_id),
        tenantRepairResponseButton(ticketPublicId, 'negotiate', '我要協商', 'secondary', undefined, handedOffContext.tenant_line_user_id),
        tenantRepairResponseButton(ticketPublicId, 'supplement', '補充說明', 'secondary', undefined, handedOffContext.tenant_line_user_id),
        repairRecordButton(ticketPublicId),
      ] : [
        tenantRepairResponseButton(ticketPublicId, 'supplement', '補充說明', 'primary', '#1F2937', handedOffContext.tenant_line_user_id),
        repairRecordButton(ticketPublicId),
      ],
    });
    await notifyTenant(db, lineClient, handedOffContext, tenantMessage, next);
    return { handled: true, messages: [text(`已通知房客：${isTenantPays ? '確認修繕責任/費用負擔' : '補充報修資料'}。`)] };
  }

  let toStatus = next;
  let note = '';
  if (next === 'tenant_self_repair') {
    // Detailed execution ownership is stored in dispatch_party/action_owner;
    // the legacy status column intentionally stays inside its CHECK enum.
    toStatus = 'accepted';
    note = '房東同意房客自修，修好後需上傳照片確認。';
  } else if (next === 'in_progress') {
    note = '房東已受理派修。';
  } else if (next === 'vendor_judgement') {
    toStatus = 'in_progress';
    note = '房東將請維修人員判斷損壞原因，再確認責任與費用。';
  } else if (next === 'landlord_completed') {
    note = '房東標記已修復，等待房客上傳修復後照片並確認。';
  }
  const updated = repairs.changeRepairStatus(db, {
    ticketPublicId,
    toStatus,
    messageText: note,
    createdByUserId: identity.user_id,
  });
  const updatedContext = next === 'tenant_self_repair'
    ? repairs.updateRepairWorkflowState(db, {
      ticketPublicId,
      dispatchParty: 'tenant',
      repairStatus: 'awaiting_execution',
      appointmentStatus: 'not_required',
      actionOwner: 'tenant',
      waitingOn: 'tenant',
      caseStatus: 'open',
    })
    : repairs.getRepairContext(db, ticketPublicId) || { ...context, ...updated };

  const tenantMessage = (() => {
    if (next === 'tenant_self_repair') {
      return tenantRepairStatusCard({
        title: '房東同意房客自修',
        tag: '可自修',
        ticket: { ...context, ...updated, status: updated.status },
        lines: [
          `報修單：${ticketPublicId}`,
          '修好後請回傳照片，房東確認後才會結案。',
        ],
        actions: [
          tenantCloseStartButton(ticketPublicId, '回傳照片'),
          repairRecordButton(ticketPublicId),
        ],
      });
    }
    if (next === 'vendor_judgement') {
      return tenantRepairStatusCard({
        title: '房東將請維修人員判斷',
        tag: '待確認',
        ticket: { ...updatedContext, status: 'in_progress' },
        lines: [
          `報修單：${ticketPublicId}`,
          '房東會先請維修人員確認損壞原因，再決定責任與費用。',
          repairBasisLine(updatedContext),
        ],
        actions: [repairRecordButton(ticketPublicId, 'primary', '#1F2937')],
      });
    }
    if (next === 'landlord_completed') {
      return tenantRepairStatusCard({
        title: '房東標記修繕完成',
        tag: '請回傳照片',
        ticket: { ...context, ...updated, status: updated.status },
        lines: [
          `報修單：${ticketPublicId}`,
          '請上傳「修好後的照片」。上傳後會通知房東確認，房東確認後才會結案。',
        ],
        actions: [
          tenantCloseStartButton(ticketPublicId, '回傳照片'),
          repairRecordButton(ticketPublicId),
        ],
      });
    }
    return tenantRepairStatusCard({
      title: next === 'in_progress' ? '房東已受理派修' : '報修狀態更新',
      tag: repairStatusText(updated.status, updated),
      ticket: { ...context, ...updated, status: updated.status },
      lines: [`報修單：${ticketPublicId}`, note || '報修狀態已更新。'],
      actions: [repairRecordButton(ticketPublicId, 'primary', '#1F2937')],
    });
  })();

  if ((next === 'tenant_self_repair' || next === 'landlord_completed') && context.tenant_line_user_id) {
    startTenantCloseFlow(db, updated, context.tenant_line_user_id, tenantMessage);
  }
  if (context.tenant_user_id || context.tenant_line_identity_id) {
    await notifications.recordNotificationDelivery({
      db,
      lineClient,
      message: tenantMessage,
      notification: {
        publicId: `notif-repair-status-${ticketPublicId}-${next}-${updated.status}`,
        eventType: 'repair_status_updated',
        entityType: 'repair_ticket',
        entityId: ticketPublicId,
        templateCode: 'line_repair_status',
        payload: {
          ticketPublicId,
          unitLabel: context.unit_label,
          status: updated.status,
          statusText: repairStatusText(updated.status),
          note,
        },
      },
      recipient: {
        userId: context.tenant_user_id,
        lineIdentityId: context.tenant_line_identity_id,
        lineUserId: context.tenant_line_user_id,
      },
      idempotencyKey: `repair_status:${ticketPublicId}:${next}:${updated.status}:tenant:${context.tenant_user_id || context.tenant_line_identity_id}:line`,
    }).catch((err) => console.error('Failed to notify repair status tenant:', err.message));
  }

  return { handled: true, messages: [text(`已更新 ${ticketPublicId}：${repairStatusText(updated.status)}。${note}`.trim())] };
}

function repairRecordButton(ticketPublicId, style = 'secondary', color) {
  return uriButton('完整紀錄', repairRecordUrl(ticketPublicId), style, color);
}

function tenantCloseStartButton(ticketPublicId, label = '回傳照片', lineUserId = '') {
  return uriButton(label, repairSupplementUrl(ticketPublicId, 'completion', lineUserId), 'primary', '#1F2937');
}

async function handleUrgentRepairContact({ lineUserId, ticketPublicId, lineClient } = {}) {
  const db = getDb();
  const { identity, error } = findIdentityOrReply(db, lineUserId);
  if (error) return { handled: true, messages: [text(error)] };
  const ticket = repairs.getRepairContext(db, ticketPublicId);
  if (!ticket || Number(ticket.tenant_user_id || ticket.reported_by_user_id) !== Number(identity.user_id)) {
    return { handled: true, messages: [text('找不到這筆緊急報修，請從案件卡片重新開啟。')] };
  }
  repairs.addRepairUpdate(db, {
    repairTicketId: ticket.id,
    updateType: 'urgent_contact',
    fromStatus: ticket.status,
    toStatus: ticket.status,
    messageText: '房客透過緊急案件發出聯絡房東提醒。',
    createdByUserId: identity.user_id,
  });
  repairs.startRepairSession(db, {
    lineIdentityId: identity.line_identity_id,
    repairTicketId: ticket.id,
    leaseId: ticket.lease_id,
    rentalUnitId: ticket.rental_unit_id,
    flowType: 'urgent_repair_contact',
    stepCode: 'await_message',
    context: { ticketPublicId: ticket.public_id },
    ttlMinutes: 15,
  });
  const updatedTicket = repairs.getRepairContext(db, ticket.public_id) || ticket;
  if (lineClient) {
    await notifyLandlordsRepairUpdate(db, lineClient, updatedTicket, {
      unitLabel: updatedTicket.unit_label,
      tenantName: updatedTicket.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: lineUserId,
    }, 'urgent_tenant_contact');
  }
  return {
    handled: true,
    messages: [text('已通知房東這筆緊急案件需要聯絡。請直接輸入要告知房東的情況；你的下一則訊息會同步顯示在房東的案件通知與完整紀錄。若有立即危險，請先遠離危險設備並使用「立即撥打房東」或聯絡緊急專業人員。')],
  };
}

function tenantRepairResponseButton(ticketPublicId, decision, label, style = 'secondary', color, lineUserId = '') {
  if (decision === 'supplement' || decision === 'negotiate') {
    return uriButton(label, repairSupplementUrl(ticketPublicId, decision, lineUserId), style, color);
  }
  return {
    type: 'button',
    style,
    height: 'sm',
    color,
    action: {
      type: 'postback',
      label,
      displayText: label,
      data: `action=tenant_repair_response&id=${encodeURIComponent(ticketPublicId)}&decision=${encodeURIComponent(decision)}`,
    },
  };
}

async function handleTenantRepairPostback(event, lineClient = require('../lineClient').client) {
  const params = new URLSearchParams(String(event.postback && event.postback.data || ''));
  if (!['tenant_repair_close_start', 'tenant_repair_response', 'tenant_repair_appointment', 'tenant_repair_appointment_time'].includes(params.get('action'))) return { handled: false, messages: [] };

  const db = getDb();
  const identity = repairs.getLineIdentity(db, event.source && event.source.userId);
  if (!identity) return { handled: true, messages: [text('找不到你的房客身分，暫時無法回傳報修進度。')] };

  const ticketPublicId = params.get('id');
  const context = repairs.getRepairContext(db, ticketPublicId);
  if (!context) return { handled: true, messages: [text('找不到這張報修單。')] };
  if (context.tenant_user_id !== identity.user_id) {
    return { handled: true, messages: [text('你沒有這張報修單的回傳權限。')] };
  }
  if (params.get('action') === 'tenant_repair_appointment') {
    const decision = params.get('decision');
    if (!['accept', 'reschedule'].includes(decision)) {
      return { handled: true, messages: [text('找不到這次預約回覆。')] };
    }
    const messageText = decision === 'accept'
      ? '房客確認預約時間可以，等待房東／維修人員依約到場。'
      : '房客希望改期，等待房東重新提出修繕時間。';
    repairs.addRepairUpdate(db, {
      repairTicketId: context.id,
      // repair_updates currently persists the appointment lifecycle under the
      // existing `appointment` event type; the response detail is retained in
      // the message and notification event instead of inventing an invalid DB value.
      updateType: 'appointment',
      messageText,
      createdByUserId: identity.user_id,
    });
    const updatedContext = repairs.getRepairContext(db, ticketPublicId) || context;
    await notifyLandlordsRepairUpdate(db, lineClient, updatedContext, {
      unitLabel: updatedContext.unit_label,
      tenantName: updatedContext.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: event.source && event.source.userId,
    }, `tenant_appointment_${decision}`);
    if (decision === 'accept') {
      return { handled: true, messages: [text('已回覆時間可以，已通知房東。')] };
    }
    return {
      handled: true,
      messages: [tenantRepairStatusCard({
        title: '選擇希望改期時段',
        tag: '改期',
        ticket: updatedContext,
        lines: ['請先選擇較方便的時段；房東會依此重新安排。'],
        actions: [
          postback('上午', `action=tenant_repair_appointment_time&id=${encodeURIComponent(ticketPublicId)}&preference=morning`, 'primary', '#1F2937'),
          postback('下午', `action=tenant_repair_appointment_time&id=${encodeURIComponent(ticketPublicId)}&preference=afternoon`),
          postback('晚上', `action=tenant_repair_appointment_time&id=${encodeURIComponent(ticketPublicId)}&preference=evening`),
        ],
      })],
    };
  }
  if (params.get('action') === 'tenant_repair_appointment_time') {
    const preference = params.get('preference');
    const preferenceLabel = ({ morning: '上午', afternoon: '下午', evening: '晚上' })[preference];
    if (!preferenceLabel) return { handled: true, messages: [text('找不到你選擇的改期時段。')] };
    repairs.addRepairUpdate(db, {
      repairTicketId: context.id,
      updateType: 'appointment',
      messageText: `房客希望改約：${preferenceLabel}時段。`,
      createdByUserId: identity.user_id,
    });
    const updatedContext = repairs.getRepairContext(db, ticketPublicId) || context;
    await notifyLandlordsRepairUpdate(db, lineClient, updatedContext, {
      unitLabel: updatedContext.unit_label,
      tenantName: updatedContext.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: event.source && event.source.userId,
    }, 'tenant_appointment_reschedule_preference');
    return { handled: true, messages: [text(`已記錄希望改約${preferenceLabel}，並通知房東重新安排。`)] };
  }
  if (params.get('action') === 'tenant_repair_response') {
    const decision = params.get('decision');
    const decisionText = {
      accept: '房客接受目前處理方案；後續仍需安排修繕、確認報價／收據與實際金額。',
      reject: '房客不同意房東提出的修繕條件，需再協商。',
      negotiate: '房客希望協商修繕責任、費用或處理方式。',
      supplement: '房客希望補充說明或提供更多資料。',
    }[decision] || '房客回覆修繕協商。';
    let updatedContext = context;
    if (decision === 'accept') {
      const updated = repairs.changeRepairStatus(db, {
        ticketPublicId,
        toStatus: 'accepted',
        messageText: decisionText,
        createdByUserId: identity.user_id,
      });
      // 房客接受的是本次「責任／費用方向」，不是自行選擇誰來修。
      // 下一步交回房東選擇執行方式（房東安排或授權房客自修），
      // 兩種方式都不會改變已確認的房客付款責任。
      repairs.updateRepairWorkflowState(db, {
        ticketPublicId,
        liabilityStatus: 'confirmed',
        repairStatus: 'awaiting_execution',
        actionOwner: 'landlord',
        waitingOn: 'none',
      });
      updatedContext = repairs.getRepairContext(db, ticketPublicId) || { ...context, ...updated };
    } else {
      repairs.addRepairUpdate(db, {
        repairTicketId: context.id,
        updateType: 'message',
        messageText: decisionText,
        createdByUserId: identity.user_id,
      });
    }
    await notifyLandlordsRepairUpdate(db, lineClient, updatedContext, {
      unitLabel: updatedContext.unit_label,
      tenantName: updatedContext.tenant_name || identity.display_name_cache || '房客',
      fallbackLineUserId: event.source && event.source.userId,
    }, `tenant_response_${decision || 'reply'}`);
    if (decision === 'supplement' || decision === 'negotiate') {
      repairs.startRepairSession(db, {
        lineIdentityId: identity.line_identity_id,
        repairTicketId: context.id,
        leaseId: context.lease_id,
        rentalUnitId: context.rental_unit_id,
        flowType: 'repair_close',
        stepCode: 'await_tenant_confirmation',
        context: {
          ticketPublicId,
          mode: decision === 'negotiate' ? 'negotiation' : 'supplement',
        },
        ttlMinutes: 45,
      });
      if (decision === 'negotiate') {
        return {
          handled: true,
          messages: [negotiationFlowText(`已開啟協商。\n報修單：${ticketPublicId}\n請直接說明你不同意的原因、可接受的金額或希望的處理方式；每一則都會通知房東。\n完成後按「完成協商」。`)],
        };
      }
      return {
        handled: true,
        messages: [supplementFlowText(`已記錄你要補充資料。\n報修單：${ticketPublicId}\n請直接輸入補充說明，或上傳照片／附件；每一則都會通知房東。\n完成後按「完成補充」。`)],
      };
    }
    return { handled: true, messages: [text(`已送出回覆：${decisionText}`)] };
  }
  if (!['in_progress', 'landlord_completed', 'reopened'].includes(String(context.status || ''))) {
    return { handled: true, messages: [text('這張報修單目前還不能回傳修好照片，請等房東受理或同意處理方式。')] };
  }

  const message = repairNoticeCard({
    icon: '📸',
    title: '回傳修好照片',
    tag: '待上傳',
    lines: [
      context.unit_label || '租屋物件',
      `報修單：${ticketPublicId}`,
      '請直接上傳「修好後的照片」。上傳後會通知房東確認，房東確認後才會正式結案。',
    ],
    actions: [messageButton('取消', '取消')],
  });
  startTenantCloseFlow(db, context, event.source && event.source.userId, message);
  return { handled: true, messages: [message] };
}

module.exports = {
  _resetRepairServiceForTests: () => {
    if (dbInstance && dbInstance.open) dbInstance.close();
    dbInstance = null;
  },
  cancelActiveRepairSessionForLineUser,
  handleActiveRepairSession,
  handleRepairCommand,
  handleRepairHistoryCommand,
  handleRepairHistoryCommandAsync,
  handleRepairHistoryCommandConfigured,
  handleRepairPostback,
  handleRepairProgressCommand,
  handleRepairProgressCommandAsync,
  handleRepairProgressCommandConfigured,
  handleRepairStartCommand,
  handleUrgentRepairContact,
  handleTenantRepairPostback,
  notifyLandlords,
  notifyLandlordsRepairUpdate,
  notifyTenant,
  tenantRepairStatusCard,
};
