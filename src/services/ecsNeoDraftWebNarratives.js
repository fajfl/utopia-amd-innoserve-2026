const { escapeHtml, conditionFieldLabel } = require('./v2ContractDocumentService');

async function draftWebNarratives(db, versionId) {
  const draft = await db.get(`SELECT responsibility_matrix_json FROM prepared_contract_drafts
    WHERE materialized_contract_version_id=? ORDER BY id DESC LIMIT 1`, [versionId]);
  if (!draft) return '';
  const rows = JSON.parse(draft.responsibility_matrix_json);
  const narratives = rows.filter((row) => typeof row.modelNarrative === 'string' && row.modelNarrative.trim());
  if (!narratives.length) return '<section class="card"><h2>AI 白話說明</h2><p>這一版暫無 AI 說明，請直接閱讀下方契約內容。</p></section>';
  return '<section class="card draft-narratives"><h2>AI 白話說明</h2><p class="muted">僅協助閱讀，不是雙方約定的條款；請以本版契約內容為準。</p><dl>'
    + narratives.map((row) => `<dt>${escapeHtml(conditionFieldLabel(row.clauseField))}</dt><dd style="white-space:pre-wrap">${escapeHtml(row.modelNarrative)}</dd>`).join('')
    + '</dl></section>';
}

module.exports = { draftWebNarratives };
