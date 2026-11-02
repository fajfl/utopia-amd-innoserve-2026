const { buildRepairAssistantAnalysis } = require('./repairAiAssistant');

function money(value) {
  return `NT$ ${Number(value || 0).toLocaleString('zh-TW')}`;
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function shortText(value, max = 18) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '-';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dateText(value) {
  if (!value) return '-';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return String(value);
  return match[4] ? `${match[2]}/${match[3]} ${match[4]}:${match[5]}` : `${match[2]}/${match[3]}`;
}

function externalPageUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const liffId = process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
  if (process.env.LINE_USE_MINIAPP_URLS !== 'false' && liffId) {
    return `https://miniapp.line.me/${encodeURIComponent(liffId)}${normalizedPath}`;
  }
  const baseUrl = (process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${baseUrl}${normalizedPath}`;
}

function publicWebUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const baseUrl = (process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${baseUrl}${normalizedPath}`;
}

function repairFileUrl(filePublicId) {
  if (!filePublicId) return null;
  return publicWebUrl(`/v2/repair-files/${encodeURIComponent(filePublicId)}`);
}

function repairPageUrl(path) {
  return process.env.REPAIR_USE_MINIAPP_URLS === 'true'
    ? externalPageUrl(path)
    : publicWebUrl(path);
}

function repairRecordUrl(ticketPublicId) {
  if (!ticketPublicId) return null;
  return repairPageUrl(`/tenant/repairs/${encodeURIComponent(ticketPublicId)}`);
}

function landlordRepairHistoryUrl(lineUserId, scope) {
  const params = new URLSearchParams();
  if (lineUserId) params.set('lineUserId', lineUserId);
  if (scope) params.set('scope', scope);
  params.set('status', 'history');
  const query = params.toString() ? `?${params.toString()}` : '';
  return repairPageUrl(`/landlord/repairs${query}`);
}

function landlordRepairActiveUrl(lineUserId, scope) {
  const params = new URLSearchParams();
  if (lineUserId) params.set('lineUserId', lineUserId);
  if (scope) params.set('scope', scope);
  params.set('status', 'open');
  const query = params.toString() ? `?${params.toString()}` : '';
  return repairPageUrl(`/landlord/repairs${query}`);
}

function landlordRepairDetailUrl(ticketPublicId, lineUserId, scope) {
  const params = new URLSearchParams();
  if (lineUserId) params.set('lineUserId', lineUserId);
  if (scope) params.set('scope', scope);
  const query = params.toString() ? `?${params.toString()}` : '';
  return repairPageUrl(`/landlord/repairs/${encodeURIComponent(ticketPublicId)}${query}`);
}

function landlordRepairNegotiationUrl(ticketPublicId, lineUserId, scope) {
  const params = new URLSearchParams({ mode: 'dispute' });
  if (lineUserId) params.set('lineUserId', lineUserId);
  if (scope) params.set('scope', scope);
  return repairPageUrl(`/landlord/repairs/${encodeURIComponent(ticketPublicId)}/exception?${params.toString()}`);
}

function landlordRepairAdoptRecommendationUrl(ticketPublicId, lineUserId, scope) {
  const params = new URLSearchParams();
  if (lineUserId) params.set('lineUserId', lineUserId);
  if (scope) params.set('scope', scope);
  return repairPageUrl(`/landlord/repairs/${encodeURIComponent(ticketPublicId)}/adopt-recommendation?${params.toString()}`);
}

function landlordTaskCenterUrl(lineUserId, scope, tab = '') {
  const params = new URLSearchParams();
  if (lineUserId) params.set('lineUserId', lineUserId);
  if (scope) params.set('scope', scope);
  if (tab) params.set('tab', tab);
  const query = params.toString() ? `?${params.toString()}` : '';
  return repairPageUrl(`/landlord/tasks${query}`);
}

function targetMonthText(overview) {
  return String(overview.targetMonth || '').replace('-', '/') || '本月';
}

function statusLabel(status) {
  return ({
    pending: '待處',
    notified: '通知',
    answered: '已答',
    reported: '通報',
    accepted: '受理',
    in_progress: '處理',
    landlord_completed: '待確認',
    tenant_confirmed: '已結案',
    reopened: '退回',
    cancelled: '取消',
    rejected: '拒絕',
    submitted: '送出',
    under_review: '審核',
    contracting: '簽約',
    scheduled: '排程',
    paid: '已繳',
    partially_paid: '部分',
    overdue: '逾期',
    urgent: '急',
    high: '高',
    completed: '完成',
  })[status] || status || '-';
}

function statusTone(status, done = false) {
  if (done || ['answered', 'paid', 'completed', 'tenant_confirmed'].includes(status)) {
    return { color: '#047857', bg: '#ECFDF5' };
  }

  if (['overdue', 'urgent', 'high', 'reopened', 'rejected'].includes(status)) {
    return { color: '#B91C1C', bg: '#FEF2F2' };
  }

  if (['pending', 'notified', 'submitted', 'under_review', 'accepted', 'in_progress', 'landlord_completed', 'partially_paid'].includes(status)) {
    return { color: '#B45309', bg: '#FFFBEB' };
  }

  return { color: '#2563EB', bg: '#EFF6FF' };
}

function dashboardAction(label, view, options = {}) {
  const params = new URLSearchParams({
    action: 'dashboard_view',
    view,
    ...(options.params || {}),
  });
  return {
    type: 'postback',
    label,
    displayText: options.displayText || label,
    data: params.toString(),
  };
}

function quickReplyItems(actions) {
  return {
    quickReply: {
      items: actions.map(({ label, view }) => ({
        type: 'action',
        action: dashboardAction(label, view),
      })),
    },
  };
}

function dashboardQuickReplyMessage(text, actions) {
  return {
    type: 'text',
    text,
    ...quickReplyItems(actions),
  };
}

function withDashboardQuickReply(message, actions) {
  return {
    ...message,
    ...quickReplyItems(actions),
  };
}

function actionButton(label, view, style = 'secondary') {
  return {
    type: 'button',
    height: 'sm',
    style,
    color: style === 'primary' ? '#3F4A2F' : undefined,
    action: dashboardAction(label, view),
  };
}

function uriButton(label, uri, style = 'secondary') {
  return {
    type: 'button',
    height: 'sm',
    style,
    color: style === 'primary' ? '#3F4A2F' : undefined,
    action: {
      type: 'uri',
      label,
      uri,
    },
  };
}

function badge(text, color = '#374151', bg = '#F1F5F9') {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: '44px',
    backgroundColor: bg,
    cornerRadius: '999px',
    paddingTop: '2px',
    paddingBottom: '2px',
    paddingStart: '3px',
    paddingEnd: '3px',
    contents: [
      {
        type: 'text',
        text,
        size: 'xxs',
        color,
        weight: 'bold',
        align: 'center',
        maxLines: 1,
      },
    ],
  };
}

function statusBadge(status, done = false) {
  const tone = statusTone(status, done);
  return badge(statusLabel(status), tone.color, tone.bg);
}

function compactCountBadge(text, color = '#374151', bg = '#F1F5F9') {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: '34px',
    height: '24px',
    backgroundColor: bg,
    cornerRadius: '999px',
    justifyContent: 'center',
    alignItems: 'center',
    contents: [
      {
        type: 'text',
        text: String(text),
        size: 'xxs',
        color,
        weight: 'bold',
        align: 'center',
        gravity: 'center',
        maxLines: 1,
      },
    ],
  };
}

function metric(label, value, hint, color = '#1F2937') {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '10px',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#64748B' },
      { type: 'text', text: String(value), size: 'lg', weight: 'bold', color, margin: 'xs', maxLines: 1 },
      ...(hint ? [{ type: 'text', text: hint, size: 'xxs', color: '#64748B', wrap: true, margin: 'xs', maxLines: 2 }] : []),
    ],
  };
}

function row(label, value, color = '#374151') {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#64748B', flex: 5 },
      { type: 'text', text: String(value), size: 'sm', color, weight: 'bold', align: 'end', flex: 7, wrap: true },
    ],
  };
}

function sectionTitle(text, subtext) {
  return {
    type: 'box',
    layout: 'vertical',
    contents: [
      { type: 'text', text, size: 'sm', weight: 'bold', color: '#111827' },
      ...(subtext ? [{ type: 'text', text: subtext, size: 'xs', color: '#64748B', wrap: true, margin: 'xs' }] : []),
    ],
  };
}

function itemCard({ title, subtitle, detail, marker, color = '#374151' }) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '10px',
    spacing: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        alignItems: 'center',
        contents: [
          {
            type: 'text',
            text: shortText(title, 16),
            size: 'sm',
            color,
            weight: 'bold',
            flex: 1,
            maxLines: 1,
          },
          ...(marker ? [{
            type: 'box',
            layout: 'vertical',
            flex: 0,
            contents: [marker],
          }] : []),
        ],
      },
      ...(subtitle ? [{
        type: 'text',
        text: shortText(subtitle, 22),
        size: 'xs',
        color: '#64748B',
        maxLines: 1,
      }] : []),
      ...(detail ? [{
        type: 'text',
        text: shortText(detail, 38),
        size: 'xs',
        color: '#475569',
        wrap: true,
        maxLines: 2,
      }] : []),
    ],
  };
}

function shell(titleText, subtitle, body, footer) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1F2937',
      paddingAll: '13px',
      contents: [
        { type: 'text', text: titleText, color: '#FFFFFF', weight: 'bold', size: 'lg' },
        { type: 'text', text: subtitle, color: '#CBD5E1', size: 'xs', wrap: true, margin: 'xs' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#F1F5F9',
      paddingAll: '12px',
      spacing: 'sm',
      contents: body,
    },
    ...(footer ? {
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footer,
      },
    } : {}),
  };
}

function notificationShell(titleText, subtitle, body, footer) {
  return {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FFFFFF',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: titleText, weight: 'bold', size: 'lg', color: '#1F2937' },
        ...(subtitle ? [{ type: 'text', text: subtitle, size: 'xs', color: '#64748B', wrap: true, margin: 'xs' }] : []),
        { type: 'separator', margin: 'md' },
        ...body,
      ],
    },
    ...(footer ? {
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footer,
      },
    } : {}),
  };
}

function notificationIconRow(icon, title, description, { count, badgeText, badgeColor = '#374151', badgeBg = '#F1F5F9', view, showCountBadge = true } = {}) {
  const line = {
    type: 'box',
    layout: 'horizontal',
    margin: 'lg',
    spacing: 'md',
    alignItems: 'center',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '40px',
        height: '40px',
        cornerRadius: '10px',
        backgroundColor: '#F1F5F9',
        justifyContent: 'center',
        alignItems: 'center',
        contents: [{ type: 'text', text: icon, size: 'xl', align: 'center', gravity: 'center' }],
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        justifyContent: 'center',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'sm', color: '#111827' },
          { type: 'text', text: description, size: 'xs', color: '#64748B', margin: 'xs', wrap: true, maxLines: 2 },
        ],
      },
      ...(showCountBadge ? [compactCountBadge(String(badgeText || count || 0), badgeColor, badgeBg)] : []),
    ],
  };
  if (view) line.action = dashboardAction(title, view);
  return line;
}

function todoSummaryRow(icon, title, countText, description) {
  return notificationIconRow(
    icon,
    title,
    `${countText}｜${description}`,
    { showCountBadge: false },
  );
}

function taskMenuQuickReplyMessage() {
  return dashboardQuickReplyMessage('選一個待辦類別進入明細', [
    { label: '問題', view: 'question_rooms' },
    { label: '看房', view: 'showings' },
    { label: '點交', view: 'inspections' },
    { label: '簽約', view: 'intentions' },
    { label: '修繕', view: 'repairs' },
    { label: '取消', view: 'task_menu_cancel' },
  ]);
}

function taskMenuQuickReplyActions() {
  return [
    { label: '問題', view: 'question_rooms' },
    { label: '看房', view: 'showings' },
    { label: '點交', view: 'inspections' },
    { label: '簽約', view: 'intentions' },
    { label: '修繕', view: 'repairs' },
    { label: '取消', view: 'task_menu_cancel' },
  ];
}

function historyQuickReplyMessage() {
  return dashboardQuickReplyMessage('選一個通知類別查看最新 10 則', historyQuickReplyActions());
}

function historyQuickReplyActions() {
  return [
    { label: '問題', view: 'history:question' },
    { label: '看房', view: 'history:showing' },
    { label: '點交', view: 'history:inspection' },
    { label: '簽約', view: 'history:intention' },
    { label: '修繕', view: 'history:repair' },
    { label: '金流', view: 'history:billing' },
    { label: '取消', view: 'history_cancel' },
  ];
}

function notificationFilterTitle(filter) {
  return ({
    all: '全部',
    question: '問題',
    showing: '看房',
    inspection: '點交',
    intention: '簽約',
    repair: '修繕',
    billing: '金流',
  })[filter] || '全部';
}

function notificationListRow(item) {
  const line = {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    spacing: 'sm',
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '10px',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '40px',
        height: '40px',
        flex: 0,
        backgroundColor: item.iconBg || '#F1F5F9',
        cornerRadius: '10px',
        justifyContent: 'center',
        alignItems: 'center',
        contents: [
          { type: 'text', text: item.icon || '🔔', size: 'xl', align: 'center', gravity: 'center' },
        ],
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            alignItems: 'center',
            contents: [
              { type: 'text', text: shortText(item.title, 20), size: 'sm', weight: 'bold', color: item.color || '#111827', flex: 1, maxLines: 1 },
              badge(item.tag, item.color || '#374151', item.badgeBg || '#F1F5F9'),
            ],
          },
          ...(item.subtitle ? [{ type: 'text', text: shortText(item.subtitle, 24), size: 'xs', color: '#64748B', maxLines: 1 }] : []),
          ...(item.detail ? [{ type: 'text', text: shortText(item.detail, 40), size: 'xs', color: '#475569', wrap: true, maxLines: 2 }] : []),
          ...(item.eventAt ? [{ type: 'text', text: dateText(item.eventAt), size: 'xxs', color: '#94A3B8', margin: 'xs', maxLines: 1 }] : []),
        ],
      },
    ],
  };
  return line;
}

const CHARGE_TYPE_LABELS = {
  rent: '租金',
  management_fee: '管理費',
  water: '水費',
  electricity: '電費',
  gas: '瓦斯費',
  parking: '停車費',
  repair: '修繕費',
  other: '其他',
};

function detailOptionCard({ icon, iconBg = '#F1F5F9', title, detail, meta, buttonLabel, view, badgeText, badgeColor = '#374151', badgeBg = '#F1F5F9' }) {
  const neutralIconBg = '#F3F4F6';
  const neutralBadgeColor = '#64748B';
  const neutralBadgeBg = '#E5E7EB';
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
    borderWidth: '1px',
    cornerRadius: '16px',
    paddingAll: '12px',
    spacing: 'sm',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        alignItems: 'center',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '42px',
            height: '42px',
            cornerRadius: '10px',
            backgroundColor: neutralIconBg,
            justifyContent: 'center',
            alignItems: 'center',
            contents: [{ type: 'text', text: icon, size: 'xl', align: 'center', gravity: 'center' }],
          },
          {
            type: 'box',
            layout: 'vertical',
            flex: 1,
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                alignItems: 'center',
                contents: [
                  { type: 'text', text: shortText(title, 18), size: 'sm', weight: 'bold', color: '#111827', flex: 1, maxLines: 1 },
                  ...(badgeText ? [compactCountBadge(badgeText, neutralBadgeColor, neutralBadgeBg)] : []),
                ],
              },
              ...(detail ? [{ type: 'text', text: shortText(detail, 34), size: 'xs', color: '#53627C', margin: 'xs', wrap: true, maxLines: 2 }] : []),
              ...(meta ? [{ type: 'text', text: shortText(meta, 34), size: 'xxs', color: '#94A3B8', margin: 'xs', maxLines: 1 }] : []),
            ],
          },
        ],
      },
      ...(buttonLabel && view ? [{
        type: 'button',
        height: 'sm',
        style: 'primary',
        color: '#1F2937',
        action: dashboardAction(buttonLabel, view),
      }] : []),
    ],
  };
}

function taskTotal(overview) {
  return Number(overview.pendingLandlordQuestionCount || 0) +
    Number(overview.upcomingShowingCount || 0) +
    Number(overview.activeIntentionCount || 0) +
    Number(overview.pendingInspectionConfirmationCount || 0) +
    Number(overview.pendingSignatureCount || 0) +
    Number(overview.openRepairTicketCount || 0);
}

function notificationTotal(overview) {
  return taskTotal(overview) +
    Number(overview.dueChargeReminderCount || 0);
}

function preRentTaskTotal(overview) {
  return Number(overview.pendingLandlordQuestionCount || 0) +
    Number(overview.upcomingShowingCount || 0) +
    Number(overview.activeIntentionCount || 0);
}

function postRentTaskTotal(overview) {
  return Number(overview.pendingInspectionConfirmationCount || 0) +
    Number(overview.pendingSignatureCount || 0) +
    Number(overview.openRepairTicketCount || 0);
}

function questionCard(item) {
  const answered = item.status === 'answered' || Number(item.answer_count || 0) > 0;
  return itemCard({
    title: item.tenant_name,
    subtitle: item.unit_label,
    detail: item.question_text,
    marker: statusBadge(item.status, answered),
    color: answered ? '#047857' : '#B45309',
  });
}

function showingCard(item) {
  return detailOptionCard({
    icon: '🗓️',
    iconBg: '#DBEAFE',
    title: item.tenant_name || '房客',
    detail: `${item.unit_label || '房源'}｜${dateText(item.starts_at)} 看房`,
    meta: '看房審核與提醒',
    badgeText: statusLabel(item.status),
    badgeColor: '#2563EB',
    badgeBg: '#EFF6FF',
  });
}

function intentionCard(item) {
  const terms = [
    item.rent_amount ? `租金 ${money(item.rent_amount)}` : null,
    item.move_in_date ? `入住 ${dateText(item.move_in_date)}` : null,
  ].filter(Boolean).join('，');

  const publicId = item.public_id || item.publicId;
  const card = detailOptionCard({
    icon: '📝',
    iconBg: '#FEF3C7',
    title: item.tenant_name || '房客',
    detail: terms || item.special_request_text || '條件待確認',
    meta: item.unit_label,
    badgeText: statusLabel(item.status),
    badgeColor: '#D97706',
    badgeBg: '#FEF3C7',
  });
  if (!publicId || ['contracting', 'rejected', 'ended'].includes(String(item.status || ''))) {
    return card;
  }
  card.contents.push({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    margin: 'sm',
    contents: [
      {
        type: 'button',
        height: 'sm',
        style: 'primary',
        color: '#1F2937',
        action: {
          type: 'postback',
          label: '接受去簽約',
          data: `action=intention_decision&id=${encodeURIComponent(publicId)}&decision=accept`,
          displayText: '接受去簽約',
        },
      },
      {
        type: 'button',
        height: 'sm',
        style: 'secondary',
        action: {
          type: 'postback',
          label: '拒絕',
          data: `action=intention_decision&id=${encodeURIComponent(publicId)}&decision=reject`,
          displayText: '拒絕承租條件',
        },
      },
    ],
  });
  return card;
}

function repairAction(label, ticketPublicId, next, style = 'secondary', color, scope) {
  const data = new URLSearchParams({
    action: 'repair_update',
    id: ticketPublicId,
    next,
    ...(scope ? { scope } : {}),
  }).toString();
  return {
    type: 'button',
    height: 'sm',
    style,
    color,
    action: {
      type: 'postback',
      label,
      data,
      displayText: label,
    },
  };
}

function repairDetailAction(ticketPublicId, scope) {
  const recordUrl = repairRecordUrl(ticketPublicId);
  if (recordUrl) {
    return uriButton('詳情', recordUrl, 'primary', '#1F2937');
  }
  return {
    type: 'button',
    height: 'sm',
    style: 'primary',
    color: '#1F2937',
    action: dashboardAction('詳情', `repair_detail:${ticketPublicId}`, {
      params: scope ? { scope } : {},
    }),
  };
}

function repairActionGroup(actions) {
  if (!actions || !actions.length) return null;
  if (actions.length <= 2) {
    return {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      margin: 'sm',
      contents: actions,
    };
  }
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'sm',
    contents: [
      actions[0],
      ...(actions.length > 1 ? [{
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: actions.slice(1, 3),
      }] : []),
      ...(actions.length > 3 ? [{
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: actions.slice(3, 5),
      }] : []),
    ],
  };
}

function uriButton(label, uri, style = 'secondary', color) {
  return {
    type: 'button',
    height: 'sm',
    style,
    color,
    action: {
      type: 'uri',
      label,
      uri,
    },
  };
}

function postbackButton(label, data, style = 'secondary', color) {
  return {
    type: 'button',
    height: 'sm',
    style,
    color,
    action: {
      type: 'postback',
      label,
      displayText: label,
      data,
    },
  };
}

function repairProgressText(status, item = {}) {
  const dispatchParty = String(item.dispatch_party || (status === 'tenant_self_repair' ? 'tenant' : '') || 'review_required');
  const repairStatus = String(item.repair_status || (['landlord_completed', 'repair_completed', 'tenant_confirmed'].includes(status) ? 'completed' : ''));
  const verificationStatus = String(item.repair_verification_status || (status === 'tenant_confirmed' ? 'confirmed' : 'pending'));
  const settlementStatus = String(item.settlement_status || (status === 'tenant_confirmed' ? 'not_required' : 'pending'));
  if (String(item.case_status || '') === 'closed' || status === 'tenant_confirmed') return '修繕已結案';
  if (repairStatus === 'completed') {
    if (verificationStatus === 'confirmed') {
      return ['completed', 'not_required', 'waived'].includes(settlementStatus) ? '修復與費用已完成，待結案' : '修復已確認，費用待結算';
    }
    if (dispatchParty !== 'tenant' && Number(item.completion_photo_count || 0) > 0) return '房東已回傳修好資料，待房客查驗';
    if (dispatchParty === 'tenant' && Number(item.completion_photo_count || 0) > 0) return '房客已回傳修好資料，待房東查驗';
  }
  if (status === 'landlord_completed') {
    return Number(item.completion_photo_count || 0) > 0
      ? '修好照片已回傳，待房東確認'
      : '房東標記修復，待回傳修好照片';
  }
  return ({
    reported: '房客已通報，待房東決定',
    accepted: '已受理，待安排修繕',
    in_progress: '處理中，等待修復回報',
    tenant_confirmed: '房東已確認結案',
    reopened: '房客回報仍有問題',
  })[status] || '修繕進度待確認';
}

function repairProgressStep(item = {}) {
  const status = String(item.status || '');
  if (status === 'tenant_confirmed') return 4;
  if (status === 'landlord_completed') return 3;
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

function repairProgressBar(item = {}) {
  const current = repairProgressStep(item);
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'xs',
    margin: 'sm',
    contents: ['通報', '處理', '回傳', '確認'].map((label, index) => {
      const step = index + 1;
      const done = current >= step;
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
            contents: [{ type: 'text', text: done ? '✓' : '○', size: 'xxs', color: done ? '#FFFFFF' : '#CBD5E1', weight: 'bold', align: 'center' }],
          },
          { type: 'text', text: label, size: 'xxs', color: done ? tone.color : '#94A3B8', align: 'center' },
        ],
      };
    }),
  };
}

function repairImageBox(filePublicId, label) {
  const url = repairFileUrl(filePublicId);
  if (!url) return null;
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    contents: [
      ...(label ? [{ type: 'text', text: label, size: 'xxs', color: '#64748B' }] : []),
      {
        type: 'image',
        url,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
      },
    ],
  };
}

function imageRepairFiles(item, purpose) {
  return (Array.isArray(item && item.files) ? item.files : [])
    .filter((file) => (!purpose || file.purpose === purpose) && String(file.mime_type || '').startsWith('image/'));
}

function repairDecisionCard(item, scope) {
  const urgent = item.priority === 'urgent' || item.priority === 'high';
  const ticketPublicId = item.public_id || item.publicId;
  const status = String(item.status || '');
  const stageTone = repairStepTone(repairProgressStep(item));
  const isClosed = status === 'tenant_confirmed';
  const showDecision = ['reported', 'accepted', 'reopened'].includes(status);
  const showComplete = ['accepted', 'in_progress', 'reopened'].includes(status);
  const showLandlordConfirm = status === 'landlord_completed';
  const actions = ticketPublicId ? [
    repairDetailAction(ticketPublicId, scope),
    ...(showDecision ? [
      repairAction('房東派修', ticketPublicId, 'in_progress', 'primary', '#1F2937', scope),
      repairAction('同意自修', ticketPublicId, 'tenant_self_repair', 'secondary', undefined, scope),
      repairAction('房客負擔', ticketPublicId, 'tenant_pays', 'secondary', undefined, scope),
      repairAction('補資料', ticketPublicId, 'need_info', 'secondary', undefined, scope),
    ] : []),
    ...(showLandlordConfirm ? [
      repairAction('確認完成', ticketPublicId, 'landlord_confirmed', 'primary', '#1F2937', scope),
      repairAction('退回', ticketPublicId, 'reopen', 'secondary', undefined, scope),
    ] : []),
    ...(showComplete ? [
      repairAction('完成', ticketPublicId, 'landlord_completed', showDecision ? 'secondary' : 'primary', showDecision ? undefined : '#1F2937', scope),
    ] : []),
  ].slice(0, 5) : [];
  const card = detailOptionCard({
    icon: '🛠️',
    iconBg: urgent ? '#FEE2E2' : '#F3F4F6',
    title: item.unit_label || '房源',
    detail: item.description || item.category || '報修內容待確認',
    meta: isClosed
      ? `${item.unit_label || '房源'}｜${shortText(item.tenant_name || '房客', 12)}｜結案 ${dateText(item.updated_at || item.reported_at)}`
      : `${shortText(item.tenant_name || '房客', 12)}｜${repairProgressText(item.status, item)}`,
    badgeText: statusLabel(urgent ? item.priority : item.status),
    badgeColor: urgent ? '#B91C1C' : stageTone.color,
    badgeBg: urgent ? '#FEE2E2' : stageTone.bg,
  });
  if (showDecision) {
    card.contents.push(repairAiSummaryBox(item));
  }
  card.contents.push(repairProgressBar(item));
  if (actions.length) {
    card.contents.push(repairActionGroup(actions));
  }
  return card;
}

function repairInfoRow(label, value, color = '#475569') {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#94A3B8', flex: 2 },
      { type: 'text', text: String(value || '-'), size: 'xs', color, flex: 5, wrap: true },
    ],
  };
}

function repairAiSummaryBox(item = {}) {
  const analysis = buildRepairAssistantAnalysis({
    description: item.description,
    photoCount: item.damage_photo_count || (Array.isArray(item.files) ? item.files.filter((file) => file.purpose === 'damage_photo').length : 0),
    unitLabel: item.unit_label,
  });
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'sm',
    backgroundColor: '#F8FAFC',
    borderColor: '#E5E7EB',
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '10px',
    spacing: 'xs',
    contents: [
      { type: 'text', text: 'AI 助手整理', size: 'xs', weight: 'bold', color: '#0F172A' },
      { type: 'text', text: analysis.summaryLines[0], size: 'xxs', color: '#334155', wrap: true },
      { type: 'text', text: analysis.summaryLines[1], size: 'xxs', color: '#475569', wrap: true },
    ],
  };
}

function repairEntrySummaryCard(item = {}, scope, lineUserId) {
  const ticketPublicId = item.public_id || item.publicId;
  const photoCount = Number(item.damage_photo_count || 0);
  const analysis = buildRepairAssistantAnalysis({
    description: item.description,
    photoCount,
    unitLabel: item.unit_label,
  });
  const line = (label, value, color = '#334155', maxLines = 2) => ({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xxs', color: '#94A3B8', flex: 3, maxLines: 1 },
      { type: 'text', text: String(value || '-'), size: 'xxs', color, flex: 9, wrap: true, maxLines },
    ],
  });
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#F8FAFC',
    borderColor: '#E5E7EB',
    borderWidth: '1px',
    cornerRadius: '16px',
    paddingAll: '12px',
    spacing: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        alignItems: 'center',
        contents: [
          { type: 'text', text: shortText(item.tenant_name || '房客', 18), size: 'sm', weight: 'bold', color: '#111827', flex: 1, maxLines: 1 },
          { type: 'text', text: dateText(item.event_at || item.updated_at || item.reported_at), size: 'xxs', color: '#94A3B8', align: 'end', flex: 1, maxLines: 1 },
        ],
      },
      { type: 'separator', margin: 'sm' },
      line('AI 協商摘要', item.unit_label || '租屋物件', '#111827', 1),
      line('報修內容', item.description || item.category || '尚未提供'),
      line('損壞照片', `${photoCount} 張`, '#334155', 1),
      line('初判', `${analysis.risk.label}；${analysis.responsibility.label}`, '#1F2937'),
      line('建議', analysis.recommendedAction, '#334155'),
      line('依據', analysis.responsibility.reason, '#64748B', 3),
      line('待補', analysis.missing && analysis.missing.length ? analysis.missing.join('、') : '無', '#64748B'),
      ...(ticketPublicId ? [{
        type: 'button',
        height: 'sm',
        style: 'primary',
        color: '#1F2937',
        margin: 'sm',
        action: {
          type: 'uri',
          label: '處理並查看',
          uri: landlordRepairDetailUrl(ticketPublicId, lineUserId, scope),
        },
      }] : []),
    ],
  };
}

function repairDetailBubble(item, scope) {
  const ticketPublicId = item && (item.public_id || item.publicId);
  const status = String(item && item.status || '');
  const showDecision = ['reported', 'accepted', 'reopened'].includes(status);
  const showComplete = ['accepted', 'in_progress', 'reopened'].includes(status);
  const showLandlordConfirm = status === 'landlord_completed';
  const damagePhotos = imageRepairFiles(item, 'damage_photo');
  const completionPhotos = imageRepairFiles(item, 'completion_photo');
  const recordUrl = repairRecordUrl(ticketPublicId);
  const actions = ticketPublicId ? [
    ...(showDecision ? [
      repairAction('房東派修', ticketPublicId, 'in_progress', 'primary', '#1F2937', scope),
      repairAction('同意自修', ticketPublicId, 'tenant_self_repair', 'secondary', undefined, scope),
      repairAction('房客負擔', ticketPublicId, 'tenant_pays', 'secondary', undefined, scope),
      repairAction('補資料', ticketPublicId, 'need_info', 'secondary', undefined, scope),
    ] : []),
    ...(showLandlordConfirm ? [
      repairAction('確認完成', ticketPublicId, 'landlord_confirmed', 'primary', '#1F2937', scope),
      repairAction('退回', ticketPublicId, 'reopen', 'secondary', undefined, scope),
    ] : []),
    ...(showComplete ? [
      repairAction('完成', ticketPublicId, 'landlord_completed', showDecision ? 'secondary' : 'primary', showDecision ? undefined : '#1F2937', scope),
    ] : []),
  ].slice(0, 4) : [];

  return notificationShell(
    '🛠️ 報修詳情',
    ticketPublicId || '報修單',
    [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#F8FAFC',
        borderColor: '#E5E7EB',
        borderWidth: '1px',
        cornerRadius: '16px',
        paddingAll: '12px',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            alignItems: 'center',
            contents: [
              { type: 'text', text: item.unit_label || '房源', size: 'md', weight: 'bold', color: '#111827', flex: 1, wrap: true },
              statusBadge(item.priority === 'urgent' || item.priority === 'high' ? item.priority : item.status),
            ],
          },
          repairProgressBar({ ...item, completion_photo_count: completionPhotos.length || item.completion_photo_count }),
          repairInfoRow('房客', item.tenant_name || '房客'),
          repairInfoRow('分類', item.category || '一般報修'),
          repairInfoRow('狀態', repairProgressText(item.status, { ...item, completion_photo_count: completionPhotos.length || item.completion_photo_count }), '#1F2937'),
          repairInfoRow('通報', dateText(item.reported_at || item.event_at)),
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '報修內容', size: 'xs', color: '#94A3B8', margin: 'xs' },
          { type: 'text', text: item.description || '尚無描述', size: 'sm', color: '#111827', wrap: true },
          ...(showDecision ? [repairAiSummaryBox(item)] : []),
          repairInfoRow('損壞照片', damagePhotos.length ? `${damagePhotos.length} 張，請開啟完整紀錄查看` : '尚未附損壞照片'),
        ],
      },
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        borderColor: '#E5E7EB',
        borderWidth: '1px',
        cornerRadius: '16px',
        paddingAll: '12px',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '修繕進度', size: 'sm', weight: 'bold', color: '#111827' },
          { type: 'text', text: repairProgressText(item.status, { ...item, completion_photo_count: completionPhotos.length || item.completion_photo_count }), size: 'xs', color: '#64748B', wrap: true },
          repairInfoRow('修好照片', completionPhotos.length ? `${completionPhotos.length} 張，待房東確認` : '尚未回傳修好後照片'),
        ],
      },
      ...(recordUrl ? [uriButton('開啟完整紀錄', recordUrl, 'primary', '#1F2937')] : []),
      ...(actions.length ? [repairActionGroup(actions)] : []),
    ],
  );
}

function inspectionTypeText(value) {
  return ({
    move_in: '入住點交',
    move_out: '退租點交',
    pre_rent: '租前點交',
    post_rent: '租後點交',
  })[value] || '物況點交';
}

function inspectionCard(item) {
  return detailOptionCard({
    icon: '🏠',
    iconBg: '#CFFAFE',
    title: item.tenant_name || '房客',
    detail: `${inspectionTypeText(item.inspection_type)}完成，待房東確認`,
    meta: item.unit_label,
    badgeText: '點交',
    badgeColor: '#0891B2',
    badgeBg: '#ECFEFF',
  });
}

function cashflowCard(item) {
  const unpaid = Math.max(0, Number(item.amount || 0) - Number(item.paid_amount || 0));
  return itemCard({
    title: item.unit_label,
    subtitle: item.due_date ? `到期 ${dateText(item.due_date)}` : undefined,
    detail: `${money(item.paid_amount)} / ${money(item.amount)}${unpaid ? `，未收 ${money(unpaid)}` : ''}`,
    marker: statusBadge(item.status),
    color: unpaid > 0 ? '#B91C1C' : '#047857',
  });
}

function emptyCard(titleText, detail, color = '#64748B') {
  return itemCard({
    title: titleText,
    detail,
    color,
    marker: badge('無', '#64748B', '#E5E7EB'),
  });
}

function detailList(items, mapper, emptyTitle, emptyDetail) {
  if (!items || !items.length) return [emptyCard(emptyTitle, emptyDetail)];
  return items.slice(0, 4).map(mapper);
}

function eventTime(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function latestNotificationItems(overview, limit = 5, filter = 'all') {
  const items = [];
  (overview.questionItems || []).forEach((item) => items.push({
    key: 'question',
    stage: '租屋前',
    tag: '問',
    icon: '💬',
    iconBg: '#F3E8FF',
    title: '問題｜房客提出問題',
    subtitle: item.unit_label,
    detail: item.question_text || '等待房東回覆',
    color: '#7C3AED',
    badgeBg: '#F3E8FF',
    eventAt: item.event_at,
  }));
  (overview.showingItems || []).forEach((item) => items.push({
    key: 'showing',
    stage: '租屋前',
    tag: '看',
    icon: '🗓️',
    iconBg: '#DBEAFE',
    title: '看房｜房客送出預約',
    subtitle: item.unit_label,
    detail: `${dateText(item.starts_at)} 看房`,
    color: '#2563EB',
    badgeBg: '#EFF6FF',
    eventAt: item.event_at || item.starts_at,
  }));
  (overview.intentionItems || []).forEach((item) => items.push({
    key: 'intention',
    stage: '租屋前',
    tag: '條',
    icon: '📝',
    iconBg: '#FEF3C7',
    title: '條件｜房客提出承租條件',
    subtitle: item.unit_label,
    detail: [
      item.rent_amount ? `租金 ${money(item.rent_amount)}` : null,
      item.move_in_date ? `入住 ${dateText(item.move_in_date)}` : null,
    ].filter(Boolean).join('｜') || item.special_request_text || '條件待確認',
    color: '#D97706',
    badgeBg: '#FEF3C7',
    eventAt: item.event_at,
  }));
  (overview.inspectionItems || []).forEach((item) => items.push({
    key: 'inspection',
    stage: '租屋後',
    tag: '點',
    icon: '🏠',
    iconBg: '#CFFAFE',
    title: '點交｜房客完成物況點交',
    subtitle: item.unit_label,
    detail: '等待房東確認',
    color: '#0891B2',
    badgeBg: '#ECFEFF',
    eventAt: item.event_at,
  }));
  (overview.repairItems || []).forEach((item) => items.push({
    key: 'repair',
    stage: '租屋後',
    tag: '修',
    icon: '🛠️',
    iconBg: '#FEE2E2',
    title: '修繕｜報修狀態更新',
    subtitle: item.unit_label,
    detail: `${repairProgressText(item.status, item)}｜${item.description || item.category || ''}`,
    color: '#DC2626',
    badgeBg: '#FEE2E2',
    eventAt: item.event_at || item.reported_at,
  }));
  (overview.dueReminderItems || []).forEach((item) => items.push({
    key: 'billing',
    stage: '租屋後',
    tag: '金',
    icon: '💰',
    iconBg: '#D1FAE5',
    title: '系統｜金流提醒',
    subtitle: item.unit_label,
    detail: `${money(Math.max(0, Number(item.amount || 0) - Number(item.paid_amount || 0)) || item.amount)} 待處理；詳細請看帳務金流`,
    color: '#059669',
    badgeBg: '#D1FAE5',
    eventAt: item.event_at || item.due_date,
  }));

  return items
    .filter((item) => filter === 'all' || item.key === filter)
    .sort((a, b) => eventTime(b.eventAt) - eventTime(a.eventAt))
    .slice(0, limit)
    .map(notificationListRow);
}

function overviewBubble(overview) {
  const alertRows = [];
  if (overview.vacantUnitCount > 0) {
    alertRows.push(row('空置物件', `${overview.vacantUnitCount} 間`, '#B45309'));
  }
  if (overview.outstandingRentAmount > 0) {
    alertRows.push(row('未收金額', money(overview.outstandingRentAmount), '#B91C1C'));
  }
  if (overview.overdueChargeCount > 0) {
    alertRows.push(row('逾期帳單', `${overview.overdueChargeCount} 筆`, '#B91C1C'));
  }
  if (overview.openRepairTicketCount > 0) {
    alertRows.push(row('報修中', `${overview.openRepairTicketCount} 件`, '#B45309'));
  }
  if (alertRows.length === 0) {
    alertRows.push(row('狀態', '✅ 一切正常', '#047857'));
  }

  return shell(
    '👑 房東數據總攬',
    `${targetMonthText(overview)}｜租務摘要`,
    [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          metric('總物件', `${overview.totalUnitCount || 0} 間`, `出租 ${overview.occupiedUnitCount || 0}｜空置 ${overview.vacantUnitCount || 0}`),
          metric('出租率', percent(overview.occupancyRate), `空置率 ${percent(overview.vacancyRate)}`, Number(overview.vacancyRate || 0) >= 0.5 ? '#B45309' : '#047857'),
        ],
      },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          metric('本月預收', money(overview.expectedRentAmount), `已收 ${money(overview.receivedRentAmount)}`, '#047857'),
          metric('收款率', percent(overview.collectionRate), `${overview.rentChargeCount || 0} 筆帳單`, Number(overview.collectionRate || 0) >= 0.8 ? '#047857' : '#B45309'),
        ],
      },
      sectionTitle('重點提醒'),
      ...alertRows,
    ],
    [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          actionButton('💰 收益分析', 'cashflow', 'primary'),
          actionButton('📈 出租趨勢', 'rental'),
        ],
      },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          actionButton('🏠 物件績效', 'property'),
          {
            type: 'button',
            height: 'sm',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '📊 儀表板',
              displayText: '儀表板功能開發中，敬請期待！',
              data: 'action=dashboard_view&view=full_dashboard',
            },
          },
        ],
      },
    ],
  );
}

function tasksBubble(overview) {
  const taskUrl = landlordTaskCenterUrl(overview.lineUserId, overview.scope, 'tasks');
  return notificationShell(
    '✅ 通知與待辦',
    'LINE 只提示事件；完整處理與分類都在外部頁。',
    [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          metric('待我處理', `${taskTotal(overview)} 項`, '目前輪到房東'),
          metric('修繕進行中', `${overview.openRepairTicketCount || 0} 件`, '其餘分類到中心查看'),
        ],
      },
    ],
    [
      uriButton('開啟通知與待辦中心', taskUrl, 'primary'),
    ],
  );
}

function latestNotificationsBubble(overview, filter = 'all') {
  const latestItems = latestNotificationItems(overview, 5, filter);
  const filterTitle = notificationFilterTitle(filter);
  const notificationUrl = landlordTaskCenterUrl(overview.lineUserId, overview.scope, 'notifications');
  return notificationShell(
    '🔔 最新通知',
    `${filterTitle}｜最新 5 則事件，只看狀態不做決策`,
    latestItems.length ? latestItems : [emptyCard('目前沒有通知', '尚無新的狀態更新')],
    [
      uriButton('開啟通知中心', notificationUrl, 'primary'),
    ],
  );
}

function notificationHubCarousel(overview) {
  const latestItems = latestNotificationItems(overview, 3, 'all');
  const taskUrl = landlordTaskCenterUrl(overview.lineUserId, overview.scope, 'tasks');
  return notificationShell(
    '✅ 通知與待辦',
    `待我處理 ${taskTotal(overview)} 項｜修繕進行中 ${overview.openRepairTicketCount || 0} 件`,
    [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          metric('待我處理', `${taskTotal(overview)} 項`, '現在輪到房東', '#1F2937'),
          metric('最新通知', `${notificationTotal(overview)} 則`, '顯示最新事件', '#B45309'),
        ],
      },
      sectionTitle('最新事件', '只顯示 3 則；完整分類與紀錄請到外部頁。'),
      ...(latestItems.length ? latestItems : [emptyCard('目前沒有通知', '尚無新的狀態更新')]),
    ],
    [
      uriButton('開啟通知與待辦中心', taskUrl, 'primary'),
    ],
  );
}

function questionRoomCard(item) {
  return detailOptionCard({
    icon: '💬',
    iconBg: '#F3F4F6',
    title: item.unitLabel || item.title || '房源',
    detail: item.rentAmount ? `租金 ${money(item.rentAmount)}` : '待回答問題',
    meta: '選房源後進 AI 知識庫回答',
    badgeText: `${item.pendingQuestionCount || 0}`,
    badgeColor: '#B45309',
    badgeBg: '#FFFBEB',
    buttonLabel: '回答',
    view: `question_room:${item.publicId}`,
  });
}

function questionRoomsBubble(overview) {
  const rooms = overview.questionListingItems || [];
  return notificationShell(
    '💬 選擇房源',
    '選房源後會進 AI 知識庫回答該房問題',
    rooms.length ? rooms.slice(0, 5).map(questionRoomCard) : [emptyCard('目前沒有待回答問題', '房客問題都已處理')],
  );
}

function detailBubble(titleText, subtitle, items, mapper, emptyTitle, emptyDetail) {
  return notificationShell(
    titleText,
    subtitle,
    detailList(items, mapper, emptyTitle, emptyDetail),
  );
}

function questionsBubble(overview) {
  return detailBubble(
    '❓ 待回答問題',
    `${overview.pendingLandlordQuestionCount || 0} 題待處理`,
    overview.questionItems,
    questionCard,
    '目前沒有待回答問題',
    '房客問題都已處理',
  );
}

function showingsBubble(overview) {
  return detailBubble(
    '🗓️ 看房提醒',
    `${overview.upcomingShowingCount || 0} 件近期預約`,
    overview.showingItems,
    showingCard,
    '目前沒有看房提醒',
    '尚無近期預約',
  );
}

function intentionsBubble(overview) {
  return detailBubble(
    '📝 簽約條件',
    `${overview.activeIntentionCount || 0} 件條件待決定`,
    overview.intentionItems,
    intentionCard,
    '目前沒有簽約條件待決定',
    '尚無租金、入住或特殊條件待確認',
  );
}

function repairsBubble(overview) {
  return notificationShell(
    '🛠️ 房客報修｜正在修繕',
    `${overview.openRepairTicketCount || 0} 件未結案｜照片與歷史請開完整紀錄`,
    detailList(
      overview.repairItems,
      (item) => repairDecisionCard(item, overview.scope),
      '目前沒有房客報修',
      '維修事項都已處理',
    ),
    [
      actionButton('修繕歷史', 'repair_history', 'primary'),
    ],
  );
}

function repairHistoryBubble(overview) {
  return notificationShell(
    '🧾 修繕歷史',
    '最近 3 筆已結案｜完整歷史可依房源查看',
    detailList(
      overview.repairHistoryItems,
      (item) => repairDecisionCard(item, overview.scope),
      '目前沒有修繕歷史',
      '尚無已結案的報修紀錄',
    ),
    [
      ...(landlordRepairHistoryUrl(overview.lineUserId, overview.scope) ? [uriButton('完整歷史', landlordRepairHistoryUrl(overview.lineUserId, overview.scope), 'primary', '#1F2937')] : []),
      actionButton('正在修繕', 'repairs'),
    ],
  );
}

function landlordRepairEntryBubble(overview) {
  const latest = (overview.repairItems || [])[0];
  const activeUrl = landlordRepairActiveUrl(overview.lineUserId, overview.scope);
  const historyUrl = landlordRepairHistoryUrl(overview.lineUserId, overview.scope);
  const analysis = latest ? buildRepairAssistantAnalysis({
    description: latest.description,
    photoCount: latest.damage_photo_count,
    unitLabel: latest.unit_label,
  }) : null;
  return notificationShell(
    '🛠️ 房客報修',
    `${overview.openRepairTicketCount || 0} 件未結案｜LINE 只做通知與快速決策`,
    [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#F8FAFC',
        borderColor: '#E5E7EB',
        borderWidth: '1px',
        cornerRadius: '16px',
        paddingAll: '12px',
        spacing: 'xs',
        contents: latest ? [
          { type: 'text', text: latest.unit_label || '租屋物件', size: 'sm', weight: 'bold', color: '#111827', wrap: true },
          { type: 'text', text: shortText(latest.description || latest.category || '報修內容待確認', 34), size: 'xs', color: '#334155', wrap: true },
          { type: 'text', text: `${shortText(latest.tenant_name || '房客', 12)}｜${repairProgressText(latest.status, latest)}`, size: 'xxs', color: '#64748B', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: `AI：${analysis ? shortText(analysis.summaryLines[0], 36) : '等待整理報修內容'}`, size: 'xs', color: '#334155', wrap: true, margin: 'sm' },
        ] : [
          { type: 'text', text: '目前沒有待處理的報修', size: 'sm', weight: 'bold', color: '#111827' },
          { type: 'text', text: '新報修進來後，這裡會顯示最新一筆摘要。', size: 'xs', color: '#64748B', wrap: true, margin: 'xs' },
        ],
      },
    ],
    [
      actionButton('處理', 'repair_process', 'primary'),
      ...(activeUrl ? [uriButton('查看正在報修', activeUrl)] : []),
      ...(historyUrl ? [uriButton('查看報修歷史', historyUrl)] : []),
    ],
  );
}

function landlordRepairProcessBubble(overview) {
  return notificationShell(
    '🛠️ 修繕處理',
    `${overview.openRepairTicketCount || 0} 件未結案｜選一筆案件決定處理方式`,
    detailList(
      overview.repairItems,
      (item) => repairDecisionCard(item, overview.scope),
      '目前沒有待處理報修',
      '新的報修會即時推到這裡，完整照片與紀錄請走外部頁。',
    ),
    [
      ...(landlordRepairActiveUrl(overview.lineUserId, overview.scope) ? [uriButton('查看正在報修', landlordRepairActiveUrl(overview.lineUserId, overview.scope), 'primary', '#1F2937')] : []),
      actionButton('回報修入口', 'repairs'),
    ],
  );
}

function landlordRepairHistoryEntryBubble(overview) {
  const historyUrl = landlordRepairHistoryUrl(overview.lineUserId, overview.scope);
  return notificationShell(
    '📗 報修歷史',
    '已結案報修不放在 LINE 洗版；請到外部頁依房源查看完整紀錄。',
    [
      emptyCard('查看完整報修歷史', `${(overview.repairHistoryItems || []).length} 筆近期結案摘要；外部頁可依房源篩選。`),
    ],
    [
      ...(historyUrl ? [uriButton('查看報修歷史', historyUrl, 'primary', '#1F2937')] : []),
      actionButton('回報修入口', 'repairs'),
    ],
  );
}

function landlordRepairEntryBubbleV2(overview) {
  const actionItems = (overview.repairItems || []).slice(0, 3);
  const activeUrl = landlordRepairActiveUrl(overview.lineUserId, overview.scope);
  const historyUrl = landlordRepairHistoryUrl(overview.lineUserId, overview.scope);
  return notificationShell(
    '🛠️ 房客報修',
    `${overview.openRepairTicketCount || 0} 件未結案｜只列需要房東快速判斷的案件`,
    actionItems.length
      ? actionItems.map((item) => repairEntrySummaryCard(item, overview.scope, overview.lineUserId))
      : [emptyCard('目前沒有待處理報修', '新報修或待確認案件會出現在這裡。')],
    [
      ...(activeUrl ? [uriButton('查看正在報修', activeUrl, 'primary', '#1F2937')] : []),
      ...(historyUrl ? [uriButton('查看報修歷史', historyUrl)] : []),
    ],
  );
}

function landlordRepairProcessBubbleV2(overview) {
  const actionItems = (overview.repairItems || []).slice(0, 5);
  return notificationShell(
    '🛠️ 修繕待處理',
    `${overview.openRepairTicketCount || 0} 件未結案｜點「處理這筆」進入單筆決策`,
    actionItems.length
      ? actionItems.map((item) => repairEntrySummaryCard(item, overview.scope, overview.lineUserId))
      : [emptyCard('目前沒有待處理報修', '新的報修、退回案件或待確認照片會出現在這裡。')],
    [
      ...(landlordRepairActiveUrl(overview.lineUserId, overview.scope) ? [uriButton('查看正在報修', landlordRepairActiveUrl(overview.lineUserId, overview.scope), 'primary', '#1F2937')] : []),
      actionButton('回報修入口', 'repairs'),
    ],
  );
}

function inspectionsBubble(overview) {
  return detailBubble(
    '🏠 點交確認',
    `${overview.pendingInspectionConfirmationCount || 0} 件待確認`,
    overview.inspectionItems,
    inspectionCard,
    '目前沒有點交待確認',
    '點交事項都已處理',
  );
}

function wideMetric(label, value, hint, color = '#1F2937') {
  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E7EB',
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '16px',
    alignItems: 'center',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          { type: 'text', text: label, size: 'xs', color: '#64748B' },
          ...(hint ? [{ type: 'text', text: hint, size: 'xxs', color: '#64748B', wrap: true, margin: 'xs', maxLines: 2 }] : []),
        ],
      },
      { type: 'text', text: String(value), size: 'lg', weight: 'bold', color, align: 'end', flex: 1 },
    ],
  };
}

function cashflowBubble(overview) {
  const chargeRows = (overview.chargeTypeBreakdown || []).map((ct) =>
    row(`• ${CHARGE_TYPE_LABELS[ct.charge_type] || ct.charge_type}`, money(ct.total_amount))
  );
  if (chargeRows.length === 0) {
    chargeRows.push(row('本月尚無帳單', '-', '#64748B'));
  }

  return shell(
    '💰 收益分析',
    `${targetMonthText(overview)}｜收款率 ${percent(overview.collectionRate)}`,
    [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          metric('預收', money(overview.expectedRentAmount), `${overview.rentChargeCount || 0} 筆帳單`),
          metric('已收', money(overview.receivedRentAmount), `收款率 ${percent(overview.collectionRate)}`, '#047857'),
        ],
      },
      wideMetric('未收金額', money(overview.outstandingRentAmount), `${overview.overdueChargeCount || 0} 筆逾期`, overview.outstandingRentAmount ? '#B91C1C' : '#047857'),
      sectionTitle('費用分佈'),
      ...chargeRows,
    ],
    [actionButton('回總攬', 'overview')],
  );
}

function rentalTrendBubble(overview) {
  const occupancyRate = Math.round(Number(overview.occupancyRate || 0) * 100);
  const occupancyColor = occupancyRate >= 80 ? '#047857' : (occupancyRate >= 50 ? '#B45309' : '#B91C1C');

  const vacantRows = (overview.vacantUnits || []).map((unit) => ({
    type: 'box', layout: 'vertical', margin: 'sm', contents: [
      { type: 'text', text: `• ${unit.unit_label || unit.address_text || '未命名物件'}`, size: 'sm', weight: 'bold', color: '#374151' },
      { type: 'text', text: `  預期租金 ${money(unit.rent)}`, size: 'xs', color: '#64748B' },
    ],
  }));
  if (vacantRows.length === 0) {
    vacantRows.push({ type: 'text', text: '✅ 目前無空置物件', size: 'sm', color: '#047857', margin: 'sm' });
  }

  return shell(
    '📈 出租趨勢',
    `出租率 ${occupancyRate}%｜${overview.occupiedUnitCount || 0}/${overview.totalUnitCount || 0} 間出租中`,
    [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          metric('出租率', `${occupancyRate}%`, `${overview.occupiedUnitCount || 0} 間出租中`, occupancyColor),
          metric('空置', `${overview.vacantUnitCount || 0} 間`, `${overview.marketingUnitCount || 0} 招租中`, overview.vacantUnitCount ? '#B45309' : '#047857'),
        ],
      },
      sectionTitle('租客漏斗'),
      row('詢問數', `${overview.totalInquiryCount || 0} 件`),
      row('承租意向', `${overview.intentionCount || 0} 件`),
      row('簽約中', `${overview.contractCount || 0} 件`),
      row('已出租', `${overview.leaseCount || 0} 件`, '#047857'),
      sectionTitle('空置物件'),
      ...vacantRows,
    ],
    [actionButton('回總攬', 'overview')],
  );
}

function propertyBubble(overview) {
  const items = overview.propertyItems || [];

  if (items.length === 0) {
    return shell(
      '🏠 物件績效',
      '目前沒有物件資料',
      [{ type: 'text', text: '尚無物件可顯示', size: 'sm', color: '#64748B' }],
      [actionButton('回總攬', 'overview')],
    );
  }

  const propertyRows = items.slice(0, 5).map((prop) => {
    const statusText = prop.unit_status === 'leased' ? '✅出租' : '⚪空置';
    const statusColor = prop.unit_status === 'leased' ? '#047857' : '#64748B';
    const repairText = prop.repair_ticket_count > 0
      ? `報修 ${prop.repair_ticket_count} 件`
      : '無報修';
    const repairColor = prop.repair_ticket_count > 0 ? '#B45309' : '#047857';

    return {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#FFFFFF',
      borderColor: '#E5E7EB',
      borderWidth: '1px',
      cornerRadius: '12px',
      paddingAll: '10px',
      margin: 'sm',
      contents: [
        {
          type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: shortText(prop.unit_label || prop.address_text || '未命名', 14), size: 'sm', weight: 'bold', color: '#111827', flex: 1 },
            { type: 'text', text: statusText, size: 'xxs', color: statusColor, weight: 'bold', align: 'end', flex: 0 },
          ],
        },
        {
          type: 'box', layout: 'horizontal', margin: 'xs', contents: [
            { type: 'text', text: `月租 ${money(prop.rent)}`, size: 'xs', color: '#64748B', flex: 1 },
            { type: 'text', text: repairText, size: 'xs', color: repairColor, align: 'end', flex: 0 },
          ],
        },
      ],
    };
  });

  return shell(
    '🏠 物件績效',
    `共 ${items.length} 間物件`,
    [
      sectionTitle('各物件概況'),
      ...propertyRows,
    ],
    [actionButton('回總攬', 'overview')],
  );
}

function fullDashboardPlaceholder() {
  return shell(
    '📊 儀表板',
    '功能開發中',
    [
      {
        type: 'box', layout: 'vertical', alignItems: 'center', paddingAll: '20px', contents: [
          { type: 'text', text: '🚧', size: '3xl' },
          { type: 'text', text: '儀表板功能開發中', size: 'md', weight: 'bold', color: '#374151', margin: 'md' },
          { type: 'text', text: '完整的視覺化圖表與數據分析即將上線，敬請期待！', size: 'sm', color: '#64748B', wrap: true, margin: 'sm', align: 'center' },
        ],
      },
    ],
    [actionButton('回總攬', 'overview')],
  );
}

function historyBubble(overview, filter = 'all') {
  const filterTitle = notificationFilterTitle(filter);
  const items = latestNotificationItems(overview, 10, filter);
  return notificationShell(
    '📜 歷史通知',
    `${filterTitle}｜最新 10 則`,
    items.length ? items : [emptyCard('目前沒有歷史紀錄', '尚無通知或代辦')],
  );
}

function selectedBubble(overview, view) {
  if (view === 'tasks') return notificationHubCarousel(overview);
  if (view === 'latest') return latestNotificationsBubble(overview);
  if (view === 'cashflow') return cashflowBubble(overview);
  if (view === 'rental') return rentalTrendBubble(overview);
  if (view === 'property') return propertyBubble(overview);
  if (view === 'full_dashboard') return fullDashboardPlaceholder();
  if (view === 'questions' || view === 'question_rooms') return questionRoomsBubble(overview);
  if (view === 'showings') return showingsBubble(overview);
  if (view === 'intentions') return intentionsBubble(overview);
  if (view === 'inspections') return inspectionsBubble(overview);
  if (view === 'repairs') return landlordRepairEntryBubbleV2(overview);
  if (view === 'repair_process') return landlordRepairProcessBubbleV2(overview);
  if (view === 'repair_history') return landlordRepairHistoryEntryBubble(overview);
  if (view === 'history') return historyBubble(overview);
  if (view && view.startsWith('history:')) return historyBubble(overview, view.slice('history:'.length) || 'all');
  return overviewBubble(overview);
}

function dashboardOverviewCard(overview) {
  return {
    type: 'flex',
    altText: `數據總覽｜${overview.totalUnitCount || 0}間物件｜出租率${percent(overview.occupancyRate)}｜未收${money(overview.outstandingRentAmount)}`,
    contents: {
      type: 'carousel',
      contents: [
        overviewBubble(overview),
        cashflowBubble(overview),
        rentalTrendBubble(overview),
        propertyBubble(overview),
      ],
    },
  };
}

function dashboardSectionCard(overview, view) {
  return {
    type: 'flex',
    altText: view === 'tasks' ? `待辦事項 ${taskTotal(overview)}｜通知 ${notificationTotal(overview)}` : `數據總覽｜${view || 'overview'}`,
    contents: selectedBubble(overview, view),
  };
}

function dashboardTaskSectionCard(overview, view) {
  return withDashboardQuickReply(dashboardSectionCard(overview, view), taskMenuQuickReplyActions());
}

function dashboardHistorySectionCard(overview, view = 'history') {
  return withDashboardQuickReply(dashboardSectionCard(overview, view), historyQuickReplyActions());
}

function legacyDashboardRepairDetailCard(repairItem, scope, lineUserId, options = {}) {
  const ticketPublicId = repairItem && (repairItem.public_id || repairItem.publicId);
  if (repairItem && ticketPublicId && lineUserId) {
    const photoCount = Number(repairItem.damage_photo_count || (Array.isArray(repairItem.files)
      ? repairItem.files.filter((file) => file.purpose === 'damage_photo').length
      : 0) || 0);
    const analysis = buildRepairAssistantAnalysis({
      description: repairItem.description,
      photoCount,
      unitLabel: repairItem.unit_label,
    });
    const row = (label, value) => ({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        { type: 'text', text: label, size: 'xs', color: '#94A3B8', flex: 3, maxLines: 1 },
        { type: 'text', text: String(value || '-'), size: 'xs', color: '#334155', flex: 8, wrap: true, maxLines: 2 },
      ],
    });
    const titleText = options.title || '🛠️ 新報修通知';
    const subtitleText = options.subtitle || 'LINE 只做通知；請到外部頁處理責任、費用與照片';
    const tone = { color: '#FFFFFF', bg: '#1F2937', border: '#1F2937', tagBg: '#E5E7EB', tagColor: '#1F2937' };
    const tag = options.tag || '房東端';
    const negotiationText = options.negotiationText
      || repairItem.latest_negotiation_text
      || repairItem.negotiationText
      || '';
    const footerActions = [
      ...(options.enableRecommendationChoices ? [{
        type: 'button', height: 'sm', style: 'primary', color: '#1F2937',
        action: { type: 'uri', label: '採用目前建議', uri: landlordRepairAdoptRecommendationUrl(ticketPublicId, lineUserId, scope) },
      }, {
        type: 'button', height: 'sm',
        action: { type: 'uri', label: '補充或提出異議', uri: landlordRepairNegotiationUrl(ticketPublicId, lineUserId, scope) },
      }] : []),
      ...(options.enableNegotiationReply ? [{
        type: 'button', height: 'sm', style: 'primary', color: '#1F2937',
        action: { type: 'uri', label: '前往回覆協商', uri: landlordRepairNegotiationUrl(ticketPublicId, lineUserId, scope) },
      }] : []),
      {
        type: 'button',
        height: 'sm',
        style: options.enableNegotiationReply || options.enableRecommendationChoices ? 'secondary' : 'primary',
        color: options.enableNegotiationReply || options.enableRecommendationChoices ? undefined : '#1F2937',
        action: {
          type: 'uri',
          label: '處理並查看',
          uri: landlordRepairDetailUrl(ticketPublicId, lineUserId, scope),
        },
      },
    ];
    return {
      type: 'flex',
      altText: `${titleText.replace(/^[^\w\u4e00-\u9fff]+/, '')}｜${repairItem.unit_label || ticketPublicId}`,
      contents: notificationShell(
        titleText,
        subtitleText,
        [
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            backgroundColor: '#F8FAFC',
            borderColor: tone.border,
            borderWidth: '1px',
            cornerRadius: '16px',
            paddingAll: '12px',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                alignItems: 'center',
                contents: [
                  { type: 'text', text: repairItem.unit_label || '報修案件', size: 'md', weight: 'bold', color: '#111827', wrap: true, flex: 1 },
                  {
                    type: 'box',
                    layout: 'vertical',
                    flex: 0,
                    backgroundColor: tone.tagBg,
                    cornerRadius: '999px',
                    paddingStart: '10px',
                    paddingEnd: '10px',
                    paddingTop: '3px',
                    paddingBottom: '3px',
                    contents: [{ type: 'text', text: String(tag), size: 'xxs', color: tone.tagColor, weight: 'bold', align: 'center' }],
                  },
                ],
              },
              row('房客', repairItem.tenant_name || '房客'),
              row('通知', subtitleText),
              row('報修內容', repairItem.description || repairItem.category || '尚未提供'),
              ...(negotiationText ? [row('協商內容', negotiationText)] : []),
              row('房客意願', repairItem.tenant_repair_preference || repairItem.tenantRepairPreference || '尚未選擇'),
              row('損壞照片', `${photoCount} 張`),
              row('初判', `${analysis.risk.label}；${analysis.responsibility.label}`),
              row('建議', analysis.recommendedAction),
              row('時間', dateText(repairItem.event_at || repairItem.updated_at || repairItem.reported_at)),
            ],
          },
        ],
        footerActions,
      ),
    };
  }
  return {
    type: 'flex',
    altText: `報修詳情｜${repairItem && (repairItem.unit_label || repairItem.public_id) || '房客報修'}`,
    contents: repairDetailBubble(repairItem, scope),
  };
}

function dashboardRepairDetailCard(repairItem, scope, lineUserId, options = {}) {
  const ticketPublicId = repairItem && (repairItem.public_id || repairItem.publicId);
  if (!repairItem || !ticketPublicId || !lineUserId) {
    return {
      type: 'flex',
      altText: `報修通知：${repairItem && (repairItem.unit_label || repairItem.public_id) || '未指定報修'}`,
      contents: repairDetailBubble(repairItem, scope),
    };
  }

  const photoCount = Number(repairItem.damage_photo_count || (Array.isArray(repairItem.files)
    ? repairItem.files.filter((file) => file.purpose === 'damage_photo').length
    : 0) || 0);
  const tenantName = repairItem.tenant_name || '房客';
  const eventTime = dateText(repairItem.event_at || repairItem.updated_at || repairItem.reported_at);
  const titleText = options.title || '🛠️ 新報修通知';
  const subtitleText = options.subtitle || '有一筆報修事件需要查看';
  const tag = options.tag || '房東端';
  const isTenantSide = String(tag).includes('房客');
  const tone = isTenantSide
    ? { border: '#A7F3D0', tagBg: '#DCFCE7', tagColor: '#047857' }
    : { border: '#1F2937', tagBg: '#E5E7EB', tagColor: '#1F2937' };

  const summaryText = options.summary
    || repairItem.description
    || repairItem.category
    || '房客新增了一筆報修案件。';
  const negotiationText = options.negotiationText
    || repairItem.latest_negotiation_text
    || repairItem.negotiationText
    || '';
  const detailUrl = landlordRepairDetailUrl(ticketPublicId, lineUserId, scope);
  const footerActions = [
    ...(options.enableRecommendationChoices ? [{
      type: 'button',
      height: 'sm',
      style: 'primary',
      color: '#1F2937',
      action: {
        type: 'uri',
        label: '採用目前建議',
        uri: landlordRepairAdoptRecommendationUrl(ticketPublicId, lineUserId, scope),
      },
    }, {
      type: 'button',
      height: 'sm',
      action: {
        type: 'uri',
        label: '補充或提出異議',
        uri: landlordRepairNegotiationUrl(ticketPublicId, lineUserId, scope),
      },
    }] : []),
    ...(options.enableNegotiationReply ? [{
      type: 'button',
      height: 'sm',
      style: 'primary',
      color: '#1F2937',
      action: {
        type: 'uri',
        label: '前往回覆協商',
        uri: landlordRepairNegotiationUrl(ticketPublicId, lineUserId, scope),
      },
    }] : []),
    {
      type: 'button',
      height: 'sm',
      style: options.enableNegotiationReply || options.enableRecommendationChoices ? 'secondary' : 'primary',
      color: options.enableNegotiationReply || options.enableRecommendationChoices ? undefined : (isTenantSide ? '#047857' : '#1F2937'),
      action: {
        type: 'uri',
        label: '查看案件',
        uri: detailUrl,
      },
    },
  ];

  return {
    type: 'flex',
    altText: `${titleText.replace(/^[^\w\u4e00-\u9fff]+/, '')}：${repairItem.unit_label || ticketPublicId}`,
    contents: notificationShell(
      titleText,
      subtitleText,
      [
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          backgroundColor: '#F8FAFC',
          borderColor: tone.border,
          borderWidth: '1px',
          cornerRadius: '16px',
          paddingAll: '12px',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'sm',
              alignItems: 'center',
              contents: [
                { type: 'text', text: repairItem.unit_label || '租屋物件', size: 'md', weight: 'bold', color: '#111827', wrap: true, flex: 1 },
                {
                  type: 'box',
                  layout: 'vertical',
                  flex: 0,
                  backgroundColor: tone.tagBg,
                  cornerRadius: '999px',
                  paddingStart: '10px',
                  paddingEnd: '10px',
                  paddingTop: '3px',
                  paddingBottom: '3px',
                  contents: [{ type: 'text', text: String(tag), size: 'xxs', color: tone.tagColor, weight: 'bold', align: 'center' }],
                },
              ],
            },
            { type: 'text', text: String(summaryText), size: 'sm', color: '#334155', wrap: true, maxLines: 2, margin: 'sm' },
            ...(negotiationText ? [{
              type: 'text',
              text: `協商：${String(negotiationText)}`,
              size: 'xs',
              color: '#475569',
              wrap: true,
              maxLines: 2,
              margin: 'sm',
            }] : []),
            { type: 'text', text: `${tenantName}｜照片 ${photoCount} 張｜${eventTime}`, size: 'xxs', color: '#94A3B8', wrap: true, margin: 'sm' },
          ],
        },
      ],
      footerActions,
    ),
  };
}

module.exports = {
  dashboardOverviewCard,
  dashboardSectionCard,
  dashboardTaskSectionCard,
  dashboardHistorySectionCard,
  dashboardRepairDetailCard,
  taskMenuQuickReplyMessage,
  historyQuickReplyMessage,
};
