const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const { tidbConfigFromEnv } = require('./tidbPool');

const MIGRATION_FILENAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

// 雲端 schema 的 1~12 版是由 SQLite 轉換工具產生的,不是由 migrations-tidb 套用的。
// 因此 TiDB 的 migration 軌道從 013 起算;低於或等於這個版號的檔案視為作者失誤。
const BASELINE_VERSION = 12;

// database/migrations/ 是 SQLite 方言,不能拿來跑 TiDB:
//   INTEGER PRIMARY KEY 在 MySQL 只是普通主鍵(當初 88 個自增就是這樣消失的)
//   CREATE TRIGGER 在 parser 階段就失敗
//   TEXT UNIQUE 需要改成 VARCHAR(n)
//   date('now') 不報錯,直接回傳 NULL
// 所以兩個方言各有一份檔案,版號必須一一對應。

function listMigrations(migrationsDir) {
  const resolved = path.resolve(migrationsDir);
  if (!fs.existsSync(resolved)) return [];

  const files = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILENAME);
      if (!match) throw new Error(`invalid migration filename: ${entry.name}`);
      return {
        filename: entry.name,
        version: Number(match[1]),
        name: match[2],
        key: `${match[1]}_${match[2]}`,
        path: path.join(resolved, entry.name)
      };
    })
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].version === files[index].version) {
      throw new Error(`duplicate migration version: ${files[index].version}`);
    }
  }
  return files;
}

function checksumOf(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

// 最容易發生的事故是只寫了一種方言就上線,兩邊 schema 從此靜默分岔。
function assertDialectParity({ sqliteDir, tidbDir, baselineVersion = BASELINE_VERSION } = {}) {
  const sqlite = listMigrations(sqliteDir).filter((m) => m.version > baselineVersion);
  const tidb = listMigrations(tidbDir).filter((m) => m.version > baselineVersion);

  const tidbVersions = new Set(tidb.map((m) => m.version));
  const sqliteVersions = new Set(sqlite.map((m) => m.version));

  const missingTidb = sqlite.filter((m) => !tidbVersions.has(m.version)).map((m) => m.key);
  const missingSqlite = tidb.filter((m) => !sqliteVersions.has(m.version)).map((m) => m.key);

  if (missingTidb.length) {
    throw new Error(`missing TiDB migration for: ${missingTidb.join(', ')}`);
  }
  if (missingSqlite.length) {
    throw new Error(`missing SQLite migration for: ${missingSqlite.join(', ')}`);
  }
  return { checked: sqlite.length };
}

async function ensureMigrationTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version BIGINT NOT NULL PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedVersions(connection) {
  const [rows] = await connection.query('SELECT version, name, checksum FROM schema_migrations');
  return new Map(rows.map((row) => [Number(row.version), row]));
}

/**
 * 套用 TiDB migration。
 *
 * 重要:TiDB 與 MySQL 一樣**不支援交易式 DDL** —— 每個 DDL 語句都會自動 commit。
 * SQLite 的 runner 用 BEGIN IMMEDIATE 包住整個檔案,失敗可以整批 rollback;
 * 這裡做不到。一個檔案跑到一半失敗,前面已執行的語句會留在資料庫裡。
 *
 * 因此:
 *   - 失敗時不寫入 schema_migrations,該版本維持「未套用」
 *   - 錯誤訊息會標明需要人工確認已產生的部分 schema
 *   - migration 檔案應盡量用 IF NOT EXISTS / IF EXISTS 讓重跑安全
 */
async function applyTidbMigrations(connection, {
  dir,
  baselineVersion = BASELINE_VERSION
} = {}) {
  await ensureMigrationTable(connection);

  const migrations = listMigrations(dir);
  const tooLow = migrations.filter((m) => m.version <= baselineVersion);
  if (tooLow.length) {
    throw new Error(
      `TiDB migrations must start after version ${baselineVersion} ` +
      `(cloud schema 1-${baselineVersion} came from the SQLite conversion, not from these files); ` +
      `offending: ${tooLow.map((m) => m.key).join(', ')}`
    );
  }

  const applied = await appliedVersions(connection);
  const result = { applied: [], skipped: [] };

  for (const migration of migrations) {
    const sql = fs.readFileSync(migration.path, 'utf8');
    const checksum = checksumOf(sql);
    const existing = applied.get(migration.version);

    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== checksum) {
        throw new Error(`checksum mismatch for migration ${migration.key}`);
      }
      result.skipped.push(migration.key);
      continue;
    }

    try {
      await connection.query(sql);
    } catch (error) {
      error.message =
        `migration ${migration.key} failed: ${error.message}\n` +
        'TiDB 的 DDL 不是交易式的,失敗前已執行的語句仍然生效。' +
        '請先人工確認資料庫狀態再重跑。';
      throw error;
    }

    await connection.query(
      'INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)',
      [migration.version, migration.name, checksum]
    );
    result.applied.push(migration.key);
  }

  return result;
}

// migration 檔案含多個語句,需要 multipleStatements。刻意不放進共用連線池:
// 應用程式的查詢開著 multipleStatements 會擴大 SQL injection 的破壞面。
async function createMigrationConnection(env = process.env) {
  const config = tidbConfigFromEnv(env);
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl,
    dateStrings: config.dateStrings,
    supportBigNumbers: config.supportBigNumbers,
    timezone: config.timezone,
    multipleStatements: true
  });
}

module.exports = {
  BASELINE_VERSION,
  applyTidbMigrations,
  assertDialectParity,
  checksumOf,
  createMigrationConnection,
  listMigrations
};
