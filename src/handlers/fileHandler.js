const { downloadMessageContent } = require('../services/contentDownloadService');
const { saveMessage } = require('../services/archiveService');
const { createFileRecord, linkMessageFile } = require('../services/fileRecordService');
const { ensureCaseForEvent } = require('../services/caseService');

async function handleFileMessage(event, client) {
  const message = event.message;
  const groupId = event.source.groupId || event.source.roomId || 'unknown-group';
  try {
    const rentalCase = ensureCaseForEvent(event);
    const downloaded = await downloadMessageContent({
      messageId: message.id,
      messageType: message.type,
      fileName: message.fileName,
      groupId
    });

    const messageRowId = saveMessage(event, {
      message_type: message.type,
      file_name: downloaded.fileName,
      file_path: downloaded.filePath,
      file_mime_type: downloaded.mimeType,
      file_size: downloaded.size,
      content_hash: downloaded.hash
    });
    const fileId = createFileRecord({
      caseId: rentalCase ? rentalCase.case_id : null,
      category: 'message_attachment',
      originalFileName: downloaded.fileName,
      mimeType: downloaded.mimeType,
      sizeBytes: downloaded.size,
      hash: downloaded.hash,
      storageKey: downloaded.filePath,
      storageProvider: downloaded.storageProvider
    });
    linkMessageFile(messageRowId, fileId);

    if (!event.replyToken) return;

    const replyText = message.type === 'file'
      ? `已收到並保存檔案：${downloaded.fileName}`
      : `已收到並保存${message.type === 'image' ? '圖片' : message.type === 'video' ? '影片' : '音訊'}。`;

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: replyText
    });
  } catch (error) {
    console.error('Failed to download or archive LINE content:', error.message);
    saveMessage(event, {
      message_type: message.type,
      file_name: message.fileName || null
    });
  }
}

module.exports = { handleFileMessage };
