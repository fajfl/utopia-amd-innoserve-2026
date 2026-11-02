const crypto = require('crypto');
const db = require('../db');

function stableCaseIdForLineThread(lineThreadId) {
  return `case-${crypto.createHash('sha256').update(lineThreadId).digest('hex').slice(0, 12)}`;
}

function ensureCaseForLineThread(lineThreadId, fields = {}) {
  if (!lineThreadId) return null;

  const existing = db.prepare(`
    SELECT
      id,
      case_id,
      line_group_id,
      status,
      title,
      source_listing_url,
      current_condition_snapshot_id,
      current_draft_version_id,
      executed_contract_id,
      closed_at
    FROM cases
    WHERE line_group_id = @lineThreadId
  `).get({ lineThreadId });

  if (existing) return existing;

  db.prepare(`
    INSERT OR IGNORE INTO cases (
      case_id,
      line_group_id,
      status,
      title,
      source_listing_url
    ) VALUES (
      @caseId,
      @lineThreadId,
      'negotiating',
      @title,
      @sourceListingUrl
    )
  `).run({
    caseId: stableCaseIdForLineThread(lineThreadId),
    lineThreadId,
    title: fields.title || 'LINE 租屋協商案件',
    sourceListingUrl: fields.sourceListingUrl || null
  });

  return db.prepare(`
    SELECT
      id,
      case_id,
      line_group_id,
      status,
      title,
      source_listing_url,
      current_condition_snapshot_id,
      current_draft_version_id,
      executed_contract_id,
      closed_at
    FROM cases
    WHERE line_group_id = @lineThreadId
  `).get({ lineThreadId });
}

function lineThreadIdFromSource(source = {}) {
  return source.groupId || source.roomId || null;
}

function ensureCaseForEvent(event, fields = {}) {
  return ensureCaseForLineThread(lineThreadIdFromSource(event.source || {}), fields);
}

module.exports = {
  ensureCaseForEvent,
  ensureCaseForLineThread,
  lineThreadIdFromSource,
  stableCaseIdForLineThread
};
