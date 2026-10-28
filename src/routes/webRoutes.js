const express = require('express');
const { getUserProfile, upsertUserProfile } = require('../services/profileService');

const router = express.Router();
const jsonParser = express.json({ limit: '50mb' });

function configuredLiffAppId() {
  return process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title, body, extraHead = '') {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

function profilePayload(profile, lineUserId = '') {
  return {
    lineUserId: profile && profile.line_user_id ? profile.line_user_id : lineUserId,
    name: profile && profile.name ? profile.name : '',
    legalName: profile && profile.legal_name ? profile.legal_name : '',
    phone: profile && profile.phone ? profile.phone : '',
    email: profile && profile.email ? profile.email : '',
    nationalId: profile && profile.national_id ? profile.national_id : '',
    address: profile && profile.address ? profile.address : '',
    registrationStatus: profile && profile.registration_status ? profile.registration_status : 'new'
  };
}

function queryValue(req, key, fallback) {
  if (req.query[key]) return req.query[key];
  if (!req.query['liff.state']) return fallback;

  try {
    let state = String(req.query['liff.state']);
    const queryIndex = state.indexOf('?');
    if (queryIndex >= 0) {
      state = state.slice(queryIndex + 1);
    } else {
      state = state.replace(/^\?/, '');
    }
    const params = new URLSearchParams(state);
    return params.get(key) || fallback;
  } catch (error) {
    return fallback;
  }
}

function liffStatePath(req) {
  const state = req.query['liff.state'];
  if (!state) return '';
  try {
    const decoded = decodeURIComponent(String(state)).trim();
    if (decoded.startsWith('//') || decoded.includes('://') || decoded.startsWith('\\')) {
      return '';
    }
    return decoded.startsWith('/') ? decoded : '';
  } catch (error) {
    return '';
  }
}

router.get('/', (req, res, next) => {
  const statePath = liffStatePath(req);
  const isAllowedPath = statePath.startsWith('/profile') || statePath.startsWith('/tenant/pre-inspections/');
  if (isAllowedPath) {
    res.redirect(302, statePath);
    return;
  }
  next();
});

router.get('/profile', (req, res) => {
  const lineUserId = queryValue(req, 'lineUserId', '');
  const profile = getUserProfile(lineUserId) || {};
  const isRegistered = Boolean(profile.registration_status === 'registered');

  res.type('html').send(page('個人資料', `
    <main class="profile-page">
      <section class="profile-hero">
        <img src="/assets/ecs-neo-logo.png" alt="ECS NEO">
        <p>${isRegistered ? '修改資料' : '合約助手'}</p>
        <h1>個人資料</h1>
        <span>${isRegistered ? '已註冊過' : '請完成基本資料後再進行簽約'}</span>
      </section>

      <section class="profile-card">
        <form id="profileForm">
          <div id="successPanel" class="success-panel" hidden>
            <strong>資料已儲存</strong>
            <span>你現在可以回 LINE 進行簽約。視窗將嘗試自動關閉。</span>
          </div>

          <input id="lineUserId" name="lineUserId" type="hidden" value="${escapeHtml(lineUserId)}">

          <label>
            <span>姓名 *</span>
            <input name="name" autocomplete="name" required value="${escapeHtml(profile.name || '')}">
          </label>

          <label>
            <span>真實姓名 *</span>
            <input name="legalName" autocomplete="name" required value="${escapeHtml(profile.legal_name || '')}">
          </label>

          <label>
            <span>手機 *</span>
            <input name="phone" autocomplete="tel" inputmode="tel" required value="${escapeHtml(profile.phone || '')}">
          </label>

          <label>
            <span>信箱</span>
            <input name="email" autocomplete="email" inputmode="email" type="email" value="${escapeHtml(profile.email || '')}">
          </label>

          <label>
            <span>身分證</span>
            <input name="nationalId" autocomplete="off" value="${escapeHtml(profile.national_id || '')}">
          </label>

          <label>
            <span>戶籍地址 *</span>
            <textarea name="address" rows="3" autocomplete="street-address" required>${escapeHtml(profile.address || '')}</textarea>
          </label>

          <p class="note">身分證與信箱為選填。資料僅用於合約聯絡、提醒與簽署紀錄。</p>
          <button type="submit">${isRegistered ? '已註冊過，更新資料' : '完成註冊'}</button>
          <p id="profileMessage" class="message"></p>
        </form>
      </section>
    </main>

    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <script>
      const liffAppId = ${JSON.stringify(configuredLiffAppId())};
      const form = document.getElementById('profileForm');
      const lineUserInput = document.getElementById('lineUserId');
      const message = document.getElementById('profileMessage');
      const successPanel = document.getElementById('successPanel');

      function fillProfileFields(profile) {
        if (!profile) return;
        form.elements.name.value = profile.name || '';
        form.elements.legalName.value = profile.legalName || '';
        form.elements.phone.value = profile.phone || '';
        form.elements.email.value = profile.email || '';
        form.elements.nationalId.value = profile.nationalId || '';
        form.elements.address.value = profile.address || '';
      }

      async function loadProfileForLineUser(lineUserId) {
        if (!lineUserId) return;
        try {
          const response = await fetch('/api/profile?lineUserId=' + encodeURIComponent(lineUserId), {
            headers: { accept: 'application/json' }
          });
          const result = await response.json();
          if (response.ok && result.ok) fillProfileFields(result.profile);
        } catch (error) {
          console.warn('Unable to load profile:', error.message);
        }
      }

      async function resolveLineUserId() {
        let resolved = lineUserInput.value || '';
        try {
          if (liffAppId && window.liff) {
            await liff.init({ liffId: liffAppId });
          }
          if (liffAppId && window.liff && !liff.isLoggedIn()) {
            liff.login({ redirectUri: window.location.href });
            return resolved;
          }
          if (liffAppId && window.liff && liff.isLoggedIn()) {
            const profile = await liff.getProfile();
            resolved = profile.userId || resolved;
          }
        } catch (error) {
          console.warn('LIFF profile unavailable:', error.message);
        }
        lineUserInput.value = resolved;
        return resolved;
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await resolveLineUserId();
        const data = Object.fromEntries(new FormData(form).entries());
        message.className = 'message';
        message.textContent = '正在儲存...';

        try {
          const response = await fetch('/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          const result = await response.json();
          if (!response.ok || !result.ok) {
            throw new Error(result.error || '儲存失敗');
          }
          document.body.classList.add('registered-done');
          successPanel.hidden = false;
          message.className = 'message success';
          message.textContent = '註冊成功，正在回到 LINE...';
          setTimeout(() => {
            try {
              if (window.liff && liff.isInClient && liff.isInClient()) {
                liff.closeWindow();
                return;
              }
            } catch (error) {
              console.warn('Unable to close LIFF window:', error.message);
            }
            message.textContent = '註冊成功。若視窗沒有自動關閉，可以按右上角 X 回到 LINE。';
          }, 1800);
        } catch (error) {
          message.className = 'message error';
          message.textContent = error.message;
        }
      });

      (async () => {
        const resolved = await resolveLineUserId();
        if (resolved) {
          await loadProfileForLineUser(resolved);
        } else {
          message.className = 'message error';
          message.textContent = liffAppId
            ? '無法透過 LINE 取得目前點擊者的 lineUserId，請從 LINE 群組卡片重新開啟。'
            : '系統尚未設定 LIFF_ID，無法啟動 LIFF 來取得目前點擊者的 lineUserId。請先在 .env 設定 LIFF_ID。';
        }
      })();
    </script>

    <style>
      body { margin: 0; background: linear-gradient(180deg, #F7FEE7 0%, #F8FAFC 38%); color: #111827; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .profile-page { max-width: 520px; margin: 0 auto; padding: 18px 14px 28px; }
      .profile-hero { position: relative; overflow: hidden; background: #FFFFFF; color: #0F172A; border: 1px solid #E5E7EB; border-radius: 18px; padding: 20px 22px 40px; box-shadow: 0 18px 40px rgba(15,23,42,.08); }
      .profile-hero img { display: block; width: min(100%, 360px); height: auto; margin: 2px auto 18px; }
      .profile-hero p, .profile-hero h1, .profile-hero span { position: relative; z-index: 1; }
      .profile-hero p { margin: 0 0 6px; color: #0F766E; font-size: 13px; font-weight: 800; }
      .profile-hero h1 { margin: 0; font-size: 30px; letter-spacing: 0; }
      .profile-hero span { display: inline-block; margin-top: 12px; padding: 7px 11px; background: #ECFDF5; color: #059669; border-radius: 999px; font-size: 12px; font-weight: 800; }
      .profile-card { position: relative; margin-top: -26px; background: #fff; border: 1px solid #E5E7EB; border-radius: 22px; padding: 20px; box-shadow: 0 18px 40px rgba(15,23,42,.12); }
      form { display: grid; gap: 13px; }
      label { display: grid; gap: 7px; }
      label span { color: #475569; font-size: 13px; font-weight: 800; }
      input, textarea { width: 100%; box-sizing: border-box; border: 1px solid #E5E7EB; border-radius: 12px; padding: 12px 13px; font: inherit; color: #111827; background: #fff; outline: none; }
      input:focus, textarea:focus { border-color: #0F766E; box-shadow: 0 0 0 3px rgba(236,253,245,.95); }
      textarea { resize: vertical; min-height: 92px; }
      .note { margin: 2px 0 0; color: #64748B; font-size: 12px; line-height: 1.6; }
      button { border: 0; border-radius: 12px; background: #0F766E; color: #fff; padding: 13px 14px; font: inherit; font-weight: 900; cursor: pointer; }
      .message { min-height: 20px; margin: 0; color: #64748B; font-size: 13px; line-height: 1.5; }
      .message.success { color: #059669; font-weight: 800; }
      .message.error { color: #DC2626; font-weight: 800; }
      .success-panel { background: #ECFDF5; border: 1px solid #BBF7D0; border-radius: 16px; padding: 14px; color: #059669; }
      .success-panel strong { display: block; font-size: 18px; margin-bottom: 4px; }
      .success-panel span { display: block; color: #0F766E; font-size: 13px; line-height: 1.5; }
      .registered-done button { background: #059669; }
      @media (max-width: 560px) {
        .profile-page { padding: 0 0 20px; }
        .profile-hero { border-radius: 0 0 24px 24px; }
        .profile-card { margin: -26px 12px 0; }
      }
    </style>
  `));
});

router.get('/api/profile', (req, res) => {
  const lineUserId = String(req.query.lineUserId || '').trim();
  if (!lineUserId) {
    res.status(400).json({ ok: false, error: 'lineUserId is required' });
    return;
  }

  res.json({
    ok: true,
    profile: profilePayload(getUserProfile(lineUserId), lineUserId)
  });
});

router.post('/api/profile', jsonParser, (req, res, next) => {
  try {
    const profile = upsertUserProfile(req.body || {});
    res.json({
      ok: true,
      profile: {
        lineUserId: profile.line_user_id,
        name: profile.name,
        legalName: profile.legal_name,
        phone: profile.phone,
        email: profile.email,
        nationalId: profile.national_id,
        address: profile.address,
        registrationStatus: profile.registration_status
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/contracts', (req, res) => {
  res.send('<html><body><div style="padding: 40px; text-align: center; font-family: sans-serif;"><h2>合約智慧行事曆 (開發中)</h2><p>這裡將會是完整的行事曆畫面！</p></div></body></html>');
});

module.exports = router;
