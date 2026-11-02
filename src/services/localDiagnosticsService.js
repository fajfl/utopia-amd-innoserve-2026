const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const context = new AsyncLocalStorage();
const directory = path.resolve(__dirname, '../../data/local-diagnostics');
function enabled() {
  return process.env.LOCAL_DIAGNOSTICS_ENABLED === 'true' && ['development', 'test'].includes(process.env.NODE_ENV);
}
function actorRef(id) {
  return id ? crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 20) : null;
}
function sanitize(value, depth = 0) {
  if (depth > 16) return '[depth limit]';
  if (typeof value === 'string') {
    if (/^data:|^[A-Za-z0-9+/]{200,}={0,2}$/.test(value)) return '[binary omitted]';
    const text = value.length > 32768 ? value.slice(0, 32768) + '[truncated]' : value;
    return text
      .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]')
      .replace(/((?:^|[?&])(?:[^=&\s]*(?:token|signature|credential)|code|state|key|secret|lineUserId)=)[^&#\s"<>]+/gi, '$1[redacted]')
      .replace(/((?:api[_-]?key|password|secret|access[_-]?token|reply[_-]?token)\s*[=:]\s*)[^\s,;"<>]+/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /token|secret|password|cookie|authorization|signature|otp|base64|phone|email|national.?id|^code$|^state$/i.test(key)
      ? '[redacted]' : sanitize(item, depth + 1)
  ]));
  return value;
}
function record(type, fields = {}) {
  if (!enabled()) return;
  const scope = context.getStore() || {};
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = sanitize({ timestamp: new Date().toISOString(), type, traceId: scope.traceId,
      eventId: scope.eventId, actor: actorRef(scope.lineUserId),
      role: scope.lineUserId ? require('./testRoleService').getActiveRole(scope.lineUserId) : null, ...fields });
    // shortcut: 僅供單機測試，逐筆同步落檔；高流量部署前換正式日誌收集器。
    fs.appendFileSync(path.join(directory, `${entry.timestamp.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (error) {
    console.error('[local-diagnostics] 寫入失敗', error.code || 'unknown');
  }
}
function withLineEvent(event, work) {
  if (!enabled()) return work();
  return context.run({ ...context.getStore(), traceId: crypto.randomUUID(), eventId: event.webhookEventId || event.message?.id,
    lineUserId: event.source?.userId }, async () => {
    record('line.inbound', { eventType: event.type, eventTimestamp: event.timestamp,
      sourceType: event.source?.type, message: event.message, postback: event.postback, redelivery: event.deliveryContext?.isRedelivery });
    try {
      const result = await work();
      record('line.handled');
      return result;
    } catch (error) {
      record('line.failed', { errorCode: error.code, status: error.statusCode });
      throw error;
    }
  });
}
function instrumentLineClient(client) {
  for (const method of ['replyMessage', 'pushMessage', 'linkRichMenuToUser']) {
    const original = client[method];
    if (typeof original !== 'function') continue;
    client[method] = async function (...args) {
      if (!enabled()) return original.apply(this, args);
      const attemptId = crypto.randomUUID();
      const started = Date.now();
      record('line.send.attempt', { attemptId, method, recipient: method !== 'replyMessage' ? actorRef(args[0]) : undefined, payload: args[1] });
      try {
        const result = await original.apply(this, args);
        record('line.send.accepted', { attemptId, method, durationMs: Date.now() - started,
          messageIds: result?.sentMessages?.map(item => item.id) });
        return result;
      } catch (error) {
        record('line.send.failed', { attemptId, method, durationMs: Date.now() - started,
          status: error.statusCode || error.originalError?.response?.status, errorCode: error.code });
        throw error;
      }
    };
  }
  return client;
}
function httpMiddleware(req, res, next) {
  if (!enabled() || req.path.startsWith('/assets/') || ['/health', '/favicon.ico'].includes(req.path)) return next();
  const lineUserId = require('./liffSessionService').readSession(req);
  const scope = { traceId: crypto.randomUUID(), lineUserId };
  return context.run(scope, () => {
    const started = Date.now();
    const sensitive = /\/(?:otp|sign|evidence|auth|profile)(?:\/|$)/i.test(req.path) || /session|login|callback|logout/i.test(req.path);
    let response;
    const json = res.json;
    res.json = function (body) {
      if (!sensitive && /\/api\//.test(req.path)) response = sanitize(body);
      return json.call(this, body);
    };
    const finish = outcome => context.run(scope, () => {
      scope.lineUserId = scope.lineUserId || require('./liffSessionService').readSession(req);
      const input = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) =>
        ['role', 'question', 'text', 'summary', 'urgent', 'occurredOn', 'confirmed', 'previewId', 'proposalId', 'kind', 'action', 'contractPublicId', 'listingPublicId', 'inquiryPublicId'].includes(key)));
      record('http.' + outcome, { method: req.method, path: req.path, route: req.route?.path,
        status: res.statusCode, durationMs: Date.now() - started,
        role: res.getHeader('X-Test-Role') || null, input: sensitive ? undefined : input, response });
    });
    res.once('finish', () => finish('finished'));
    res.once('close', () => { if (!res.writableFinished) finish('aborted'); });
    next();
  });
}
module.exports = { enabled, directory, actorRef, sanitize, record, withLineEvent, instrumentLineClient, httpMiddleware };
