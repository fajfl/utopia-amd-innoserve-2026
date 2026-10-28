const db = require('../db');

function cleanText(value) {
  return String(value || '').trim();
}

function validateProfileInput(input) {
  const displayName = cleanText(input.displayName || input.name);
  const legalName = cleanText(input.legalName || input.realName);
  const profile = {
    lineUserId: cleanText(input.lineUserId),
    displayName,
    legalName,
    phone: cleanText(input.phone),
    email: cleanText(input.email),
    address: cleanText(input.address),
    nationalId: cleanText(input.nationalId || input.national_id)
  };

  const missing = [];
  if (!profile.lineUserId) missing.push('LINE 使用者');
  if (!profile.displayName) missing.push('姓名');
  if (!profile.legalName) missing.push('真實姓名');
  if (!profile.phone) missing.push('手機');
  if (!profile.address) missing.push('地址');

  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
    missing.push('有效信箱');
  }

  return { profile, missing };
}

function getUserProfile(lineUserId) {
  const userId = cleanText(lineUserId);
  if (!userId) return null;

  const row = db.prepare(`
    SELECT
      li.line_user_id,
      up.display_name,
      up.legal_name,
      up.phone,
      up.email,
      up.national_id,
      up.household_address,
      up.created_at,
      up.updated_at
    FROM line_identities li
    JOIN user_profiles up ON up.user_id = li.user_id
    WHERE li.line_user_id = ?
  `).get(userId);

  if (!row) return null;

  return {
    line_user_id: row.line_user_id,
    name: row.display_name || row.legal_name || '',
    display_name: row.display_name || '',
    legal_name: row.legal_name || '',
    phone: row.phone || '',
    email: row.email || '',
    national_id: row.national_id || '',
    address: row.household_address || '',
    registration_status: row.display_name && row.legal_name && row.phone && row.household_address
      ? 'registered'
      : 'incomplete',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function isUserRegistered(lineUserId) {
  const profile = getUserProfile(lineUserId);
  return Boolean(
    profile &&
    profile.registration_status === 'registered' &&
    profile.name &&
    profile.phone &&
    profile.address
  );
}

function ensureLineIdentity(lineUserId) {
  const existing = db.prepare(`
    SELECT user_id
    FROM line_identities
    WHERE line_user_id = ?
  `).get(lineUserId);

  if (existing) return existing.user_id;

  const userResult = db.prepare(`
    INSERT INTO users (status)
    VALUES ('active')
  `).run();

  db.prepare(`
    INSERT INTO line_identities (user_id, line_user_id)
    VALUES (@userId, @lineUserId)
  `).run({
    userId: userResult.lastInsertRowid,
    lineUserId
  });

  return userResult.lastInsertRowid;
}

function upsertUserProfile(input) {
  const { profile, missing } = validateProfileInput(input);
  if (missing.length) {
    const error = new Error(`缺少或格式不正確：${missing.join('、')}`);
    error.statusCode = 400;
    throw error;
  }

  const tx = db.transaction(() => {
    const userId = ensureLineIdentity(profile.lineUserId);

    db.prepare(`
      INSERT INTO user_profiles (
        user_id,
        display_name,
        legal_name,
        phone,
        household_address,
        national_id,
        email,
        updated_at
      )
      VALUES (
        @userId,
        @displayName,
        @legalName,
        @phone,
        @householdAddress,
        @nationalId,
        @email,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = excluded.display_name,
        legal_name = excluded.legal_name,
        phone = excluded.phone,
        household_address = excluded.household_address,
        national_id = excluded.national_id,
        email = excluded.email,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      userId,
      displayName: profile.displayName,
      legalName: profile.legalName,
      phone: profile.phone,
      householdAddress: profile.address,
      nationalId: profile.nationalId || null,
      email: profile.email
    });

    syncParticipantSnapshotsForLineUser(profile.lineUserId);
  });

  tx();
  return getUserProfile(profile.lineUserId);
}

function updateOptionalProfileFields({ lineUserId, nationalId, email }) {
  const userId = ensureLineIdentity(cleanText(lineUserId));
  const existing = getUserProfile(lineUserId);
  if (!existing || existing.registration_status !== 'registered') {
    const error = new Error('請先完成個人資料，再補充身分證或信箱。');
    error.statusCode = 400;
    throw error;
  }

  const nextNationalId = cleanText(nationalId);
  const nextEmail = cleanText(email);
  if (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    const error = new Error('信箱格式不正確。');
    error.statusCode = 400;
    throw error;
  }

  db.prepare(`
    UPDATE user_profiles
    SET national_id = COALESCE(@nationalId, national_id),
        email = COALESCE(@email, email),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = @userId
  `).run({
    userId,
    nationalId: nextNationalId || null,
    email: nextEmail || null
  });

  syncParticipantSnapshotsForLineUser(lineUserId);
  return getUserProfile(lineUserId);
}

function syncParticipantSnapshotsForLineUser(lineUserId) {
  const row = db.prepare(`
    SELECT
      li.user_id,
      li.line_user_id,
      up.display_name,
      up.legal_name,
      up.phone,
      up.household_address,
      up.national_id,
      up.email
    FROM line_identities li
    JOIN user_profiles up ON up.user_id = li.user_id
    WHERE li.line_user_id = @lineUserId
  `).get({ lineUserId: cleanText(lineUserId) });
  if (!row) return;

  db.prepare(`
    UPDATE case_participants
    SET user_id = @userId,
        display_name_snapshot = @displayName,
        legal_name_snapshot = @legalName,
        phone_snapshot = @phone,
        household_address_snapshot = @householdAddress,
        national_id_snapshot = @nationalId,
        email_snapshot = @email,
        updated_at = CURRENT_TIMESTAMP
    WHERE line_user_id = @lineUserId
      AND status = 'active'
  `).run({
    userId: row.user_id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    legalName: row.legal_name,
    phone: row.phone,
    householdAddress: row.household_address,
    nationalId: row.national_id,
    email: row.email
  });
}

module.exports = {
  ensureLineIdentity,
  getUserProfile,
  isUserRegistered,
  syncParticipantSnapshotsForLineUser,
  updateOptionalProfileFields,
  upsertUserProfile,
  validateProfileInput
};
