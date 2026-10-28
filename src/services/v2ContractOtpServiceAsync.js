// OTP service 的 driver 版本。參數 `db` 收的是 sqlDriver 的 driver。

const crypto = require('node:crypto');
const repository = require('../repositories/v2ContractRepositoryAsync');

const DEMO_CODE = '123456';
// OTP 在流程第 1 步驗證、最後一步才使用,中間要讀合約、填資料、錄影、簽名。
// 5 分鐘做不完,使用者會被反覆踢回重驗。
const OTP_TTL_MS = 10 * 60 * 1000;
const purposeFor = (requestPublicId) => `contract_signature:${requestPublicId}`;
const verifierHash = (challengePublicId, code) => crypto.createHash('sha256')
  .update(`${challengePublicId}:${String(code)}`).digest('hex');

async function startMockOtp({ db, lineUserId, signatureRequestPublicId }) {
  const request = await repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  if (!['pending', 'sent', 'viewed'].includes(request.status)) throw new Error('簽署請求已失效');
  const challengePublicId = `verification-${crypto.randomUUID()}`;
  const purpose = purposeFor(signatureRequestPublicId);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await db.transaction(async (tx) => {
    await tx.run("UPDATE verification_challenges SET status='cancelled' WHERE user_id=? AND purpose=? AND status='pending'",
      [request.user_id, purpose]);
    const result = await tx.run(`INSERT INTO verification_challenges
      (public_id,user_id,purpose,channel,destination_masked,verifier_hash,provider,expires_at)
      VALUES (?,?,?,'mock','Demo 顯示碼',?,'demo-fixed-code',?)`,
    [challengePublicId, request.user_id, purpose, verifierHash(challengePublicId, DEMO_CODE), expiresAt]);
    await tx.run("INSERT INTO verification_events (challenge_id,event_type,detail_json) VALUES (?,'sent',?)",
      [result.insertId, JSON.stringify({ demo: true })]);
  });
  return { challengePublicId, demoCode: DEMO_CODE, expiresAt, channel: 'mock' };
}

async function requireChallenge(db, { lineUserId, challengePublicId }) {
  const row = await db.get(`SELECT vc.* FROM verification_challenges vc
    JOIN line_identities li ON li.user_id=vc.user_id
    WHERE vc.public_id=? AND li.line_user_id=?`, [challengePublicId, lineUserId]);
  if (!row) throw new Error('驗證碼挑戰不存在');
  return row;
}

async function verifyMockOtp({ db, lineUserId, challengePublicId, code }) {
  return db.transaction(async (tx) => {
    const challenge = await requireChallenge(tx, { lineUserId, challengePublicId });
    if (challenge.status === 'verified') return { verified: true, challengePublicId };
    if (challenge.status !== 'pending') throw new Error('驗證碼已失效');
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      await tx.run("UPDATE verification_challenges SET status='expired' WHERE id=?", [challenge.id]);
      await tx.run("INSERT INTO verification_events (challenge_id,event_type) VALUES (?,'expired')", [challenge.id]);
      throw new Error('驗證碼已逾時');
    }
    if (verifierHash(challengePublicId, code) !== challenge.verifier_hash) {
      const attempts = challenge.attempt_count + 1;
      const locked = attempts >= challenge.max_attempts;
      await tx.run('UPDATE verification_challenges SET attempt_count=?,status=? WHERE id=?',
        [attempts, locked ? 'locked' : 'pending', challenge.id]);
      await tx.run('INSERT INTO verification_events (challenge_id,event_type,detail_json) VALUES (?,?,?)',
        [challenge.id, locked ? 'locked' : 'failed_attempt', JSON.stringify({ attempt: attempts })]);
      throw new Error(locked ? '驗證碼錯誤次數過多' : '驗證碼錯誤');
    }
    await tx.run("UPDATE verification_challenges SET status='verified',verified_at=CURRENT_TIMESTAMP WHERE id=?", [challenge.id]);
    await tx.run("INSERT INTO verification_events (challenge_id,event_type) VALUES (?,'verified')", [challenge.id]);
    return { verified: true, challengePublicId };
  });
}

async function requireVerifiedOtp({ db, lineUserId, signatureRequestPublicId }) {
  const request = await repository.requireSignatureRequest(db, { lineUserId, signatureRequestPublicId });
  // 原本寫成 datetime(vc.expires_at) > datetime('now'),那是 SQLite 專有函式,
  // TiDB 沒有 datetime()。這裡不改用方言片段,而是直接移除方言依賴:
  // expires_at 只有 startMockOtp 一個寫入者,永遠是 new Date().toISOString(),
  // 而 ISO-8601 的字典序就是時間序,字串比較在兩邊都正確。
  const challenge = await db.get(`SELECT vc.* FROM verification_challenges vc
    WHERE vc.user_id=? AND vc.purpose=? AND vc.status='verified'
      AND vc.expires_at > ?
    ORDER BY vc.verified_at DESC,vc.id DESC LIMIT 1`,
  [request.user_id, purposeFor(signatureRequestPublicId), new Date().toISOString()]);
  if (!challenge) {
    const error = new Error('請先完成 OTP 驗證');
    error.statusCode = 400;
    throw error;
  }
  return challenge;
}

module.exports = { DEMO_CODE, startMockOtp, verifyMockOtp, requireVerifiedOtp };
