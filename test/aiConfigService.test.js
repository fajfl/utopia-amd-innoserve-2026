const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEEPSEEK_API_BASE_URL,
  aiRequestOptions,
  DEFAULT_MODEL,
  GEMINI_API_BASE_URL,
  getAiConfig,
  assertAiConfig,
  resolveAiCredentials,
  supportsJsonSchema,
  vertexBaseUrl,
  vertexModelName
} = require('../src/services/aiConfigService');

// 供應商是 Google Gemini,預設走 Vertex AI + GCP OAuth。
// 這個檔案守住三件事:
//   1. 沒設環境變數時不會落回已退役的 NVIDIA / 本地端點
//   2. Vertex 的 URL 與模型前綴這兩個「錯了只會拿到怪錯誤」的細節
//   3. Vertex 不把認證當成靜態設定值(權杖會過期,存進 config 遲早被快取成常數)

const AI_ENV_KEYS = [
  'AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'AI_MAX_TOKENS', 'AI_TIMEOUT_MS',
  'AI_ENABLE_JSON_SCHEMA', 'DEEPSEEK_API_KEY', 'deepseek_api',
  'VERTEX_PROJECT', 'VERTEX_LOCATION',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GCLOUD_PROJECT',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL',
  'NVIDIA_API_KEY', 'NVIDIA_MODEL', 'NVIDIA_BASE_URL',
  'NVIDIA_MAX_TOKENS', 'NVIDIA_TIMEOUT_MS'
];

function withEnv(overrides, run) {
  const saved = new Map(AI_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of AI_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return run();
  } finally {
    for (const key of AI_ENV_KEYS) delete process.env[key];
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

// --- 預設不會走回退役的路 ---

test('沒設任何東西時預設是 Vertex,不是靜態金鑰', () => {
  withEnv({}, () => {
    const config = getAiConfig();
    assert.equal(config.provider, 'vertex');
    assert.equal(config.apiKey, undefined, 'Vertex 不該有靜態金鑰');
    assert.equal(config.model, vertexModelName(DEFAULT_MODEL));
  });
});

test('預設不會落回 NVIDIA 或本地端點', () => {
  withEnv({ VERTEX_PROJECT: 'demo-project' }, () => {
    const { baseURL } = getAiConfig();
    assert.doesNotMatch(baseURL, /integrate\.api\.nvidia\.com/);
    assert.doesNotMatch(baseURL, /localhost|127\.0\.0\.1/);
    assert.match(baseURL, /^https:\/\//);
  });
});

test('舊的 NVIDIA_* 不會把供應商拉回 NVIDIA', () => {
  withEnv({ NVIDIA_API_KEY: 'legacy', VERTEX_PROJECT: 'demo-project' }, () => {
    const config = getAiConfig();
    assert.equal(config.provider, 'vertex');
    assert.doesNotMatch(config.baseURL, /nvidia/i);
  });
});

// --- Vertex 的兩個易錯細節 ---

test('global 的主機名沒有區域前綴,其他區域有', () => {
  // 這個寫錯不會拿到 JSON 錯誤,而是 Google 的 HTML 404 頁面,很難查。
  assert.equal(
    vertexBaseUrl('p1', 'global'),
    'https://aiplatform.googleapis.com/v1/projects/p1/locations/global/endpoints/openapi'
  );
  assert.equal(
    vertexBaseUrl('p1', 'us-central1'),
    'https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/endpoints/openapi'
  );
});

test('Vertex 會自動補 google/ 前綴,已經有前綴就不重複補', () => {
  assert.equal(vertexModelName('gemini-3.7-flash'), 'google/gemini-3.7-flash');
  assert.equal(vertexModelName('google/gemini-3.7-flash'), 'google/gemini-3.7-flash');
  assert.equal(vertexModelName('publishers/anthropic/x'), 'publishers/anthropic/x');
});

test('AI_MODEL 不必寫前綴,baseURL 由 project 與 location 組出來', () => {
  withEnv({ VERTEX_PROJECT: 'proj-x', VERTEX_LOCATION: 'us-central1', AI_MODEL: 'gemini-3.7-flash' }, () => {
    const config = getAiConfig();
    assert.equal(config.model, 'google/gemini-3.7-flash');
    assert.match(config.baseURL, /us-central1-aiplatform\.googleapis\.com/);
    assert.match(config.baseURL, /projects\/proj-x\/locations\/us-central1/);
  });
});

test('GOOGLE_CLOUD_PROJECT 可以取代 VERTEX_PROJECT', () => {
  withEnv({ GOOGLE_CLOUD_PROJECT: 'from-gcloud' }, () => {
    assert.equal(getAiConfig().vertexProject, 'from-gcloud');
  });
});

test('沒有 project 時錯誤訊息要講得出下一步', () => {
  withEnv({}, () => {
    assert.throws(
      () => assertAiConfig(getAiConfig(), 'test purpose'),
      (error) => {
        assert.match(error.message, /VERTEX_PROJECT/);
        assert.match(error.message, /AI_PROVIDER=gemini/, '要告訴使用者還有金鑰這條路');
        assert.doesNotMatch(error.message, /NVIDIA/);
        return true;
      }
    );
  });
});

// --- 切換到靜態金鑰那條路 ---

test('設了 GEMINI_API_KEY 就自動走 Gemini API', () => {
  withEnv({ GEMINI_API_KEY: 'key-abc' }, () => {
    const config = getAiConfig();
    assert.equal(config.provider, 'gemini');
    assert.equal(config.apiKey, 'key-abc');
    assert.equal(config.baseURL, GEMINI_API_BASE_URL);
    assert.equal(config.model, DEFAULT_MODEL, 'Gemini API 不要 google/ 前綴');
  });
});

test('AI_PROVIDER 顯式指定優先於自動判斷', () => {
  withEnv({ AI_PROVIDER: 'vertex', GEMINI_API_KEY: 'key-abc', VERTEX_PROJECT: 'p' }, () => {
    assert.equal(getAiConfig().provider, 'vertex');
  });
});

test('Gemini API 缺金鑰時擋下來', () => {
  withEnv({ AI_PROVIDER: 'gemini' }, () => {
    assert.throws(() => assertAiConfig(getAiConfig(), 'test'), /AI_API_KEY|GEMINI_API_KEY/);
  });
});

test('顯式 AI_BASE_URL 永遠優先,方便指到 proxy 或假伺服器', () => {
  withEnv({ AI_BASE_URL: 'https://proxy.test/v1/', VERTEX_PROJECT: 'p' }, () => {
    assert.equal(getAiConfig().baseURL, 'https://proxy.test/v1', '結尾斜線要去掉');
  });
});

// --- 認證不是設定值 ---

test('Vertex 的認證只能從 resolveAiCredentials 拿,不會出現在 config 裡', () => {
  withEnv({ VERTEX_PROJECT: 'p' }, () => {
    const config = getAiConfig();
    assert.doesNotMatch(JSON.stringify(config), /Bearer/);
    assert.equal(config.apiKey, undefined);
  });
});

test('靜態金鑰那條路不需要連線就能解析出 Authorization', async () => {
  await withEnv({ GEMINI_API_KEY: 'key-abc' }, async () => {
    const credentials = await resolveAiCredentials(getAiConfig());
    assert.equal(credentials.authorization, 'Bearer key-abc');
  });
});

// --- json_schema 支援判斷 ---

test('Vertex 與 Gemini API 端點都認得 json_schema', () => {
  withEnv({}, () => {
    assert.equal(supportsJsonSchema(vertexBaseUrl('p', 'global')), true);
    assert.equal(supportsJsonSchema(vertexBaseUrl('p', 'us-central1')), true);
    assert.equal(supportsJsonSchema(GEMINI_API_BASE_URL), true);
    assert.equal(supportsJsonSchema('http://192.168.0.2:8080/v1'), false);
    assert.equal(supportsJsonSchema(''), false);
  });
});

test('AI_ENABLE_JSON_SCHEMA 可以兩個方向覆寫判斷', () => {
  withEnv({ AI_ENABLE_JSON_SCHEMA: 'true' }, () => {
    assert.equal(supportsJsonSchema('http://192.168.0.2:8080/v1'), true);
  });
  withEnv({ AI_ENABLE_JSON_SCHEMA: 'false' }, () => {
    assert.equal(supportsJsonSchema(GEMINI_API_BASE_URL), false);
  });
});


test('DeepSeek uses Flash and isolated credentials even with legacy Gemini config', () => {
  withEnv({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test', GEMINI_API_KEY: 'wrong-key', GEMINI_MODEL: 'wrong-model' }, () => {
    const config = getAiConfig({ defaultModel: 'wrong-caller-default' });
    assert.equal(config.model, 'deepseek-flash');
    assert.equal(config.apiKey, 'deepseek-test');
    assert.equal(config.baseURL, DEEPSEEK_API_BASE_URL);
    assert.deepEqual(aiRequestOptions(config), { thinking: { type: 'disabled' } });
    assertAiConfig(config, 'test');
  });
  withEnv({ AI_PROVIDER: 'deepseek', GEMINI_API_KEY: 'wrong-key' }, () => {
    assert.throws(() => assertAiConfig(getAiConfig(), 'test'), /DEEPSEEK_API_KEY/);
  });
});

test('DeepSeek legacy key alias selects provider and never enables unsupported JSON schema', () => {
  withEnv({ deepseek_api: 'legacy-local-key', AI_ENABLE_JSON_SCHEMA: 'true' }, () => {
    assert.equal(getAiConfig().provider, 'deepseek');
    assert.equal(getAiConfig().apiKey, 'legacy-local-key');
    assert.equal(supportsJsonSchema(DEEPSEEK_API_BASE_URL), false);
    assert.deepEqual(aiRequestOptions({ provider: 'vertex' }), {});
  });
});


for (const provider of ['vllm', 'llamacpp']) {
  test(`${provider}: explicit self-hosted settings never inherit cloud keys or model`, () => {
    withEnv({ AI_PROVIDER: provider, AI_MODEL: 'ecsneo-model', AI_BASE_URL: 'http://127.0.0.1:8001/v1/', AI_API_KEY: 'local-key', DEEPSEEK_API_KEY: 'wrong-key', GEMINI_MODEL: 'wrong-model' }, () => {
      const config = getAiConfig();
      assertAiConfig(config, 'test');
      assert.equal(config.model, 'ecsneo-model');
      assert.equal(config.baseURL, 'http://127.0.0.1:8001/v1');
      assert.equal(config.apiKey, 'local-key');
      assert.deepEqual(aiRequestOptions(config), {});
    });
    withEnv({ AI_PROVIDER: provider, DEEPSEEK_API_KEY: 'wrong-key', GEMINI_API_KEY: 'wrong-key' }, () => {
      assert.throws(() => assertAiConfig(getAiConfig(), 'test'), /AI_MODEL/);
      process.env.AI_MODEL = 'ecsneo-model';
      assert.throws(() => assertAiConfig(getAiConfig(), 'test'), /AI_API_KEY/);
      process.env.AI_API_KEY = 'local-key';
      assert.throws(() => assertAiConfig(getAiConfig(), 'test'), /AI_BASE_URL/);
    });
  });
}
