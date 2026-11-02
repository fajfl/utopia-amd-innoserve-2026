const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/isolateDatabase');
process.env.NODE_ENV = 'production';
process.env.LINE_CHANNEL_SECRET = 'synthetic-test-secret';
process.env.V2_DB_DRIVER = 'sqlite';
const { signSession, liffBootstrap, resolveIdentity } = require('../src/services/liffSessionService');
const app = require('../src/app');

test('profile and retired admin reject anonymous access; bootstrap cannot inject script', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/profile?lineUserId=other`)).status, 401);
  assert.equal((await fetch(`${base}/groups/test/messages`)).status, 404);
  const html = await (await fetch(`${base}/?liff.state=${encodeURIComponent('/v2/</script><script>bad()</script>')}&code=x&state=y`)).text();
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.doesNotMatch(liffBootstrap('</script><script>bad()</script>'), /<script>bad\(\)<\/script>/);
  assert.equal(resolveIdentity({ query: { lineUserId: 'other' }, get: () => '' }).lineUserId, '');
  const cookie = `v2_liff_session=${signSession('actual')}`;
  const response = await fetch(`${base}/api/profile?lineUserId=other`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).profile.lineUserId, 'actual');
});

test('development identity fallback is disabled unless explicitly enabled in tests', () => {
  const previousMode = process.env.NODE_ENV;
  const previousFlag = process.env.ALLOW_TEST_LINE_IDENTITY;
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_TEST_LINE_IDENTITY;
    assert.equal(resolveIdentity({ query: { lineUserId: 'fake' }, get: () => '' }).lineUserId, '');
    process.env.ALLOW_TEST_LINE_IDENTITY = 'true';
    assert.equal(resolveIdentity({ query: { lineUserId: 'fake' }, get: () => '' }).lineUserId, '');
  } finally {
    process.env.NODE_ENV = previousMode;
    if (previousFlag === undefined) delete process.env.ALLOW_TEST_LINE_IDENTITY;
    else process.env.ALLOW_TEST_LINE_IDENTITY = previousFlag;
  }
});
