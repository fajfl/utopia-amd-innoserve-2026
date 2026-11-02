const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectFile } = require('../scripts/check-public-release');

test('public check rejects private files and detects credential-shaped content', () => {
  for (const name of ['.env', 'deploy/amd/.env.backup', 'data/demo.sqlite', 'uploads/photo.jpg', 'private.key', 'proposal.docx']) {
    assert.ok(inspectFile(name).includes('private-file'), name);
  }
  assert.ok(inspectFile('src/config.js', 'gh' + 'p_' + 'z'.repeat(36)).includes('github-token'));
  assert.ok(inspectFile('src/config.js', 'sk-' + 'z'.repeat(30)).includes('api-token'));
  assert.ok(inspectFile('src/config.js', 'U' + 'b'.repeat(32)).includes('line-identity'));
  assert.ok(inspectFile('README.md', 'https://demo.' + 'ngrok-free.dev').includes('personal-tunnel'));
});

test('public check permits empty templates, skeleton folders and synthetic URLs', () => {
  for (const name of ['.env.example', 'deploy/amd/.env.example', 'data/.gitkeep', 'uploads/pre-inspections/.gitkeep']) {
    assert.deepEqual(inspectFile(name), []);
  }
  assert.deepEqual(inspectFile('demo.json', 'https://images.example.test/90000001/photo-1.jpg'), []);
});
