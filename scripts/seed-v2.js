const fs = require('node:fs');
const path = require('node:path');
const {
  openV2Database,
  applyMigrations
} = require('../src/database/migrationRunner');
const {
  applyDemoSeed
} = require('../src/database/demoSeed');

function readDbPath(argv) {
  const index = argv.indexOf('--db');
  if (index === -1) return path.join(__dirname, '..', 'data', 'ecs-neo-v2.sqlite');
  if (!argv[index + 1]) throw new Error('--db requires a file path');
  return path.resolve(argv[index + 1]);
}

function viewCounts(db) {
  const names = [
    'vw_landlord_portfolio_summary',
    'vw_listing_funnel',
    'vw_monthly_collection',
    'vw_repair_performance',
    'vw_ai_knowledge_coverage',
    'vw_contract_attention'
  ];
  return Object.fromEntries(names.map((name) => [
    name,
    db.prepare(`SELECT COUNT(*) count FROM ${name}`).get().count
  ]));
}

function run(argv) {
  const root = path.join(__dirname, '..');
  const dbPath = readDbPath(argv);
  const fixturePath = path.join(
    root,
    'database',
    'seeds',
    'fixtures',
    'synthetic-listings.json'
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const db = openV2Database(dbPath);
  try {
    const migrations = applyMigrations(db, path.join(root, 'database', 'migrations'));
    const seed = applyDemoSeed(db, fixture);
    // Migration 027 seeds defaults for an already-existing Room 1. A brand-new
    // demo database receives its rental units after migrations, so replay its
    // idempotent SQL once after the fixture is present.
    db.exec(fs.readFileSync(
      path.join(root, 'database', 'migrations', '027_rental_unit_repair_rule_defaults.sql'),
      'utf8'
    ));
    const foreignKeyErrors = db.pragma('foreign_key_check');
    if (foreignKeyErrors.length) {
      throw new Error(`foreign key check failed with ${foreignKeyErrors.length} error(s)`);
    }
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
    const summary = {
      dbPath,
      fixturePath,
      migrations,
      seed,
      unitRepairDefaults: db.prepare(`
        SELECT COUNT(*) count
        FROM rental_unit_repair_rule_defaults d
        JOIN rental_units ru ON ru.id = d.rental_unit_id
        WHERE ru.public_id = 'demo-591-unit-90000001'
      `).get().count,
      quality: db.prepare(`
        SELECT parse_status, COUNT(*) count
        FROM listing_snapshots
        WHERE public_id LIKE 'demo-591-snapshot-%'
        GROUP BY parse_status
        ORDER BY parse_status
      `).all(),
      foreignKeyErrors: 0,
      integrity,
      views: viewCounts(db)
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  run(process.argv.slice(2));
}

module.exports = { run };
