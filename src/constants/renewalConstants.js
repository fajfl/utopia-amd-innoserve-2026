// 續約提醒與續約期的門檻。
//
// 2026-09-21:房東(產品負責人)與組員討論後,把原訂「到期前 30 天」改成
// 「到期前 2 個月」——tenantInquiryRoutes.js 的被動提醒 banner
// (renewalInfo.renewalStartDate)統一引用這個常數。之後續約模組增加獨立排程時，
// 也應引用同一設定，不要再寫死另一個天數。
const RENEWAL_WINDOW_MONTHS = 2;

module.exports = { RENEWAL_WINDOW_MONTHS };
