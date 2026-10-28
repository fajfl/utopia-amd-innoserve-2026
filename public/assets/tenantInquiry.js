window.onerror = function(message, source, lineno, colno, error) {
  if (message.includes('Unexpected EOF') && source && source.includes('ngrok-free.dev')) {
    console.warn('Ignored ngrok EOF error:', message);
    return true; // Ignore and don't alert
  }
  alert('JS Error: ' + message + ' at ' + source + ':' + lineno);
  return false;
};

async function loadInquiries() {
  try {
    const response = await fetch('/v2/api/tenant/inquiries');
    const data = await response.json();
    const container = document.getElementById('inquiry-list');
    
    if (!data.ok || !data.inquiries || data.inquiries.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:#6b7280; font-size:14px; margin-top:40px;">目前尚無進行中的找房紀錄</p>';
      return;
    }

    container.innerHTML = data.inquiries.map(inq => {
      const badgeClass = inq.isActiveContext ? 'badge-active' : 'badge-inactive';
      const badgeText = inq.isActiveContext ? '💬 對話中' : '已關聯';
      
      let apptHtml = '';
      if (inq.appointment) {
        const timeStr = inq.appointment.startsAt.replace('T', ' ');
        let statusLabel = '';
        let statusClass = '';
        
        if (inq.appointment.status === 'pending') {
          statusLabel = '房東確認中';
          statusClass = 'appt-pending';
        } else if (inq.appointment.status === 'confirmed') {
          statusLabel = '預約成功';
          statusClass = 'appt-confirmed';
        } else if (inq.appointment.status === 'rejected') {
          statusLabel = '房東婉拒';
          statusClass = 'appt-rejected';
        }
        
        apptHtml = `
          <div class="appt-status ${statusClass}">
            <span>🕒 ${statusLabel}：${timeStr}</span>
            ${inq.appointment.status !== 'rejected' ? `<button class="btn-cancel" onclick="cancelAppointment('${inq.appointment.publicId}')">取消預約</button>` : ''}
          </div>
        `;
      }

      const defaultImg = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="#9ca3af" style="padding:16px;"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`;
      const imageTag = inq.imageUrl 
        ? `<img class="house-img" src="${inq.imageUrl}" onerror="this.outerHTML='${defaultImg}'">`
        : defaultImg;

      return `
        <div class="house-card">
          <div class="house-main">
            <div class="house-img-container">
              ${imageTag}
            </div>
            <div class="house-info">
              <h2 class="house-title">${inq.title || '（未提供名稱）'}</h2>
              <p class="house-rent">${typeof inq.rentAmount === 'number' ? '$' + inq.rentAmount.toLocaleString() + ' 元/月' : '租金面議'}</p>
              <span class="house-badge ${badgeClass}">${badgeText}</span>
            </div>
          </div>
          
          ${apptHtml}

          <div class="btn-group">
            <button class="btn btn-ask" ${inq.isActiveContext ? 'disabled' : ''} onclick="activateInquiry('${inq.publicId}')">
              ${inq.isActiveContext ? '目前詢問中' : '【按我詢問】'}
            </button>
            <button class="btn btn-reserve" onclick="toggleReserveBox('${inq.publicId}')">
              【看房預約】
            </button>
          </div>

          <div class="reserve-box" id="reserve-${inq.publicId}">
            <label>選擇房東開放的看房時段</label>
            <select id="time-${inq.publicId}" required>
              <option value="">載入中…</option>
            </select>
            <div class="reserve-btn-row">
              <button class="btn-submit-appt" onclick="submitAppointment('${inq.publicId}')">提交預約</button>
              <button class="btn-cancel-appt" onclick="toggleReserveBox('${inq.publicId}')">取消</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
    document.getElementById('inquiry-list').innerHTML = '<p style="text-align:center; color:#dc2626; font-size:14px;">資料載入失敗，請重試</p>';
  }
}

function closeLiffWindow() {
  try {
    if (window.liff && typeof liff.isInClient === 'function' && liff.isInClient()) {
      liff.closeWindow();
      return true;
    }
  } catch (error) {
    console.warn('liff.isInClient check error:', error.message);
  }
  return false;
}

function showActivateModal(listingTitle) {
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const descEl = document.getElementById('modal-desc');

  if (titleEl) titleEl.textContent = '對話情境已切換';
  if (descEl) descEl.textContent = `已成功切換為詢問「${listingTitle || '此房源'}」！正在返回 LINE 聊天室...`;

  if (overlay) overlay.classList.add('active');
}

function closeModalAndReturn() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('active');

  const closed = closeLiffWindow();
  if (!closed) {
    const btn = document.getElementById('modal-confirm-btn');
    if (btn) {
      btn.textContent = '重新載入清單';
      btn.onclick = () => { document.getElementById('modal-overlay').classList.remove('active'); loadInquiries(); };
    }
  }
}

async function activateInquiry(publicId) {
  try {
    const res = await fetch(`/v2/api/tenant/inquiries/${publicId}/activate`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showActivateModal(data.listingTitle);
    } else {
      alert('切換失敗: ' + (data.error || '未知錯誤'));
    }
  } catch (e) {
    alert('網路請求出錯');
  }
}

// 時間不再由房客自己填。看房時段是房東開出來的,這裡只負責把目前還能選的那些
// 撈回來塞進下拉選單;送出去的是 slotPublicId,不是時間字串——後端也不收時間。
async function loadSlots(inquiryPublicId) {
  const select = document.getElementById(`time-${inquiryPublicId}`);
  if (!select) return;
  const reserveBox = document.getElementById(`reserve-${inquiryPublicId}`);
  const label = reserveBox.querySelector('label');
  const btnRow = reserveBox.querySelector('.reserve-btn-row');
  
  select.style.display = 'block';
  label.innerText = '選擇房東開放的時段';
  btnRow.innerHTML = `
    <button class="btn-submit-appt" onclick="submitAppointment('${inquiryPublicId}')">提交預約</button>
    <button class="btn-cancel-appt" onclick="toggleReserveBox('${inquiryPublicId}')">取消</button>
  `;

  select.innerHTML = '<option value="">載入中…</option>';
  try {
    const res = await fetch(`/v2/api/tenant/inquiries/${encodeURIComponent(inquiryPublicId)}/slots`);
    const data = await res.json();
    const slots = (data.ok && data.slots) || [];
    if (!slots.length) {
      select.style.display = 'none';
      label.innerText = '房東目前尚未開放看房時段';
      btnRow.innerHTML = `
        <button class="btn-submit-appt" onclick="requestSlots('${inquiryPublicId}')" style="background:#0F766E;">向房東索取看房時間</button>
        <button class="btn-cancel-appt" onclick="toggleReserveBox('${inquiryPublicId}')">取消</button>
      `;
      return;
    }
    select.innerHTML = '<option value="">請選擇時段</option>' + slots.map(slot => {
      const timeLabel = slot.startsAt.replace('T', ' ') + (slot.endsAt ? ' ~ ' + slot.endsAt.replace('T', ' ') : '');
      return `<option value="${slot.publicId}">${timeLabel}</option>`;
    }).join('');
  } catch (e) {
    select.innerHTML = '<option value="">時段載入失敗，請重試</option>';
  }
}

const pendingSlotRequests = new Set();
async function requestSlots(inquiryPublicId) {
  if (pendingSlotRequests.has(inquiryPublicId)) return;
  pendingSlotRequests.add(inquiryPublicId);
  try {
    const res = await fetch(`/v2/api/tenant/inquiries/${encodeURIComponent(inquiryPublicId)}/request-slots`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      alert(data.message || '已傳送提醒！系統已推播通知房東開放時段。');
      toggleReserveBox(inquiryPublicId);
    } else {
      alert('提醒失敗: ' + (data.error || '未知錯誤'));
    }
  } catch (e) {
    alert('網路請求出錯');
  } finally {
    pendingSlotRequests.delete(inquiryPublicId);
  }
}

function toggleReserveBox(publicId) {
  const box = document.getElementById(`reserve-${publicId}`);
  box.classList.toggle('open');
  if (box.classList.contains('open')) loadSlots(publicId);
}

async function submitAppointment(inquiryPublicId) {
  const slotPublicId = document.getElementById(`time-${inquiryPublicId}`).value;
  if (!slotPublicId) {
    alert('請選擇房東開放的看房時段');
    return;
  }
  try {
    const res = await fetch('/v2/api/tenant/appointments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inquiryPublicId, slotPublicId })
    });
    const data = await res.json();
    if (data.ok) {
      const closed = closeLiffWindow();
      if (!closed) loadInquiries();
    } else {
      alert('提交失敗: ' + (data.error || '未知錯誤'));
    }
  } catch (e) {
    alert('網路請求出錯');
  }
}

async function cancelAppointment(publicId) {
  if (!confirm('確定要取消此看房預約嗎？')) return;
  try {
    const res = await fetch(`/v2/api/tenant/appointments/${publicId}/cancel`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      const closed = closeLiffWindow();
      if (!closed) loadInquiries();
    } else {
      alert('取消失敗: ' + (data.error || '未知錯誤'));
    }
  } catch (e) {
    alert('網路請求出錯');
  }
}

// 初始化
(async () => {
  const config = window.APP_CONFIG || {};
  if (config.liffId && typeof liff !== 'undefined') {
    try {
      await liff.init({ liffId: config.liffId });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return;
      }
    } catch (e) {
      console.error('LIFF init failed', e);
    }
  }
  loadInquiries();
})();

// 明確曝露至全域，防止 WebView 隔離
window.loadInquiries = loadInquiries;
window.activateInquiry = activateInquiry;
window.closeModalAndReturn = closeModalAndReturn;
window.closeLiffWindow = closeLiffWindow;
window.toggleReserveBox = toggleReserveBox;
window.loadSlots = loadSlots;
window.submitAppointment = submitAppointment;
window.cancelAppointment = cancelAppointment;
window.requestSlots = requestSlots;
