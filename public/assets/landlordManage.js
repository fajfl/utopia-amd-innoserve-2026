// 房東管理台。寫法跟 tenantInquiry.js 一樣:沒有框架、innerHTML 組畫面、
// 函式明確掛到 window 上(LINE 的 WebView 會隔離模組作用域,不掛就點不到)。

let state = { listings: [], current: '', tab: 'slots', slots: [], rules: [] };

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pretty(stamp) {
  return String(stamp || '').replace('T', ' ');
}

async function api(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `請求失敗(${response.status})`);
  }
  return data;
}

async function loadListings() {
  const select = document.getElementById('listing');
  try {
    const data = await api('/v2/api/landlord/listings');
    state.listings = data.listings;
    if (!state.listings.length) {
      select.innerHTML = '<option value="">目前沒有你名下的房源</option>';
      document.getElementById('slot-list').innerHTML = '<p class="empty">目前沒有你名下的房源</p>';
      document.getElementById('rule-list').innerHTML = '<p class="empty">目前沒有你名下的房源</p>';
      return;
    }
    select.innerHTML = state.listings
      .map((item) => {
        const title = item.title || item.publicId;
        const label = item.unitLabel ? `${item.unitLabel}・${title}` : title;
        return `<option value="${escapeHtml(item.publicId)}">${escapeHtml(label)}</option>`;
      })
      .join('');
    state.current = state.listings[0].publicId;
    select.value = state.current;
    select.onchange = () => { state.current = select.value; refresh(); };
    refresh();
  } catch (error) {
    select.innerHTML = '<option value="">載入失敗</option>';
    document.getElementById('slot-error').textContent = error.message;
  }
}

function switchTab(tab) {
  state.tab = tab;
  document.getElementById('tab-slots').classList.toggle('active', tab === 'slots');
  document.getElementById('tab-rules').classList.toggle('active', tab === 'rules');
  document.getElementById('panel-slots').style.display = tab === 'slots' ? '' : 'none';
  document.getElementById('panel-rules').style.display = tab === 'rules' ? '' : 'none';
  refresh();
}

function refresh() {
  if (!state.current) return;
  if (state.tab === 'slots') return loadSlots();
  return loadRules();
}

async function loadSlots() {
  const box = document.getElementById('slot-list');
  try {
    const data = await api(`/v2/api/landlord/listings/${encodeURIComponent(state.current)}/slots`);
    state.slots = data.slots;
    if (!state.slots.length) {
      box.innerHTML = '<p class="empty">還沒有開放任何看房時段</p>';
      return;
    }
    box.innerHTML = state.slots.map((slot) => {
      const pill = slot.status === 'booked'
        ? `<span class="pill pill-booked">已預約</span>`
        : slot.expired
          ? `<span class="pill pill-expired">已過期</span>`
          : slot.status === 'closed'
            ? `<span class="pill pill-closed">已停用</span>`
            : `<span class="pill pill-open">開放中</span>`;
      const who = slot.appointment
        ? `<small>${escapeHtml(slot.appointment.tenantName)}・${escapeHtml(slot.appointment.status)}</small>`
        : `<small>${slot.endsAt ? '至 ' + escapeHtml(pretty(slot.endsAt)) : '未設定結束時間'}</small>`;
      const actions = slot.status === 'booked'
        ? ''
        : slot.status === 'closed'
          ? `<button class="mini danger" onclick="removeSlot('${escapeHtml(slot.publicId)}')">刪除</button>`
          : `<button class="mini" onclick="closeSlot('${escapeHtml(slot.publicId)}')">停用</button>
             <button class="mini danger" onclick="removeSlot('${escapeHtml(slot.publicId)}')">刪除</button>`;
      return `<div class="row">
        <div class="grow"><b>${escapeHtml(pretty(slot.startsAt))}</b>${who}</div>
        ${pill}
        ${actions}
      </div>`;
    }).join('');
  } catch (error) {
    box.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

async function createSlot() {
  const input = document.getElementById('slot-start');
  const error = document.getElementById('slot-error');
  error.textContent = '';
  if (!input.value) {
    error.textContent = '請先選擇日期與時間。';
    return;
  }
  try {
    await api(`/v2/api/landlord/listings/${encodeURIComponent(state.current)}/slots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startsAt: input.value })
    });
    input.value = '';
    loadSlots();
  } catch (err) {
    error.textContent = err.message;
  }
}

async function closeSlot(publicId) {
  const error = document.getElementById('slot-error');
  error.textContent = '';
  try {
    await api(`/v2/api/landlord/slots/${encodeURIComponent(publicId)}/close`, { method: 'POST' });
    loadSlots();
  } catch (err) {
    error.textContent = err.message;
  }
}

async function removeSlot(publicId) {
  if (!confirm('確定要刪除這個時段嗎？已經被預約過的時段會改成停用並保留紀錄。')) return;
  const error = document.getElementById('slot-error');
  error.textContent = '';
  try {
    await api(`/v2/api/landlord/slots/${encodeURIComponent(publicId)}`, { method: 'DELETE' });
    loadSlots();
  } catch (err) {
    error.textContent = err.message;
  }
}

async function loadRules() {
  const box = document.getElementById('rule-list');
  try {
    const data = await api(`/v2/api/landlord/listings/${encodeURIComponent(state.current)}/rules`);
    state.rules = data.rules;
    if (!state.rules.length) {
      box.innerHTML = '<p class="empty">還沒有補充任何房源規則。可以在 LINE 輸入「AI知識庫」新增。</p>';
      return;
    }
    box.innerHTML = state.rules.map((rule, index) => {
      const pills = [
        rule.visibility === 'internal' ? '<span class="pill pill-internal">內部</span>' : '',
        rule.status === 'active'
          ? '<span class="pill pill-open">啟用中</span>'
          : '<span class="pill pill-closed">已停用</span>'
      ].join('');
      const toggle = rule.status === 'active'
        ? `<button class="mini danger" onclick="disableRule('${escapeHtml(rule.publicId)}')">停用</button>`
        : `<button class="mini" onclick="enableRule('${escapeHtml(rule.publicId)}')">啟用</button>`;
      return `<div class="row">
        <div class="grow"><b>${escapeHtml(rule.text)}</b><small>${escapeHtml(rule.ruleType)}</small></div>
        ${pills}
        <button class="mini" ${index === 0 ? 'disabled' : ''} onclick="moveRule(${index}, -1)">↑</button>
        <button class="mini" ${index === state.rules.length - 1 ? 'disabled' : ''} onclick="moveRule(${index}, 1)">↓</button>
        ${toggle}
      </div>`;
    }).join('');
  } catch (error) {
    box.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  }
}

// 上/下移一格之後把**整份**順序送回去。只送被移動的那兩筆的話,伺服器沒辦法
// 判斷其他規則該排在哪裡。
async function moveRule(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.rules.length) return;
  const order = state.rules.map((rule) => rule.publicId);
  const [moved] = order.splice(index, 1);
  order.splice(target, 0, moved);
  try {
    await api(`/v2/api/landlord/listings/${encodeURIComponent(state.current)}/rules/reorder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order })
    });
    loadRules();
  } catch (error) {
    alert(error.message);
  }
}

async function disableRule(publicId) {
  if (!confirm('停用之後 AI 就不會再參考這條規則，紀錄仍會保留。要繼續嗎？')) return;
  try {
    await api(`/v2/api/landlord/listings/${encodeURIComponent(state.current)}/rules/${encodeURIComponent(publicId)}/disable`, { method: 'POST' });
    loadRules();
  } catch (error) {
    alert(error.message);
  }
}

async function enableRule(publicId) {
  try {
    await api(`/v2/api/landlord/listings/${encodeURIComponent(state.current)}/rules/${encodeURIComponent(publicId)}/enable`, { method: 'POST' });
    loadRules();
  } catch (error) {
    alert(error.message);
  }
}

(async () => {
  const config = window.APP_CONFIG || {};
  if (config.liffId && typeof liff !== 'undefined') {
    try {
      await liff.init({ liffId: config.liffId });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return;
      }
    } catch (error) {
      console.error('LIFF init failed', error);
    }
  }
  loadListings();
})();

window.switchTab = switchTab;
window.createSlot = createSlot;
window.closeSlot = closeSlot;
window.removeSlot = removeSlot;
window.moveRule = moveRule;
window.disableRule = disableRule;
window.enableRule = enableRule;
