const path = require('node:path');
const {
  openV2Database,
  applyMigrations
} = require('../src/database/migrationRunner');

// --db 優先,其次 V2_DATABASE_PATH,最後才是正式資料庫。
//
// 中間那一段本來沒有:app 讀 V2_DATABASE_PATH,這支不讀,所以「設好環境變數再跑
// migration」會安安靜靜地升級**正式**資料庫,而使用者以為自己在動另一份。
// 已經踩過一次,不要再讓它預設指向正式庫。
function readDbPath(argv) {
  const dbFlagIndex = argv.indexOf('--db');
  if (dbFlagIndex !== -1) {
    const value = argv[dbFlagIndex + 1];
    if (!value) throw new Error('--db requires a file path');
    return path.resolve(value);
  }
  if (process.env.V2_DATABASE_PATH) return path.resolve(process.env.V2_DATABASE_PATH);
  return path.join(__dirname, '..', 'data', 'ecs-neo-v2.sqlite');
}

const dbPath = readDbPath(process.argv.slice(2));
const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
const db = openV2Database(dbPath);

try {
  const result = applyMigrations(db, migrationsDir);
  process.stdout.write(`${JSON.stringify({ dbPath, ...result })}\n`);
} finally {
  db.close();
}
