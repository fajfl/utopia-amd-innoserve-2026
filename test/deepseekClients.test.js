const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { createDraftNarrativeClient } = require('../src/services/ecsNeoDraftNarrativeClient');
const { extractConditionJson } = require('../src/services/conditionExtractionService');

test('DeepSeek HTTP clients send Flash, JSON object and disabled thinking, including repair', async (t) => {
  const keys = ['AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'DEEPSEEK_API_KEY', 'AI_ENABLE_JSON_SCHEMA'];
  const saved = keys.map(key => [key, process.env[key]]);
  Object.assign(process.env, { AI_PROVIDER: 'deepseek', AI_MODEL: 'deepseek-flash', AI_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_API_KEY: 'test-only', AI_ENABLE_JSON_SCHEMA: 'true' });
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const requests = [];
  t.mock.method(axios, 'post', async (url, payload, options) => {
    requests.push(payload);
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(payload.model, 'deepseek-flash');
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    return { data: { model: 'deepseek-flash', choices: [{ message: { content: requests.length === 1 ? '{"clauseNarratives":{},"suspectedConflicts":[]}' : '{broken' } }] } };
  });
  const result = await createDraftNarrativeClient().generateDraftNarrative({ clauseSnapshot: {} });
  assert.equal(result.modelId, 'deepseek-flash');
  // Invalid JSON must still fail validation, then repair with the same provider settings.
  await assert.rejects(extractConditionJson({}));
  assert.equal(requests.length, 3);
});

for (const provider of ['vllm', 'llamacpp']) {
  test(`${provider}: HTTP clients use explicit endpoint and key, including JSON repair`, async (t) => {
    const keys = ['AI_PROVIDER', 'AI_MODEL', 'AI_BASE_URL', 'AI_API_KEY', 'AI_ENABLE_JSON_SCHEMA', 'DEEPSEEK_API_KEY'];
    const saved = keys.map(key => [key, process.env[key]]);
    Object.assign(process.env, { AI_PROVIDER: provider, AI_MODEL: 'ecsneo-model', AI_BASE_URL: 'http://127.0.0.1:8001/v1/', AI_API_KEY: 'local-key', AI_ENABLE_JSON_SCHEMA: 'false', DEEPSEEK_API_KEY: 'wrong-key' });
    t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const requests = [];
    t.mock.method(axios, 'post', async (url, payload, options) => {
      requests.push(payload);
      assert.equal(url, 'http://127.0.0.1:8001/v1/chat/completions');
      assert.equal(payload.model, 'ecsneo-model');
      assert.equal(Object.hasOwn(payload, 'thinking'), false);
      assert.deepEqual(payload.response_format, { type: 'json_object' });
      assert.equal(options.headers.Authorization, 'Bearer local-key');
      return { data: { model: 'ecsneo-model', choices: [{ message: { content: requests.length === 1 ? '{"clauseNarratives":{},"suspectedConflicts":[]}' : '{broken' } }] } };
    });
    const result = await createDraftNarrativeClient().generateDraftNarrative({ clauseSnapshot: {} });
    assert.equal(result.modelId, 'ecsneo-model');
    await assert.rejects(extractConditionJson({}));
    assert.equal(requests.length, 3);
  });
}
