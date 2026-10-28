const { appTimeZone, normalizeStamp } = require('./showingSlotTime');

function displayStamp(value) {
  return normalizeStamp(value) ? String(value).replace('T', ' ') : '時間待確認';
}

function addMinutes(stamp, minutes) {
  const normalized = normalizeStamp(stamp);
  if (!normalized) return null;
  const [datePart, timePart] = normalized.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0')
  ].join('-') + `T${String(next.getUTCHours()).padStart(2, '0')}:${String(next.getUTCMinutes()).padStart(2, '0')}`;
}

function calendarStamp(value) {
  const normalized = normalizeStamp(value);
  return normalized ? `${normalized.replace(/[-:]/g, '')}00` : '';
}

function googleCalendarUrl({ listingTitle, startsAt, endsAt }) {
  const start = normalizeStamp(startsAt);
  if (!start) return '';
  const end = normalizeStamp(endsAt) || addMinutes(start, 60);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `看房：${listingTitle || '房源'}`,
    dates: `${calendarStamp(start)}/${calendarStamp(end)}`,
    ctz: appTimeZone(),
    details: '房東已同意本次看房預約。看房時請開啟屋況點交，記錄照片、影片與備註。'
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function inspectionStartAction(appointmentPublicId) {
  return {
    type: 'postback',
    label: '開始屋況點交',
    data: new URLSearchParams({ action: 'tenant_pre_inspection_start', appointment_id: appointmentPublicId }).toString(),
    displayText: '開始屋況點交'
  };
}

function confirmedShowingCard({ appointmentPublicId, listingTitle, startsAt, endsAt }) {
  const calendarUrl = googleCalendarUrl({ listingTitle, startsAt, endsAt });
  const actions = [];
  if (calendarUrl) {
    actions.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: { type: 'uri', label: '加入行事曆', uri: calendarUrl }
    });
  }
  actions.push({
    type: 'button',
    style: 'primary',
    color: '#0F766E',
    height: 'sm',
    action: inspectionStartAction(appointmentPublicId)
  });

  return {
    type: 'flex',
    altText: '房東已同意看房預約',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0F766E', paddingAll: 'xl',
        contents: [
          { type: 'text', text: '看房預約已核准', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: '房東已同意本次預約', color: '#CCFBF1', size: 'sm', margin: 'sm' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'xl', spacing: 'md',
        contents: [
          { type: 'text', text: listingTitle || '房源', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: `看房時間：${displayStamp(startsAt)}`, size: 'sm', color: '#475569', wrap: true },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '看房時請點「開始屋況點交」，即時拍照、錄影或記下屋況；這份紀錄會精確連到本次看房。', size: 'sm', color: '#334155', wrap: true }
        ]
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: actions }
    }
  };
}

function showingDayOfReminderCard({ appointmentPublicId, listingTitle, startsAt }) {
  return {
    type: 'flex',
    altText: '今天有看房預約，記得屋況點交',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'xl', spacing: 'md',
        contents: [
          { type: 'text', text: '今天要看房', weight: 'bold', size: 'lg', color: '#0F766E' },
          { type: 'text', text: listingTitle || '房源', size: 'md', weight: 'bold', wrap: true },
          { type: 'text', text: `時間：${displayStamp(startsAt)}`, size: 'sm', color: '#475569' },
          { type: 'text', text: '到現場後請開啟屋況點交，拍下設備、瑕疵與重要備註，完成後可送交房東確認。', size: 'sm', color: '#334155', wrap: true }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        contents: [{ type: 'button', style: 'primary', color: '#0F766E', action: inspectionStartAction(appointmentPublicId) }]
      }
    }
  };
}

module.exports = { confirmedShowingCard, googleCalendarUrl, showingDayOfReminderCard };
