const crypto = require('node:crypto');

function sessionSecret() {
  return process.env.LINE_CHANNEL_SECRET || process.env.SESSION_SECRET || 'pre-inspection-secret-key';
}

function signPreInspectionSession(lineUserId, expiresAt) {
  const exp = expiresAt || (Date.now() + 60 * 60 * 1000);
  const payload = Buffer.from(JSON.stringify({ lineUserId, expiresAt: exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readPreInspectionSession(req) {
  const readSharedSession = () => require('./liffSessionService').readSession(req);
  const cookieHeader = String(req.get('cookie') || req.headers?.cookie || '');
  const token = cookieHeader
    .split(';')
    .map(p => p.trim())
    .find(p => p.startsWith('v2_pre_inspection_session='))
    ?.slice(26);

  if (!token) return readSharedSession();

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return readSharedSession();

  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return readSharedSession();
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.lineUserId || !data.expiresAt) return readSharedSession();
    if (Number(data.expiresAt) <= Date.now()) return readSharedSession();
    return String(data.lineUserId);
  } catch {
    return readSharedSession();
  }
}

async function verifyLineIdToken({ idToken, channelId }) {
  if (!idToken || typeof idToken !== 'string') {
    return { ok: false, error: 'Missing idToken' };
  }

  const expectedChannelId = channelId || process.env.LINE_LOGIN_CHANNEL_ID || process.env.LINE_CHANNEL_ID || '';
  const bodyParams = new URLSearchParams();
  bodyParams.append('id_token', idToken);
  if (expectedChannelId) {
    bodyParams.append('client_id', expectedChannelId);
  }

  try {
    const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: bodyParams.toString()
    });

    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, error: `LINE verification failed: ${response.status} ${errText}` };
    }

    const data = await response.json();
    const nowSec = Math.floor(Date.now() / 1000);

    if (!data.sub) {
      return { ok: false, error: 'Invalid token response: sub missing' };
    }
    if (data.iss !== 'https://access.line.me') {
      return { ok: false, error: `Invalid issuer: ${data.iss}` };
    }
    if (expectedChannelId && data.aud !== expectedChannelId) {
      return { ok: false, error: `Audience mismatch: expected ${expectedChannelId}, got ${data.aud}` };
    }
    if (!data.exp || Number(data.exp) <= nowSec) {
      return { ok: false, error: 'ID token has expired' };
    }

    const maxAgeSeconds = Math.max(1, Number(data.exp) - nowSec);
    const expiresAt = Number(data.exp) * 1000;

    return {
      ok: true,
      lineUserId: data.sub,
      expiresAt,
      maxAgeSeconds
    };
  } catch (err) {
    return { ok: false, error: `Network error verifying idToken: ${err.message}` };
  }
}

function preInspectionIdentityMiddleware(req, res, next) {
  req.preInspectionLineUserId = readPreInspectionSession(req);
  next();
}

function getValidPreInspectionLiffId() {
  const liffId = process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
  if (!liffId || liffId === 'your_line_liff_app_id' || liffId.includes('placeholder')) {
    return '';
  }
  return liffId.trim();
}

function preInspectionLiffBootstrap(returnUrl) {
  return require('./liffSessionService').liffBootstrap(returnUrl);
}

module.exports = {
  signPreInspectionSession,
  readPreInspectionSession,
  verifyLineIdToken,
  preInspectionIdentityMiddleware,
  getValidPreInspectionLiffId,
  preInspectionLiffBootstrap
};
