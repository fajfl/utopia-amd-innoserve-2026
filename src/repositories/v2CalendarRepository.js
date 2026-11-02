/**
 * V2 Calendar Repository
 */

const EVENT_TYPE_COLORS = {
  showing: 'green',
  rent_due: 'red',
  contract_expiry: 'olive',
  renewal_reminder: 'olive',
  repair_appointment: 'orange',
  inspection: 'orange',
  billing: 'red',
  lease_end: 'olive',
};

/**
 * 取得使用者在指定年月的行事曆事件。
 * @param {object} driver - sqlDriver (SQLite or TiDB)
 * @param {number|null} userId - users.id
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {Promise<Array<{day: number, title: string, event_type: string, color: string, starts_at: string, subtitle: string}>>}
 */
async function getUserCalendarEvents(driver, userId, year, month) {
  if (!userId) return [];

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const monthStart = `${monthStr}-01`;
  const nextMonth = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const events = [];

  // ── 1. calendar_events
  try {
    const calRows = await driver.all(`
      SELECT
        ce.event_type,
        ce.title,
        ce.starts_at,
        COALESCE(l.title, '') AS subtitle
      FROM calendar_events ce
      LEFT JOIN listings l ON l.id = ce.listing_id
      LEFT JOIN inquiries i ON i.id = ce.inquiry_id
      LEFT JOIN contract_parties cp ON cp.contract_id = ce.contract_id
      LEFT JOIN lease_parties lp ON lp.user_id = ?
      LEFT JOIN leases le ON le.id = lp.lease_id AND le.contract_id = ce.contract_id
      WHERE ce.status = 'scheduled'
        AND ce.starts_at >= ?
        AND ce.starts_at < ?
        AND (
          i.user_id = ?
          OR cp.user_id = ?
          OR le.id IS NOT NULL
        )
      ORDER BY ce.starts_at
    `, [userId, monthStart, nextMonth, userId, userId]);

    for (const row of calRows) {
      const day = parseDayFromDate(row.starts_at);
      if (day) {
        events.push({
          day,
          title: row.title || row.event_type,
          event_type: row.event_type,
          color: EVENT_TYPE_COLORS[row.event_type] || 'gray',
          starts_at: row.starts_at,
          subtitle: row.subtitle,
        });
      }
    }
  } catch (err) {
    if (!String(err.message).includes('no such table') && !String(err.message).includes("doesn't exist")) throw err;
  }

  // ── 2. showing_appointments
  try {
    const showingRows = await driver.all(`
      SELECT
        sa.starts_at,
        sa.status,
        COALESCE(l.title, '看房預約') AS title
      FROM showing_appointments sa
      JOIN listings l ON l.id = sa.listing_id
      WHERE sa.tenant_user_id = ?
        AND sa.status IN ('pending', 'confirmed')
        AND sa.starts_at >= ?
        AND sa.starts_at < ?
      ORDER BY sa.starts_at
    `, [userId, monthStart, nextMonth]);

    for (const row of showingRows) {
      const day = parseDayFromDate(row.starts_at);
      if (day) {
        const statusLabel = row.status === 'confirmed' ? '已確認' : '待確認';
        events.push({
          day,
          title: `🏠 ${row.title}`,
          event_type: 'showing',
          color: 'green',
          starts_at: row.starts_at,
          subtitle: statusLabel,
        });
      }
    }
  } catch (err) {
    if (!String(err.message).includes('no such table') && !String(err.message).includes("doesn't exist")) throw err;
  }

  // ── 3. billing_charges
  try {
    const billingRows = await driver.all(`
      SELECT
        bc.due_date,
        bc.charge_type,
        bc.amount,
        bc.status
      FROM billing_charges bc
      JOIN leases le ON le.id = bc.lease_id
      JOIN lease_parties lp ON lp.lease_id = le.id AND lp.user_id = ?
      WHERE bc.status IN ('pending', 'partially_paid', 'overdue')
        AND bc.due_date >= ?
        AND bc.due_date < ?
      ORDER BY bc.due_date
    `, [userId, monthStart, nextMonth]);

    const CHARGE_LABELS = {
      rent: '租金',
      management_fee: '管理費',
      water: '水費',
      electricity: '電費',
      gas: '瓦斯費',
      parking: '停車費',
      repair: '修繕費',
      other: '費用',
    };

    for (const row of billingRows) {
      const day = parseDayFromDate(row.due_date);
      if (day) {
        const label = CHARGE_LABELS[row.charge_type] || row.charge_type;
        const statusLabel = row.status === 'overdue' ? '逾期' : '待繳';
        events.push({
          day,
          title: `💰 ${label} NT$${Number(row.amount).toLocaleString('zh-TW')}`,
          event_type: 'billing',
          color: 'red',
          starts_at: row.due_date,
          subtitle: statusLabel,
        });
      }
    }
  } catch (err) {
    if (!String(err.message).includes('no such table') && !String(err.message).includes("doesn't exist")) throw err;
  }

  // ── 4. leases
  try {
    const leaseRows = await driver.all(`
      SELECT
        le.end_date,
        ru.unit_label
      FROM leases le
      JOIN lease_parties lp ON lp.lease_id = le.id AND lp.user_id = ?
      JOIN rental_units ru ON ru.id = le.rental_unit_id
      WHERE le.status IN ('active', 'scheduled')
        AND le.end_date >= ?
        AND le.end_date < ?
    `, [userId, monthStart, nextMonth]);

    for (const row of leaseRows) {
      const day = parseDayFromDate(row.end_date);
      if (day) {
        events.push({
          day,
          title: `📋 合約到期`,
          event_type: 'lease_end',
          color: 'olive',
          starts_at: row.end_date,
          subtitle: row.unit_label || '',
        });
      }
    }
  } catch (err) {
    if (!String(err.message).includes('no such table') && !String(err.message).includes("doesn't exist")) throw err;
  }

  events.sort((a, b) => a.day - b.day || String(a.starts_at).localeCompare(String(b.starts_at)));

  return deduplicateEvents(events);
}

function parseDayFromDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).match(/^\d{4}-\d{2}-(\d{2})/);
  return match ? Number(match[1]) : null;
}

function deduplicateEvents(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.day}|${e.event_type}|${e.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  getUserCalendarEvents,
  EVENT_TYPE_COLORS,
};
