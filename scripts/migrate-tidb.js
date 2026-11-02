#!/usr/bin/env node
require('dotenv').config();

const path = require('node:path');
const {
  BASELINE_VERSION,
  applyTidbMigrations,
  assertDialectParity,
  checksumOf,
  createMigrationConnection,
  listMigrations
} = require('../src/database/tidbMigrationRunner');

const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SQLITE_DIR = path.join(ROOT, 'database', 'migrations');
const TIDB_DIR = path.join(ROOT, 'database', 'migrations-tidb');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // 只寫了一種方言就上線,兩邊 schema 會靜默分岔。每次都先擋。
  const parity = assertDialectParity({ sqliteDir: SQLITE_DIR, tidbDir: TIDB_DIR });
  console.log(`方言對照   OK（${parity.checked} 個 013+ 版本兩邊都有）`);

  const migrations = listMigrations(TIDB_DIR);
  console.log(`本地檔案   ${migrations.length} 個（baseline 為 ${BASELINE_VERSION}，1-${BASELINE_VERSION} 版由 SQLite 轉換產生）`);

  const connection = await createMigrationConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version BIGINT NOT NULL PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const [rows] = await connection.query(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
    );
    console.log(`雲端已套用 ${rows.length} 個（最高版號 ${rows.length ? rows[rows.length - 1].version : 0}）`);

    if (dryRun) {
      const pending = migrations.filter((migration) => {
        const existing = rows.find((row) => Number(row.version) === migration.version);
        if (!existing) return true;
        // 已套用的也檢查一次 checksum,提早發現被改過的 migration
        const checksum = checksumOf(fs.readFileSync(migration.path, 'utf8'));
        if (existing.checksum !== checksum) {
          throw new Error(`checksum mismatch for migration ${migration.key}`);
        }
        return false;
      });
      console.log('');
      if (!pending.length) {
        console.log('待套用     無');
      } else {
        console.log(`待套用     ${pending.length} 個`);
        for (const migration of pending) console.log(`  ${migration.key}`);
      }
      console.log('\n(--dry-run 未做任何寫入)');
      return;
    }

    const result = await applyTidbMigrations(connection, { dir: TIDB_DIR });
    console.log('');
    console.log(`已套用     ${result.applied.length ? result.applied.join(', ') : '無'}`);
    console.log(`已略過     ${result.skipped.length ? result.skipped.join(', ') : '無'}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`\nTiDB migration 失敗: ${error.message}`);
  if (error.code) console.error(`錯誤代碼: ${error.code}`);
  process.exitCode = 1;
});
