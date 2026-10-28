// 看房時段的時間格式與「現在」。
//
// showing_appointments.starts_at 從第一天起就是瀏覽器 datetime-local 的字串,
// 也就是**當地牆上時間**、沒有時區標記,格式 YYYY-MM-DDTHH:MM。showing_slots
// 沿用同一格式,字典序等於時間序,SQLite 與 TiDB 都能直接比字串。
//
// 因此「時段過期了沒」不能拿 new Date().toISOString() 去比:那是 UTC,對台灣時間
// 會差 8 小時,結果是**已經過去的時段還開放預約**,而且不會有任何錯誤訊息。
// 這裡把「現在」也轉成同一個時區的牆上時間再比。
//
// 時區可以用 APP_TIME_ZONE 覆寫,預設 Asia/Taipei —— 這個專案的房源、房東、房客
// 都在台灣,伺服器卻可能跑在 UTC 的雲端主機上。

const DEFAULT_TIME_ZONE = 'Asia/Taipei';

// YYYY-MM-DDTHH:MM,秒數可有可無(datetime-local 在某些瀏覽器會帶 :00)。
const STAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

// 日曆挑日期 → YYYY-MM-DD;時間格挑時刻 → HH:MM。兩者都是「牆上時間」的一半,
// 拼起來才是一個 stamp,所以驗證與拼接都放在這裡,不散到路由或前端。
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

const MINUTES_PER_DAY = 24 * 60;

function appTimeZone() {
  return process.env.APP_TIME_ZONE || DEFAULT_TIME_ZONE;
}

// 目前時間在 timeZone 之下的牆上時間,格式與 slot / appointment 的 starts_at 相同。
function localStamp(now = new Date(), timeZone = appTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  // hourCycle h23 在部分 runtime 仍會給 '24' 表示午夜,直接補回 '00'。
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

function localDate(now = new Date(), timeZone = appTimeZone()) {
  return localStamp(now, timeZone).slice(0, 10);
}

// 房東送進來的時間一律正規化成 YYYY-MM-DDTHH:MM,順便擋掉 2026-02-31 這種
// 格式對但不存在的日期 —— 那種值存進去之後永遠不會等於任何真實時間。
function normalizeStamp(value) {
  const text = String(value || '').trim();
  const match = STAMP_PATTERN.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  if (probe.getUTCFullYear() !== Number(year)
    || probe.getUTCMonth() !== Number(month) - 1
    || probe.getUTCDate() !== Number(day)
    || probe.getUTCHours() !== Number(hour)
    || probe.getUTCMinutes() !== Number(minute)) {
    return null;
  }
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

// ---- 日期與時刻的零件 ----
//
// 週期規則(「每週四 20:00 之後」)存的是 weekday + HH:MM + 結束日期,不是 stamp。
// 展開成實際 stamp 的算術全部用 Date.UTC 做:UTC 沒有日光節約也沒有時區偏移,
// 「加一天」永遠是加 86400 秒。算完再自己格式化成牆上時間字串,不經過任何
// toISOString() —— 那會把結果偏移回 UTC,正是 showingSlotTime 存在的原因。

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeDate(value) {
  const match = DATE_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  // 借 normalizeStamp 擋掉 2026-02-31 這種格式對但不存在的日期,規則只有一份。
  return normalizeStamp(`${match[0]}T00:00`) ? match[0] : null;
}

function normalizeTime(value) {
  const match = TIME_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const [, hour, minute] = match;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  return `${hour}:${minute}`;
}

function minutesOfTime(time) {
  const normalized = normalizeTime(time);
  if (!normalized) return null;
  return Number(normalized.slice(0, 2)) * 60 + Number(normalized.slice(3, 5));
}

// 日期 + 時刻 → slot 的 starts_at。任一半不合法就整個不合法。
function composeStamp(date, time) {
  const day = normalizeDate(date);
  const clock = normalizeTime(time);
  if (!day || !clock) return null;
  return normalizeStamp(`${day}T${clock}`);
}

function dateToUtc(date) {
  const day = normalizeDate(date);
  if (!day) return null;
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

function formatUtcDate(millis) {
  const probe = new Date(millis);
  return `${probe.getUTCFullYear()}-${pad2(probe.getUTCMonth() + 1)}-${pad2(probe.getUTCDate())}`;
}

function addDays(date, days) {
  const base = dateToUtc(date);
  if (base === null || !Number.isInteger(days)) return null;
  return formatUtcDate(base + days * 86400000);
}

// 0 = 週日,與 JS 的 Date#getDay 一致,前端的 chip 順序才不必再換算一次。
function weekdayOf(date) {
  const base = dateToUtc(date);
  if (base === null) return null;
  return new Date(base).getUTCDay();
}

// 單次時段的「每場長度」會讓結束時間跨過午夜(23:30 + 60 分鐘),所以這裡允許進位到隔天。
function addMinutesToStamp(stamp, minutes) {
  const normalized = normalizeStamp(stamp);
  if (!normalized || !Number.isInteger(minutes)) return null;
  const base = dateToUtc(normalized.slice(0, 10));
  const total = base + (minutesOfTime(normalized.slice(11, 16)) + minutes) * 60000;
  const probe = new Date(total);
  return `${formatUtcDate(total)}T${pad2(probe.getUTCHours())}:${pad2(probe.getUTCMinutes())}`;
}

/**
 * 把一條週期規則展開成實際的 stamp 區間。
 *
 * 邊界一律由呼叫端給,函式本身不看「現在」:
 *   fromDate   從哪一天開始找(含),通常是今天
 *   untilDate  找到哪一天為止(含),就是規則的硬邊界
 *   maxSlots   產生上限,超過就截斷並回報 truncated
 *   afterStamp 早於或等於這個 stamp 的區間直接丟掉(擋掉「今天但已經過去的時刻」)
 *
 * 一天之內從 startTime 起、每 slotMinutes 一場,直到再開一場就會超過 endTime。
 * 刻意不讓場次跨過 endTime:房東寫 20:00-22:00 的意思是 22:00 就結束了。
 */
function enumerateWeeklySlots({
  weekday,
  startTime,
  endTime,
  slotMinutes,
  fromDate,
  untilDate,
  maxSlots = 60,
  afterStamp = null
} = {}) {
  const startMinutes = minutesOfTime(startTime);
  const endMinutes = minutesOfTime(endTime);
  const from = normalizeDate(fromDate);
  const until = normalizeDate(untilDate);
  if (startMinutes === null || endMinutes === null || !from || !until) return null;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0 || slotMinutes > MINUTES_PER_DAY) return null;
  if (endMinutes - startMinutes < slotMinutes) return null;
  if (until < from) return { slots: [], truncated: false };

  const slots = [];
  let truncated = false;
  // 先跳到第一個符合 weekday 的日期,之後每次 +7 天,不必逐日檢查。
  const offset = (weekday - weekdayOf(from) + 7) % 7;
  for (let date = addDays(from, offset); date && date <= until; date = addDays(date, 7)) {
    for (let at = startMinutes; at + slotMinutes <= endMinutes; at += slotMinutes) {
      const startsAt = composeStamp(date, `${pad2(Math.floor(at / 60))}:${pad2(at % 60)}`);
      if (!startsAt) continue;
      if (afterStamp && startsAt <= afterStamp) continue;
      if (slots.length >= maxSlots) {
        truncated = true;
        return { slots, truncated };
      }
      slots.push({ startsAt, endsAt: addMinutesToStamp(startsAt, slotMinutes) });
    }
  }
  return { slots, truncated };
}

module.exports = {
  DEFAULT_TIME_ZONE,
  MINUTES_PER_DAY,
  addDays,
  addMinutesToStamp,
  appTimeZone,
  composeStamp,
  enumerateWeeklySlots,
  localDate,
  localStamp,
  minutesOfTime,
  normalizeDate,
  normalizeStamp,
  normalizeTime,
  weekdayOf
};
