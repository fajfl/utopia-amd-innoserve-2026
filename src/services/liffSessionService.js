// LIFF 身分:cookie 簽章、LIFF ID 檢查、bootstrap 頁與統一身分中介層。
//
// 這四段原本只長在 tenantInquiryRoutes.js 裡。房東端的管理頁要用完全一樣的
// 身分規則,所以搬到這裡共用 —— 複製第二份的話,兩邊的 cookie 名稱、逾時判斷或
// demo 身分只要有一處先改,另一邊會在沒有錯誤訊息的情況下開始接受不同的身分。
//
// 行為與搬移前逐字相同,沒有放寬任何一項:cookie 名稱 v2_liff_session、
// HMAC-SHA256 + timingSafeEqual、expiresAt 過期即視為未登入。

const crypto = require('node:crypto');

const SESSION_COOKIE = 'v2_liff_session=';

function sessionSecret() {
  return process.env.LINE_CHANNEL_SECRET || '';
}

function signSession(lineUserId, expiresAt = Date.now() + 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ lineUserId, expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function setSessionCookie(req, res, lineUserId) {
  const secure = req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
  res.setHeader(
    'Set-Cookie',
    `v2_liff_session=${signSession(lineUserId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? '; Secure' : ''}`
  );
}

function readSession(req) {
  const token = String(req.get('cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(SESSION_COOKIE))?.slice(SESSION_COOKIE.length);
  if (!token || !sessionSecret()) return '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return '';
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return '';
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url'));
    return data.expiresAt > Date.now() ? data.lineUserId : '';
  } catch {
    return '';
  }
}

function getValidLiffId() {
  const liffId = process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
  if (!liffId || liffId === 'your_line_liff_app_id' || liffId.includes('placeholder')) {
    return '';
  }
  return liffId.trim();
}

function liffUrl(path) {
  const normalizedPath = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`;
  const liffId = getValidLiffId();
  if (liffId) return `https://liff.line.me/${encodeURIComponent(liffId)}${normalizedPath}`;
  const baseUrl = (process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  return `${baseUrl}${normalizedPath}`;
}

function liffBootstrap(returnUrl) {
  const liffId = getValidLiffId();
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>正在確認 LINE 身分</title><script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#334155;background:#f8fafc}.panel{width:min(100%,420px);padding:24px;border:1px solid #dbe3ee;border-radius:16px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.08);text-align:center}h1{margin:0 0 10px;font-size:21px;color:#0f172a}#msg{margin:0;line-height:1.7}.detail{margin:12px 0 0;color:#64748b;font-size:13px;line-height:1.6;word-break:break-word;white-space:pre-wrap}button{margin-top:18px;border:0;border-radius:10px;padding:11px 18px;background:#2563eb;color:#fff;font:inherit;font-weight:700}button[hidden]{display:none}</style></head><body><main class="panel"><h1 id="title">正在開啟服務</h1><p id="msg">正在確認 LINE 身分…</p><p id="detail" class="detail"></p><button id="retry" type="button" hidden onclick="location.reload()">重新嘗試</button></main><script>(async()=>{const title=document.getElementById('title');const msg=document.getElementById('msg');const detail=document.getElementById('detail');const retry=document.getElementById('retry');try{const lid=${JSON.stringify(liffId)};if(!lid)throw new Error('系統尚未設定 LIFF ID');if(!window.liff)throw new Error('LINE LIFF SDK 載入失敗');await liff.init({liffId:lid});if(!liff.isLoggedIn()){liff.login({redirectUri:location.href});return;}const accessToken=liff.getAccessToken();if(!accessToken)throw new Error('無法取得 LINE 登入憑證');const response=await fetch('/v2/api/liff-session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({accessToken})});if(!response.ok){let reason='HTTP '+response.status;try{const body=await response.json();if(body&&body.error)reason+=' / '+body.error}catch{}throw new Error(reason);}location.replace(${JSON.stringify(returnUrl)})}catch(error){title.textContent='無法開啟服務';msg.textContent='請確認是從 LINE 內開啟，再重新嘗試。';detail.textContent='原因：'+(error&&(error.code?error.code+' / ':'')+(error.message||error));retry.hidden=false}})()</script></body></html>`;
}

// 統一身分檢索:一律讀簽章過的 cookie;非 production 才允許用 query / header 指定,
// 這是既有測試與本機除錯依賴的行為。
// 中介層的本體抽出來單獨導出。有些路由掛在沒有 identityMiddleware 的 router 上
// (屋況點交那幾支就是),原本各自抄了一份本機除錯的判斷,規則一改
// 就會分岔。要在中介層之外取身分時呼叫這支,不要重抄。
function resolveIdentity(req) {
  const lineUserId = readSession(req)
    || (process.env.NODE_ENV !== 'production'
      ? String(req.query.lineUserId || req.get('x-line-user-id') || '').trim()
      : '');
  return { lineUserId };
}

function identityMiddleware(req, res, next) {
  req.v2LineUserId = resolveIdentity(req).lineUserId;
  next();
}

module.exports = { getValidLiffId, identityMiddleware, liffBootstrap, liffUrl, readSession, resolveIdentity, sessionSecret, setSessionCookie, signSession };
