// LINE 多步流程 session repository 的 driver 版本:同一份實作,底下可掛
// better-sqlite3 或 mysql2。參數 `db` 收的是 sqlDriver 的 driver,不是原始連線;
// 傳錯的話第一次 await db.get(...) 就會炸,不會靜默出錯。
//
// 同步版 (v2LineFlowRepository.js) 的 startFlow 用 db.transaction(...).immediate()
// 自己開交易。driver 介面**沒有** inTransaction 屬性,所以照 v2InquiryRepositoryAsync
// 的做法拆成 *Core(假設自己已經在交易裡)加一個負責開交易的 wrapper;
// 要跟其他寫入組成同一個交易時呼叫 Core,把外層的 tx 傳進來。
//
// 交易中一律使用 transaction 回呼給的 tx。用交易外的 driver 查詢,在 mysql2 會落到
// 另一條連線,讀到交易外的狀態。

const crypto = require('node:crypto');

function iso(value) { return new Date(value || Date.now()).toISOString(); }
function plusMinutes(value, minutes) { return new Date(new Date(value).getTime() + minutes * 60000).toISOString(); }

// context_json 在 SQLite 是 TEXT。若 TiDB 那側把它建成 JSON 型別,mysql2 會直接
// 回傳已解析的物件,對物件呼叫 JSON.parse 會拋 SyntaxError,所以先讓物件原樣通過。
function parseContext(value) {
  if (value && typeof value === 'object') return value;
  return JSON.parse(value || '{}');
}

function rowValue(row) {
  if (!row) return null;
  return {
    publicId: row.public_id,
    lineIdentityId: row.line_identity_id,
    listingId: row.listing_id,
    flowType: row.flow_type,
    stepCode: row.step_code,
    context: parseContext(row.context_json),
    expiresAt: row.expires_at
  };
}

// 同一個 line_identity 同時只允許一個未結束的 session
// (uq_line_flow_sessions_active_identity)。先把舊的標成 replaced 再插新的,
// 兩件事必須在同一個交易裡,否則中途失敗會把使用者卡在「舊的已結束、新的沒建立」。
async function startFlowCore(db, input) {
  const now = iso(input.now);
  await db.run(`UPDATE line_flow_sessions SET finished_at=?, finish_reason='replaced', updated_at=?
    WHERE line_identity_id=? AND finished_at IS NULL`, [now, now, input.lineIdentityId]);
  const publicId = `line-flow-${crypto.randomUUID()}`;
  await db.run(`INSERT INTO line_flow_sessions
    (public_id,line_identity_id,flow_type,listing_id,step_code,context_json,started_at,updated_at,expires_at)
    VALUES (?,?,'landlord_knowledge',?,?,?,?,?,?)`,
  [publicId, input.lineIdentityId, input.listingId || null, input.stepCode,
    JSON.stringify(input.context || {}), now, now, plusMinutes(now, 10)]);
  // 刻意用 public_id 回查而不是拿 insertId:TiDB 的 AUTO_INCREMENT 是分段配發的,
  // public_id 才是兩個 driver 都指向同一列的鍵。
  return rowValue(await db.get('SELECT * FROM line_flow_sessions WHERE public_id=?', [publicId]));
}

function startFlow(db, input) {
  return db.transaction((tx) => startFlowCore(tx, input));
}

async function getActiveFlow(db, lineIdentityId, at = new Date()) {
  const now = iso(at);
  const row = await db.get(`SELECT * FROM line_flow_sessions
    WHERE line_identity_id=? AND finished_at IS NULL`, [lineIdentityId]);
  if (!row) return null;
  // expires_at 只有本檔案寫入,永遠是 toISOString() 的結果;ISO-8601 的字典序就是
  // 時間序,所以這裡用字串比較,兩個 driver 都正確,也不需要 SQLite 專有的 datetime()。
  if (row.expires_at <= now) {
    // finished_at IS NULL 是護欄:併發時另一個呼叫可能已經把它收掉,
    // 沒有這個條件會覆蓋掉別人寫的 finish_reason。
    await db.run(`UPDATE line_flow_sessions SET finished_at=?,finish_reason='expired',updated_at=?
      WHERE id=? AND finished_at IS NULL`, [now, now, row.id]);
    return null;
  }
  return rowValue(row);
}

// 同步版是「UPDATE ... WHERE public_id=? AND finished_at IS NULL,再看 changes」。
// 那個寫法搬到 mysql2 會出錯:MySQL 的 affectedRows 預設回報**實際被改動**的列數,
// 不是符合條件的列數。若這次 advance 的欄位值剛好和現值相同(例如注入固定的 now
// 又沒換 step),affectedRows 會是 0,於是誤報 'active flow not found'。
// 因此改成先確認未結束的 session 存在、再更新,兩個 driver 行為一致。
// 這變成 read-modify-write,所以 wrapper 用交易包起來。
async function advanceFlowCore(db, input) {
  const now = iso(input.now);
  const existing = await db.get(
    'SELECT id FROM line_flow_sessions WHERE public_id=? AND finished_at IS NULL',
    [input.publicId]
  );
  if (!existing) throw new Error('active flow not found');
  await db.run(`UPDATE line_flow_sessions SET step_code=?,context_json=?,listing_id=COALESCE(?,listing_id),
    updated_at=?,expires_at=? WHERE id=?`,
  [input.stepCode, JSON.stringify(input.context || {}), input.listingId || null,
    now, plusMinutes(now, 10), existing.id]);
  return rowValue(await db.get('SELECT * FROM line_flow_sessions WHERE public_id=?', [input.publicId]));
}

function advanceFlow(db, input) {
  return db.transaction((tx) => advanceFlowCore(tx, input));
}

// finishFlow / cancelFlow 的 changes 判斷在 mysql2 是安全的:finished_at 由 NULL 變成
// 有值,一定算「實際改動」,所以 affectedRows 與符合條件的列數一致。
async function finishFlow(db, publicId, reason = 'completed', at = new Date()) {
  const now = iso(at);
  const result = await db.run(`UPDATE line_flow_sessions SET finished_at=?,finish_reason=?,updated_at=?
    WHERE public_id=? AND finished_at IS NULL`, [now, reason, now, publicId]);
  return result.changes > 0;
}

async function cancelFlow(db, lineIdentityId, at = new Date()) {
  const now = iso(at);
  const result = await db.run(`UPDATE line_flow_sessions SET finished_at=?,finish_reason='cancelled',updated_at=?
    WHERE line_identity_id=? AND finished_at IS NULL`, [now, now, lineIdentityId]);
  return result.changes > 0;
}

module.exports = {
  advanceFlow,
  advanceFlowCore,
  cancelFlow,
  finishFlow,
  getActiveFlow,
  startFlow,
  startFlowCore
};
