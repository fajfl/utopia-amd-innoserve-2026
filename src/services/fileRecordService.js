const db = require('../db');

function createFileRecord({
  caseId,
  uploadedByUserId,
  category,
  originalFileName,
  mimeType,
  sizeBytes,
  hash,
  storageKey,
  storageProvider = 'local'
}) {
  db.prepare(`
    INSERT OR IGNORE INTO files (
      case_id,
      uploaded_by_user_id,
      category,
      original_file_name,
      mime_type,
      size_bytes,
      sha256_hash,
      storage_key,
      storage_provider,
      status
    ) VALUES (
      @caseId,
      @uploadedByUserId,
      @category,
      @originalFileName,
      @mimeType,
      @sizeBytes,
      @hash,
      @storageKey,
      @storageProvider,
      'active'
    )
  `).run({
    caseId: caseId || null,
    uploadedByUserId: uploadedByUserId || null,
    category,
    originalFileName: originalFileName || null,
    mimeType: mimeType || null,
    sizeBytes: sizeBytes || null,
    hash,
    storageKey,
    storageProvider
  });

  const row = db.prepare(`
    SELECT id
    FROM files
    WHERE storage_key = @storageKey
  `).get({ storageKey });

  return row.id;
}

function linkMessageFile(messageId, fileId) {
  db.prepare(`
    INSERT OR IGNORE INTO message_files (
      message_id,
      file_id
    ) VALUES (
      @messageId,
      @fileId
    )
  `).run({ messageId, fileId });
}

module.exports = {
  createFileRecord,
  linkMessageFile
};
