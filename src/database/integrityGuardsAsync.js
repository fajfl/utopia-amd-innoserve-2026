// 非同步的完整性防線,與 integrityGuards.js 共用 integrityRules.js 的同一份規則。
//
// 收的是 sqlDriver 的 driver,不是原始連線 —— 所以同一份實作同時服務
// better-sqlite3 與 mysql2,不需要為每個 driver 再寫一份。
//
// 在交易中呼叫時,傳進來的必須是 transaction 回呼給的那個 tx。若改用交易外的
// driver 查詢,guard 會讀到交易外的狀態,防線就形同虛設。

const { RULES, decide } = require('./integrityRules');

const guards = {};

for (const [name, rule] of Object.entries(RULES)) {
  guards[name] = async function guard(driver, input) {
    if (rule.skip && rule.skip(input)) return;
    const row = await driver.get(rule.sql, rule.params(input));
    decide(rule, Boolean(row));
  };
  Object.defineProperty(guards[name], 'name', { value: name });
}

module.exports = guards;
