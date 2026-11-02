const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATION_FILENAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

function openV2Database(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function listMigrations(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];

  const files = fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILENAME);
      if (!match) {
        throw new Error(`invalid migration filename: ${entry.name}`);
      }
      return {
        filename: entry.name,
        version: Number(match[1]),
        name: match[2],
        key: `${match[1]}_${match[2]}`,
        path: path.join(migrationsDir, entry.name)
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

function applyMigrations(db, migrationsDir) {
  ensureMigrationTable(db);
  const migrations = listMigrations(path.resolve(migrationsDir));
  const applied = [];
  const skipped = [];
  const selectApplied = db.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    WHERE version = ?
  `);
  const insertApplied = db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum)
    VALUES (?, ?, ?)
  `);

  for (const migration of migrations) {
    const sql = fs.readFileSync(migration.path, 'utf8');
    const normalizedSql = sql.replace(/\r\n/g, '\n');
    const checksum = crypto.createHash('sha256').update(normalizedSql).digest('hex');
    const compatibleChecksums = new Set([
      checksum,
      crypto.createHash('sha256').update(normalizedSql.replace(/\n/g, '\r\n')).digest('hex'),
    ]);
    const existing = selectApplied.get(migration.version);

    if (existing) {
      if (existing.name !== migration.name || !compatibleChecksums.has(existing.checksum)) {
        throw new Error(`checksum mismatch for migration ${migration.key}`);
      }
      skipped.push(migration.key);
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      insertApplied.run(migration.version, migration.name, checksum);
      db.exec('COMMIT');
      applied.push(migration.key);
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  return { applied, skipped };
}

module.exports = {
  applyMigrations,
  openV2Database
};
