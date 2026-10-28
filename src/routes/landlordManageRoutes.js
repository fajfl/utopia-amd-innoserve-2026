// 房東管理台(LIFF):可看房時段 + 房源規則。
//
// 身分與房客端同一套(services/liffSessionService.js),差別只在每一條路由都要
// 先過 requireOwnedListing —— 登入不等於有權限,房東只能碰自己名下的房源。
// 所有權判斷集中在 v2ShowingSlotRepositoryAsync.findOwnedListing,不在這裡另寫
// 一份 SQL,否則兩份條件遲早會分岔。
//
// 全部查詢走 V2 driver,SQLite 與 TiDB 共用;這裡不開任何本機 SQLite 連線。

const express = require('express');

const { withInjectedSqlite, withV2Driver } = require('../database/v2Driver');
const { getValidLiffId, identityMiddleware, liffBootstrap } = require('../services/liffSessionService');
const {
  addDays,
  addMinutesToStamp,
  composeStamp,
  enumerateWeeklySlots,
  localDate,
  localStamp,
  minutesOfTime,
  normalizeDate,
  normalizeStamp,
  normalizeTime
} = require('../services/showingSlotTime');
const { notifyTenantsOfNewShowingSlot } = require('../services/tenantNotificationServiceAsync');
const slots = require('../repositories/v2ShowingSlotRepositoryAsync');
const rules = require('../repositories/v2LandlordRuleRepositoryAsync');

// 週期規則的硬邊界。房東可以選的「重複到」最遠就是今天 + 84 天。
// 有邊界才有可能「建立時一次展開完」,不必背景 job 也不必在房客查詢時補寫。
const RECURRENCE_HORIZON_DAYS = 84;
// 一條規則的產生上限。12 週 × 一天 24 場 = 288 列,對一個房源來說是雜訊不是資料。
const MAX_SLOTS_PER_RECURRENCE = 60;
// 單日一次可以開幾個時刻。時間格是 30 分鐘一格,24 格剛好蓋滿 08:00-20:00。
const MAX_BULK_TIMES = 24;
// 每場長度的白名單。開放任意分鐘數只會讓房東做出 07 分鐘的時段。
const SLOT_MINUTE_CHOICES = [30, 60, 90, 120];
const DEFAULT_SLOT_MINUTES = 60;

// 回傳 null 代表「沒填」,false 代表「填了但不在白名單」。兩者的回應不一樣:
// 沒填是合法的(單筆時段可以不設結束時間),填錯要讓房東知道。
function durationOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Number(value);
  return SLOT_MINUTE_CHOICES.includes(minutes) ? minutes : false;
}

function createLandlordManageRoutes({ getDb: customGetDb } = {}) {
  const router = express.Router();
  // 測試注入自己的 better-sqlite3 連線;包成 driver 之後路由的寫法完全一樣。
  const withDriver = customGetDb ? withInjectedSqlite(customGetDb) : withV2Driver;

  // 自己掛 JSON parser,不依賴掛載順序。body-parser 看到 req 已經被解析過會直接跳過,
  // 所以跟 v2ContractRoutes 那個 /v2/api parser 疊在一起也不會重複讀 stream。
  router.use('/v2/api', express.json({ limit: '1mb' }));
  router.use(identityMiddleware);


  // 找不到房源與沒有權限一律回同一個 404。分開回 403 會讓外人用回應差異問出
  // 某個 listing public_id 存不存在。
  async function requireOwnedListing(db, req) {
    return slots.findOwnedListing(db, {
      listingPublicId: req.params.listingPublicId,
      lineUserId: req.v2LineUserId,
      today: localDate()
    });
  }

  function notOwned(res) {
    return res.status(404).json({ ok: false, error: '找不到這個房源，或它不在你名下。' });
  }

  // 規則的所有權一律回頭問房源,不另外存一份 owner。跟時段的 close / delete 同一個模式:
  // 找不到與沒有權限回同一個 404,外人問不出某個 public_id 存不存在。
  async function requireOwnedRecurrence(db, req) {
    const rule = await slots.findRecurrenceByPublicId(db, req.params.recurrencePublicId);
    if (!rule) return null;
    const listing = await slots.findOwnedListingById(db, {
      listingId: rule.listingId,
      lineUserId: req.v2LineUserId,
      today: localDate()
    });
    if (!listing) return null;
    return { ...rule, ownerUserId: listing.ownerUserId };
  }

  function notOwnedRecurrence(res) {
    return res.status(404).json({ ok: false, error: '找不到這條週期規則，或它不在你名下的房源。' });
  }

  router.get('/landlordManage', (req, res) => {
    if (!req.v2LineUserId) {
      return res.send(liffBootstrap(req.originalUrl));
    }
    res.send(page());
  });

  router.get('/v2/api/landlord/listings', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const listings = await withDriver((db) => slots.listOwnedListings(db, {
        lineUserId: req.v2LineUserId,
        today: localDate()
      }));
      res.json({ ok: true, listings: listings.map((item) => ({
        publicId: item.publicId,
        title: item.title,
        unitLabel: item.unitLabel,
        rentAmount: item.rentAmount
      })) });
    } catch (error) {
      next(error);
    }
  });

  // ---- 看房時段 ----

  router.get('/v2/api/landlord/listings/:listingPublicId/slots', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const result = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return null;
        return slots.listSlotsForListing(db, { listingId: listing.id, nowStamp: localStamp() });
      });
      if (!result) return notOwned(res);
      res.json({ ok: true, slots: result });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v2/api/landlord/listings/:listingPublicId/slots', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const startsAt = normalizeStamp((req.body || {}).startsAt);
    const endsAtRaw = (req.body || {}).endsAt;
    const endsAt = endsAtRaw ? normalizeStamp(endsAtRaw) : null;
    if (!startsAt) return res.status(400).json({ ok: false, error: '時間格式不正確，請重新選擇。' });
    if (endsAtRaw && !endsAt) return res.status(400).json({ ok: false, error: '結束時間格式不正確。' });
    if (endsAt && endsAt < startsAt) {
      return res.status(400).json({ ok: false, error: '結束時間不能早於開始時間。' });
    }
    // 已經過去的時間開出來也沒有人選得到,直接擋在這裡,房東才知道自己按錯了。
    if (startsAt <= localStamp()) {
      return res.status(400).json({ ok: false, error: '不能建立已經過去的時段。' });
    }

    try {
      const outcome = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return { notOwned: true };
        try {
          const slot = await slots.createSlot(db, {
            listingId: listing.id,
            createdByUserId: listing.ownerUserId,
            startsAt,
            endsAt
          });
          
          return { slot, listingId: listing.id };
        } catch (error) {
          // uq_showing_slots_listing_starts。兩個 driver 的訊息不一樣,所以看關鍵字。
          if (/UNIQUE|Duplicate entry|ER_DUP_ENTRY/i.test(error.message)) {
            return { duplicate: true };
          }
          throw error;
        }
      });

      if (outcome.notOwned) return notOwned(res);
      if (outcome.duplicate) {
        return res.status(409).json({ ok: false, error: '這個房源已經有同一個開始時間的時段了。' });
      }
      
      // 非同步通知所有詢問中的房客，使用新的資料庫連線
      withDriver(async (notifyDb) => {
        await notifyTenantsOfNewShowingSlot(notifyDb, outcome.listingId);
      }).catch(err => {
        console.error('[landlordManageRoutes] background notification failed:', err);
      });

      res.json({ ok: true, slot: outcome.slot });
    } catch (error) {
      next(error);
    }
  });

  // 同一天一次開好幾個時刻。日曆挑日期、時間格多選時刻,一次送過來。
  //
  // 為什麼不叫房東按 N 次上面那支:datetime-local 逐格點到分鐘、送出、再點下一格,
  // 在 LINE 內建瀏覽器裡開一天三場就要三十幾下。這支把「一天要開哪些場」當成一次操作。
  //
  // 已經存在的時刻算 skipped 不算錯誤 —— 房東補開一天時不必記得自己上次開過哪幾格。
  router.post('/v2/api/landlord/listings/:listingPublicId/slots/bulk', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const body = req.body || {};
    const date = normalizeDate(body.date);
    if (!date) return res.status(400).json({ ok: false, error: '日期格式不正確，請重新選擇。' });

    const rawTimes = Array.isArray(body.times) ? body.times : [];
    if (!rawTimes.length) return res.status(400).json({ ok: false, error: '請至少選擇一個時間。' });
    if (rawTimes.length > MAX_BULK_TIMES) {
      return res.status(400).json({ ok: false, error: `一次最多開 ${MAX_BULK_TIMES} 個時段。` });
    }
    const times = rawTimes.map(normalizeTime);
    if (times.some((time) => !time)) {
      return res.status(400).json({ ok: false, error: '時間格式不正確，請重新選擇。' });
    }

    const duration = durationOrNull(body.durationMinutes);
    if (duration === false) {
      return res.status(400).json({ ok: false, error: '每場長度不正確。' });
    }

    // 過去的時刻開出來沒有人選得到。整批都在過去才報錯,只有幾格在過去就靜靜濾掉:
    // 房東選「今天」時本來就會看到已經過完的時間格。
    const nowStamp = localStamp();
    const entries = [];
    for (const time of times) {
      const startsAt = composeStamp(date, time);
      if (!startsAt || startsAt <= nowStamp) continue;
      entries.push({ startsAt, endsAt: duration ? addMinutesToStamp(startsAt, duration) : null });
    }
    if (!entries.length) {
      return res.status(400).json({ ok: false, error: '所選時間都已經過去了，請改選之後的時間。' });
    }

    try {
      const outcome = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return { notOwned: true };
        const result = await db.transaction((tx) => slots.createSlotsBulk(tx, {
          listingId: listing.id,
          createdByUserId: listing.ownerUserId,
          entries
        }));
        return { ...result, listingId: listing.id };
      });
      if (outcome.notOwned) return notOwned(res);
      
      if (outcome.created && outcome.created.length > 0) {
        withDriver(async (notifyDb) => {
          await notifyTenantsOfNewShowingSlot(notifyDb, outcome.listingId);
        }).catch(err => console.error('[landlordManageRoutes] bulk background notification failed:', err));
      }

      res.json({
        ok: true,
        created: outcome.created.length,
        skipped: outcome.skipped + (times.length - entries.length)
      });
    } catch (error) {
      next(error);
    }
  });

  // ---- 週期性時段 ----

  router.get('/v2/api/landlord/listings/:listingPublicId/slot-recurrences', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const result = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return null;
        return slots.listRecurrencesForListing(db, { listingId: listing.id, nowStamp: localStamp() });
      });
      if (!result) return notOwned(res);
      res.json({ ok: true, recurrences: result, horizonDays: RECURRENCE_HORIZON_DAYS });
    } catch (error) {
      next(error);
    }
  });

  /**
   * 「每週四 20:00-22:00 都可以」。一次送多個 weekday,每個 weekday 一條規則。
   *
   * 規則只是產生器:建立當下就把 until_date 之前的區間展開成一般的 showing_slots。
   * 房客端因此一列程式都不用改 —— listAvailableSlotsForInquiry 看到的還是實際列。
   *
   * until_date 一定會被夾在 RECURRENCE_HORIZON_DAYS 以內。「每週四」如果沒有邊界
   * 就不是資料而是無限序列;夾住之後展開一次做完,不需要背景 job 往前滾。
   */
  router.post('/v2/api/landlord/listings/:listingPublicId/slot-recurrences', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const body = req.body || {};
    const weekdays = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : []).map(Number))]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((left, right) => left - right);
    if (!weekdays.length) return res.status(400).json({ ok: false, error: '請至少選擇一個星期。' });

    const startTime = normalizeTime(body.startTime);
    const endTime = normalizeTime(body.endTime);
    if (!startTime || !endTime) {
      return res.status(400).json({ ok: false, error: '開始或結束時間格式不正確。' });
    }
    // durationOrNull 回 false 是「填了但不在白名單」。不能寫成 `|| DEFAULT` ——
    // false || 60 會把 slotMinutes:7 當成沒填,靜靜開出一堆 60 分鐘的場次。
    // 沒填(null)才套預設,錯誤訊息與 /slots/bulk 那條路徑保持同一句。
    const requestedSlotMinutes = durationOrNull(body.slotMinutes);
    if (requestedSlotMinutes === false) {
      return res.status(400).json({ ok: false, error: '每場長度不正確。' });
    }
    const slotMinutes = requestedSlotMinutes === null ? DEFAULT_SLOT_MINUTES : requestedSlotMinutes;
    if (minutesOfTime(endTime) - minutesOfTime(startTime) < slotMinutes) {
      return res.status(400).json({ ok: false, error: '結束時間至少要比開始時間晚一場的長度。' });
    }

    const today = localDate();
    const untilDate = normalizeDate(body.untilDate);
    if (!untilDate) return res.status(400).json({ ok: false, error: '請選擇這條規則重複到哪一天。' });
    if (untilDate < today) {
      return res.status(400).json({ ok: false, error: '結束日期不能是過去的日期。' });
    }
    const horizonDate = addDays(today, RECURRENCE_HORIZON_DAYS);
    if (untilDate > horizonDate) {
      return res.status(400).json({
        ok: false,
        error: `週期時段最多只能開到 ${horizonDate}（${RECURRENCE_HORIZON_DAYS / 7} 週）。`
      });
    }

    const nowStamp = localStamp();
    const plans = [];
    for (const weekday of weekdays) {
      const expansion = enumerateWeeklySlots({
        weekday,
        startTime,
        endTime,
        slotMinutes,
        fromDate: today,
        untilDate,
        maxSlots: MAX_SLOTS_PER_RECURRENCE,
        afterStamp: nowStamp
      });
      if (!expansion) return res.status(400).json({ ok: false, error: '這組週期設定算不出任何時段。' });
      if (expansion.truncated) {
        return res.status(400).json({
          ok: false,
          error: `一條規則最多產生 ${MAX_SLOTS_PER_RECURRENCE} 個時段，請縮短重複範圍或加長每場時間。`
        });
      }
      plans.push({ weekday, entries: expansion.slots });
    }
    if (plans.every((plan) => !plan.entries.length)) {
      return res.status(400).json({ ok: false, error: '這個範圍內沒有還沒過去的時段，請往後選。' });
    }

    try {
      const outcome = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return { notOwned: true };
        return db.transaction(async (tx) => {
          const summary = { created: 0, skipped: 0, rules: [] };
          for (const plan of plans) {
            const rule = await slots.upsertRecurrenceCore(tx, {
              listingId: listing.id,
              createdByUserId: listing.ownerUserId,
              weekday: plan.weekday,
              startTime,
              endTime,
              slotMinutes,
              untilDate
            });
            // 改過參數(或重新啟用)的規則先把自己未來、沒人用的時段收乾淨,
            // 再照新參數重新展開。否則縮短範圍或改長度會留下一批孤兒時段。
            if (rule.reused) {
              await slots.retireRecurrenceSlotsCore(tx, { recurrenceId: rule.id, nowStamp });
            }
            const written = await slots.createSlotsBulk(tx, {
              listingId: listing.id,
              createdByUserId: listing.ownerUserId,
              entries: plan.entries,
              recurrenceId: rule.id
            });
            summary.created += written.created.length;
            summary.skipped += written.skipped;
            summary.rules.push({ publicId: rule.publicId, weekday: plan.weekday, reused: rule.reused });
          }
          return { ...summary, listingId: listing.id };
        });
      });
      if (outcome.notOwned) return notOwned(res);

      if (outcome.created > 0) {
        withDriver(async (notifyDb) => {
          await notifyTenantsOfNewShowingSlot(notifyDb, outcome.listingId);
        }).catch(err => console.error('[landlordManageRoutes] recurrence background notification failed:', err));
      }

      res.json({
        ok: true,
        created: outcome.created, skipped: outcome.skipped, rules: outcome.rules });
    } catch (error) {
      next(error);
    }
  });

  // 停用整條規則:規則本身變 inactive,而且它產生的未來時段一起收掉。
  // 只改規則狀態是不夠的 —— 房客看到的是 showing_slots,那些列還會繼續開放預約。
  router.post('/v2/api/landlord/slot-recurrences/:recurrencePublicId/disable', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const outcome = await withDriver(async (db) => {
        const rule = await requireOwnedRecurrence(db, req);
        if (!rule) return { missing: true };
        return db.transaction(async (tx) => {
          await slots.setRecurrenceStatusCore(tx, { recurrenceId: rule.id, status: 'inactive' });
          return slots.retireRecurrenceSlotsCore(tx, { recurrenceId: rule.id, nowStamp: localStamp() });
        });
      });
      if (outcome.missing) return notOwnedRecurrence(res);
      res.json({ ok: true, status: 'inactive', removed: outcome.deleted, closed: outcome.closed });
    } catch (error) {
      next(error);
    }
  });

  // 重新啟用:規則變 active,並照現有參數重新展開。展開會跳過已存在的 starts_at,
  // 所以重複按不會產生重複列,已經被預約的那幾天也不受影響。
  router.post('/v2/api/landlord/slot-recurrences/:recurrencePublicId/enable', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const outcome = await withDriver(async (db) => {
        const rule = await requireOwnedRecurrence(db, req);
        if (!rule) return { missing: true };
        const today = localDate();
        const expansion = enumerateWeeklySlots({
          weekday: rule.weekday,
          startTime: rule.startTime,
          endTime: rule.endTime,
          slotMinutes: rule.slotMinutes,
          fromDate: today,
          untilDate: rule.untilDate,
          maxSlots: MAX_SLOTS_PER_RECURRENCE,
          afterStamp: localStamp()
        });
        const entries = expansion ? expansion.slots : [];
        return db.transaction(async (tx) => {
          await slots.setRecurrenceStatusCore(tx, { recurrenceId: rule.id, status: 'active' });
          const written = await slots.createSlotsBulk(tx, {
            listingId: rule.listingId,
            createdByUserId: rule.ownerUserId,
            entries,
            recurrenceId: rule.id
          });
          return { created: written.created.length, skipped: written.skipped };
        });
      });
      if (outcome.missing) return notOwnedRecurrence(res);
      res.json({ ok: true, status: 'active', created: outcome.created, skipped: outcome.skipped });
    } catch (error) {
      next(error);
    }
  });

  // 停用一個尚未被預約的時段。已被占用的要先讓那筆預約結束(房客取消或房東拒絕)。
  router.post('/v2/api/landlord/slots/:slotPublicId/close', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const outcome = await withDriver(async (db) => {
        const slot = await slots.findSlotByPublicId(db, req.params.slotPublicId);
        if (!slot) return { missing: true };
        const listing = await slots.findOwnedListingById(db, {
          listingId: slot.listingId,
          lineUserId: req.v2LineUserId,
          today: localDate()
        });
        if (!listing) return { missing: true };
        if (slot.status === 'booked' || slot.heldAppointmentId || slot.repairHeldCount) {
          return { booked: true };
        }
        return { closed: await slots.closeSlotCore(db, { slotId: slot.id }) || slot.status === 'closed' };
      });

      if (outcome.missing) {
        return res.status(404).json({ ok: false, error: '找不到這個時段，或它不在你名下的房源。' });
      }
      if (outcome.booked) {
        return res.status(409).json({ ok: false, error: '這個時段已經被房客預約，請先處理該筆預約再停用。' });
      }
      res.json({ ok: true, status: 'closed' });
    } catch (error) {
      next(error);
    }
  });

  // 刪除。沒有被任何預約用過的才會真的刪掉;用過的一律軟刪成 closed,
  // showing_appointments.slot_id 指向的那一列必須留著才追得回當初約的是哪個時段。
  router.delete('/v2/api/landlord/slots/:slotPublicId', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const outcome = await withDriver(async (db) => {
        const slot = await slots.findSlotByPublicId(db, req.params.slotPublicId);
        if (!slot) return { missing: true };
        const listing = await slots.findOwnedListingById(db, {
          listingId: slot.listingId,
          lineUserId: req.v2LineUserId,
          today: localDate()
        });
        if (!listing) return { missing: true };
        if (slot.status === 'booked' || slot.heldAppointmentId || slot.repairHeldCount) return { booked: true };
        return db.transaction((tx) => slots.removeSlotCore(tx, { slotId: slot.id, used: slot.usedCount > 0 }));
      });

      if (outcome.missing) {
        return res.status(404).json({ ok: false, error: '找不到這個時段，或它不在你名下的房源。' });
      }
      if (outcome.booked) {
        return res.status(409).json({ ok: false, error: '這個時段已經被房客預約，請先處理該筆預約再刪除。' });
      }
      res.json({ ok: true, deleted: Boolean(outcome.deleted), closed: Boolean(outcome.closed) });
    } catch (error) {
      next(error);
    }
  });

  // ---- 房源規則 ----

  router.get('/v2/api/landlord/listings/:listingPublicId/rules', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const result = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return null;
        return rules.listRules(db, { rentalUnitId: listing.rentalUnitId });
      });
      if (!result) return notOwned(res);
      res.json({ ok: true, rules: result });
    } catch (error) {
      next(error);
    }
  });

  router.post('/v2/api/landlord/listings/:listingPublicId/rules/reorder', async (req, res, next) => {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const order = (req.body || {}).order;
    if (!Array.isArray(order) || order.some((value) => typeof value !== 'string' || !value)) {
      return res.status(400).json({ ok: false, error: '排序清單格式不正確。' });
    }
    try {
      const outcome = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return { notOwned: true };
        try {
          return await rules.reorderRules(db, {
            rentalUnitId: listing.rentalUnitId,
            orderedPublicIds: order
          });
        } catch (error) {
          if (error instanceof rules.RuleOwnershipError) return { rejected: error.message };
          throw error;
        }
      });
      if (outcome.notOwned) return notOwned(res);
      if (outcome.rejected) return res.status(400).json({ ok: false, error: outcome.rejected });
      res.json({ ok: true, reordered: outcome.reordered });
    } catch (error) {
      next(error);
    }
  });

  async function changeRuleStatus(req, res, next, status) {
    if (!req.v2LineUserId) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const outcome = await withDriver(async (db) => {
        const listing = await requireOwnedListing(db, req);
        if (!listing) return { notOwned: true };
        try {
          return await rules.setRuleStatus(db, {
            rentalUnitId: listing.rentalUnitId,
            rulePublicId: req.params.rulePublicId,
            status,
            now: new Date().toISOString()
          });
        } catch (error) {
          if (error instanceof rules.RuleOwnershipError) return { rejected: error.message };
          throw error;
        }
      });
      if (outcome.notOwned) return notOwned(res);
      if (outcome.rejected) {
        return res.status(404).json({ ok: false, error: '找不到這條規則，或它不屬於這個房源。' });
      }
      res.json({ ok: true, rule: outcome });
    } catch (error) {
      next(error);
    }
  }

  // 刪除規則走軟刪除(status='inactive' + knowledge_items 'retired'),資料列全部留著。
  // 房東規則會被引用在知識庫來源與歷史問答上,硬刪會把稽核鏈一起帶走。
  router.delete('/v2/api/landlord/listings/:listingPublicId/rules/:rulePublicId',
    (req, res, next) => changeRuleStatus(req, res, next, 'inactive'));

  router.post('/v2/api/landlord/listings/:listingPublicId/rules/:rulePublicId/disable',
    (req, res, next) => changeRuleStatus(req, res, next, 'inactive'));

  router.post('/v2/api/landlord/listings/:listingPublicId/rules/:rulePublicId/enable',
    (req, res, next) => changeRuleStatus(req, res, next, 'active'));

  return router;
}

// 視覺與用語沿用 /findHouses:同一組漸層、卡片與按鈕樣式,不另做一套設計。
function page() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>房東管理台</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(135deg, #f0fdfa 0%, #e0f2fe 100%);
      color: #1f2937;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      padding: 16px 12px;
    }
    header { text-align: center; margin-bottom: 20px; }
    header h1 { margin: 0; font-size: 22px; font-weight: 700; color: #0f766e; }
    header p { margin: 4px 0 0; font-size: 13px; color: #6b7280; }
    .wrap { max-width: 600px; margin: 0 auto; display: grid; gap: 16px; }
    .card {
      background: rgba(255, 255, 255, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 4px 20px rgba(15, 118, 110, 0.05);
    }
    label { display: block; font-size: 12px; font-weight: 600; color: #4b5563; margin-bottom: 6px; }
    select, input {
      width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 8px;
      font-size: 13px; margin-bottom: 10px; background: #fff;
    }
    .tabs { display: flex; gap: 8px; margin-bottom: 4px; }
    .tab {
      flex: 1; border: 0; padding: 10px; border-radius: 12px; font-size: 13px;
      font-weight: 700; cursor: pointer; background: #e5e7eb; color: #4b5563;
    }
    .tab.active { background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); color: #fff; }
    .row {
      display: flex; align-items: center; gap: 10px; padding: 10px 0;
      border-bottom: 1px solid #f3f4f6; font-size: 13px;
    }
    .row:last-child { border-bottom: 0; }
    .row .grow { flex: 1; min-width: 0; }
    .row .grow b { display: block; font-size: 13px; color: #111827; }
    .row .grow small { color: #6b7280; }
    .pill {
      display: inline-block; padding: 2px 8px; border-radius: 9999px;
      font-size: 11px; font-weight: 600;
    }
    .pill-open { background: #ccfbf1; color: #0f766e; }
    .pill-booked { background: #fef3c7; color: #b45309; }
    .pill-closed { background: #f3f4f6; color: #6b7280; }
    .pill-expired { background: #f3f4f6; color: #9ca3af; }
    .pill-internal { background: #ede9fe; color: #6d28d9; }
    .mini {
      border: 1px solid #d1d5db; background: #fff; color: #4b5563;
      padding: 4px 8px; border-radius: 6px; font-size: 11px; cursor: pointer;
    }
    .mini.danger { border-color: #fca5a5; color: #dc2626; }
    .btn {
      width: 100%; border: 0; padding: 12px; border-radius: 12px; font-size: 14px;
      font-weight: 700; cursor: pointer;
      background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); color: #fff;
    }
    .hint { font-size: 12px; color: #6b7280; margin: 8px 0 0; line-height: 1.5; }
    .empty { text-align: center; color: #6b7280; font-size: 13px; padding: 16px 0; }
    .err { color: #dc2626; font-size: 12px; margin-top: 8px; min-height: 16px; }

    /* 以下都是「用手指點」的尺寸。LINE 內建瀏覽器沒有滑鼠,
       datetime-local 的分鐘欄位在手機上要捲很久才點得到,所以改成日曆 + 時間格。
       每一個可點元素的高度都 >= 40px,間距 >= 4px。 */
    .seg {
      display: flex; gap: 6px; background: #e5e7eb; padding: 4px;
      border-radius: 12px; margin-bottom: 14px;
    }
    .seg-btn {
      flex: 1; border: 0; background: transparent; padding: 11px; border-radius: 9px;
      font-size: 13px; font-weight: 700; color: #4b5563; cursor: pointer;
    }
    .seg-btn.active { background: #fff; color: #0f766e; box-shadow: 0 1px 4px rgba(15, 118, 110, 0.18); }
    .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .cal-head b { font-size: 15px; color: #0f766e; }
    .cal-nav {
      border: 1px solid #d1d5db; background: #fff; width: 40px; height: 40px;
      border-radius: 10px; font-size: 18px; color: #0f766e; cursor: pointer; padding: 0;
    }
    .cal-nav:disabled { color: #d1d5db; }
    .cal-dow, .cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
    .cal-dow span { text-align: center; font-size: 11px; color: #9ca3af; padding-bottom: 4px; }
    .day {
      height: 42px; border: 1px solid #e5e7eb; background: #fff; border-radius: 10px;
      font-size: 14px; color: #1f2937; cursor: pointer; padding: 0; position: relative;
    }
    .day.blank { border: 0; background: transparent; cursor: default; }
    .day:disabled { color: #d1d5db; background: #f9fafb; cursor: default; }
    /* 這一天已經有開好的時段:一個小點,房東不必往下捲就知道哪幾天開過了。 */
    .day.has::after {
      content: ''; position: absolute; left: 50%; bottom: 5px; transform: translateX(-50%);
      width: 5px; height: 5px; border-radius: 50%; background: #0d9488;
    }
    .day.on { background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); color: #fff; border-color: #0f766e; font-weight: 700; }
    .day.on.has::after { background: #fff; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .chip {
      border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 9999px;
      padding: 0 14px; height: 40px; min-width: 44px; font-size: 13px; cursor: pointer;
    }
    .chip.on { background: linear-gradient(135deg, #0d9488 0%, #0f766e 100%); color: #fff; border-color: #0f766e; font-weight: 700; }
    .chip:disabled { color: #d1d5db; background: #f9fafb; cursor: default; }
    .chip-label { width: 100%; font-size: 11px; color: #9ca3af; margin: 2px 0 -2px; }
    .preview {
      font-size: 12px; color: #0f766e; background: #f0fdfa; border-radius: 10px;
      padding: 9px 10px; margin: 0 0 10px; line-height: 1.5;
    }
    .card h2 { margin: 0 0 8px; font-size: 14px; color: #0f766e; }
  </style>
</head>
<body>
  <header>
    <h1>房東管理台</h1>
    <p>開放看房時段、整理房源規則</p>
  </header>
  <main class="wrap">
    <div class="card">
      <label for="listing">選擇房源</label>
      <select id="listing"></select>
    </div>
    <div class="tabs">
      <button class="tab active" id="tab-slots" onclick="switchTab('slots')">看房時段</button>
      <button class="tab" id="tab-rules" onclick="switchTab('rules')">房源規則</button>
    </div>
    <section id="panel-slots">
      <div class="card">
        <div class="seg">
          <button class="seg-btn active" id="mode-once" onclick="slotMode('once')">挑日期開放</button>
          <button class="seg-btn" id="mode-weekly" onclick="slotMode('weekly')">每週固定</button>
        </div>

        <div id="body-once">
          <div class="cal-head">
            <button class="cal-nav" id="cal-prev" onclick="calMove(-1)" aria-label="上一個月">‹</button>
            <b id="cal-title">—</b>
            <button class="cal-nav" onclick="calMove(1)" aria-label="下一個月">›</button>
          </div>
          <div class="cal-dow" aria-hidden="true">
            <span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span>
          </div>
          <div class="cal" id="cal-grid" role="grid" aria-label="選擇日期"></div>
          <label id="once-times-label">要開放哪些時間（可多選）</label>
          <div class="chips" id="once-times" role="group" aria-labelledby="once-times-label"></div>
          <label id="once-duration-label">每場多久</label>
          <div class="chips" id="once-duration" role="group" aria-labelledby="once-duration-label"></div>
          <p class="preview" id="once-preview">先點一個日期，再點想開放的時間。</p>
          <button class="btn" id="once-submit" onclick="submitOnce()">新增選好的時段</button>
        </div>

        <div id="body-weekly" style="display:none">
          <label id="wk-days-label">每週哪幾天（可多選）</label>
          <div class="chips" id="wk-days" role="group" aria-labelledby="wk-days-label"></div>
          <label id="wk-start-label">從幾點開始</label>
          <div class="chips" id="wk-start" role="group" aria-labelledby="wk-start-label"></div>
          <label id="wk-end-label">到幾點結束</label>
          <div class="chips" id="wk-end" role="group" aria-labelledby="wk-end-label"></div>
          <label id="wk-duration-label">每場多久</label>
          <div class="chips" id="wk-duration" role="group" aria-labelledby="wk-duration-label"></div>
          <label for="wk-until">這條規則重複到</label>
          <input type="date" id="wk-until" onchange="renderWeekly()">
          <p class="preview" id="wk-preview">例如「每週四 20:00 到 22:00」，一次就會把每個週四的時段都開好。</p>
          <button class="btn" id="weekly-submit" onclick="submitWeekly()">建立每週固定時段</button>
        </div>

        <p class="err" id="slot-error"></p>
        <p class="hint">房客只會看到「開放中」而且還沒過期的時段。房客取消後時段會自動回到開放中；你按拒絕的時段會被收起來，不會再給下一位房客。週期規則產生的每一天都是獨立時段，可以單獨停用或刪除。</p>
      </div>
      <div class="card" id="recurrence-list" style="display:none"></div>
      <div class="card" id="slot-list"><p class="empty">載入中…</p></div>
    </section>
    <section id="panel-rules" style="display:none">
      <div class="card" id="rule-list"><p class="empty">載入中…</p></div>
      <p class="hint">規則順序就是 AI 讀到的順序，排在前面的先看到。停用的規則會從 AI 參考資料裡移除，但紀錄會留著。內部規則不會提供給回答房客的 AI。</p>
    </section>
  </main>
  <script>
    window.APP_CONFIG = {
      liffId: ${JSON.stringify(getValidLiffId())}
    };
  </script>
  <script>${slotComposerScript()}</script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script src="/assets/landlordManage.js?t=${Date.now()}"></script>
</body>
</html>`;
}

/**
 * 新增時段的互動:日曆 + 時間格 + 每週固定規則。
 *
 * 為什麼寫在這裡而不是 public/assets/landlordManage.js:這一輪的可動檔案不含那支
 * 靜態資源。所以分工是 —— 房源下拉、時段清單、房源規則仍然由 landlordManage.js
 * 負責,這支只管「新增時段」那張卡片與週期規則卡片。兩邊的接點只有兩個:
 *   讀 #listing 的 value 拿目前房源(下拉是 landlordManage.js 建的)
 *   建立成功後呼叫 window.switchTab('slots') 讓它重畫時段清單
 * 如果之後允許改那支檔案,這段應該搬過去,兩邊就不必再靠這兩個接點對接。
 */
function slotComposerScript() {
  return `(function () {
  // 時間格的範圍與粒度。08:00 起、30 分鐘一格、最後一格 21:30。
  var DAY_START = 8 * 60, DAY_END = 22 * 60, STEP = 30;
  var DURATIONS = [30, 60, 90, 120];
  var DOW = ['日', '一', '二', '三', '四', '五', '六'];
  var HORIZON_DAYS = ${RECURRENCE_HORIZON_DAYS};
  var MAX_TIMES = ${MAX_BULK_TIMES};
  var MAX_PER_RULE = ${MAX_SLOTS_PER_RECURRENCE};
  // 時間格分段標題。房東找「晚上八點」時不必從 08:00 一路數過去。
  var BANDS = [[DAY_START, 12 * 60, '上午'], [12 * 60, 18 * 60, '下午'], [18 * 60, DAY_END, '晚上']];

  var ui = {
    mode: 'once',
    cursor: null,        // 日曆目前顯示的月份,{ year, month }(month 為 0 起算)
    date: '',            // 選到的日期 YYYY-MM-DD
    times: {},           // 選到的時刻,'HH:MM' -> true
    duration: 60,
    weekdays: {},        // 選到的星期,0..6 -> true
    wkStart: '19:00',
    wkEnd: '22:00',
    wkDuration: 60,
    openDates: {},       // 已經有時段的日期,用來在日曆上點一個點
    recurrences: []
  };

  function pad(value) { return value < 10 ? '0' + value : String(value); }
  function fmt(year, month, day) { return year + '-' + pad(month + 1) + '-' + pad(day); }
  function today() { var now = new Date(); return fmt(now.getFullYear(), now.getMonth(), now.getDate()); }
  function nowClock() { var now = new Date(); return pad(now.getHours()) + ':' + pad(now.getMinutes()); }
  function shift(date, days) {
    var base = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
    base.setDate(base.getDate() + days);
    return fmt(base.getFullYear(), base.getMonth(), base.getDate());
  }
  function weekdayOf(date) {
    return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();
  }
  function mins(clock) { return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)); }
  function clockOf(total) { return pad(Math.floor(total / 60)) + ':' + pad(total % 60); }
  function el(id) { return document.getElementById(id); }
  function listingId() { var node = el('listing'); return node ? node.value : ''; }
  function setError(text) { var node = el('slot-error'); if (node) node.textContent = text || ''; }

  // 送出中就把按鈕停掉。這只是體驗:重複送出的正確性由資料庫的唯一索引保證
  // (repositories/v2ShowingSlotRepositoryAsync.js 的 insert-ignore / upsert),
  // 不是靠這個旗標 —— 使用者開兩個分頁、或按鈕還沒 disable 就連點兩下都繞得過它。
  var busy = false;
  async function guard(buttonId, label, run) {
    if (busy) return;
    busy = true;
    var button = el(buttonId);
    var original = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = label; }
    try {
      await run();
    } finally {
      busy = false;
      if (button) { button.disabled = false; button.textContent = original; }
    }
  }
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function api(url, options) {
    var response = await fetch(url, options);
    var data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    if (!response.ok || !data.ok) throw new Error(data.error || ('請求失敗(' + response.status + ')'));
    return data;
  }

  // ---- 單次:日曆 ----

  function calMove(delta) {
    var month = ui.cursor.month + delta;
    var year = ui.cursor.year + Math.floor(month / 12);
    ui.cursor = { year: year, month: ((month % 12) + 12) % 12 };
    renderCalendar();
  }

  function pickDate(date) {
    ui.date = date;
    // 換日期時清掉已選時刻:上一個日期選的「已過去」判斷對新日期不成立。
    ui.times = {};
    renderCalendar();
    renderOnceTimes();
  }

  function renderCalendar() {
    var first = new Date(ui.cursor.year, ui.cursor.month, 1);
    var days = new Date(ui.cursor.year, ui.cursor.month + 1, 0).getDate();
    var min = today();
    var max = shift(min, HORIZON_DAYS);
    el('cal-title').textContent = ui.cursor.year + ' 年 ' + (ui.cursor.month + 1) + ' 月';
    el('cal-prev').disabled = fmt(ui.cursor.year, ui.cursor.month, days) < min;

    var cells = [];
    for (var blank = 0; blank < first.getDay(); blank += 1) {
      cells.push('<button class="day blank" disabled aria-hidden="true"></button>');
    }
    for (var day = 1; day <= days; day += 1) {
      var date = fmt(ui.cursor.year, ui.cursor.month, day);
      var classes = ['day'];
      if (ui.openDates[date]) classes.push('has');
      if (date === ui.date) classes.push('on');
      var blocked = date < min || date > max;
      cells.push('<button class="' + classes.join(' ') + '"' + (blocked ? ' disabled' : '')
        + ' aria-pressed="' + (date === ui.date) + '"'
        + ' onclick="pickDate(\\'' + date + '\\')">' + day + '</button>');
    }
    el('cal-grid').innerHTML = cells.join('');
  }

  // ---- 單次:時間格 ----

  function toggleTime(clock) {
    if (ui.times[clock]) delete ui.times[clock];
    else ui.times[clock] = true;
    renderOnceTimes();
  }

  function pickDuration(minutes) {
    ui.duration = minutes;
    renderOnceTimes();
  }

  function renderOnceTimes() {
    var isToday = ui.date === today();
    var floor = isToday ? nowClock() : '';
    var html = [];
    for (var band = 0; band < BANDS.length; band += 1) {
      html.push('<span class="chip-label">' + BANDS[band][2] + '</span>');
      for (var at = BANDS[band][0]; at < BANDS[band][1]; at += STEP) {
        var clock = clockOf(at);
        var past = !ui.date || (isToday && clock <= floor);
        html.push('<button class="chip' + (ui.times[clock] ? ' on' : '') + '"'
          + (past ? ' disabled' : '') + ' aria-pressed="' + Boolean(ui.times[clock]) + '"'
          + ' onclick="toggleTime(\\'' + clock + '\\')">' + clock + '</button>');
      }
    }
    el('once-times').innerHTML = html.join('');
    el('once-duration').innerHTML = DURATIONS.map(function (minutes) {
      return '<button class="chip' + (ui.duration === minutes ? ' on' : '') + '"'
        + ' aria-pressed="' + (ui.duration === minutes) + '"'
        + ' onclick="pickDuration(' + minutes + ')">' + minutes + ' 分鐘</button>';
    }).join('');

    var picked = Object.keys(ui.times).sort();
    el('once-preview').textContent = !ui.date
      ? '先點一個日期，再點想開放的時間。'
      : !picked.length
        ? ui.date + '：還沒選時間。'
        : ui.date + ' 會開 ' + picked.length + ' 個時段（每場 ' + ui.duration + ' 分鐘）：' + picked.join('、');
  }

  async function submitOnce() {
    setError('');
    if (!listingId()) return setError('請先選擇房源。');
    if (!ui.date) return setError('請先點一個日期。');
    var picked = Object.keys(ui.times).sort();
    if (!picked.length) return setError('請至少選一個時間。');
    if (picked.length > MAX_TIMES) return setError('一次最多開 ' + MAX_TIMES + ' 個時段。');
    await guard('once-submit', '新增中…', async function () {
      try {
        var result = await api('/v2/api/landlord/listings/' + encodeURIComponent(listingId()) + '/slots/bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ date: ui.date, times: picked, durationMinutes: ui.duration })
        });
        ui.times = {};
        renderOnceTimes();
        setError('');
        el('once-preview').textContent = '已新增 ' + result.created + ' 個時段'
          + (result.skipped ? '，' + result.skipped + ' 個先前已經開過。' : '。');
        await refreshAll(true);
      } catch (error) {
        setError(error.message);
      }
    });
  }

  // ---- 每週固定 ----

  function toggleWeekday(day) {
    if (ui.weekdays[day]) delete ui.weekdays[day];
    else ui.weekdays[day] = true;
    renderWeekly();
  }
  function pickWkStart(clock) { ui.wkStart = clock; renderWeekly(); }
  function pickWkEnd(clock) { ui.wkEnd = clock; renderWeekly(); }
  function pickWkDuration(minutes) { ui.wkDuration = minutes; renderWeekly(); }

  function timeChips(containerId, selected, handler, from, to) {
    var html = [];
    for (var at = from; at <= to; at += 60) {
      var clock = clockOf(at);
      html.push('<button class="chip' + (selected === clock ? ' on' : '') + '"'
        + ' aria-pressed="' + (selected === clock) + '"'
        + ' onclick="' + handler + '(\\'' + clock + '\\')">' + clock + '</button>');
    }
    el(containerId).innerHTML = html.join('');
  }

  // 一條規則會產生幾個時段,在按下去之前就算給房東看。伺服器有同一套上限,
  // 這裡只是不要讓他填完才被退回。
  function countWeekly(untilDate) {
    var perDay = Math.floor((mins(ui.wkEnd) - mins(ui.wkStart)) / ui.wkDuration);
    if (perDay <= 0) return { perDay: 0, total: 0, worst: 0 };
    var start = today();
    var total = 0, worst = 0;
    var picked = Object.keys(ui.weekdays).map(Number);
    for (var index = 0; index < picked.length; index += 1) {
      var offset = (picked[index] - weekdayOf(start) + 7) % 7;
      var count = 0;
      for (var date = shift(start, offset); date <= untilDate; date = shift(date, 7)) count += 1;
      total += count * perDay;
      worst = Math.max(worst, count * perDay);
    }
    return { perDay: perDay, total: total, worst: worst };
  }

  function renderWeekly() {
    el('wk-days').innerHTML = DOW.map(function (label, day) {
      return '<button class="chip' + (ui.weekdays[day] ? ' on' : '') + '"'
        + ' aria-pressed="' + Boolean(ui.weekdays[day]) + '"'
        + ' onclick="toggleWeekday(' + day + ')">' + label + '</button>';
    }).join('');
    timeChips('wk-start', ui.wkStart, 'pickWkStart', DAY_START, DAY_END - 60);
    timeChips('wk-end', ui.wkEnd, 'pickWkEnd', DAY_START + 60, DAY_END);
    el('wk-duration').innerHTML = DURATIONS.map(function (minutes) {
      return '<button class="chip' + (ui.wkDuration === minutes ? ' on' : '') + '"'
        + ' aria-pressed="' + (ui.wkDuration === minutes) + '"'
        + ' onclick="pickWkDuration(' + minutes + ')">' + minutes + ' 分鐘</button>';
    }).join('');

    var until = el('wk-until');
    until.min = today();
    until.max = shift(today(), HORIZON_DAYS);
    if (!until.value) until.value = shift(today(), 28);
    if (until.value > until.max) until.value = until.max;

    var picked = Object.keys(ui.weekdays).map(Number).sort();
    var node = el('wk-preview');
    if (!picked.length) {
      node.textContent = '例如「每週四 20:00 到 22:00」，一次就會把每個週四的時段都開好。';
      return;
    }
    var counted = countWeekly(until.value);
    if (counted.perDay <= 0) {
      node.textContent = '結束時間至少要比開始時間晚一場的長度。';
      return;
    }
    node.textContent = '每週 ' + picked.map(function (day) { return DOW[day]; }).join('、')
      + ' 的 ' + ui.wkStart + '–' + ui.wkEnd + '，每場 ' + ui.wkDuration + ' 分鐘（一天 '
      + counted.perDay + ' 場）。到 ' + until.value + ' 為止大約會開 ' + counted.total + ' 個時段。'
      + (counted.worst > MAX_PER_RULE ? '（單一星期超過 ' + MAX_PER_RULE + ' 個上限，請縮短範圍或加長每場時間）' : '');
  }

  async function submitWeekly() {
    setError('');
    if (!listingId()) return setError('請先選擇房源。');
    var picked = Object.keys(ui.weekdays).map(Number).sort();
    if (!picked.length) return setError('請至少選一個星期。');
    await guard('weekly-submit', '建立中…', async function () {
      try {
        var result = await api('/v2/api/landlord/listings/' + encodeURIComponent(listingId()) + '/slot-recurrences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            weekdays: picked,
            startTime: ui.wkStart,
            endTime: ui.wkEnd,
            slotMinutes: ui.wkDuration,
            untilDate: el('wk-until').value
          })
        });
        el('wk-preview').textContent = '已建立 ' + result.rules.length + ' 條規則，開出 '
          + result.created + ' 個時段'
          + (result.skipped ? '，' + result.skipped + ' 個先前已經開過。' : '。');
        await refreshAll(true);
      } catch (error) {
        setError(error.message);
      }
    });
  }

  // ---- 週期規則清單 ----

  function renderRecurrences() {
    var box = el('recurrence-list');
    if (!ui.recurrences.length) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = '';
    box.innerHTML = '<h2>每週固定規則</h2>' + ui.recurrences.map(function (rule) {
      var active = rule.status === 'active';
      var pill = active
        ? '<span class="pill pill-open">進行中</span>'
        : '<span class="pill pill-closed">已停用</span>';
      var action = active
        ? '<button class="mini danger" onclick="disableRecurrence(\\'' + escapeHtml(rule.publicId) + '\\')">停用</button>'
        : '<button class="mini" onclick="enableRecurrence(\\'' + escapeHtml(rule.publicId) + '\\')">重新啟用</button>';
      return '<div class="row"><div class="grow">'
        + '<b>每週' + DOW[rule.weekday] + ' ' + escapeHtml(rule.startTime) + '–' + escapeHtml(rule.endTime) + '</b>'
        + '<small>每場 ' + rule.slotMinutes + ' 分鐘・到 ' + escapeHtml(rule.untilDate) + '・開放中 '
        + rule.openCount + ' 個'
        + (rule.bookedCount ? '・已被預約 ' + rule.bookedCount + ' 個' : '') + '</small>'
        + '</div>' + pill + action + '</div>';
    }).join('');
  }

  async function disableRecurrence(publicId) {
    if (!confirm('停用這條規則會把它之後還沒有人預約的時段一起收掉。已經被預約的那幾天不會動，要先在下面的清單處理那筆預約。要繼續嗎？')) return;
    setError('');
    try {
      await api('/v2/api/landlord/slot-recurrences/' + encodeURIComponent(publicId) + '/disable', { method: 'POST' });
      await refreshAll(true);
    } catch (error) {
      setError(error.message);
    }
  }

  async function enableRecurrence(publicId) {
    setError('');
    try {
      await api('/v2/api/landlord/slot-recurrences/' + encodeURIComponent(publicId) + '/enable', { method: 'POST' });
      await refreshAll(true);
    } catch (error) {
      setError(error.message);
    }
  }

  // ---- 載入與模式切換 ----

  function slotMode(mode) {
    ui.mode = mode;
    el('mode-once').classList.toggle('active', mode === 'once');
    el('mode-weekly').classList.toggle('active', mode === 'weekly');
    el('body-once').style.display = mode === 'once' ? '' : 'none';
    el('body-weekly').style.display = mode === 'weekly' ? '' : 'none';
    if (mode === 'weekly') renderWeekly();
  }

  // 規則清單與日曆上的小圓點都要重畫。時段清單本身由 landlordManage.js 的
  // switchTab('slots') → loadSlots() 負責,這裡不自己畫,免得兩邊搶同一個容器。
  // reloadList 只有在自己剛寫入資料時才給 true;開頁時它已經載過一次了。
  async function refreshAll(reloadList) {
    var listing = listingId();
    if (!listing) return;
    try {
      var rules = await api('/v2/api/landlord/listings/' + encodeURIComponent(listing) + '/slot-recurrences');
      ui.recurrences = rules.recurrences;
    } catch (error) {
      ui.recurrences = [];
    }
    try {
      var listed = await api('/v2/api/landlord/listings/' + encodeURIComponent(listing) + '/slots');
      ui.openDates = {};
      for (var index = 0; index < listed.slots.length; index += 1) {
        var slot = listed.slots[index];
        if (slot.status !== 'closed') ui.openDates[String(slot.startsAt).slice(0, 10)] = true;
      }
    } catch (error) {
      ui.openDates = {};
    }
    renderRecurrences();
    renderCalendar();
    if (reloadList && typeof window.switchTab === 'function') window.switchTab('slots');
  }

  // #listing 是 landlordManage.js 非同步填的,它填完不會發事件(直接設 value 再自己
  // refresh)。所以這裡短輪詢等它出現,之後改由 change 事件驅動。
  function waitForListing(tries) {
    if (listingId()) return refreshAll(false);
    if (tries <= 0) return;
    setTimeout(function () { waitForListing(tries - 1); }, 150);
  }

  function boot() {
    var now = new Date();
    ui.cursor = { year: now.getFullYear(), month: now.getMonth() };
    renderCalendar();
    renderOnceTimes();
    renderWeekly();
    var select = el('listing');
    // addEventListener 不會蓋掉 landlordManage.js 設的 select.onchange,兩邊都會收到。
    if (select) select.addEventListener('change', function () { refreshAll(false); });
    waitForListing(40);
  }

  window.slotMode = slotMode;
  window.calMove = calMove;
  window.pickDate = pickDate;
  window.toggleTime = toggleTime;
  window.pickDuration = pickDuration;
  window.submitOnce = submitOnce;
  window.toggleWeekday = toggleWeekday;
  window.pickWkStart = pickWkStart;
  window.pickWkEnd = pickWkEnd;
  window.pickWkDuration = pickWkDuration;
  window.renderWeekly = renderWeekly;
  window.submitWeekly = submitWeekly;
  window.disableRecurrence = disableRecurrence;
  window.enableRecurrence = enableRecurrence;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();`;
}

module.exports = { createLandlordManageRoutes };
