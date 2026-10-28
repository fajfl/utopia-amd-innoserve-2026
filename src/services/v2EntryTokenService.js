const { sqliteDriver } = require('../database/sqlDriver');
const { withV2Driver } = require('../database/v2Driver');
const { findListingByEntryToken } = require('../repositories/v2ListingEntryTokenRepositoryAsync');
const { activateInquiryForListing, findOrCreateLineUser } = require('../repositories/v2InquiryRepositoryAsync');
const { freezeListingImages } = require('./v2ListingImageFreezeService');

async function listingReply(db, listing) {
  const snapshot = await db.get(`SELECT ls.normalized_address address_text, ls.raw_payload_json
    FROM listing_snapshots ls WHERE ls.listing_id=?
    ORDER BY ls.is_latest_valid DESC, ls.captured_at DESC, ls.id DESC LIMIT 1`, [listing.id]) || {};
  const property = await db.get(`SELECT p.address_text, p.normalized_address FROM properties p
    JOIN rental_units ru ON ru.property_id = p.id WHERE ru.id=?`, [listing.rental_unit_id]) || {};

  const rawAddr = snapshot.address_text || property.address_text || property.normalized_address;
  const addressText = (!rawAddr || String(rawAddr).startsWith('未擷取完整地址')) ? '待確認' : rawAddr;

  let payload = {};
  try { payload = JSON.parse(snapshot.raw_payload_json || '{}'); } catch {}
  return ['我已帶入這筆 591 房源：','',listing.title || '591 房源',
    `月租：${listing.current_rent_amount ? `${Number(listing.current_rent_amount).toLocaleString('zh-TW')} 元/月` : '待確認'}`,
    `地址：${addressText}`,
    payload.rooms ? `格局：${payload.rooms}` : null,
    payload.floor ? `樓層：${payload.floor}` : null,'',
    '你可以繼續詢問這間房源；房客 AI Agent 尚未完成，目前只建立找房紀錄與房源脈絡。']
    .filter((line) => line !== null).join('\n');
}

// 八碼數字是**有歧義**的輸入。591 的官方入口送出的是「591租屋詢問 12345678」,
// 光是八碼數字則是人手動打的 —— 而房客手打八碼數字最常見的情況是日期
// (20260920)、電話尾碼或門牌。所以這裡要回報是哪一種意圖,不能只回代碼:
// 兩者查不到房源時的處理方式必須不一樣。
//
// @returns {{code: string, explicit: boolean}|null}
function parseEntryCodeText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const explicit = text.match(/^(?:591租屋詢問|案件碼)\s*[:：]?\s*(\d{8})$/);
  if (explicit) return { code: explicit[1], explicit: true };
  const bare = text.match(/^\d{8}$/);
  if (bare) return { code: bare[0], explicit: false };
  return null;
}

/**
 * 這則訊息該不該就此結束在「591 案件碼」這條路上?
 *
 * 明確指名案件碼卻查不到,是使用者該知道的事,要回話並停在這裡。
 * 但只打了八碼數字又查不到房源,代表它**根本不是案件碼** —— 這時候回一句
 * 「找不到這組 591 案件碼」並 return,等於把訊息吃掉。實測就是這樣讓房客打的
 * 日期永遠到不了 Agent:模型從來沒收到那句話,看起來卻像模型看不懂日期。
 */
function shouldConsumeEntryCode(parsed, result) {
  if (!parsed) return false;
  if (parsed.explicit) return true;
  return (result || {}).ok !== false;
}

function injectedDriver(db) {
  return typeof db.get === 'function' ? db : sqliteDriver(db);
}

async function bindV2EntryToken(input, options = {}) {
  const injected = input.db || options.db;
  const withDriver = injected
    ? (fn) => fn(injectedDriver(injected))
    : (options.withDriver || withV2Driver);
  const binding = await withDriver(async (db) => {
    const listing = await findListingByEntryToken(db, String(input.entryCode || '').trim());
    if (!listing) {
      if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
        console.log(`[LINE bind] driver=${db.dialect.name} tokenFound=false inquiryStatus=none`);
      }
      return { ok:false, replyText:'找不到這組 591 案件碼，請重新從 591 房源頁點擊 ECS NEO 入口。' };
    }
    const identity = await findOrCreateLineUser(db, { lineUserId:input.lineUserId, displayName:input.displayName });
    const result = await activateInquiryForListing(db, { lineIdentityId:identity.lineIdentityId,
      listingId:listing.id, providerEventId:input.providerEventId,
      occurredAt:input.occurredAt || new Date().toISOString() });
    
    if (result.created) {
      // 異步推播給房東, 不阻擋回覆房客
      const { notifyLandlordOfNewInquiry } = require('./tenantNotificationServiceAsync');
      notifyLandlordOfNewInquiry(db, result.inquiryId).catch(err => {
        console.error('Failed to notify landlord of new inquiry:', err.message);
      });
    }

    if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
      console.log(`[LINE bind runtime] serverStartTime=${global.SERVER_START_TIME} requestHost=${input.requestHost || null} driver=${db.dialect.name} listingId=${listing.source_listing_id || listing.id}`);
      console.log(`[LINE bind db] driver=${db.dialect.name} readCurrentRent=${listing.current_rent_amount}`);
    }
    return { ok:true, entryCode:listing.token, listingId:listing.id, listingPublicId:listing.public_id,
      userId:identity.userId, inquiryId:result.inquiryId, created:result.created, replyText:await listingReply(db, listing) };
  });
  if (!binding.ok) return binding;

  const { listingId, userId, ...result } = binding;

  // 凍結刻意**不 await**。這條路徑的呼叫端是 cleanMessageHandler,拿到回傳值才
  // 送 client.replyMessage;await 下去等於讓使用者等 591 把圖吐完。實測 12 張圖
  // 遇上 591 沒回應是 20 秒(併發 3 × 5 秒 timeout × 4 批),那期間 webhook 的
  // HTTP response 也還沒回。
  //
  // 失敗完全隔離:整個 promise 已經 catch 過,沒有人 await 也不會變成
  // unhandledRejection。漏掉的圖留在 listing_media.file_id IS NULL,
  // 由 scripts/freeze-listing-images.js 重掃。
  if (binding.created) {
    const freeze = options.freezeListingImages || freezeListingImages;
    const task = Promise.resolve()
      .then(() => freeze(
        { listingId: binding.listingId, createdByUserId: binding.userId },
        { withDriver, ...(options.imageFreezeOptions || {}) }
      ))
      .then((freezeResult) => {
        const frozen = Array.isArray(freezeResult) ? freezeResult : [];
        for (const failed of frozen.filter((item) => !item.ok)) {
          console.warn('Failed to freeze a 591 listing image:', failed.error);
        }
        return frozen;
      })
      .catch((error) => {
        console.warn('Failed to freeze 591 listing images:', error.message);
        return [{ ok: false, error: error.message }];
      });
    // 不可列舉:這個值只給測試與腳本等背景工作,不該混進 JSON 回應。
    Object.defineProperty(result, 'freezeCompleted', { value: task, enumerable: false });
  }
  return result;
}

module.exports = { bindV2EntryToken, parseEntryCodeText, shouldConsumeEntryCode };
