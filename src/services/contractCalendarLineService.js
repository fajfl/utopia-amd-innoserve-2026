/**
 * Contract Calendar LINE Service
 */
const { withV2Driver } = require('../database/v2Driver');
const { getUserCalendarEvents } = require('../repositories/v2CalendarRepository');
const { calendarCardMessage } = require('./cardMessageService');
const { client } = require('../lineClient');

const CALENDAR_TEXTS = new Set([
  '行事曆',
  '合約行事曆',
]);

function isCalendarCommand(text) {
  return CALENDAR_TEXTS.has(String(text || '').trim());
}

async function resolveUserId(driver, lineUserId) {
  if (!lineUserId) return null;
  
  if (lineUserId === 'demo-user-tenant' || lineUserId === 'demo-user-landlord') {
    const rows = await driver.all("SELECT id FROM users WHERE public_id LIKE 'user-%' ORDER BY id LIMIT 1");
    return rows.length > 0 ? rows[0].id : null;
  }

  const rows = await driver.all('SELECT user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
  return rows.length > 0 ? rows[0].user_id : null;
}

async function handleCalendarCommand(lineUserId, replyToken, year, month) {
  try {
    await withV2Driver(async (driver) => {
      const userId = await resolveUserId(driver, lineUserId);
      const now = new Date();
      const calYear = year || now.getFullYear();
      const calMonth = month || (now.getMonth() + 1);

      const events = userId ? await getUserCalendarEvents(driver, userId, calYear, calMonth) : [];
      
      const flexMessage = calendarCardMessage(events, calYear, calMonth);
      
      if (replyToken) {
        await client.replyMessage(replyToken, [flexMessage]);
      } else {
        await client.pushMessage(lineUserId, [flexMessage]);
      }
    });
  } catch (error) {
    console.error('Failed to handle calendar command:', error);
  }
}

module.exports = {
  isCalendarCommand,
  handleCalendarCommand,
};
