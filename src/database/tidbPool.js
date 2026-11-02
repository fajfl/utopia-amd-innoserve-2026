const mysql = require('mysql2/promise');

// TiDB Cloud 連線層。刻意與 better-sqlite3 的 openV2Database 並存:
// 這一支只負責「拿到一條正確設定的連線」,不做 migration,也不改既有同步路徑。
//
// openV2Database 每次呼叫都會跑 applyMigrations,SQLite 上只是慢,接到雲端會
// 變成每個請求一次跨區 round-trip,所以這裡不重蹈覆轍。

const DEFAULT_PORT = 4000;
const DEFAULT_CONNECTION_LIMIT = 10;

function requiredValue(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`${key} is required to connect to TiDB`);
  return value;
}

function positiveInteger(rawValue, fallback, key) {
  if (rawValue === undefined || String(rawValue).trim() === '') return fallback;
  const value = Number(String(rawValue).trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(rawValue)}`);
  }
  return value;
}

function sslEnabled(rawValue) {
  // TiDB Cloud Serverless 一律要求 TLS,預設開啟;只有明確寫 false 才關掉。
  const value = String(rawValue === undefined ? 'true' : rawValue).trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

function tidbConfigFromEnv(env = process.env) {
  return {
    host: requiredValue(env, 'DB_HOST'),
    port: positiveInteger(env.DB_PORT, DEFAULT_PORT, 'DB_PORT'),
    user: requiredValue(env, 'DB_USER'),
    password: String(env.DB_PASSWORD || ''),
    database: requiredValue(env, 'DB_DATABASE'),
    connectionLimit: positiveInteger(env.DB_CONNECTION_LIMIT, DEFAULT_CONNECTION_LIMIT, 'DB_CONNECTION_LIMIT'),
    ssl: sslEnabled(env.DB_SSL) ? { minVersion: 'TLSv1.2' } : undefined,

    // DATETIME 回傳字串而不是 JS Date。V2 的欄位在 SQLite 是 TEXT,呼叫端到處
    // 直接比較字串,轉成 Date 會靜默改變行為。
    dateStrings: true,

    // TiDB 的 AUTO_INCREMENT 以區段快取分配,id 可能超出 JS 安全整數範圍。
    // 超出時回傳字串而不是靜默失去精度。
    supportBigNumbers: true,

    timezone: 'Z',
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true
  };
}

let pool;

function getV2Pool() {
  if (!pool) pool = mysql.createPool(tidbConfigFromEnv());
  return pool;
}

async function closeV2Pool() {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  await closing.end();
}

// 測試用:注入假的 pool,避免測試連上真的叢集。
function setV2PoolForTesting(replacement) {
  pool = replacement;
}

async function withConnection(fn) {
  const connection = await getV2Pool().getConnection();
  try {
    return await fn(connection);
  } finally {
    connection.release();
  }
}

// MySQL 協定的交易綁在單一 session 上。直接對 pool 下 BEGIN 再下 UPDATE,
// 兩句可能落在不同連線,交易保證會靜默消失 —— 所以這裡一定要 pin 住連線。
async function withTransaction(fn) {
  return withConnection(async (connection) => {
    await connection.beginTransaction();
    try {
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  });
}

module.exports = {
  closeV2Pool,
  getV2Pool,
  setV2PoolForTesting,
  tidbConfigFromEnv,
  withConnection,
  withTransaction
};
