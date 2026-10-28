const db = require('../db');
const { ensureCaseForEvent, ensureCaseForLineThread } = require('./caseService');
const { sha256 } = require('./hashService');

const insertEvent = db.prepare(`
  INSERT INTO line_events (
    case_id,
    event_id,
    event_type,
    source_type,
    group_id,
    room_id,
    user_id,
    timestamp,
    raw_json,
    raw_json_hash
  ) VALUES (
    @case_id,
    @event_id,
    @event_type,
    @source_type,
    @group_id,
    @room_id,
    @user_id,
    @timestamp,
    @raw_json,
    @raw_json_hash
  )
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (
    case_id,
    message_id,
    group_id,
    room_id,
    user_id,
    message_type,
    text_content,
    file_name,
    file_path,
    file_mime_type,
    file_size,
    content_hash,
    line_timestamp
  ) VALUES (
    @case_id,
    @message_id,
    @group_id,
    @room_id,
    @user_id,
    @message_type,
    @text_content,
    @file_name,
    @file_path,
    @file_mime_type,
    @file_size,
    @content_hash,
    @line_timestamp
  )
`);

const insertPostback = db.prepare(`
  INSERT INTO postbacks (
    group_id,
    room_id,
    user_id,
    postback_data,
    action,
    case_id,
    draft_id,
    line_timestamp
  ) VALUES (
    @group_id,
    @room_id,
    @user_id,
    @postback_data,
    @action,
    @case_id,
    @draft_id,
    @line_timestamp
  )
`);

const insertBotCommand = db.prepare(`
  INSERT INTO bot_commands (
    group_id,
    room_id,
    user_id,
    source_message_id,
    command_type,
    command_text,
    ai_response
  ) VALUES (
    @group_id,
    @room_id,
    @user_id,
    @source_message_id,
    @command_type,
    @command_text,
    @ai_response
  )
`);

function sourceFields(event) {
  const source = event.source || {};

  return {
    source_type: source.type || null,
    group_id: source.groupId || null,
    room_id: source.roomId || null,
    user_id: source.userId || null
  };
}

function saveRawEvent(event) {
  const message = event.message || {};
  const rentalCase = ensureCaseForEvent(event);
  const rawJson = JSON.stringify(event);
  insertEvent.run({
    case_id: rentalCase ? rentalCase.case_id : null,
    event_id: event.webhookEventId || message.id || null,
    event_type: event.type || null,
    ...sourceFields(event),
    timestamp: event.timestamp || null,
    raw_json: rawJson,
    raw_json_hash: sha256(Buffer.from(rawJson, 'utf8'))
  });
}

function saveMessage(event, fields) {
  const source = sourceFields(event);
  const message = event.message || {};
  const rentalCase = ensureCaseForEvent(event);
  const textContent = fields.text_content || null;
  const contentHash = fields.content_hash ||
    (textContent ? sha256(Buffer.from(textContent, 'utf8')) : null);

  const result = insertMessage.run({
    case_id: rentalCase ? rentalCase.case_id : null,
    message_id: message.id || null,
    group_id: source.group_id,
    room_id: source.room_id,
    user_id: source.user_id,
    message_type: fields.message_type || message.type || null,
    text_content: textContent,
    file_name: fields.file_name || null,
    file_path: fields.file_path || null,
    file_mime_type: fields.file_mime_type || null,
    file_size: fields.file_size || null,
    content_hash: contentHash,
    line_timestamp: event.timestamp || null
  });

  return result.lastInsertRowid;
}

function recordGroupJoin(groupId) {
  if (!groupId) return;
  ensureCaseForLineThread(groupId);
}

function recordGroupLeave(groupId) {
  if (!groupId) return;
  db.prepare(`
    UPDATE cases
    SET updated_at = CURRENT_TIMESTAMP
    WHERE line_group_id = @groupId
  `).run({ groupId });
}

function savePostback(event) {
  const source = sourceFields(event);
  const data = event.postback && event.postback.data ? event.postback.data : '';
  const params = new URLSearchParams(data);

  insertPostback.run({
    group_id: source.group_id,
    room_id: source.room_id,
    user_id: source.user_id,
    postback_data: data,
    action: params.get('action'),
    case_id: params.get('caseId'),
    draft_id: params.get('draftId'),
    line_timestamp: event.timestamp || null
  });

  return {
    action: params.get('action'),
    caseId: params.get('caseId'),
    draftId: params.get('draftId')
  };
}

function saveBotCommand(event, command) {
  const source = sourceFields(event);
  const message = event.message || {};

  const result = insertBotCommand.run({
    group_id: source.group_id,
    room_id: source.room_id,
    user_id: source.user_id,
    source_message_id: message.id || null,
    command_type: command.commandType,
    command_text: command.commandText,
    ai_response: command.aiResponse
  });

  return result.lastInsertRowid;
}

function updateBotCommandResponse(id, aiResponse) {
  db.prepare(`
    UPDATE bot_commands
    SET ai_response = @ai_response
    WHERE id = @id
  `).run({
    id,
    ai_response: aiResponse
  });
}

const insertRentalListing = db.prepare(`
  INSERT INTO rental_listings (
    message_id, case_id, source_message_id, group_id, room_id, user_id,
    source, url, price, title, address, rooms, type, floor,
    amenities, description
  ) VALUES (
    @message_id, @case_id, @source_message_id, @group_id, @room_id, @user_id,
    @source, @url, @price, @title, @address, @rooms, @type, @floor,
    @amenities, @description
  )
`);

const selectMessageRowByLineId = db.prepare(`
  SELECT id
  FROM messages
  WHERE message_id = @message_id
  ORDER BY id DESC
  LIMIT 1
`);

function saveRentalListing(event, fields) {
  const source = sourceFields(event);
  const message = event.message || {};
  const rentalCase = ensureCaseForEvent(event, {
    title: [fields.title, fields.address].filter(Boolean).join(' - ') || undefined,
    sourceListingUrl: fields.url || undefined
  });
  const sourceMessage = message.id
    ? selectMessageRowByLineId.get({ message_id: message.id })
    : null;

  insertRentalListing.run({
    message_id: message.id || null,
    case_id: rentalCase ? rentalCase.case_id : null,
    source_message_id: sourceMessage ? sourceMessage.id : null,
    group_id: source.group_id,
    room_id: source.room_id,
    user_id: source.user_id,
    source: fields.source || null,
    url: fields.url || null,
    price: fields.price || null,
    title: fields.title || null,
    address: fields.address || null,
    rooms: fields.rooms || null,
    type: fields.type || null,
    floor: fields.floor || null,
    amenities: fields.amenities || null,
    description: fields.description || null
  });
}

module.exports = {
  recordGroupJoin,
  recordGroupLeave,
  saveBotCommand,
  saveMessage,
  savePostback,
  saveRawEvent,
  saveRentalListing,
  updateBotCommandResponse
};
