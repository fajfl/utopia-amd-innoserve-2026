const db = require('../db');

function handlePostbackAction(postback, event) {
  const action = postback && postback.action;
  const resolved = resolvePostbackTarget(postback, event);

  if (action === 'continue_negotiation') {
    if (!resolved.caseId || !resolved.draftId) {
      return '找不到草稿資料，請回群組重新產生草稿。';
    }
    if (isExecutedCase(resolved.caseId)) {
      return '合約已成立，案件已結案；如需變更請另開新協商流程。';
    }
    db.prepare(`
      UPDATE draft_versions
      SET status = 'draft'
      WHERE case_id = @caseId
        AND draft_id = @draftId
    `).run(resolved);
    db.prepare(`
      UPDATE cases
      SET status = 'negotiating',
          updated_at = CURRENT_TIMESTAMP
      WHERE case_id = @caseId
    `).run(resolved);
    return '已回到協調中，請在群組繼續補充或修改條件。';
  }

  if (action === 'decline_sign') {
    return '已暫緩簽署，請在群組繼續協調。';
  }

  if (action === 'confirm_document') {
    if (!resolved.caseId || !resolved.draftId) {
      return '找不到要確認的草稿，請重新開啟草稿卡片。';
    }
    if (isExecutedCase(resolved.caseId)) {
      return '合約已成立，案件已結案。';
    }
    const result = markDraftReadyToSign(resolved);
    return result.changes
      ? '已確認文件，草稿狀態已更新為可簽署。'
      : '找不到要確認的草稿，請重新產生草稿。';
  }

  if (action === 'confirm_draft') {
    if (!resolved.caseId || !resolved.draftId) {
      return '找不到要確認的草稿，請重新開啟草稿卡片。';
    }
    if (isExecutedCase(resolved.caseId)) {
      return '合約已成立，案件已結案。';
    }
    const result = markDraftReadyToSign(resolved);
    return result.changes
      ? '已確認草稿，狀態已更新為可簽署。'
      : '找不到要確認的草稿，請重新產生草稿。';
  }

  return `已收到你的確認：${action || 'unknown'}`;
}

function isExecutedCase(caseId) {
  const row = db.prepare(`
    SELECT executed_contract_id, status
    FROM cases
    WHERE case_id = @caseId
    LIMIT 1
  `).get({ caseId });
  return Boolean(row && (row.executed_contract_id || row.status === 'executed'));
}

function resolvePostbackTarget(postback, event) {
  let caseId = postback && postback.caseId;
  const draftId = postback && postback.draftId;
  const groupId = event && event.source && event.source.groupId;

  if (!caseId && groupId) {
    const row = db.prepare(`
      SELECT case_id
      FROM cases
      WHERE line_group_id = @groupId
      LIMIT 1
    `).get({ groupId });
    caseId = row ? row.case_id : null;
  }

  if (!caseId && draftId) {
    const row = db.prepare(`
      SELECT case_id
      FROM draft_versions
      WHERE draft_id = @draftId
      ORDER BY id DESC
      LIMIT 1
    `).get({ draftId });
    caseId = row ? row.case_id : null;
  }

  return {
    caseId: caseId || null,
    draftId: draftId || null
  };
}

function markDraftReadyToSign({ caseId, draftId }) {
  const result = db.prepare(`
    UPDATE draft_versions
    SET status = 'ready_to_sign'
    WHERE case_id = @caseId
      AND draft_id = @draftId
      AND superseded_at IS NULL
      AND id = (
        SELECT current_draft_version_id
        FROM cases
        WHERE case_id = @caseId
      )
  `).run({ caseId, draftId });

  if (result.changes) {
    db.prepare(`
      UPDATE cases
      SET status = 'ready_to_sign',
          updated_at = CURRENT_TIMESTAMP
      WHERE case_id = @caseId
    `).run({ caseId });
  }

  return result;
}

module.exports = {
  handlePostbackAction,
  markDraftReadyToSign
};
