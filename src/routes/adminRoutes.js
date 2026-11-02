const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/groups', (req, res) => {
  const rows = db.prepare(`
    SELECT
      line_group_id AS group_id,
      title AS group_name,
      created_at AS joined_at,
      NULL AS left_at,
      status,
      created_at
    FROM cases
    ORDER BY created_at DESC
  `).all();

  res.json(rows);
});

router.get('/cases', (req, res) => {
  const rows = db.prepare(`
    SELECT
      case_id,
      line_group_id,
      status,
      title,
      source_listing_url,
      current_condition_snapshot_id,
      current_draft_version_id,
      executed_contract_id,
      created_at,
      updated_at,
      closed_at
    FROM cases
    ORDER BY id DESC
    LIMIT 200
  `).all();

  res.json(rows);
});

router.get('/cases/:caseId/drafts', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      case_id,
      draft_id,
      version_number,
      condition_snapshot_id,
      contract_hash,
      status,
      created_at,
      superseded_at
    FROM draft_versions
    WHERE case_id = @caseId
    ORDER BY version_number ASC, id ASC
  `).all({ caseId: req.params.caseId });

  res.json(rows);
});

router.get('/cases/:caseId/condition-sources', (req, res) => {
  const rows = db.prepare(`
    SELECT
      css.condition_snapshot_id,
      css.message_id AS message_row_id,
      m.message_id AS line_message_id,
      css.field_path,
      m.text_content,
      css.created_at
    FROM condition_snapshot_sources css
    JOIN condition_snapshots cs ON cs.id = css.condition_snapshot_id
    JOIN messages m ON m.id = css.message_id
    WHERE cs.case_id = @caseId
    ORDER BY css.condition_snapshot_id ASC, m.line_timestamp ASC, css.field_path ASC
  `).all({ caseId: req.params.caseId });

  res.json(rows);
});

router.get('/cases/:caseId/signatures', (req, res) => {
  const rows = db.prepare(`
    SELECT
      sr.id,
      sr.case_id,
      sr.executed_contract_id,
      sr.draft_version_id,
      sr.case_participant_id,
      cp.role,
      cp.line_user_id,
      cp.display_name_snapshot,
      sr.signature_hash,
      sr.signed_at,
      sr.created_at
    FROM signature_records sr
    JOIN case_participants cp ON cp.id = sr.case_participant_id
    WHERE sr.case_id = @caseId
    ORDER BY sr.signed_at ASC, sr.id ASC
  `).all({ caseId: req.params.caseId });

  res.json(rows);
});

router.get('/cases/:caseId/calendar-events', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      case_id,
      executed_contract_id,
      event_type,
      title,
      description,
      starts_at,
      ends_at,
      timezone,
      status,
      recurrence_rule,
      created_at,
      updated_at,
      cancelled_at
    FROM calendar_events
    WHERE case_id = @caseId
    ORDER BY starts_at ASC, id ASC
  `).all({ caseId: req.params.caseId });

  res.json(rows);
});

router.get('/cases/:caseId/files', (req, res) => {
  const rows = db.prepare(`
    SELECT
      f.id,
      f.case_id,
      f.category,
      f.original_file_name,
      f.mime_type,
      f.size_bytes,
      f.sha256_hash,
      f.storage_key,
      f.storage_provider,
      f.status,
      f.created_at,
      f.deleted_at,
      f.purged_at,
      mf.message_id AS message_row_id,
      m.message_id AS line_message_id
    FROM files f
    LEFT JOIN message_files mf ON mf.file_id = f.id
    LEFT JOIN messages m ON m.id = mf.message_id
    WHERE f.case_id = @caseId
    ORDER BY f.created_at ASC, f.id ASC
  `).all({ caseId: req.params.caseId });

  res.json(rows);
});

router.get('/groups/:groupId/messages', (req, res) => {
  const rows = db.prepare(`
    SELECT
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
      line_timestamp,
      created_at
    FROM messages
    WHERE group_id = @groupId
    ORDER BY line_timestamp ASC, id ASC
  `).all({ groupId: req.params.groupId });

  res.json(rows);
});

router.get('/groups/:groupId/files', (req, res) => {
  const rows = db.prepare(`
    SELECT
      m.message_id,
      m.group_id,
      m.user_id,
      m.message_type,
      f.original_file_name AS file_name,
      f.storage_key AS file_path,
      f.mime_type AS file_mime_type,
      f.size_bytes AS file_size,
      f.sha256_hash AS content_hash,
      m.line_timestamp,
      f.created_at
    FROM files f
    JOIN cases c ON c.case_id = f.case_id
    LEFT JOIN message_files mf ON mf.file_id = f.id
    LEFT JOIN messages m ON m.id = mf.message_id
    WHERE c.line_group_id = @groupId
      AND f.category = 'message_attachment'
    ORDER BY m.line_timestamp ASC, f.id ASC
  `).all({ groupId: req.params.groupId });

  res.json(rows);
});

router.get('/groups/:groupId/postbacks', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      group_id,
      room_id,
      user_id,
      postback_data,
      action,
      case_id,
      draft_id,
      line_timestamp,
      created_at
    FROM postbacks
    WHERE group_id = @groupId
    ORDER BY line_timestamp ASC, id ASC
  `).all({ groupId: req.params.groupId });

  res.json(rows);
});

router.get('/groups/:groupId/bot-commands', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      group_id,
      room_id,
      user_id,
      source_message_id,
      command_type,
      command_text,
      ai_response,
      created_at
    FROM bot_commands
    WHERE group_id = @groupId
    ORDER BY id ASC
  `).all({ groupId: req.params.groupId });

  res.json(rows);
});

router.get('/groups/:groupId/negotiation-summaries', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      group_id,
      requested_by_user_id,
      source_message_ids_json,
      summary_json,
      human_readable_summary,
      model_name,
      created_at
    FROM negotiation_summaries
    WHERE group_id = @groupId
    ORDER BY id DESC
  `).all({ groupId: req.params.groupId });

  res.json(rows);
});

router.get('/sign-confirmations', (req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      case_id,
      draft_id,
      NULL AS user_agent,
      NULL AS ip_address,
      created_at
    FROM draft_versions
    WHERE status = 'ready_to_sign'
    ORDER BY id DESC
    LIMIT 100
  `).all();

  res.json(rows);
});

router.get('/video-signatures', (req, res) => {
  const rows = db.prepare(`
    SELECT
      sr.id,
      sr.case_id,
      dv.draft_id,
      cp.line_user_id,
      cp.display_name_snapshot AS signer_name,
      image_file.storage_key AS signature_image_path,
      stroke_file.storage_key AS stroke_data_path,
      video_file.storage_key AS video_path,
      video_file.mime_type AS video_mime_type,
      sr.user_agent,
      sr.ip_address,
      sr.created_at
    FROM signature_records sr
    JOIN draft_versions dv ON dv.id = sr.draft_version_id
    JOIN case_participants cp ON cp.id = sr.case_participant_id
    LEFT JOIN files image_file ON image_file.id = sr.signature_image_file_id
    LEFT JOIN files stroke_file ON stroke_file.id = sr.signature_strokes_file_id
    LEFT JOIN files video_file ON video_file.id = sr.signature_video_file_id
    ORDER BY sr.id DESC
    LIMIT 100
  `).all();

  res.json(rows);
});

router.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare(`
    SELECT
      id,
      event_id,
      event_type,
      source_type,
      group_id,
      room_id,
      user_id,
      timestamp,
      raw_json,
      created_at
    FROM line_events
    ORDER BY id DESC
    LIMIT @limit
  `).all({ limit });

  res.json(rows);
});

module.exports = router;
