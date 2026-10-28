const COLORS = {
  red: '#E94B5F',
  redBg: '#FFF3F5',
  green: '#0F8F7F',
  greenBg: '#ECFDF8',
  olive: '#7C9A1F',
  oliveBg: '#F8FBEA',
  gray: '#475569',
  grayBg: '#EEF2F7',
  grayBorder: '#94A3B8',
  orange: '#F59E0B',
  orangeBg: '#FFFBEB',
  title: '#0F172A',
  text: '#111827',
  muted: '#64748B',
  line: '#E5E7EB',
  white: '#FFFFFF'
};

function webUrl(path) {
  const baseUrl = (process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${baseUrl}${path}`;
}

function liffAppId() {
  return process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
}

function liffUrl(path) {
  const id = liffAppId();
  if (!id) return webUrl(path);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `https://miniapp.line.me/${encodeURIComponent(id)}${normalizedPath}`;
}

function contractDraftsUrl() {
  return liffUrl('/v2/contracts/drafts?v=2');
}

function electronicSignatureUrl() {
  return liffUrl('/v2/sign?v=2');
}

function contractsUrl() { return liffUrl('/v2/contracts'); }
function profileUrl() { return liffUrl('/profile'); }

function googleCalendarUrl({ title, start, end, details }) {
  return `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${start}/${end}`, details }).toString()}`;
}

function outlookCalendarUrl({ title, start, end, details }) {
  return `https://outlook.live.com/calendar/0/deeplink/compose?${new URLSearchParams({ subject: title, startdt: start, enddt: end, body: details }).toString()}`;
}

function imageIcon(name, bg) {
  return {
    type: 'box', layout: 'vertical', width: '34px', height: '34px', cornerRadius: '10px', backgroundColor: bg,
    justifyContent: 'center', alignItems: 'center', paddingAll: '8px',
    contents: [{ type: 'image', url: webUrl(`/assets/icons/${name}.png`), size: 'full', aspectMode: 'fit' }]
  };
}

function pill(text, bg, color) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: '999px', borderColor: color, borderWidth: '1px', paddingTop: '6px', paddingBottom: '6px', paddingStart: '12px', paddingEnd: '12px',
    contents: [{ type: 'text', text, size: 'xs', weight: 'bold', color, align: 'center' }]
  };
}

function actionButton(label, uri, color, style = 'primary') {
  return { type: 'button', style, height: 'sm', color, action: { type: 'uri', label, uri } };
}

function detailIconRow(icon, label, value, color = COLORS.muted, options = {}) {
  return {
    type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm', alignItems: 'flex-start',
    contents: [
      { type: 'text', text: label, size: 'xs', color: COLORS.muted, weight: 'bold', flex: 5, wrap: true },
      { type: 'text', text: value, size: 'xs', color: COLORS.text, align: 'end', flex: 7, wrap: true, maxLines: options.maxLines || 1 }
    ]
  };
}

function reminderCardMessage(options = {}) {
  const reminder = {
    name: options.name || '王小明', reminderBy: options.reminderBy || '合約助手', subject: options.subject || '押金返還確認',
    deadline: options.deadline || '2026/5/25 09:00', contractTitle: options.contractTitle || '王小明租屋合約',
    note: options.note || '請於截止日前確認提醒事項是否已完成。', uri: options.uri || contractsUrl()
  };
  return { type: 'flex', altText: `合約提醒：${reminder.subject}`, contents: { type: 'bubble', size: 'mega', body: { type: 'box', layout: 'vertical', paddingAll: '18px', backgroundColor: COLORS.white, contents: [
    { type: 'box', layout: 'horizontal', alignItems: 'center', contents: [imageIcon('bell-orange', COLORS.orangeBg), { type: 'text', text: '合約提醒', size: 'sm', weight: 'bold', color: COLORS.orange, margin: 'md', flex: 1 }, pill('待處理', COLORS.orangeBg, COLORS.orange)] },
    { type: 'text', text: reminder.contractTitle, size: 'xl', weight: 'bold', color: COLORS.title, margin: 'lg', wrap: true },
    { type: 'text', text: reminder.note, size: 'xs', color: COLORS.muted, margin: 'sm', wrap: true },
    { type: 'separator', margin: 'xl', color: COLORS.line },
    detailIconRow('user-neutral', '名字', reminder.name), detailIconRow('bell-neutral', '提醒人', reminder.reminderBy), detailIconRow('clipboard', '提醒事項', reminder.subject, COLORS.orange, { maxLines: 2 }), detailIconRow('calendar', '截止日', reminder.deadline, COLORS.orange, { maxLines: 2 }),
    { type: 'box', layout: 'horizontal', margin: 'lg', paddingAll: '14px', backgroundColor: COLORS.orangeBg, cornerRadius: '14px', borderColor: '#FDE68A', borderWidth: '1px', alignItems: 'center', contents: [
      { type: 'box', layout: 'vertical', width: '18px', height: '18px', flex: 0, margin: 'xs', contents: [{ type: 'image', url: webUrl('/assets/icons/clipboard.png'), size: 'full', aspectMode: 'fit' }] },
      { type: 'box', layout: 'vertical', margin: 'md', flex: 1, contents: [
        { type: 'text', text: '提醒事項', size: 'xs', color: COLORS.muted },
        { type: 'text', text: reminder.subject, size: 'md', color: COLORS.orange, weight: 'bold', margin: 'xs', wrap: true }
      ]},
      { type: 'text', text: '›', size: 'xl', color: COLORS.muted, flex: 0 }
    ] },
    { type: 'box', layout: 'vertical', margin: 'lg', contents: [actionButton('查看合約狀態', reminder.uri, COLORS.orange)] }
  ] } } };
}

function calendarDay(text, options = {}) {
  const content = { type: 'text', text: text || ' ', size: 'xs', align: 'center', color: options.color || (text ? '#334155' : '#CBD5E1'), weight: options.weight || 'regular' };
  if (!options.backgroundColor) return content;
  return { type: 'box', layout: 'vertical', flex: 1, height: '24px', backgroundColor: options.backgroundColor, cornerRadius: '999px', justifyContent: 'center', contents: [content] };
}

function calendarWeek(days, highlights = {}) {
  return { type: 'box', layout: 'horizontal', spacing: 'xs', margin: 'xs', contents: days.map((day) => {
    const item = calendarDay(day, highlights[day] || {});
    return item.type === 'box' ? item : { type: 'box', layout: 'vertical', flex: 1, height: '24px', justifyContent: 'center', contents: [item] };
  }) };
}

function legendDot(label, color) {
  return { type: 'box', layout: 'horizontal', flex: 1, contents: [{ type: 'text', text: '●', size: 'xxs', color, flex: 0 }, { type: 'text', text: label, size: 'xxs', color: COLORS.muted, margin: 'xs' }] };
}

function calendarReminderCard(date, title, subtitle, color, backgroundColor) {
  const contents = [
    { type: 'text', text: date || '-', size: 'xs', color, weight: 'bold', align: 'center' },
    { type: 'text', text: title || '-', size: 'xs', color: COLORS.text, weight: 'bold', align: 'center', margin: 'sm', wrap: true },
  ];
  if (subtitle) {
    contents.push({ type: 'text', text: subtitle, size: 'xxs', color: COLORS.muted, align: 'center', margin: 'xs', wrap: true });
  }
  return { type: 'box', layout: 'vertical', flex: 1, paddingAll: '10px', backgroundColor, cornerRadius: '14px', contents };
}

function calendarCardMessage(events = [], year, month) {
  const now = new Date();
  const calYear = year || now.getFullYear();
  const calMonth = month || (now.getMonth() + 1);
  const monthLabel = `${calMonth}月`;

  const firstDay = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;

  const COLOR_MAP = {
    red: { backgroundColor: COLORS.redBg, color: COLORS.red, weight: 'bold' },
    green: { backgroundColor: COLORS.greenBg, color: COLORS.green, weight: 'bold' },
    olive: { backgroundColor: COLORS.oliveBg, color: COLORS.olive, weight: 'bold' },
    orange: { backgroundColor: COLORS.orangeBg, color: COLORS.orange, weight: 'bold' },
    gray: { backgroundColor: COLORS.grayBg, color: COLORS.gray, weight: 'bold' },
  };
  const PRIORITY = { red: 4, orange: 3, olive: 2, green: 1, gray: 0 };

  const highlights = {};
  for (const evt of events) {
    if (evt.day >= 1 && evt.day <= daysInMonth) {
      const existing = highlights[String(evt.day)];
      const existingPri = existing ? (PRIORITY[existing._color] || 0) : -1;
      const newPri = PRIORITY[evt.color] || 0;
      if (newPri > existingPri) {
        highlights[String(evt.day)] = { ...(COLOR_MAP[evt.color] || COLOR_MAP.gray), _color: evt.color };
      }
    }
  }
  for (const key of Object.keys(highlights)) delete highlights[key]._color;

  const weeks = [];
  let currentDay = 1;
  let weekDays = [];
  for (let i = 0; i < startOffset; i++) weekDays.push('');
  while (currentDay <= daysInMonth) {
    weekDays.push(String(currentDay));
    currentDay++;
    if (weekDays.length === 7) { weeks.push(weekDays); weekDays = []; }
  }
  if (weekDays.length > 0) {
    while (weekDays.length < 7) weekDays.push('');
    weeks.push(weekDays);
  }

  const eventDays = [...new Set(events.map((e) => e.day))].sort((a, b) => a - b);
  const subtitle = eventDays.length > 0
    ? `${eventDays.slice(0, 5).join('\u3001')}${eventDays.length > 5 ? ' \u7b49' : ''} \u662f\u672c\u6708\u91cd\u9ede\u65e5\u671f`
    : '\u672c\u6708\u66ab\u7121\u6392\u5b9a\u4e8b\u9805';

  const reminderCards = events.length
    ? events.slice(0, 3).map((event, index) => {
      const colors = [[COLORS.red, COLORS.redBg], [COLORS.green, COLORS.greenBg], [COLORS.olive, COLORS.oliveBg]][index] || [COLORS.gray, COLORS.grayBg];
      const dateStr = event.starts_at ? formatMonthDay(event.starts_at) : `${calMonth}/${event.day}`;
      return calendarReminderCard(dateStr, event.title || event.event_type, event.subtitle || '', colors[0], colors[1]);
    })
    : [calendarReminderCard('-', '\u5c1a\u7121\u63d0\u9192', '\u66ab\u7121\u6392\u5b9a\u4e8b\u9805', COLORS.gray, COLORS.grayBg)];

  const firstEvent = events[0] || {};
  const defaultDate = `${calYear}-${String(calMonth).padStart(2, '0')}-01`;

  // Month navigation
  const prevMonth = calMonth === 1 ? 12 : calMonth - 1;
  const prevYear = calMonth === 1 ? calYear - 1 : calYear;
  const nextMonth = calMonth === 12 ? 1 : calMonth + 1;
  const nextYear = calMonth === 12 ? calYear + 1 : calYear;
  const prevMonthLabel = `${prevMonth}\u6708`;
  const nextMonthLabel = `${nextMonth}\u6708`;

  const googleUrl = googleCalendarUrl({
    title: firstEvent.title || '\u884c\u4e8b\u66c6\u63d0\u9192',
    start: formatGoogleDate(firstEvent.starts_at || defaultDate) || '20260101T010000Z',
    end: formatGoogleDate(firstEvent.starts_at || defaultDate, 1) || '20260101T020000Z',
    details: firstEvent.subtitle || '\u884c\u4e8b\u66c6\u63d0\u9192',
  });
  const outlookUrl = outlookCalendarUrl({
    title: firstEvent.title || '\u884c\u4e8b\u66c6\u63d0\u9192',
    start: firstEvent.starts_at || `${defaultDate}T09:00:00`,
    end: firstEvent.starts_at || `${defaultDate}T10:00:00`,
    details: firstEvent.subtitle || '\u884c\u4e8b\u66c6\u63d0\u9192',
  });
  const fullCalendarUrl = liffUrl('/calendar');

  return { type: 'flex', altText: `${monthLabel}\u884c\u4e8b\u66c6`, contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: COLORS.title, paddingAll: '16px', contents: [
      { type: 'text', text: `\ud83d\udcc5 ${calYear}\u5e74${monthLabel}\u884c\u4e8b\u66c6`, size: 'xl', weight: 'bold', color: COLORS.white },
      { type: 'text', text: subtitle, size: 'xs', color: COLORS.line, margin: 'xs', wrap: true },
    ] },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: COLORS.white, contents: [
      { type: 'box', layout: 'vertical', paddingAll: '10px', backgroundColor: COLORS.grayBg, cornerRadius: '16px', contents: [
        { type: 'box', layout: 'horizontal', contents: ['\u4e00','\u4e8c','\u4e09','\u56db','\u4e94','\u516d','\u65e5'].map((day) => ({ type: 'text', text: day, size: 'xxs', color: '#94A3B8', align: 'center', flex: 1 })) },
        ...weeks.map((w) => calendarWeek(w, highlights)),
      ] },
      { type: 'box', layout: 'horizontal', margin: 'md', spacing: 'sm', contents: [legendDot('\u7e73\u8cbb', COLORS.red), legendDot('\u770b\u623f', COLORS.green), legendDot('\u5408\u7d04', COLORS.olive)] },
      { type: 'separator', margin: 'md', color: COLORS.line },
      { type: 'box', layout: 'horizontal', margin: 'md', contents: [
        { type: 'text', text: '\u6700\u8fd1\u63d0\u9192', size: 'xs', color: COLORS.muted, weight: 'bold', flex: 1 },
        { type: 'text', text: `${events.length} \u4ef6\u4e8b\u9805`, size: 'xs', color: COLORS.green, weight: 'bold', align: 'end', flex: 1 },
      ] },
      { type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm', contents: reminderCards },
    ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', backgroundColor: COLORS.white, contents: [
      actionButton('\u5b8c\u6574\u884c\u4e8b\u66c6', fullCalendarUrl, COLORS.green),
      actionButton('\u52a0\u5165 Google \u65e5\u66c6', googleUrl, '#D1D5DB', 'secondary'),
      actionButton('\u52a0\u5165 Outlook \u65e5\u66c6', outlookUrl, '#D1D5DB', 'secondary'),
    ] },
  } };
}

function formatMonthDay(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(5, 10) || String(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatGoogleDate(dateStr, addHours = 0) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(d.getHours() + addHours);
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  } catch { return null; }
}

function profileCardMessage() {
  return { type: 'template', altText: '個人資料', template: { type: 'buttons', title: '個人資料', text: '查看或更新姓名、手機、信箱與戶籍地址。', actions: [{ type: 'uri', label: '前往個人資料', uri: profileUrl() }] } };
}

function contractDraftEntryCardMessage() {
  return { type: 'template', altText: '合約草稿', template: { type: 'buttons', title: '合約草稿', text: '查看 Agent 整理的最新合約草稿與版本紀錄。', actions: [{ type: 'uri', label: '開啟合約草稿', uri: contractDraftsUrl() }] } };
}

function electronicSignatureEntryCardMessage() {
  return { type: 'template', altText: '電子簽署', template: { type: 'buttons', title: '電子簽署', text: '查看目前待簽合約並進行驗證與簽署。', actions: [{ type: 'uri', label: '開啟電子簽署', uri: electronicSignatureUrl() }] } };
}

function carouselMessage() {
  const docs = [{ label: '主合約', draftId: 'main-v1' }, { label: 'NDA', draftId: 'nda-v1' }, { label: '報價單', draftId: 'quote-v1' }];
  return { type: 'template', altText: '合約文件確認清單', template: { type: 'carousel', columns: docs.map((doc) => ({ title: doc.label, text: '請預覽後確認。', actions: [{ type: 'uri', label: '預覽', uri: contractsUrl() }, { type: 'postback', label: '確認', data: `action=confirm_document&draftId=${encodeURIComponent(doc.draftId)}` }] })) } };
}

module.exports = { calendarCardMessage, carouselMessage, contractDraftEntryCardMessage, contractDraftsUrl, contractsUrl, electronicSignatureEntryCardMessage, electronicSignatureUrl, profileCardMessage, profileUrl, reminderCardMessage, webUrl };
