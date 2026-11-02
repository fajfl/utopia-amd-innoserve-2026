// Default: offline dry-run. --bundle <reviewed JSON> selects archived official sources.
// --apply --approved-by-user-id <id> imports DRAFT versions only; activation is separate.
// Partial demo previews require --demo-fixtures and also stay non-active.
// Without --db, V2_DB_DRIVER selects the configured SQLite/TiDB connection.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson } = require('../src/services/ecsNeoContractAcceptanceServiceAsync');
const { readVerifiedBundle } = require('./lib/verifiedBindingBundle');
const { normalizeRulePack, normalizeTemplateManifest } = require('../src/services/ecsNeoLegalRuleValidator');
const FIXTURE_DIR = path.join(__dirname, '..', 'database', 'seeds', 'fixtures');
const TEMPLATE_FILE = 'ecs-neo-contract-template-tw-residential-113-07-08.json';
const DEFAULT_REVIEWED_BUNDLE = path.join(FIXTURE_DIR, 'ecs-neo-reviewed-residential-bindings-2026-10-27.json');
const RULE_PACK_FILE = 'ecs-neo-legal-rule-pack-tw-residential-114-04-18.json';

const TEMPLATE = {
  publicId: 'template-residential',
  code: 'tw-residential',
  title: '住宅租賃契約書',
  authority: '內政部',
  versionPublicId: 'template-residential-113-07-08',
  versionLabel: '113-07-08',
  effectiveFrom: '2024-07-08'
};
const RULE_PACK = {
  publicId: 'rules-residential',
  code: 'tw-residential-mandatory',
  title: '住宅租賃應記載及不得記載事項',
  authority: '行政院',
  versionPublicId: 'rules-residential-114-04-18',
  versionLabel: '114-04-18',
  effectiveFrom: '2025-04-18'
};

function readFixture(name) {
  const bytes = fs.readFileSync(path.join(FIXTURE_DIR, name));
  const data = JSON.parse(bytes.toString('utf8'));
  const json = canonicalJson(data);
  return { json, checksum: crypto.createHash('sha256').update(json, 'utf8').digest('hex'), sourceChecksum: crypto.createHash('sha256').update(json, 'utf8').digest('hex'), data };
}

function bindingPlan({ bundlePath, demoFixtures = false } = {}) {
  if (bundlePath || !demoFixtures) return readVerifiedBundle(bundlePath || DEFAULT_REVIEWED_BUNDLE);
  const template = readFixture(TEMPLATE_FILE);
  const rulePack = readFixture(RULE_PACK_FILE);
  normalizeTemplateManifest(template.data);
  normalizeRulePack(rulePack.data);
  return { template, rulePack };
}

async function seedBindings(db, { demoFixtures = false, approvedByUserId, bundlePath, activate = false } = {}) {
  if (bundlePath && demoFixtures) throw new Error('Choose verified bundle or demo fixtures, not both');
  if (!bundlePath && !demoFixtures) throw new Error('Current fixtures are partial and unverified; explicit --demo-fixtures is required');
  if (!/^[1-9][0-9]*$/.test(String(approvedByUserId || ''))) throw new Error('--approved-by-user-id requires an explicit positive user id');
  if (activate && !bundlePath) throw new Error('Only a verified bundle can be activated');
  const plan = bindingPlan({ bundlePath, demoFixtures });
  const targetStatus = activate ? 'active' : 'draft';
  return db.transaction(async (tx) => {
    const approver = await tx.get("SELECT id FROM users WHERE id=? AND status='active'", [approvedByUserId]);
    if (!approver) throw new Error('The selected approver is not an active user');
    const result = {};
    for (const entry of [
      { metadata: plan.template.metadata || TEMPLATE, fixture: plan.template, parent: 'contract_templates', code: 'template_code', versions: 'contract_template_versions', foreignKey: 'contract_template_id', json: 'manifest_json', checksum: 'manifest_checksum', key: 'templateVersion' },
      { metadata: plan.rulePack.metadata || RULE_PACK, fixture: plan.rulePack, parent: 'legal_rule_packs', code: 'pack_code', versions: 'legal_rule_pack_versions', foreignKey: 'legal_rule_pack_id', json: 'rules_json', checksum: 'rules_checksum', key: 'rulePackVersion' }
    ]) {
      const m = entry.metadata;
      await tx.run(`${tx.dialect.insertIgnore} INTO ${entry.parent} (public_id, ${entry.code}, title, issuing_authority) VALUES (?, ?, ?, ?)`, [m.publicId, m.code, m.title, m.authority]);
      const parent = await tx.get(`SELECT id, ${entry.code} AS code, status FROM ${entry.parent} WHERE public_id=?`, [m.publicId]);
      if (!parent || parent.code !== m.code || parent.status !== 'active') throw new Error(`Conflicting or inactive binding parent: ${m.publicId}`);
      const existing = await tx.get(`SELECT * FROM ${entry.versions} WHERE public_id=? OR (${entry.foreignKey}=? AND version_label=?)`, [m.versionPublicId, parent.id, m.versionLabel]);
      if (existing) {
        if (existing.public_id !== m.versionPublicId || String(existing[entry.foreignKey]) !== String(parent.id)
            || existing.version_label !== m.versionLabel || existing.effective_from !== m.effectiveFrom
            || existing.source_checksum !== entry.fixture.sourceChecksum || existing[entry.checksum] !== entry.fixture.checksum
            || canonicalJson(JSON.parse(existing[entry.json])) !== entry.fixture.json) throw new Error(`Immutable binding conflict: ${m.versionPublicId}; create a new version instead`);
        if (activate && existing.status === 'draft') {
          await tx.run(`UPDATE ${entry.versions} SET status='active', approved_by_user_id=?, approved_at=${tx.dialect.utcNow()} WHERE id=? AND status='draft'`, [approver.id, existing.id]);
          result[entry.key] = { action: 'activated', status: 'active' };
        } else {
          if (activate && existing.status !== 'active') throw new Error(`Cannot reactivate ${existing.status} version: ${m.versionPublicId}`);
          result[entry.key] = { action: 'skipped', status: existing.status };
        }
        continue;
      }
      await tx.run(`INSERT INTO ${entry.versions}
        (public_id, ${entry.foreignKey}, version_label, source_checksum, effective_from, source_url, published_notice_ref,
         ${entry.json}, ${entry.checksum}, status, approved_by_user_id, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${tx.dialect.utcNow()})`,
      [m.versionPublicId, parent.id, m.versionLabel, entry.fixture.sourceChecksum, m.effectiveFrom, m.sourceUrl || null, m.publishedNoticeRef || null, entry.fixture.json, entry.fixture.checksum, targetStatus, approver.id]);
      result[entry.key] = { action: 'inserted', status: targetStatus };
    }
    return result;
  });
}

function parseArgs(argv) {
  const options = { apply: false, demoFixtures: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--activate') options.activate = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--demo-fixtures') options.demoFixtures = true;
    else if (arg === '--db' || arg === '--approved-by-user-id' || arg === '--bundle') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg === '--db' ? 'dbPath' : arg === '--bundle' ? 'bundlePath' : 'approvedByUserId'] = argv[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.activate && (!options.bundlePath || !options.apply)) throw new Error('--activate requires --bundle and --apply; demo fixtures cannot be activated');
  if (options.bundlePath && options.demoFixtures) throw new Error('Choose --bundle or --demo-fixtures, not both');
  if (options.apply && options.dryRun) throw new Error('--apply and --dry-run cannot be combined');
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const plan = bindingPlan(options);
  if (!options.apply) {
    console.log(JSON.stringify({ dryRun: true, databaseContacted: false,
      warning: plan.formal ? 'Verified archived sources; imports remain draft and require a separate reviewed activation. Rule coverage is declared below.' : 'Partial unverified demo fixtures only; imports remain non-active draft previews',
      importStatus: 'draft',
      bindings: [
        { publicId: (plan.template.metadata || TEMPLATE).versionPublicId, checksum: plan.template.checksum, sourceChecksum: plan.template.sourceChecksum, sourceVerification: plan.template.data.sourceVerification, coverage: plan.template.data.coverage || plan.template.data.slotCoverage, clauseCount: plan.template.data.clauses?.length || 0, annexCount: plan.template.data.annexes?.length || 0 },
        { publicId: (plan.rulePack.metadata || RULE_PACK).versionPublicId, checksum: plan.rulePack.checksum, sourceChecksum: plan.rulePack.sourceChecksum, sourceVerification: plan.rulePack.data.sourceVerification, coverage: plan.rulePack.data.coverage }
      ] }));
    return;
  }
  // Reject missing approvals before loading .env or opening a connection.
  if ((!options.demoFixtures && !options.bundlePath) || !/^[1-9][0-9]*$/.test(String(options.approvedByUserId || ''))) throw new Error('--apply requires --bundle <reviewed bundle> or --demo-fixtures, and --approved-by-user-id <id>; imports stay draft');
  require('dotenv').config({ quiet: true });
  if (options.dbPath || String(process.env.V2_DB_DRIVER || 'sqlite').trim().toLowerCase() === 'sqlite') {
    const Database = require('better-sqlite3');
    const { sqliteDriver } = require('../src/database/sqlDriver');
    const dbPath = path.resolve(options.dbPath || process.env.V2_DATABASE_PATH || path.join(__dirname, '..', 'data', 'ecs-neo-v2.sqlite'));
    const raw = new Database(dbPath, { fileMustExist: true });
    try {
      raw.pragma('foreign_keys = ON');
      console.log(JSON.stringify(await seedBindings(sqliteDriver(raw), options)));
    } finally { raw.close(); }
  } else {
    if (String(process.env.V2_DB_DRIVER).trim().toLowerCase() !== 'mysql') throw new Error('V2_DB_DRIVER must be sqlite or mysql');
    const { withV2Driver } = require('../src/database/v2Driver');
    const { closeV2Pool } = require('../src/database/tidbPool');
    try { console.log(JSON.stringify(await withV2Driver((db) => seedBindings(db, options)))); }
    finally { await closeV2Pool(); }
  }
}

module.exports = { DEFAULT_REVIEWED_BUNDLE, bindingPlan, main, parseArgs, seedBindings };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
