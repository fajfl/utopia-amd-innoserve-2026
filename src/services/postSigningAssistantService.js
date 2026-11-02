const crypto = require('node:crypto');
const repository = require('../repositories/v2ContractRepositoryAsync');
const { readStoredFile } = require('./fileStorage');

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

async function requireParty(db, { lineUserId, contractPublicId, role }) {
  if (!lineUserId) fail('請先登入', 401);
  if (!['tenant', 'landlord'].includes(role)) fail('請選擇本次身分', 400);
  const activeRole = require('./testRoleService').getActiveRole(lineUserId);
  if (activeRole && activeRole !== role) fail('測試角色已切換，請重新整理後操作', 409);
  const party = await db.get(`SELECT c.id AS contract_id, c.status, cp.user_id, cp.party_role
    FROM contracts c JOIN contract_parties cp ON cp.contract_id=c.id AND cp.status='active'
    JOIN line_identities li ON li.user_id=cp.user_id
    WHERE c.public_id=? AND li.line_user_id=? AND cp.party_role=?`, [contractPublicId, lineUserId, role]);
  if (!party) fail('沒有這份合約的當事人權限', 403);
  return party;
}

async function getSignedDocument(db, contractId) {
  const version = await repository.getSignedVersion(db, contractId);
  if (!version) fail('無法確認雙方已簽文件，請聯絡人工協助', 409);
  let bytes;
  try { bytes = await readStoredFile(version); } catch { fail('已簽文件無法讀取，請聯絡人工協助', 409); }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== version.document_hash || hash !== version.sha256_hash) fail('已簽文件完整性驗證失敗', 409);
  return { version, bytes };
}

function unescapeHtml(text) {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);
}

function documentSections(bytes) {
  const html = bytes.toString('utf8');
  return [...html.matchAll(/<section(?:\s[^>]*)?>([\s\S]*?)<\/section>/gi)].map((match, index) => {
    const heading = (match[1].match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || '';
    const title = unescapeHtml(heading.replace(/<[^>]*>/g, '')).trim();
    if (!title || /^(立契約書人|簽署|租賃標的|現行應記載)/.test(title)) return null;
    if (title.startsWith('附件一')) {
      const notes = [...match[1].matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi)]
        .map((item) => unescapeHtml(item[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean);
      return notes.length ? { locator: `原文件第 ${index + 1} 節：${title}`, text: notes.join(' ') } : null;
    }
    const text = unescapeHtml(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    return text ? { locator: `原文件第 ${index + 1} 節：${title}`, text } : null;
  }).filter(Boolean);
}

function validateAnswer(raw, sections) {
  if (!raw || typeof raw.answer !== 'string' || !raw.answer.trim() || raw.answer.length > 2000 || !Array.isArray(raw.citations) || raw.citations.length > 8) fail('AI 回覆格式不正確，請稍後重試', 502);
  const citations = raw.citations.map((citation) => {
    const section = sections.find((item) => item.locator === citation?.locator);
    if (!section || typeof citation.quote !== 'string' || citation.quote.trim().length < 4 || !section.text.includes(citation.quote)) fail('AI 引用無法在已簽文件中確認，請稍後重試', 502);
    return { locator: section.locator, quote: citation.quote };
  });
  if (!citations.length) return { answer: '合約裡沒有寫到這件事，建議直接問房東。', citations: [] };
  return { answer: raw.answer.trim(), citations };
}

async function ask({ db, lineUserId, contractPublicId, role, question, invokeModel = callModel }) {
  if (typeof question !== 'string' || !question.trim() || question.length > 1000) fail('請輸入 1000 字以內的問題', 400);
  const party = await requireParty(db, { lineUserId, contractPublicId, role });
  const { version, bytes } = await getSignedDocument(db, party.contract_id);
  const sections = documentSections(bytes);
  if (!sections.length) fail('已簽文件無法定位條款，請聯絡人工協助', 409);
  let raw;
  try { raw = await invokeModel({ question: question.trim(), sections }); }
  catch { fail('AI 暫時無法使用，請稍後重試或尋求人工協助', 503); }
  return { versionNumber: version.version_number, documentHash: version.document_hash, ...validateAnswer(raw, sections) };
}

async function callModel(payload) {
  const secret = String(process.env.AGENT_RUNTIME_SHARED_SECRET || '');
  if (!secret || String(process.env.ECS_NEO_AGENT_ENABLED).toLowerCase() !== 'true' || String(process.env.PUBLIC_DEMO_MODE).toLowerCase() === 'true' || String(process.env.V2_CONTRACT_DEMO_PUBLIC).toLowerCase() === 'true') throw new Error('agent unavailable');
  const base = String(process.env.AGENT_RUNTIME_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const response = await fetch(`${base}/v1/post-signing:ask`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('agent unavailable');
  return response.json();
}

module.exports = { requireParty, getSignedDocument, documentSections, validateAnswer, ask, callModel };
