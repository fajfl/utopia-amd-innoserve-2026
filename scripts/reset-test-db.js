// Public demo: create an empty test database; never copy a production database.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const target = path.join(__dirname, '..', 'data', 'ecs-neo-v2.test.sqlite');
const result = spawnSync(process.execPath, [path.join(__dirname, 'migrate-v2.js'), '--db', target], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
