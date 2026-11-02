const path = require('node:path');

// 簽章證據(簽名圖、筆跡、錄影)與正式合約檔案的存放位置。
//
// 原本寫成 path.dirname(db.pragma('database_list')[0].file),也就是從 SQLite
// 的檔案路徑推導出來。接上 TiDB 之後沒有檔案路徑,這個依賴必須拿掉。
//
// 解析順序:
//   1. 呼叫端明確指定
//   2. SQLite driver 暴露的實際檔案位置(維持既有行為,測試的暫存 DB 也靠這個)
//   3. V2_CONTRACT_EVIDENCE_DIR
//
// 沒有第 3 項而 driver 又不是 SQLite 時,**直接報錯**。這些是有法律意義的
// 證據檔案,靜默選一個路徑寫下去比失敗更糟。

function resolveEvidenceDir(db, explicitDir) {
  // R2 does not use a local directory. Callers still pass this through their
  // existing API, while createFileStorage ignores it for the R2 provider.
  if (String(process.env.FILE_STORAGE_PROVIDER || '').trim().toLowerCase() === 'r2') return '';
  if (explicitDir) return path.resolve(explicitDir);

  const sqliteFile = typeof db?.sqliteFile === 'function' ? db.sqliteFile() : null;
  if (sqliteFile) return path.join(path.dirname(sqliteFile), 'contract-evidence');

  const configured = String(process.env.V2_CONTRACT_EVIDENCE_DIR || '').trim();
  if (configured) return path.resolve(configured);

  throw new Error(
    'V2_CONTRACT_EVIDENCE_DIR is required when the contract database is not a local SQLite file; ' +
    'signature evidence must have an explicit storage location'
  );
}

module.exports = { resolveEvidenceDir };
