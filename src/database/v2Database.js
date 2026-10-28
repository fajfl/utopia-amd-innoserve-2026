const path = require('node:path');

const {
  applyMigrations,
  openV2Database: openConnection
} = require('./migrationRunner');

function openV2Database({ dbPath, migrationsDir } = {}) {
  if (!dbPath) throw new Error('dbPath is required');

  const db = openConnection(dbPath);
  try {
    applyMigrations(
      db,
      migrationsDir || path.join(__dirname, '..', '..', 'database', 'migrations')
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function closeV2Database(db) {
  if (db && db.open) db.close();
}

module.exports = {
  closeV2Database,
  openV2Database
};
