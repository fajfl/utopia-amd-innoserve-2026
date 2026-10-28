const path = require('node:path');
const { createLocalByteStorage } = require('./localByteStorage');
const { createR2ByteStorage } = require('./r2ByteStorage');

function useR2() {
  return String(process.env.FILE_STORAGE_PROVIDER || '').trim().toLowerCase() === 'r2';
}

function r2Root(prefix = '') {
  return [process.env.R2_OBJECT_PREFIX, prefix]
    .map((value) => String(value || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

// 共用 TiDB 卻把檔案寫本機,等於雲端資料庫指著某一台電腦的硬碟,其他人一律讀不到。
// 這正是 2026-08-25 那批「雲端 12 筆有 3 筆指向隊友 F: 槽」的成因,而且要等到有人
// 真的上傳照片才會發現。所以擋在啟動的第一秒 —— 跟 assertContractEvidenceDirConfigured
// 同一個作法:設定錯了就不要讓服務跑起來。
const SHARED_STORAGE_MESSAGE = [
  'V2_DB_DRIVER=mysql 時必須同時設定 FILE_STORAGE_PROVIDER=r2。',
  '資料庫是全隊共用的，檔案卻會寫進這台電腦的 uploads/ 與 data/ ——',
  '別人打開同一筆紀錄時，照片、簽名與錄影都會是壞的連結。',
  '請在 .env 補上 FILE_STORAGE_PROVIDER=r2 與 R2_* 四個設定後重新啟動。'
].join('\n');

function assertSharedStorageConfigured() {
  if (String(process.env.V2_DB_DRIVER || '').trim().toLowerCase() !== 'mysql') return;
  if (useR2()) return;
  throw new Error(SHARED_STORAGE_MESSAGE);
}

function createFileStorage({ localRoot, prefix = '' }) {
  if (useR2()) {
    return { provider: 's3', storage: createR2ByteStorage({ root: r2Root(prefix) }) };
  }
  return { provider: 'local', storage: createLocalByteStorage({ root: localRoot }) };
}

function storageKey(stored, provider) {
  if (provider === 's3') return stored.key;
  return path.relative(process.cwd(), stored.absolutePath).replace(/\\/g, '/');
}

// Reads a `files` row back regardless of which provider wrote it — local rows store
// a path relative to process.cwd(), r2 rows store the full R2 object key (prefix baked in).
function readStoredFile(file) {
  if (file.storage_provider === 's3') return createR2ByteStorage({ root: '' }).get(file.storage_key);
  return createLocalByteStorage({ root: process.cwd() }).get(file.storage_key);
}

module.exports = { assertSharedStorageConfigured, createFileStorage, storageKey, useR2, r2Root, readStoredFile };
