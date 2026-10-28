const { withV2Driver } = require('../database/v2Driver');
const repo = require('../repositories/v2ReminderRepository');
const { client: lineClient } = require('../lineClient');
const { showingDayOfReminderCard } = require('./showingAppointmentLinePresenter');
const { dispatchAgentNotifications } = require('./ecsNeoDraftNotificationDispatcher');

const EVENT_LABELS = {
  showing: '看房提醒',
  rent_due: '租金繳交提醒',
  lease_start: '租約開始提醒',
  lease_end: '租約到期提醒',
  custom_obligation: '合約約定事項提醒'
};

function startReminderWorker({ intervalMs = 60 * 1000 } = {}) {
  runDueReminderScan().catch((error) => {
    console.error('Reminder worker scan failed:', error.message);
  });
  const timer = setInterval(() => {
    runDueReminderScan().catch((error) => {
      console.error('Reminder worker scan failed:', error.message);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

async function runDueReminderScan(now = new Date()) {
  let count = 0;
  
  await withV2Driver(async (db) => {
    const events = await repo.getDueEvents(db, now);
    for (const event of events) {
      await sendEventReminder(db, event);
      count++;
    }

    // 合約草稿的 outbox 借用同一個掃描週期,不另開一個 timer。
    // 包在自己的 try/catch 裡:草稿通知壞掉不能連帶讓看房提醒停掉。
    try {
      await dispatchAgentNotifications({ db, lineClient });
    } catch (error) {
      console.error('Contract draft notification dispatch failed:', error.message);
    }
  });

  return count;
}

async function sendEventReminder(db, event) {
  let status = 'sent';
  let errorMessage = null;

  try {
    if (event.recipient_line_user_id) {
      const message = event.event_type === 'showing' && event.appointment_public_id
        ? showingDayOfReminderCard({
          appointmentPublicId: event.appointment_public_id,
          listingTitle: event.title,
          startsAt: event.starts_at
        })
        : { type: 'text', text: reminderText(event) };
      await lineClient.pushMessage(event.recipient_line_user_id, {
        ...message
      });
    } else {
      throw new Error('No line user id found for recipient');
    }
  } catch (error) {
    status = 'failed';
    errorMessage = error.message;
  }

  try {
    await repo.insertNotificationLog(db, {
      idempotencyKey: event.idempotency_key,
      recipientLineIdentityId: event.recipient_line_identity_id,
      recipientUserId: null, 
      eventType: event.event_type,
      entityType: event.entity_type,
      entityId: event.entity_id,
      payloadJson: {
        title: event.title,
        description: event.description,
        starts_at: event.starts_at,
        remind_at: event.remind_at || null,
        appointment_public_id: event.appointment_public_id || null
      },
      status,
      errorMessage
    });
  } catch (err) {
    console.error('Failed to log reminder push:', err.message);
  }
}

function reminderText(event) {
  const label = EVENT_LABELS[event.event_type] || event.title || '行事曆提醒';
  const lines = [
    `【${label}】`,
    `時間：${formatLocalDateTime(event.starts_at)}`
  ];
  if (event.description) lines.push(`說明：${event.description}`);
  return lines.join('\n');
}

function formatLocalDateTime(timeStr) {
  if (!timeStr) return '';
  const d = new Date(timeStr);
  if (Number.isNaN(d.getTime())) return timeStr;
  
  const datePart = [
    String(d.getFullYear()).padStart(4, '0'),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
  
  // IF it ends exactly at 00:00:00 (like rent_due), we just show date
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
     // wait, starts_at from DB is already local time string or UTC?
     // Actually let's just output local time.
  }
  
  return `${datePart} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

module.exports = {
  runDueReminderScan,
  startReminderWorker
};
