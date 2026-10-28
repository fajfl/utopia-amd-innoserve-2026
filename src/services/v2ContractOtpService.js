const crypto = require('node:crypto');
const repository = require('../repositories/v2ContractRepository');

const DEMO_CODE = '123456';
// OTP 在流程第 1 步驗證、最後一步才使用,中間要讀合約、填資料、錄影、簽名。
// 5 分鐘做不完,使用者會被反覆踢回重驗。
const OTP_TTL_MS = 10 * 60 * 1000;
const purposeFor = (requestPublicId) => `contract_signature:${requestPublicId}`;
const verifierHash = (challengePublicId, code) => crypto.createHash('sha256')
  .update(`${challengePublicId}:${String(code)}`).digest('hex');

function startMockOtp({ db, lineUserId, signatureRequestPublicId }) {
  const request = repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (!['pending', 'sent', 'viewed'].includes(request.status)) throw new Error('簽署請求已失效');
  const challengePublicId = `verification-${crypto.randomUUID()}`;
  const purpose = purposeFor(signatureRequestPublicId);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare("UPDATE verification_challenges SET status='cancelled' WHERE user_id=? AND purpose=? AND status='pending'")
      .run(request.user_id, purpose);
    const result = db.prepare(`INSERT INTO verification_challenges
      (public_id,user_id,purpose,channel,destination_masked,verifier_hash,provider,expires_at)
      VALUES (?,?,?,'mock','Demo 顯示碼',?,'demo-fixed-code',?)`)
      .run(challengePublicId, request.user_id, purpose, verifierHash(challengePublicId, DEMO_CODE), expiresAt);
    db.prepare("INSERT INTO verification_events (challenge_id,event_type,detail_json) VALUES (?,'sent',?)")
      .run(Number(result.lastInsertRowid), JSON.stringify({ demo: true }));
  }).immediate();
  return { challengePublicId, demoCode: DEMO_CODE, expiresAt, channel: 'mock' };
}

function requireChallenge(db, { lineUserId, challengePublicId }) {
  const row = db.prepare(`SELECT vc.* FROM verification_challenges vc
    JOIN line_identities li ON li.user_id=vc.user_id
    WHERE vc.public_id=? AND li.line_user_id=?`).get(challengePublicId, lineUserId);
  if (!row) throw new Error('驗證碼挑戰不存在');
  return row;
}

function verifyMockOtp({ db, lineUserId, challengePublicId, code }) {
  return db.transaction(() => {
    const challenge = requireChallenge(db, { lineUserId, challengePublicId });
    if (challenge.status === 'verified') return { verified: true, challengePublicId };
    if (challenge.status !== 'pending') throw new Error('驗證碼已失效');
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      db.prepare("UPDATE verification_challenges SET status='expired' WHERE id=?").run(challenge.id);
      db.prepare("INSERT INTO verification_events (challenge_id,event_type) VALUES (?,'expired')").run(challenge.id);
      throw new Error('驗證碼已逾時');
    }
    if (verifierHash(challengePublicId, code) !== challenge.verifier_hash) {
      const attempts = challenge.attempt_count + 1;
      const locked = attempts >= challenge.max_attempts;
      db.prepare('UPDATE verification_challenges SET attempt_count=?,status=? WHERE id=?')
        .run(attempts, locked ? 'locked' : 'pending', challenge.id);
      db.prepare('INSERT INTO verification_events (challenge_id,event_type,detail_json) VALUES (?,?,?)')
        .run(challenge.id, locked ? 'locked' : 'failed_attempt', JSON.stringify({ attempt: attempts }));
      throw new Error(locked ? '驗證碼錯誤次數過多' : '驗證碼錯誤');
    }
    db.prepare("UPDATE verification_challenges SET status='verified',verified_at=CURRENT_TIMESTAMP WHERE id=?").run(challenge.id);
    db.prepare("INSERT INTO verification_events (challenge_id,event_type) VALUES (?,'verified')").run(challenge.id);
    return { verified: true, challengePublicId };
  }).immediate();
}

function requireVerifiedOtp({ db, lineUserId, signatureRequestPublicId }) {
  const request = repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  const challenge = db.prepare(`SELECT vc.* FROM verification_challenges vc
    WHERE vc.user_id=? AND vc.purpose=? AND vc.status='verified'
      AND datetime(vc.expires_at) > datetime('now')
    ORDER BY vc.verified_at DESC,vc.id DESC LIMIT 1`)
    .get(request.user_id, purposeFor(signatureRequestPublicId));
  if (!challenge) {
    const error = new Error('請先完成 OTP 驗證');
    error.statusCode = 400;
    throw error;
  }
  return challenge;
}

module.exports = { DEMO_CODE, startMockOtp, verifyMockOtp, requireVerifiedOtp };
