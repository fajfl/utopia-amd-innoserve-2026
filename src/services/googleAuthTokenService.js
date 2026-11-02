// Vertex AI 不吃靜態 API key,要的是 Google OAuth 存取權杖,而權杖大約一小時就過期。
//
// 所以這裡不做「開機讀一次環境變數」那種寫法:每次要用的時候問,問到的結果快取到
// 快過期前為止。過期時間一律以權杖自己回報的為準,並提前一段時間換新,免得剛好
// 在請求送出的路上過期。
//
// 取得順序:
//   1. Application Default Credentials(google-auth-library)。本機是 gcloud 的
//      application_default_credentials.json,雲端是 metadata server 或
//      GOOGLE_APPLICATION_CREDENTIALS 指的 service account。
//   2. ADC 拿不到時退回 `gcloud auth print-access-token`。開發機上常見的情況是
//      只跑過 `gcloud auth login` 而沒跑 `gcloud auth application-default login`,
//      這時候 ADC 會失敗但 CLI 還是拿得到權杖。
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// 提前換新的緩衝。權杖大約一小時效期,五分鐘緩衝足夠涵蓋一次慢請求。
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// ADC 完全拿不到時,gcloud CLI 沒有回報效期,只能自己假設一個保守值。
const CLI_ASSUMED_LIFETIME_MS = 45 * 60 * 1000;

let cachedToken = null;
let cachedExpiresAt = 0;
let inFlight = null;

function isFresh(now) {
  return Boolean(cachedToken) && now + EXPIRY_SKEW_MS < cachedExpiresAt;
}

async function fromApplicationDefaultCredentials() {
  // 延後 require:沒裝 google-auth-library 的環境仍然可以走 CLI 那條路。
  let GoogleAuth;
  try {
    ({ GoogleAuth } = require('google-auth-library'));
  } catch (error) {
    throw new Error(`google-auth-library 未安裝: ${error.message}`);
  }

  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const client = await auth.getClient();
  const response = await client.getAccessToken();

  const token = response && response.token;
  if (!token) throw new Error('ADC 沒有回傳存取權杖');

  // google-auth-library 會把到期時間放在 client.credentials.expiry_date(毫秒)。
  const expiryDate = client.credentials && client.credentials.expiry_date;
  return {
    token,
    expiresAt: Number.isFinite(expiryDate) ? expiryDate : Date.now() + CLI_ASSUMED_LIFETIME_MS,
    source: 'adc'
  };
}

async function fromGcloudCli() {
  const command = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
  const { stdout } = await execFileAsync(command, ['auth', 'print-access-token'], {
    timeout: 30000,
    windowsHide: true
  });
  const token = String(stdout || '').trim();
  if (!token) throw new Error('gcloud 沒有輸出存取權杖');
  return {
    token,
    expiresAt: Date.now() + CLI_ASSUMED_LIFETIME_MS,
    source: 'gcloud-cli'
  };
}

async function fetchToken() {
  const failures = [];
  for (const attempt of [fromApplicationDefaultCredentials, fromGcloudCli]) {
    try {
      return await attempt();
    } catch (error) {
      failures.push(`${attempt.name}: ${error.message}`);
    }
  }
  throw new Error(
    `無法取得 Google 存取權杖。請先執行 gcloud auth application-default login,`
    + ` 或設定 GOOGLE_APPLICATION_CREDENTIALS。嘗試過的方式:\n  ${failures.join('\n  ')}`
  );
}

// 併發呼叫共用同一次取得,避免同時開一堆 gcloud 子行程。
async function getGoogleAccessToken({ now = Date.now(), forceRefresh = false } = {}) {
  if (!forceRefresh && isFresh(now)) return cachedToken;
  if (inFlight) return inFlight;

  inFlight = fetchToken()
    .then((result) => {
      cachedToken = result.token;
      cachedExpiresAt = result.expiresAt;
      return result.token;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

function resetGoogleAccessTokenCache() {
  cachedToken = null;
  cachedExpiresAt = 0;
  inFlight = null;
}

module.exports = {
  CLOUD_PLATFORM_SCOPE,
  EXPIRY_SKEW_MS,
  getGoogleAccessToken,
  resetGoogleAccessTokenCache
};
