// better-sqlite3(同步)的完整性防線。規則本身定義在 integrityRules.js,
// mysql2 的非同步版本在 integrityGuardsAsync.js 共用同一份規則。
//
// 遷移期間兩條路徑並存,規則只寫一次才不會分岔。

const { RULES, decide } = require('./integrityRules');

const guards = {};

for (const [name, rule] of Object.entries(RULES)) {
  guards[name] = function guard(db, input) {
    if (rule.skip && rule.skip(input)) return;
    const row = db.prepare(rule.sql).get(...rule.params(input));
    decide(rule, Boolean(row));
  };
  Object.defineProperty(guards[name], 'name', { value: name });
}

module.exports = guards;
