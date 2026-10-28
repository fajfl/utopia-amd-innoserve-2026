// 全專案的 OpenAI 相容 LLM 設定；DeepSeek 不共用 Google 憑證。
const { getGoogleAccessToken } = require('./googleAuthTokenService');

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-flash';
const DEFAULT_MODEL = 'gemini-3.7-flash';
const DEFAULT_VERTEX_LOCATION = 'global';
const DEFAULT_TIMEOUT_MS = 180000;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function numberFromEnv(primaryName, legacyName, fallback) {
  const value = process.env[primaryName] || process.env[legacyName];
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  return undefined;
}

// global 這個 location 的主機名沒有前綴,其他區域才有。寫錯會拿到一個 Google 的
// HTML 404 頁面而不是 JSON 錯誤,很難看出原因,所以在這裡一次處理掉。
function vertexBaseUrl(project, location) {
  const host = location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

// Vertex 的模型名要帶 publisher 前綴(google/gemini-3.7-flash);Gemini API 則不要。
// 讓兩邊的 AI_MODEL 可以寫成同一個值,前綴由這裡補。
function vertexModelName(model) {
  return /\//.test(model) ? model : `google/${model}`;
}

function resolveProvider() {
  const explicit = firstEnv('AI_PROVIDER');
  if (explicit) return explicit.toLowerCase();
  // 優先採用已設定的供應商金鑰；舊環境未指定時仍沿用 Vertex。
  if (firstEnv('DEEPSEEK_API_KEY', 'deepseek_api')) return 'deepseek';
  if (firstEnv('GEMINI_API_KEY')) return 'gemini';
  if (firstEnv('AI_BASE_URL')) return 'custom';
  return 'vertex';
}

function getAiConfig({ defaultModel, defaultMaxTokens, defaultTimeoutMs } = {}) {
  const provider = resolveProvider();
  const selfHosted = provider === 'vllm' || provider === 'llamacpp';

  const model = provider === 'deepseek'
    ? firstEnv('AI_MODEL') || DEEPSEEK_MODEL
    : selfHosted ? firstEnv('AI_MODEL')
    : firstEnv('AI_MODEL', 'GEMINI_MODEL', 'OPENAI_MODEL', 'NVIDIA_MODEL') || defaultModel || DEFAULT_MODEL;

  const vertexProject = firstEnv('VERTEX_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT');
  const vertexLocation = firstEnv('VERTEX_LOCATION', 'GOOGLE_CLOUD_LOCATION') || DEFAULT_VERTEX_LOCATION;

  let baseURL;
  let resolvedModel = model;
  if (provider === 'vertex') {
    baseURL = vertexProject ? vertexBaseUrl(vertexProject, vertexLocation) : '';
    resolvedModel = vertexModelName(model);
  } else if (provider === 'deepseek') {
    baseURL = DEEPSEEK_API_BASE_URL;
  } else if (selfHosted) {
    baseURL = firstEnv('AI_BASE_URL') || '';
  } else if (provider === 'gemini') {
    baseURL = GEMINI_API_BASE_URL;
  } else {
    baseURL = firstEnv('AI_BASE_URL', 'GEMINI_BASE_URL', 'OPENAI_BASE_URL', 'NVIDIA_BASE_URL') || '';
  }

  // 顯式設定的 AI_BASE_URL 永遠優先,方便指到 proxy 或測試用的假伺服器。
  const overrideBaseUrl = firstEnv('AI_BASE_URL');
  if (overrideBaseUrl) baseURL = overrideBaseUrl;

  return {
    provider,
    model: resolvedModel,
    baseURL: normalizeBaseUrl(baseURL),
    vertexProject,
    vertexLocation,
    // DeepSeek / Gemini API 使用靜態金鑰。Vertex 的動態權杖不放在這裡,
    // 因為它會過期,存進設定物件遲早會被人快取成常數。
    apiKey: provider === 'vertex'
      ? undefined
      : provider === 'deepseek'
        ? firstEnv('DEEPSEEK_API_KEY', 'deepseek_api', 'AI_API_KEY')
        : selfHosted ? firstEnv('AI_API_KEY')
        : firstEnv('AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'NVIDIA_API_KEY'),
    maxTokens: numberFromEnv('AI_MAX_TOKENS', 'NVIDIA_MAX_TOKENS', defaultMaxTokens),
    timeoutMs: numberFromEnv('AI_TIMEOUT_MS', 'NVIDIA_TIMEOUT_MS', defaultTimeoutMs || DEFAULT_TIMEOUT_MS)
  };
}

function assertAiConfig(config, purpose) {
  if (!config.model) {
    throw new Error(`AI_MODEL is required for ${purpose}. Set AI_MODEL.`);
  }

  if (config.provider === 'vertex') {
    if (!config.vertexProject) {
      throw new Error(
        `VERTEX_PROJECT is required for ${purpose}.`
        + ' Set VERTEX_PROJECT (or GOOGLE_CLOUD_PROJECT), or set AI_PROVIDER=gemini to use an API key instead.'
      );
    }
    if (!config.baseURL) {
      throw new Error(`AI_BASE_URL could not be derived for ${purpose}. Check VERTEX_PROJECT and VERTEX_LOCATION.`);
    }
    return;
  }

  if (!config.apiKey) {
    throw new Error(`AI_API_KEY is required for ${purpose}. Set DEEPSEEK_API_KEY, AI_API_KEY or GEMINI_API_KEY.`);
  }
  if (!config.baseURL) {
    throw new Error(`AI_BASE_URL is required for ${purpose}. Set AI_BASE_URL.`);
  }
}

// 呼叫端要送出請求時才呼叫這個。Vertex 會在這裡拿(或換新)OAuth 權杖,
// Gemini API 則直接回傳靜態金鑰。回傳的東西只在這一次請求裡有效,不要快取。
async function resolveAiCredentials(config) {
  if (config.provider !== 'vertex') {
    return { authorization: `Bearer ${config.apiKey}` };
  }
  const token = await getGoogleAccessToken();
  return { authorization: `Bearer ${token}` };
}

// 條件抽取需要的是「輸出一定符合 schema」,不是「輸出是合法 JSON」。
// Vertex 與 Gemini API 的 OpenAI 相容端點都支援 response_format: json_schema,
// 這是取代舊 NVIDIA nvext.guided_json 的正規做法。無法確認支援時退回 json_object。
function supportsJsonSchema(baseURL) {
  if (/^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(String(baseURL || ''))) return false;
  const override = String(process.env.AI_ENABLE_JSON_SCHEMA || '').trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  return /aiplatform\.googleapis\.com|generativelanguage\.googleapis\.com|api\.openai\.com/i
    .test(String(baseURL || ''));
}

function aiRequestOptions({ provider }) {
  return provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {};
}

module.exports = {
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_MODEL,
  aiRequestOptions,
  DEFAULT_MODEL,
  DEFAULT_VERTEX_LOCATION,
  GEMINI_API_BASE_URL,
  getAiConfig,
  assertAiConfig,
  resolveAiCredentials,
  supportsJsonSchema,
  vertexBaseUrl,
  vertexModelName
};
