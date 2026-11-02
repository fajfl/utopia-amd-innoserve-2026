const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRulePack, normalizeTemplateManifest } = require('../../src/services/ecsNeoLegalRuleValidator');

const { canonicalJson } = require('../../src/services/ecsNeoContractAcceptanceServiceAsync');

const checksum = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function readVerifiedBundle(bundlePath) {
  const root = path.dirname(path.resolve(bundlePath));
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  if (bundle.schemaVersion !== 1) throw new Error('Unsupported binding bundle schemaVersion');
  const plan = { formal: true };
  for (const key of ['template', 'rulePack']) {
    const entry = bundle[key];
    if (!entry || typeof entry !== 'object') throw new Error(`${key} metadata is required`);
    for (const field of ['publicId', 'code', 'title', 'authority', 'versionPublicId', 'versionLabel', 'effectiveFrom', 'fixturePath', 'sourcePath', 'sourceUrl', 'sourceChecksum', 'publishedNoticeRef']) {
      requireText(entry[field], `${key}.${field}`);
    }
    const sourceUrl = new URL(entry.sourceUrl);
    if (sourceUrl.protocol !== 'https:' || !sourceUrl.hostname.endsWith('.gov.tw')) throw new Error(`${key}.sourceUrl must be an official HTTPS government source`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.effectiveFrom) || Number.isNaN(Date.parse(entry.effectiveFrom))) throw new Error(`${key}.effectiveFrom must be an ISO date`);
    if (!/^[a-f0-9]{64}$/.test(entry.sourceChecksum)) throw new Error(`${key}.sourceChecksum must be SHA256`);
    const source = fs.readFileSync(path.resolve(root, entry.sourcePath));
    if (checksum(source) !== entry.sourceChecksum) throw new Error(`${key} archived official source checksum mismatch`);
    const data = JSON.parse(fs.readFileSync(path.resolve(root, entry.fixturePath), 'utf8'));
    const json = canonicalJson(data);
    if (['template-residential-113-07-08', 'rules-residential-114-04-18'].includes(entry.versionPublicId) || ['113-07-08', '114-04-18'].includes(entry.versionLabel)) throw new Error('Verified sources need new immutable version identifiers, distinct from demo versions');
    if (data.sourceVerification !== 'official_source_verified') throw new Error(`${key} must declare verified official source provenance`);
    if (data.versionLabel !== entry.versionLabel) throw new Error(`${key} payload versionLabel does not match metadata`);
    requireText(data.sourceVersionLabel, `${key}.sourceVersionLabel`);
    if (data.sourceChecksum !== entry.sourceChecksum) throw new Error(`${key} payload sourceChecksum does not match archived source`);
    requireText(data.fullText, `${key}.fullText`);
    if (key === 'template') {
      if (data.templateCode !== entry.code) throw new Error('template code mismatch');
      normalizeTemplateManifest(data);
      requireText(data.contractText, 'template.contractText');
      if (!Array.isArray(data.options) || !data.options.length) throw new Error('Template source options are required');
      if (data.coverage !== 'complete_source_text') throw new Error('Template must contain complete official source text');
      if (!Array.isArray(data.clauses) || !data.clauses.length || !Array.isArray(data.annexes) || !data.annexes.length) throw new Error('Template clauses and annexes are required');
      for (const clause of data.clauses) {
        requireText(clause.clauseRef, 'clauseRef');
        requireText(clause.clauseTitle, 'clauseTitle');
        requireText(clause.text, 'clause.text');
      }
      for (const annex of data.annexes) {
        requireText(annex.title, 'annex.title');
        requireText(annex.text, 'annex.text');
      }
      const refs = new Set(data.clauses.map((clause) => clause.clauseRef));
      if (refs.size !== data.clauses.length || data.slots.some((slot) => !refs.has(slot.clauseRef))) throw new Error('Template slot references must point to unique complete clauses');
    } else {
      if (data.packCode !== entry.code) throw new Error('rule pack code mismatch');
      normalizeRulePack(data);
      requireText(data.coverage, 'rulePack.coverage');
      requireText(data.coverageNote, 'rulePack.coverageNote');
    }
    plan[key] = { json, checksum: checksum(json), sourceChecksum: entry.sourceChecksum, data, metadata: entry };
  }
  return plan;
}

module.exports = { readVerifiedBundle };
