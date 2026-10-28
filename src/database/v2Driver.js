const path = require('node:path');

const { mysqlDriver, sqliteDriver } = require('./sqlDriver');
const { openV2Database } = require('./v2Database');
const { getV2Pool } = require('./tidbPool');

// 合約 runtime 要用哪個 driver。預設仍是 SQLite —— 切到雲端是明確的環境設定,
// 不是預設行為。
//
//   V2_DB_DRIVER=sqlite  (預設) 本機 data/ecs-neo-v2.sqlite
//   V2_DB_DRIVER=mysql         TiDB Cloud 連線池
function driverMode() {
  return String(process.env.V2_DB_DRIVER || 'sqlite').trim().toLowerCase();
}

let sqliteSingleton;
let sqliteDatabase;
function sqliteV2Driver() {
  if (!sqliteSingleton) {
    const dbPath = process.env.V2_DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'ecs-neo-v2.sqlite');
    sqliteDatabase = openV2Database({ dbPath });
    sqliteSingleton = sqliteDriver(sqliteDatabase);
  }
  return sqliteSingleton;
}

// 每個請求取得一個 driver,用完歸還。
//
// mysql2 一定要走這個包裝:交易綁在單一 session 上,若處理過程中改用 pool 直接
// 查詢,BEGIN 與後續語句會落在不同連線,交易保證會靜默消失。這裡在請求開始時
// 就取出一條連線並固定用它,結束後才 release。
//
// SQLite 沒有連線池,直接共用單例。
async function withV2Driver(fn) {
  if (driverMode() === 'mysql') {
    const connection = await getV2Pool().getConnection();
    try {
      return await fn(mysqlDriver(connection));
    } finally {
      connection.release();
    }
  }
  return fn(sqliteV2Driver());
}

// 測試會注入自己的 better-sqlite3 連線。
function withInjectedSqlite(getDb) {
  const cache = new WeakMap();
  return (fn) => {
    const db = getDb();
    if (!cache.has(db)) cache.set(db, sqliteDriver(db));
    return fn(cache.get(db));
  };
}

function resetV2DriverForTesting() {
  if (sqliteDatabase?.open) sqliteDatabase.close();
  sqliteSingleton = undefined;
  sqliteDatabase = undefined;
}

module.exports = { driverMode, resetV2DriverForTesting, withInjectedSqlite, withV2Driver };
