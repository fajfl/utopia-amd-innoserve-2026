// 測試專用 preload。由 package.json 的 test script 以 --require 載入。
//
// 為什麼需要:several 個 runtime 模組(dashboardLineService、repairWebRoutes、
// tenantRepairLineService)在第一次被呼叫時會 lazy-open V2 資料庫,路徑預設是
// 工作目錄裡那顆 **tracked** 的 data/ecs-neo-v2.sqlite。openV2Database 會順手
// 套用 database/migrations/ 底下所有 migration,所以只要有人跑全套測試,新加的
// migration 就會被寫進版控中的資料庫檔,污染其他服務與 git diff。
//
// 這裡在任何測試載入前就把預設路徑改到 temp,並強制走 SQLite driver,確保測試
// 永遠碰不到 tracked 檔案,也永遠不會連上遠端 TiDB。個別測試若自己指定路徑
// (createV2TestDatabase 就是)不受影響。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-neo-test-default-'));

process.env.V2_DATABASE_PATH = path.join(directory, 'default.sqlite');
// .env 把 driver 設成 mysql。測試絕對不能走到遠端事實來源。
process.env.V2_DB_DRIVER = 'sqlite';
// 舊版 src/db.js 也是硬寫在 data/app.sqlite,require 進來就會建表並改動檔案。
process.env.APP_DATABASE_PATH = path.join(directory, 'legacy-app.sqlite');
// 點交卡片與明細頁的短效連結都必須簽章。測試不應因為沒有載入本機 .env 而改走
// 無 token 的不安全動線。
process.env.PRE_INSPECTION_TOKEN_SECRET = process.env.PRE_INSPECTION_TOKEN_SECRET || 'test-pre-inspection-token-secret';

process.on('exit', () => {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // 程序結束時清不掉就算了,反正在 temp。
  }
});
