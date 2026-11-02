const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { sha256 } = require('./hashService');
const { createFileStorage, storageKey } = require('./fileStorage');

const rootDir = path.resolve(__dirname, '..', '..');

function getStorage() {
  const uploadRoot = process.env.UPLOAD_ROOT
    ? path.resolve(process.env.UPLOAD_ROOT)
    : path.join(rootDir, 'uploads');
  return createFileStorage({ localRoot: uploadRoot, prefix: 'private' });
}

function extensionForType(messageType) {
  if (messageType === 'image') return '.jpg';
  if (messageType === 'video') return '.mp4';
  if (messageType === 'audio') return '.m4a';
  return '.bin';
}

function safeFileName(fileName) {
  return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

function defaultFileName(messageType, messageId) {
  return `${messageType}-${messageId}${extensionForType(messageType)}`;
}

function storageExtension(fileName, messageType) {
  const ext = path.extname(fileName || '');
  return ext || extensionForType(messageType);
}

async function downloadMessageContent({ messageId, messageType, fileName, groupId }) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  let buffer;
  let mimeType = null;

  if (process.env.LINE_CONTENT_DOWNLOAD_MOCK === 'true') {
    buffer = Buffer.from(`mock-line-content:${messageId}:${messageType}`);
    mimeType = messageType === 'image' ? 'image/jpeg' : 'application/octet-stream';
  } else {
    if (!token) {
      throw new Error('LINE_CHANNEL_ACCESS_TOKEN is required to download message content.');
    }

    const response = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    buffer = Buffer.from(response.data);
    mimeType = response.headers['content-type'] || null;
  }

  const finalName = safeFileName(fileName || defaultFileName(messageType, messageId));
  const groupDirName = safeFileName(groupId || 'unknown-group');
  const savedName = `${messageId}-${crypto.randomUUID()}${storageExtension(finalName, messageType)}`;
  const configured = getStorage();
  const stored = await configured.storage.put(`${groupDirName}/${savedName}`, buffer, { contentType: mimeType });

  return {
    fileName: finalName,
    filePath: storageKey(stored, configured.provider),
    storageProvider: configured.provider,
    mimeType,
    size: buffer.length,
    hash: sha256(buffer)
  };
}

module.exports = { downloadMessageContent };
