// 可看房時段 repository(driver 版,SQLite 與 TiDB 共用一份實作)。
//
// 參數 `db` 收的是 sqlDriver 的 driver,不是原始的 better-sqlite3 連線。
//
// 三個必須守住的規則:
//
// 1. 占用時段一律走 claimSlotCore 的條件式 UPDATE 並檢查 changes。
//    「先 SELECT 看有沒有空、再 UPDATE」在兩個 driver 底下都會有競態:兩位房客
//    可以同時讀到同一個 open 時段。條件寫在 UPDATE 的 WHERE 裡,搶輸的那一邊拿到
//    0 列,呼叫端丟 SlotConflictError,整個交易回捲。
//
// 2. SQL 只用兩個方言都吃的寫法:不用 date() / datetime()(TiDB 不報錯,直接回
//    NULL),JOIN 的 ON 條件裡不放子查詢(TiDB: ON condition doesn't support
//    subqueries yet),衍生表一律給別名。
//
// 3. 「現在」由呼叫端傳進來,而且是牆上時間字串(見 services/showingSlotTime.js)。
//    starts_at 存的是沒有時區的當地時間,拿 UTC 去比會差 8 小時。
//
// 4. 批次寫入(時段與週期規則)一律讓唯一索引當仲裁者:insert-ignore 或 upsert,
//    不先 SELECT 再決定寫不寫。房東雙擊「新增」會送出兩個同樣的請求,先查再寫
//    的話兩邊都看到「不存在」,第二個 INSERT 撞唯一鍵就把整批回捲成 500。

const crypto = require('node:crypto');

class SlotConflictError extends Error {
  constructor(message = '這個時段剛剛被其他房客預約走了，請改選其他時段。') {
    super(message);
    this.name = 'SlotConflictError';
    this.statusCode = 409;
  }
}

// 房東對房源的所有權。property_owners 可以掛在整個 property 上
// (rental_unit_id IS NULL),也可以只掛某個 rental_unit,兩種都算數。
//
// effective_until 的比較刻意把日期當參數傳進來 —— 原本專案裡有幾處寫
// po.effective_until >= date('now'),TiDB 沒有 date() 這個純量函式而且不報錯,
// 比較結果恆為 NULL,還在有效期內的房東會被整批濾掉。
async function findOwnedListing(db, { listingPublicId, lineUserId, today }) {
  const row = await db.get(`
    SELECT l.id, l.public_id, l.title, l.rental_unit_id, l.current_rent_amount, po.owner_user_id
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE l.public_id = ? AND li.line_user_id = ?
      AND (po.effective_until IS NULL OR po.effective_until >= ?)
    ORDER BY po.id ASC
    LIMIT 1
  `, [listingPublicId, lineUserId, today]);
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentalUnitId: row.rental_unit_id,
    rentAmount: row.current_rent_amount,
    ownerUserId: row.owner_user_id
  };
}

// 同一條所有權判斷,但用內部 id。LINE postback 拿到的是 appointment.listing_id,
// 沒有 public_id 可用,而所有權規則只能有一份。
async function findOwnedListingById(db, { listingId, lineUserId, today }) {
  if (!listingId || !lineUserId) return null;
  const row = await db.get(`
    SELECT l.id, l.public_id, l.title, l.rental_unit_id, po.owner_user_id
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE l.id = ? AND li.line_user_id = ?
      AND (po.effective_until IS NULL OR po.effective_until >= ?)
    ORDER BY po.id ASC
    LIMIT 1
  `, [listingId, lineUserId, today]);
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentalUnitId: row.rental_unit_id,
    ownerUserId: row.owner_user_id
  };
}

// 這位房東名下的房源。DISTINCT 是因為同一個房源可能同時掛著 property 層與
// rental_unit 層的所有權紀錄,兩列都符合條件。
async function listOwnedListings(db, { lineUserId, today, limit = 50 }) {
  const rows = await db.all(`
    SELECT DISTINCT l.id, l.public_id, l.title, l.current_rent_amount, ru.unit_label
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE li.line_user_id = ?
      AND (po.effective_until IS NULL OR po.effective_until >= ?)
    ORDER BY l.id DESC
    LIMIT ?
  `, [lineUserId, today, limit]);
  return rows.map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    unitLabel: row.unit_label || '',
    rentAmount: row.current_rent_amount
  }));
}

// 房東看到的時段清單:含已被預約的、已停用的與已過期的,因為那正是他要管理的東西。
// used_count 讓呼叫端知道這個時段有沒有被預約過 —— 有的話刪除只能軟刪(closed),
// 硬刪會把稽核紀錄一起帶走。
async function listSlotsForListing(db, { listingId, nowStamp }) {
  const rows = await db.all(`
    SELECT s.id, s.public_id, s.starts_at, s.ends_at, s.status, s.held_appointment_id,
           a.public_id appointment_public_id, a.status appointment_status,
           li.display_name_cache tenant_name,
           r.public_id recurrence_public_id,
           (SELECT COUNT(*) FROM showing_appointments sa WHERE sa.slot_id = s.id) used_count,
           (SELECT COUNT(*) FROM repair_slot_reservations rs WHERE rs.showing_slot_id = s.id) repair_held_count
    FROM showing_slots s
    LEFT JOIN showing_appointments a ON a.id = s.held_appointment_id
    LEFT JOIN showing_slot_recurrences r ON r.id = s.recurrence_id
    LEFT JOIN (
      SELECT li2.user_id, li2.display_name_cache,
             ROW_NUMBER() OVER (PARTITION BY li2.user_id ORDER BY li2.id) rn
      FROM line_identities li2
    ) li ON li.user_id = a.tenant_user_id AND li.rn = 1
    WHERE s.listing_id = ?
    ORDER BY s.starts_at ASC, s.id ASC
  `, [listingId]);
  return rows.map((row) => ({
    publicId: row.public_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    expired: row.starts_at <= nowStamp,
    usedCount: Number(row.used_count) || 0,
    repairHeldCount: Number(row.repair_held_count) || 0,
    recurrencePublicId: row.recurrence_public_id || null,
    appointment: row.appointment_public_id
      ? {
        publicId: row.appointment_public_id,
        status: row.appointment_status,
        tenantName: row.tenant_name || '房客'
      }
      : null
  }));
}

// 房客看到的時段:必須屬於這筆詢問的房源、仍是 open、沒有被占用、而且還沒過期。
// 詢問本身也要屬於這位房客 —— 換句話說一個房客看不到別人詢問底下的時段。
async function listAvailableSlotsForInquiry(db, { inquiryPublicId, tenantUserId, nowStamp, limit = 60 }) {
  return (await db.all(`
    SELECT s.public_id, s.starts_at, s.ends_at
    FROM showing_slots s
    JOIN inquiries i ON i.listing_id = s.listing_id
    WHERE i.public_id = ? AND i.user_id = ? AND i.ended_at IS NULL
      AND s.status = 'open' AND s.held_appointment_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = s.id
      )
      AND s.starts_at > ?
    ORDER BY s.starts_at ASC, s.id ASC
    LIMIT ?
  `, [inquiryPublicId, tenantUserId, nowStamp, limit])).map((row) => ({
    publicId: row.public_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at
  }));
}

async function createSlot(db, { listingId, createdByUserId, startsAt, endsAt = null, recurrenceId = null }) {
  const publicId = `slot-${crypto.randomUUID()}`;
  await db.run(`
    INSERT INTO showing_slots
      (public_id, listing_id, created_by_user_id, starts_at, ends_at, status, recurrence_id)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `, [publicId, listingId, createdByUserId, startsAt, endsAt, recurrenceId]);
  return { publicId, startsAt, endsAt, status: 'open' };
}

// 寫一個時段,但把 uq_showing_slots_listing_starts 的衝突當成「已經有了」。
//
// 回傳 null = 這個 (listing_id, starts_at) 已經存在,一列都沒動。
// 仲裁交給唯一索引本身,不先 SELECT ——「先查再寫」在兩個 driver 底下都有競態:
// 兩個交易可以同時查到「不存在」,然後其中一個 INSERT 撞唯一鍵讓整批回捲。
//
// 代價是 INSERT IGNORE / INSERT OR IGNORE 會把**其他**約束違反也降級成 0 列
// (FK、CHECK)。呼叫端必須已經確認 listing 與 owner 存在(requireOwnedListing),
// 時刻格式也已經過 showingSlotTime 正規化,所以剩下唯一可能被忽略的就是重複。
async function insertSlotIfAbsent(db, { listingId, createdByUserId, startsAt, endsAt = null, recurrenceId = null }) {
  const publicId = `slot-${crypto.randomUUID()}`;
  const result = await db.run(`
    ${db.dialect.insertIgnore} INTO showing_slots
      (public_id, listing_id, created_by_user_id, starts_at, ends_at, status, recurrence_id)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `, [publicId, listingId, createdByUserId, startsAt, endsAt, recurrenceId]);
  if (!result.changes) return null;
  return { publicId, startsAt, endsAt, status: 'open' };
}

/**
 * 一次寫入多個時段(日曆多選時刻,或一條週期規則展開的結果)。
 *
 * uq_showing_slots_listing_starts 是 (listing_id, starts_at):房東手動開過的時刻、
 * 或上一次展開已經產生的時刻,再寫一次就會撞唯一約束。**唯一索引就是仲裁者** ——
 * 每一列走 insert-ignore,寫進去算 created,被忽略算 skipped,兩者都不是錯誤。
 *
 * 這就是「重複執行不會產生重複列」的機制,而且它對併發成立:房東雙擊「新增」,
 * 兩個請求都會成功,第二個全部落在 skipped,資料庫的列數不變。也因此 booked 的
 * 時段不會被覆寫 —— 它的 starts_at 已經占著那把唯一鍵。
 *
 * 假設自己已經在交易裡。
 */
async function createSlotsBulk(db, { listingId, createdByUserId, entries, recurrenceId = null }) {
  const wanted = [...new Map((entries || [])
    .filter((entry) => entry && entry.startsAt)
    .map((entry) => [entry.startsAt, entry])).values()]
    .sort((left, right) => (left.startsAt < right.startsAt ? -1 : 1));
  if (!wanted.length) return { created: [], skipped: 0 };

  const created = [];
  for (const entry of wanted) {
    const slot = await insertSlotIfAbsent(db, {
      listingId,
      createdByUserId,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt || null,
      recurrenceId
    });
    if (slot) created.push(slot);
  }
  return { created, skipped: wanted.length - created.length };
}

// ---- 週期規則 ----

function mapRecurrence(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    listingId: row.listing_id,
    weekday: Number(row.weekday),
    startTime: row.start_time,
    endTime: row.end_time,
    slotMinutes: Number(row.slot_minutes),
    untilDate: row.until_date,
    status: row.status
  };
}

// 房東的規則清單。三個計數刻意用 SELECT 清單裡的純量子查詢,不用 GROUP BY ——
// TiDB 的 ONLY_FULL_GROUP_BY 生效,GROUP BY 就得把 r 的每一個欄位都列進去,
// 加欄位時很容易漏掉一個然後只在雲端硬錯。
async function listRecurrencesForListing(db, { listingId, nowStamp }) {
  const rows = await db.all(`
    SELECT r.id, r.public_id, r.listing_id, r.weekday, r.start_time, r.end_time,
           r.slot_minutes, r.until_date, r.status,
           (SELECT COUNT(*) FROM showing_slots s1
              WHERE s1.recurrence_id = r.id) slot_count,
           (SELECT COUNT(*) FROM showing_slots s2
              WHERE s2.recurrence_id = r.id AND s2.status = 'open' AND s2.starts_at > ?) open_count,
           (SELECT COUNT(*) FROM showing_slots s3
              WHERE s3.recurrence_id = r.id AND s3.status = 'booked') booked_count
    FROM showing_slot_recurrences r
    WHERE r.listing_id = ?
    ORDER BY r.status ASC, r.weekday ASC, r.start_time ASC, r.id ASC
  `, [nowStamp, listingId]);
  return rows.map((row) => ({
    ...mapRecurrence(row),
    slotCount: Number(row.slot_count) || 0,
    openCount: Number(row.open_count) || 0,
    bookedCount: Number(row.booked_count) || 0
  }));
}

async function findRecurrenceByPublicId(db, recurrencePublicId) {
  return mapRecurrence(await db.get(`
    SELECT id, public_id, listing_id, weekday, start_time, end_time, slot_minutes, until_date, status
    FROM showing_slot_recurrences
    WHERE public_id = ?
  `, [recurrencePublicId]));
}

async function findRecurrenceByKey(db, { listingId, weekday, startTime }) {
  return mapRecurrence(await db.get(`
    SELECT id, public_id, listing_id, weekday, start_time, end_time, slot_minutes, until_date, status
    FROM showing_slot_recurrences
    WHERE listing_id = ? AND weekday = ? AND start_time = ?
  `, [listingId, weekday, startTime]));
}

// 建立或更新。同一個 (listing, weekday, start_time) 再送一次就是「改這一條」——
// 唯一約束讓「改」有唯一的落點,房東不會累積一堆看起來一樣的規則。
//
// 一句 upsert 做完,不先 SELECT 再決定 INSERT/UPDATE:兩個同時送出的相同請求會
// 同時查到「不存在」,兩邊都走 INSERT,其中一個撞 uq_showing_slot_recurrences_key
// 讓整個交易回捲(房東雙擊就收到 500)。交給唯一索引仲裁,兩邊都會成功。
//
// reused 由「回讀到的 public_id 是不是我剛剛產生的那個」判斷,不看 affectedRows ——
// MySQL 的 ON DUPLICATE KEY UPDATE 是 1(新增)/ 2(更新)/ 0(值沒變),SQLite 一律 1,
// 兩邊語意不同。回讀一次在兩個方言下都只有一種答案。
//
// MySQL 的 ON DUPLICATE KEY 會對**任何**唯一索引觸發,不像 SQLite 只認指定欄位;
// 這裡另一個唯一欄位 public_id 每次都是新的 UUID,不會誤觸。
//
// 假設自己已經在交易裡。
async function upsertRecurrenceCore(db, {
  listingId, createdByUserId, weekday, startTime, endTime, slotMinutes, untilDate
}) {
  const publicId = `slotrule-${crypto.randomUUID()}`;
  await db.run(`
    INSERT INTO showing_slot_recurrences
      (public_id, listing_id, created_by_user_id, weekday, start_time, end_time, slot_minutes, until_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    ${db.dialect.onConflict('listing_id, weekday, start_time')}
      end_time = ${db.dialect.incoming('end_time')},
      slot_minutes = ${db.dialect.incoming('slot_minutes')},
      until_date = ${db.dialect.incoming('until_date')},
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `, [publicId, listingId, createdByUserId, weekday, startTime, endTime, slotMinutes, untilDate]);

  const rule = await findRecurrenceByKey(db, { listingId, weekday, startTime });
  // upsert 之後這一列一定在。查不到只可能是 schema 或 FK 出了問題,讓它明確炸掉,
  // 而不是回一個沒有 id 的物件、到 createSlotsBulk 才變成看不懂的錯誤。
  if (!rule) throw new Error('showing_slot_recurrences upsert did not produce a row');
  return { ...rule, reused: rule.publicId !== publicId };
}

async function setRecurrenceStatusCore(db, { recurrenceId, status }) {
  const result = await db.run(`
    UPDATE showing_slot_recurrences SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `, [status, recurrenceId]);
  return result.changes > 0;
}

/**
 * 收掉一條規則往後產生的時段。停用規則、或改參數後要重新展開時都用它。
 *
 * 三種列的處理刻意不同,對應既有的軟刪規則:
 *   從沒被預約過的未來 open 時段 → 真的刪掉。房東的意思是「這些不要了」,
 *                                 留成 closed 只會讓清單被幾十列灰字塞滿。
 *   被預約過但現在是 open 的      → 軟刪成 closed。showing_appointments.slot_id
 *                                 指著它,硬刪會把稽核鏈帶走。
 *   booked 或修繕占用中          → **一列都不動**。房客手上的預約不能憑空消失,
 *                                 房東要先讓那筆預約結束,跟單筆停用的 409 同一個規則。
 *   已經過去的                    → 不動,那是歷史。
 *
 * 假設自己已經在交易裡。
 */
async function retireRecurrenceSlotsCore(db, { recurrenceId, nowStamp }) {
  const deleted = await db.run(`
    DELETE FROM showing_slots
    WHERE recurrence_id = ? AND status = 'open' AND held_appointment_id IS NULL
      AND starts_at > ?
      AND NOT EXISTS (SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = showing_slots.id)
      AND id NOT IN (SELECT sa.slot_id FROM showing_appointments sa WHERE sa.slot_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = showing_slots.id)
  `, [recurrenceId, nowStamp]);

  // 剩下的未來 open 列就是有預約歷史的那些。
  const closed = await db.run(`
    UPDATE showing_slots
    SET status = 'closed', updated_at = CURRENT_TIMESTAMP
    WHERE recurrence_id = ? AND status = 'open' AND held_appointment_id IS NULL
      AND starts_at > ?
  `, [recurrenceId, nowStamp]);

  return { deleted: deleted.changes || 0, closed: closed.changes || 0 };
}

async function findSlotByPublicId(db, slotPublicId) {
  const row = await db.get(`
    SELECT s.id, s.public_id, s.listing_id, s.starts_at, s.ends_at, s.status, s.held_appointment_id,
           (SELECT COUNT(*) FROM showing_appointments sa WHERE sa.slot_id = s.id) used_count,
           (SELECT COUNT(*) FROM repair_slot_reservations rs WHERE rs.showing_slot_id = s.id) repair_held_count
    FROM showing_slots s
    WHERE s.public_id = ?
  `, [slotPublicId]);
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    listingId: row.listing_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    heldAppointmentId: row.held_appointment_id,
    usedCount: Number(row.used_count) || 0,
    repairHeldCount: Number(row.repair_held_count) || 0
  };
}

// 沒被任何預約用過的時段可以真的刪掉(房東按錯就是想讓它消失);用過的一律軟刪成
// closed,把 showing_appointments.slot_id 指向的那一列留著,稽核時追得回去。
// 假設自己已經在交易裡。
async function removeSlotCore(db, { slotId, used }) {
  if (used) {
    const result = await db.run(`
      UPDATE showing_slots SET status = 'closed', held_appointment_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [slotId]);
    return { deleted: false, closed: result.changes > 0 };
  }
  const result = await db.run('DELETE FROM showing_slots WHERE id = ?', [slotId]);
  return { deleted: result.changes > 0, closed: false };
}

// 房東停用一個時段。已經被預約占用的時段不能停用 —— 那會讓房客手上的預約指向
// 一個「不存在」的時間,而且房客不會收到任何訊息。要先讓預約結束(取消或拒絕)。
async function closeSlotCore(db, { slotId }) {
  const result = await db.run(`
    UPDATE showing_slots SET status = 'closed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open' AND held_appointment_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = showing_slots.id)
  `, [slotId]);
  return result.changes > 0;
}

// 條件式占用。呼叫端必須已經在交易裡,而且 appointmentId 是這個交易剛剛寫進去的
// 那一筆 —— 搶輸時丟 SlotConflictError,連同預約一起回捲。
async function claimSlotCore(db, { slotId, appointmentId }) {
  const result = await db.run(`
    UPDATE showing_slots
    SET status = 'booked', held_appointment_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open' AND held_appointment_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = showing_slots.id)
  `, [appointmentId, slotId]);
  if (result.changes !== 1) throw new SlotConflictError();
  return true;
}

// 房客取消 → 時段回到 open,其他房客可以再選。
async function releaseSlotForAppointmentCore(db, { appointmentId }) {
  const result = await db.run(`
    UPDATE showing_slots
    SET status = 'open', held_appointment_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE held_appointment_id = ?
  `, [appointmentId]);
  return result.changes > 0;
}

// 房東拒絕 → 時段收起來(closed),不回到 open。
// 拒絕的既有文案就是「房東無法在此時間看房請改時間」,把同一個時段再開放給下一位
// 房客只會讓他也被拒絕一次。房東想重新開放時再自己建一個。
async function closeSlotForAppointmentCore(db, { appointmentId }) {
  const result = await db.run(`
    UPDATE showing_slots
    SET status = 'closed', held_appointment_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE held_appointment_id = ?
  `, [appointmentId]);
  return result.changes > 0;
}

module.exports = {
  SlotConflictError,
  claimSlotCore,
  closeSlotCore,
  closeSlotForAppointmentCore,
  createSlot,
  createSlotsBulk,
  findOwnedListing,
  findOwnedListingById,
  findRecurrenceByKey,
  findRecurrenceByPublicId,
  findSlotByPublicId,
  listAvailableSlotsForInquiry,
  listOwnedListings,
  listRecurrencesForListing,
  listSlotsForListing,
  releaseSlotForAppointmentCore,
  removeSlotCore,
  retireRecurrenceSlotsCore,
  setRecurrenceStatusCore,
  upsertRecurrenceCore
};
