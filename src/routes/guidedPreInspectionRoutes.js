const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const { withV2Driver } = require('../database/v2Driver');
const preInspectionRepository = require('../repositories/preInspectionRepositoryAsync');
const { createFileStorage, storageKey: storageKeyForStored } = require('../services/fileStorage');
const {
  requestToken,
  resolvePreInspectionUser,
  verifyPreInspectionToken
} = require('../services/preInspectionTokenService');
const { liffBootstrap } = require('../services/liffSessionService');
const { submitPreInspectionToLandlord } = require('../services/preInspectionLineService');

const router = express.Router();
const mediaRoot = path.join(__dirname, '..', '..', 'uploads', 'pre-inspections');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

router.use(express.json({ limit: '16mb' }));

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  return { mimeType: match[1].toLowerCase(), bytes };
}

async function tenantActiveSession(req, publicId) {
  const lineUserId = resolvePreInspectionUser(req, publicId);
  if (!lineUserId) return { lineUserId: null, session: null };
  const session = await withV2Driver(async (db) => {
    const found = await preInspectionRepository.getSessionByPublicId(db, publicId);
    if (!found || found.line_user_id !== lineUserId) return null;
    return found;
  });
  return { lineUserId, session };
}

async function seedAndReadCapture(db, session) {
  const references = await preInspectionRepository.getListingInspectionReference(db, session.listing_id);
  await preInspectionRepository.ensureInspectionItems(db, {
    sessionId: session.id,
    itemNames: references
  });
  const [items, referenceImages] = await Promise.all([
    preInspectionRepository.getInspectionItems(db, session.id),
    preInspectionRepository.getListingImages(db, session.listing_id, 8, { sessionPublicId: session.public_id })
  ]);
  const imageEntries = await db.all(`
    SELECT id, inspection_item_id
    FROM pre_inspection_entries
    WHERE session_id = ? AND entry_type = 'image' AND inspection_item_id IS NOT NULL
    ORDER BY id ASC
  `, [session.id]);
  const imagesByItem = new Map();
  for (const entry of imageEntries) {
    const list = imagesByItem.get(Number(entry.inspection_item_id)) || [];
    list.push(`/tenant/pre-inspections/${encodeURIComponent(session.public_id)}/media/${encodeURIComponent(entry.id)}`);
    imagesByItem.set(Number(entry.inspection_item_id), list);
  }
  return {
    items: items.map((item) => ({
      id: item.id,
      name: item.item_name,
      source: item.source,
      status: item.status,
      note: item.note || '',
      imageCount: Number(item.image_count || 0),
      imageUrls: imagesByItem.get(Number(item.id)) || []
    })),
    referenceImages
  };
}

function capturePage(publicId) {
  return `<!doctype html>
<html lang="zh-Hant"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>引導式屋況點交</title>
  <script>window.GUIDED_INSPECTION = { publicId: ${JSON.stringify(publicId)} };</script>
  <script defer src="/assets/compressImage.js"></script>
  <script defer src="/assets/guidedPreInspection.js"></script>
</head><body><main id="guided-inspection-root" aria-live="polite">載入點交項目…</main></body></html>`;
}

router.get('/tenant/pre-inspections/:publicId/capture', async (req, res, next) => {
  const publicId = req.params.publicId;
  const queryToken = req.query.token ? String(req.query.token).trim() : '';
  if (queryToken) {
    const verifiedUser = verifyPreInspectionToken(queryToken, publicId);
    if (!verifiedUser) return res.status(401).send('<h1>401 Unauthorized</h1><p>點交連結已失效</p>');
    res.cookie('v2_inspection_token', queryToken, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000
    });
    return res.redirect(302, `/tenant/pre-inspections/${encodeURIComponent(publicId)}/capture`);
  }

  try {
    const { lineUserId, session } = await tenantActiveSession(req, publicId);
    if (!lineUserId) return res.send(liffBootstrap(req.originalUrl));
    if (!session) return res.status(403).send('<h1>403 Forbidden</h1><p>您無權操作此屋況紀錄</p>');
    if (session.status !== 'active') {
      return res.redirect(302, `/tenant/pre-inspections/${encodeURIComponent(publicId)}`);
    }
    res.set('Cache-Control', 'no-store');
    return res.send(capturePage(publicId));
  } catch (error) {
    return next(error);
  }
});

router.get('/v2/api/tenant/pre-inspections/:publicId/guided', async (req, res, next) => {
  try {
    const { lineUserId, session } = await tenantActiveSession(req, req.params.publicId);
    if (!lineUserId) return res.status(401).json({ ok: false, error: '請回 LINE 重新開啟屋況點交。' });
    if (!session) return res.status(403).json({ ok: false, error: '沒有此屋況紀錄的操作權限。' });
    const payload = await withV2Driver(async (db) => seedAndReadCapture(db, session));
    return res.json({ ok: true, session: { publicId: session.public_id, title: session.title || '目前房源', status: session.status }, ...payload });
  } catch (error) {
    return next(error);
  }
});

router.post('/v2/api/tenant/pre-inspections/:publicId/items', async (req, res, next) => {
  try {
    const { lineUserId, session } = await tenantActiveSession(req, req.params.publicId);
    if (!lineUserId) return res.status(401).json({ ok: false, error: '請回 LINE 重新開啟屋況點交。' });
    if (!session || session.status !== 'active') return res.status(409).json({ ok: false, error: '此屋況紀錄無法再新增項目。' });
    const item = await withV2Driver((db) => preInspectionRepository.addInspectionItem(db, {
      sessionId: session.id,
      itemName: String(req.body?.itemName || '').slice(0, 80)
    }));
    if (!item) return res.status(400).json({ ok: false, error: '請輸入設備名稱。' });
    return res.json({ ok: true, item });
  } catch (error) {
    return next(error);
  }
});

router.post('/v2/api/tenant/pre-inspections/:publicId/items/:itemId', async (req, res, next) => {
  try {
    const { lineUserId, session } = await tenantActiveSession(req, req.params.publicId);
    if (!lineUserId) return res.status(401).json({ ok: false, error: '請回 LINE 重新開啟屋況點交。' });
    if (!session || session.status !== 'active') return res.status(409).json({ ok: false, error: '此屋況紀錄已封存，不能再修改。' });
    const status = String(req.body?.status || 'pending');
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    const item = await withV2Driver(async (db) => {
      const current = await preInspectionRepository.getInspectionItem(db, { sessionId: session.id, itemId: req.params.itemId });
      if (!current) return null;
      if (status === 'completed') {
        const count = await db.get(
          "SELECT COUNT(*) AS count FROM pre_inspection_entries WHERE inspection_item_id = ? AND entry_type = 'image'",
          [current.id]
        );
        if (!Number(count?.count || 0)) return 'PHOTO_REQUIRED';
      }
      return preInspectionRepository.updateInspectionItem(db, { sessionId: session.id, itemId: current.id, status, note });
    });
    if (item === 'PHOTO_REQUIRED') return res.status(400).json({ ok: false, error: '請至少拍一張照片後再標記完成。' });
    if (!item) return res.status(404).json({ ok: false, error: '找不到此設備項目。' });
    return res.json({ ok: true, item });
  } catch (error) {
    return next(error);
  }
});

router.post('/v2/api/tenant/pre-inspections/:publicId/items/:itemId/photo', async (req, res, next) => {
  try {
    const parsedImage = parseImageDataUrl(req.body?.dataUrl);
    if (!parsedImage) return res.status(400).json({ ok: false, error: '請上傳 JPG、PNG 或 WEBP 圖片，且不可超過 10MB。' });
    const { lineUserId, session } = await tenantActiveSession(req, req.params.publicId);
    if (!lineUserId) return res.status(401).json({ ok: false, error: '請回 LINE 重新開啟屋況點交。' });
    if (!session || session.status !== 'active') return res.status(409).json({ ok: false, error: '此屋況紀錄已封存，不能再上傳。' });
    const result = await withV2Driver(async (db) => {
      const item = await preInspectionRepository.getInspectionItem(db, { sessionId: session.id, itemId: req.params.itemId });
      if (!item) return null;
      const digest = crypto.createHash('sha256').update(parsedImage.bytes).digest('hex');
      const existingFile = await db.get(
        "SELECT id, storage_key FROM files WHERE sha256_hash = ? AND size_bytes = ? AND security_classification = 'private'",
        [digest, parsedImage.bytes.length]
      );
      const extension = ALLOWED_IMAGE_TYPES.get(parsedImage.mimeType);
      const fileName = `${crypto.randomUUID()}.${extension}`;
      let fileId;
      let storageKey;
      if (existingFile) {
        fileId = existingFile.id;
        storageKey = existingFile.storage_key;
      } else {
        const { provider, storage } = createFileStorage({ localRoot: mediaRoot, prefix: 'private' });
        const stored = await storage.put(`${session.public_id}/${fileName}`, parsedImage.bytes, { contentType: parsedImage.mimeType });
        storageKey = storageKeyForStored(stored, provider);
        const publicId = `file-${crypto.randomUUID()}`;
        await db.run(`
          INSERT INTO files (public_id, storage_key, storage_provider, original_name, mime_type, size_bytes, sha256_hash, security_classification, created_by_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'private', NULL)
        `, [publicId, storageKey, provider, fileName, parsedImage.mimeType, parsedImage.bytes.length, digest]);
        const inserted = await db.get(
          "SELECT id FROM files WHERE sha256_hash = ? AND size_bytes = ? AND security_classification = 'private'",
          [digest, parsedImage.bytes.length]
        );
        fileId = inserted.id;
      }
      await preInspectionRepository.addEntry(db, {
        sessionId: session.id,
        inspectionItemId: item.id,
        entryType: 'image',
        fileId,
        storagePath: storageKey,
        publicUrl: `/uploads/pre-inspections/${session.public_id}/${fileName}`,
        mimeType: parsedImage.mimeType
      });
      const entry = await db.get(
        "SELECT id FROM pre_inspection_entries WHERE session_id = ? AND inspection_item_id = ? AND file_id = ? ORDER BY id DESC LIMIT 1",
        [session.id, item.id, fileId]
      );
      return { entryId: entry.id };
    });
    if (!result) return res.status(404).json({ ok: false, error: '找不到此設備項目。' });
    return res.json({ ok: true, imageUrl: `/tenant/pre-inspections/${encodeURIComponent(session.public_id)}/media/${encodeURIComponent(result.entryId)}` });
  } catch (error) {
    return next(error);
  }
});

router.post('/v2/api/tenant/pre-inspections/:publicId/complete', async (req, res, next) => {
  try {
    const { lineUserId, session } = await tenantActiveSession(req, req.params.publicId);
    if (!lineUserId) return res.status(401).json({ ok: false, error: '請回 LINE 重新開啟屋況點交。' });
    if (!session) return res.status(403).json({ ok: false, error: '沒有此屋況紀錄的操作權限。' });
    const result = await withV2Driver(async (db) => {
      if (session.status === 'active') await preInspectionRepository.sealSession(db, session.id);
      return submitPreInspectionToLandlord(db, {
        sessionId: session.id,
        tenantLineUserId: lineUserId
      });
    });
    if (!result.ok) return res.status(409).json({ ok: false, sealed: true, error: result.message, code: result.code });
    return res.json({ ok: true, sealed: true, submitted: true, message: result.message });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
