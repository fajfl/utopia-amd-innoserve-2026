// 把 591 房源圖凍結成自己的副本。
//
// 為什麼要凍結:listing_snapshots 整張表的目的是保全「當時房源長什麼樣」——
// raw_hash、captured_at、parser_version 都在。但圖片一直是熱連結 591 的 CDN,
// 房源下架或房東換圖,快照裡的圖就跟著變或消失,證據保全等於破了一個洞。
//
// 為什麼不全部抓:有法律意義的是「這位房客當初看到什麼」,不是全站圖庫。
// 所以只在房客真的建立詢問時凍結那一筆,量級從 O(所有房源) 降到 O(有意向的房源)。
//
// 觸發時機:inquiry commit **之後**,而且呼叫端不 await(見 v2EntryTokenService)。
// 下載是外部 I/O,放在交易裡會握著連線池的連線等網路;放在回覆路徑上會讓
// 使用者等 591 吐圖。

const crypto = require('node:crypto');
const path = require('node:path');
const { createFileStorage, storageKey: storageKeyForStored } = require('./fileStorage');
const { withV2Driver } = require('../database/v2Driver');

// 5MB。真實 591 房源圖大約 200KB,這是 25 倍餘裕。
// 這個值直接決定記憶體上限:同時在手上的 buffer 最多是 concurrency 張。
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_IMAGES = 12;

function allowedImageHost(hostname, extraHosts = []) {
  const host = String(hostname || '').toLowerCase();
  return host === '591.com.tw' || host.endsWith('.591.com.tw') || extraHosts.includes(host);
}

function safeImageUrl(value, extraHosts) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedImageHost(url.hostname, extraHosts)) {
    throw new Error('image URL is not an allowed HTTPS 591 host');
  }
  return url;
}

// 用 magic bytes 判型別,不信 content-type——那是對方說了算的。
function detectImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', extension: 'png' };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return { mimeType: 'image/gif', extension: 'gif' };
  throw new Error('downloaded content is not a supported image');
}

// content-length 是對方宣告的,可能造假,所以邊串流邊累計也要擋。
async function responseBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('image is too large');
  const chunks = [];
  let size = 0;
  if (response.body && response.body[Symbol.asyncIterator]) {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error('image is too large');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('image is too large');
  return buffer;
}

// redirect: 'manual' 之後**每一跳都重新驗**。只驗第一個 URL 的話,591 那邊一個
// 開放重導向就能把我們指到內網位址。
async function downloadImage(sourceUrl, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const extraHosts = String(options.allowedHosts || process.env.V2_591_IMAGE_HOSTS || '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  let url = safeImageUrl(sourceUrl, extraHosts);
  const maxRedirects = options.maxRedirects ?? 3;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      headers: { accept: 'image/*', 'user-agent': 'ECS-NEO/1.0' }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirect === maxRedirects) throw new Error('image redirect limit exceeded');
      url = safeImageUrl(new URL(location, url).toString(), extraHosts);
      continue;
    }
    if (!response.ok) throw new Error(`image download failed (${response.status})`);
    const buffer = await responseBytes(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    return { buffer, ...detectImage(buffer) };
  }
  throw new Error('image redirect limit exceeded');
}

async function downloadChunk(items, options) {
  return Promise.all(items.map(async (item) => {
    try {
      return { ok: true, item, image: await downloadImage(item.source_url, options) };
    } catch (error) {
      return { ok: false, mediaId: item.id, error: error.message };
    }
  }));
}

// 落地一張圖。呼叫端保證這裡是**序列**執行的:sqliteDriver 的交易是
// BEGIN IMMEDIATE,同時只有一個 writer,平行跑會撞
// "cannot start a transaction within a transaction"。
async function persistImage(download, context) {
  const { item, image } = download;
  const { withDriver, storage, storageProvider, createdByUserId } = context;
  let filename;
  let storageKey;
  try {
    const digest = crypto.createHash('sha256').update(image.buffer).digest('hex');
    filename = `${digest}.${image.extension}`;

    // 同一張圖被多個房源用到只存一份,靠 files 的
    // UNIQUE (sha256_hash, size_bytes, security_classification)。
    const existing = await withDriver((db) => db.get(
      "SELECT id FROM files WHERE sha256_hash=? AND size_bytes=? AND security_classification='private'",
      [digest, image.buffer.length]
    ));
    if (existing) {
      await withDriver((db) => db.transaction(async (tx) => {
        const current = await tx.get('SELECT file_id FROM listing_media WHERE id=?', [item.id]);
        const fileId = current?.file_id || existing.id;
        if (current && !current.file_id) {
          await tx.run('UPDATE listing_media SET file_id=? WHERE id=? AND file_id IS NULL', [fileId, item.id]);
        }
        await tx.run(`${tx.dialect.insertIgnore} INTO file_links (file_id,entity_type,entity_id,purpose)
          VALUES (?,'listing_media',?,'source_freeze')`, [fileId, item.id]);
      }));
      return { ok: true, mediaId: item.id, fileId: existing.id };
    }

    // 檔案先落地再開交易。反過來的話交易會握著連線等磁碟。
    const stored = await storage.put(filename, image.buffer, { contentType: image.mimeType });
    storageKey = storageKeyForStored(stored, storageProvider);

    const saved = await withDriver((db) => db.transaction(async (tx) => {
      const current = await tx.get(`SELECT lm.file_id,f.storage_key FROM listing_media lm
        LEFT JOIN files f ON f.id=lm.file_id WHERE lm.id=?`, [item.id]);
      if (!current || current.file_id) {
        return { fileId: current?.file_id || null, reused: current?.storage_key !== storageKey };
      }
      // 刻意不拿 insertId:TiDB 的 AUTO_INCREMENT 是分段配發的,而 sha256 決定唯一列。
      await tx.run(`${tx.dialect.insertIgnore} INTO files
        (public_id,storage_key,storage_provider,original_name,mime_type,size_bytes,sha256_hash,security_classification,created_by_user_id)
        VALUES (?,?,?,?,?,?,?,?,?)`, [
        `file-${crypto.randomUUID()}`, storageKey, storageProvider, filename, image.mimeType,
        image.buffer.length, digest, 'private', createdByUserId
      ]);
      const file = await tx.get(
        "SELECT id,storage_key FROM files WHERE sha256_hash=? AND size_bytes=? AND security_classification='private'",
        [digest, image.buffer.length]
      );
      if (!file) throw new Error('file row disappeared right after insert');
      await tx.run('UPDATE listing_media SET file_id=? WHERE id=? AND file_id IS NULL', [file.id, item.id]);
      await tx.run(`${tx.dialect.insertIgnore} INTO file_links (file_id,entity_type,entity_id,purpose)
        VALUES (?,'listing_media',?,'source_freeze')`, [file.id, item.id]);
      return { fileId: file.id, reused: file.storage_key !== storageKey };
    }));
    // 有人搶先了,我們剛寫的那份沒有任何列指向它。
    if (saved.reused) await storage.delete(filename).catch(() => {});
    return { ok: true, mediaId: item.id, fileId: saved.fileId };
  } catch (error) {
    if (filename && storageKey) {
      const referenced = await withDriver(
        (db) => db.get('SELECT id FROM files WHERE storage_key=?', [storageKey])
      ).catch(() => null);
      if (!referenced) await storage.delete(filename).catch(() => {});
    }
    return { ok: false, mediaId: item.id, error: error.message };
  }
}

async function freezeListingImages({ listingId, createdByUserId = null }, options = {}) {
  const withDriver = options.withDriver || withV2Driver;
  // 待辦佇列天然就在資料裡:凍好一張就補上 file_id,所以重跑只會處理剩下的。
  const media = await withDriver((db) => db.all(`SELECT id,source_url FROM listing_media
    WHERE listing_id=? AND media_type='image' AND source_url IS NOT NULL AND file_id IS NULL
    ORDER BY sort_order,id LIMIT ?`, [listingId, options.maxImages ?? DEFAULT_MAX_IMAGES]));
  if (!media.length) return [];

  const storageRoot = options.storageRoot || path.join(process.cwd(), 'data', 'listing-images');
  const configured = options.storage
    ? { storage: options.storage, provider: options.storageProvider || 'local' }
    : createFileStorage({ localRoot: storageRoot, prefix: 'listing-images' });
  const storage = configured.storage;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const context = { withDriver, storage, storageProvider: configured.provider, createdByUserId };

  // 一次只抓 concurrency 張、落地、再抓下一批。全部先抓完再落地的話,
  // 記憶體峰值是 maxImages × maxBytes(12 × 5MB = 60MB),而且是每個同時
  // 進來的使用者各一份。分批之後峰值降到 concurrency × maxBytes。
  const results = [];
  for (let offset = 0; offset < media.length; offset += concurrency) {
    const downloaded = await downloadChunk(media.slice(offset, offset + concurrency), options);
    for (const download of downloaded) {
      results.push(download.ok ? await persistImage(download, context) : download);
    }
  }
  return results;
}

module.exports = { allowedImageHost, detectImage, downloadImage, freezeListingImages };
