const crypto = require('node:crypto');

function getSecret() {
  const secret = process.env.PRE_INSPECTION_TOKEN_SECRET || process.env.LINE_CHANNEL_SECRET;
  if (!secret || typeof secret !== 'string' || !secret.trim()) {
    return null;
  }
  return secret.trim();
}

/**
 * Generates a short-lived token bound to a lineUserId.
 * Default TTL: 10 minutes (600 seconds).
 */
function createPreInspectionToken(lineUserId, sessionPublicIdOrTtl = null, ttlSeconds = 600) {
  if (!lineUserId) return '';
  const secret = getSecret();
  if (!secret) {
    console.error('[preInspectionTokenService] Token secret missing (PRE_INSPECTION_TOKEN_SECRET or LINE_CHANNEL_SECRET)');
    return '';
  }
  let sessionPublicId = null;
  let ttl = ttlSeconds;
  if (typeof sessionPublicIdOrTtl === 'string') {
    sessionPublicId = sessionPublicIdOrTtl;
  } else if (typeof sessionPublicIdOrTtl === 'number') {
    ttl = sessionPublicIdOrTtl;
  }

  const expiresAt = Date.now() + ttl * 1000;
  const payloadObj = { lineUserId, expiresAt, r: crypto.randomBytes(6).toString('hex') };
  if (sessionPublicId) {
    payloadObj.sessionPublicId = sessionPublicId;
  }
  const payloadStr = JSON.stringify(payloadObj);
  const payloadB64 = Buffer.from(payloadStr).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verifies a pre-inspection token.
 * Returns lineUserId if valid, not expired, and matches expectedSessionPublicId if provided.
 */
function verifyPreInspectionToken(token, expectedSessionPublicId = null) {
  if (!token || typeof token !== 'string') return null;
  const secret = getSecret();
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const expectedSignature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

  try {
    const actualBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || !payload.lineUserId || !payload.expiresAt) return null;
    if (Date.now() > payload.expiresAt) return null;

    if (expectedSessionPublicId && payload.sessionPublicId && payload.sessionPublicId !== expectedSessionPublicId) {
      return null;
    }

    return payload.lineUserId;
  } catch {
    return null;
  }
}

function resolvePreInspectionUser(req, expectedSessionPublicId = null) {
  // 點交 token 只活 10 分鐘，過期後 cookie 可能還在；不能因此擋掉同樣簽章過的 LINE 登入。
  const fromToken = verifyPreInspectionToken(requestToken(req), expectedSessionPublicId);
  if (fromToken) return fromToken;
  const { readPreInspectionSession } = require('./preInspectionSessionService');
  const fromSession = readPreInspectionSession(req);
  if (fromSession) return fromSession;

  if (req.v2LineUserId) return req.v2LineUserId;

  const { readSession } = require('./liffSessionService');
  return readSession(req) || null;
}

// 屋況點交列表及其寫入 API 的身分要求比明細頁更嚴格：只接受已驗證的
// 點交短效 token，或既有 LINE session。不可採用本機除錯用的 query/header
// 身分，否則任何人都能在網址中偽造 lineUserId 取得或建立點交紀錄。
function resolveAuthenticatedPreInspectionUser(req) {
  const fromToken = verifyPreInspectionToken(requestToken(req));
  if (fromToken) return fromToken;
  const { readPreInspectionSession } = require('./preInspectionSessionService');
  return readPreInspectionSession(req) || null;
}

// token 可以來自 query 或 cookie。原本這段在兩個路由檔各抄了一份,
// 其中一份用 slice(20) 硬算前綴長度,改了 cookie 名字就會靜默取錯。
const TOKEN_COOKIE = 'v2_inspection_token=';

function requestToken(req) {
  if (!req) return '';
  // 刪除點交那支是 POST,token 走 body;其餘走 query。兩個都認,呼叫端才不必各自拼。
  const fromRequest = String(
    (req.body && req.body.token) || (req.query && req.query.token) || ''
  ).trim();
  if (fromRequest) return fromRequest;
  const cookie = String((req.headers && req.headers.cookie) || '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(TOKEN_COOKIE));
  return cookie ? cookie.slice(TOKEN_COOKIE.length).trim() : '';
}

module.exports = {
  createPreInspectionToken,
  verifyPreInspectionToken,
  requestToken,
  resolvePreInspectionUser,
  resolveAuthenticatedPreInspectionUser
};
