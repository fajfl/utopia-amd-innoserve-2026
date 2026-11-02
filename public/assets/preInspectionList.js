window.onerror = function(message, source, lineno, colno, error) {
  if (message.includes('Unexpected EOF') && source && source.includes('ngrok-free.dev')) {
    console.warn('Ignored ngrok EOF error:', message);
    return true; // Ignore and don't alert
  }
  alert('JS Error: ' + message + ' at ' + source + ':' + lineno);
  return false;
};

function getToken() {
  const config = window.APP_CONFIG || {};
  if (config.token) return config.token;
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

function authenticatedUrl(path) {
  const token = getToken();
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

async function loadPreInspectionList() {
  const container = document.getElementById('pi-list');

  try {
    const response = await fetch(authenticatedUrl(`/v2/api/tenant/pre-inspection-list?_t=${Date.now()}`), {
      cache: 'no-store',
      headers: { 'Pragma': 'no-cache', 'Cache-Control': 'no-cache' }
    });
    const data = await response.json();

    if (!data.ok) {
      container.innerHTML = `<p style="text-align:center; color:#dc2626; font-size:14px; margin-top:40px;">${data.error || '連結已失效，請回到 LINE 聊天室重新開啟屋況點交列表。'}</p>`;
      return;
    }

    if (!data.items || data.items.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:#6b7280; font-size:14px; margin-top:40px;">目前尚無找房或點交紀錄</p>';
      return;
    }

    container.innerHTML = data.items.map(item => {
      let badgeClass = 'badge-none';
      let badgeText = '尚未點交';
      let status = 'none';

      if (item.session) {
        status = item.session.status;
        if (item.session.status === 'active') {
          badgeClass = 'badge-active';
          badgeText = '⏳ 點交進行中';
        } else if (item.session.confirmationStatus === 'landlord_confirmed') {
          badgeClass = 'badge-done';
          badgeText = '✅ 點交完成';
        } else if (item.session.status === 'sealed') {
          badgeClass = 'badge-sealed';
          badgeText = '📋 已封存待確認';
        }
      }

      const defaultImg = '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="#9ca3af" style="padding:16px;"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>';
      const imageTag = item.imageUrl
        ? `<img class="house-img" src="${item.imageUrl}" onerror="this.outerHTML=decodeURIComponent('${encodeURIComponent(defaultImg)}')">`
        : defaultImg;

      let btnGroup = '';
      let statusNote = '';

      if (status === 'active') {
        btnGroup = `
          <button class="btn btn-start" onclick="continueGuidedPreInspection('${item.session.publicId}')">繼續引導式點交</button>
          <button class="btn btn-delete" style="background-color:#ef4444;color:#fff;" onclick="cancelActivePreInspection(this, '${item.session.publicId}')">放棄本次紀錄</button>
        `;
        statusNote = `<div class="status-note" style="font-size:12px;color:#0f766e;margin-top:8px;text-align:center;">從這裡繼續拍攝設備照片、填寫備註或略過項目。</div>`;
      } else if (status === 'sealed') {
        const confStatus = item.session ? item.session.confirmationStatus : null;
        const isSubmitted = confStatus === 'pending_landlord_confirmation' || confStatus === 'landlord_confirmed';
        const canDelete = !confStatus || confStatus === 'not_sent';

        const deleteBtn = canDelete
          ? `<button class="btn btn-delete" style="background-color:#ef4444;color:#fff;" onclick="deletePreInspection(this, '${item.session.publicId}')">移除紀錄包</button>`
          : '';

        if (isSubmitted) {
          statusNote = `<div class="status-note" style="font-size:12px;color:#6b7280;margin-top:8px;text-align:center;">已送交房東確認，紀錄將保留作為雙方依據</div>`;
        }

        btnGroup = `
          <button class="btn btn-view" onclick="viewPreInspection('${item.session.publicId}')">查看內容</button>
          ${deleteBtn}
        `;
      } else if (item.appointmentPublicId) {
        btnGroup = `
          <button class="btn btn-start" onclick="startPreInspection(this, '${item.appointmentPublicId}')">開始屋況點交</button>
        `;
        statusNote = `<div class="status-note" style="font-size:12px;color:#0f766e;margin-top:8px;text-align:center;">已核准看房：${(item.appointmentStartsAt || '').replace('T', ' ')}</div>`;
      }

      return `
        <div class="house-card">
          <div class="house-main">
            <div class="house-img-container">
              ${imageTag}
            </div>
            <div class="house-info">
              <h2 class="house-title">${item.title}</h2>
              <p class="house-rent">$${item.rentAmount ? item.rentAmount.toLocaleString() : '0'} 元/月</p>
              <span class="house-badge ${badgeClass}">${badgeText}</span>
            </div>
          </div>
          <div class="btn-group">
            ${btnGroup}
          </div>
          ${statusNote}
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error(err);
    if (container) {
      container.innerHTML = '<p style="text-align:center; color:#dc2626; font-size:14px; margin-top:40px;">連結已失效，請回到 LINE 聊天室重新開啟屋況點交列表。</p>';
    }
  }
}

async function startPreInspection(target, appointmentPublicIdArg) {
  let appointmentPublicId = appointmentPublicIdArg;
  let btn = null;

  if (target && target.tagName === 'BUTTON') {
    btn = target;
  } else if (typeof target === 'number' || typeof target === 'string') {
    appointmentPublicId = target;
  }

  if (!appointmentPublicId) return;

  if (btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.dataset.origText = btn.innerText;
    btn.innerText = '處理中...';
  }

  try {
    const res = await fetch(authenticatedUrl('/v2/api/tenant/pre-inspections/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appointmentPublicId })
    });
    const data = await res.json();
    if (data.ok) {
      location.href = authenticatedUrl(`/tenant/pre-inspections/${encodeURIComponent(data.sessionPublicId)}/capture`);
    } else {
      alert(data.error || '無法開啟屋況點交');
      loadPreInspectionList();
    }
  } catch (e) {
    alert('網路請求出錯');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = btn.dataset.origText || '開始屋況點交';
    }
  }
}

async function deletePreInspection(target, sessionPublicIdArg) {
  let sessionPublicId = sessionPublicIdArg;
  let btn = null;

  if (target && target.tagName === 'BUTTON') {
    btn = target;
  } else if (typeof target === 'string') {
    sessionPublicId = target;
  }

  if (!sessionPublicId) return;
  if (!confirm('確定要移除此屋況紀錄包嗎？')) return;

  if (btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.innerText = '處理中...';
  }

  try {
    const res = await fetch(authenticatedUrl('/v2/api/tenant/pre-inspections/delete'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionPublicId })
    });
    const data = await res.json();
    if (data.ok) {
      alert('已成功移除該紀錄包');
      await loadPreInspectionList();
    } else {
      alert(data.error || '移除失敗');
    }
  } catch (e) {
    alert('網路請求出錯');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '移除紀錄包';
    }
  }
}

async function cancelActivePreInspection(target, sessionPublicIdArg) {
  let sessionPublicId = sessionPublicIdArg;
  let btn = null;

  if (target && target.tagName === 'BUTTON') {
    btn = target;
  } else if (typeof target === 'string') {
    sessionPublicId = target;
  }

  if (!sessionPublicId) return;
  if (!confirm('確定要放棄本次屋況點交紀錄嗎？已上傳的照片與備註將不再保留。')) return;

  if (btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.innerText = '處理中...';
  }

  try {
    const res = await fetch(authenticatedUrl('/v2/api/tenant/pre-inspections/delete'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionPublicId })
    });
    const data = await res.json();
    if (data.ok) {
      alert('已放棄本次屋況點交紀錄');
      await loadPreInspectionList();
    } else {
      alert(data.error || '放棄失敗');
    }
  } catch (e) {
    alert('網路請求出錯');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '放棄本次紀錄';
    }
  }
}

function viewPreInspection(sessionPublicId) {
  if (!sessionPublicId) {
    alert('尚無可查看的屋況紀錄');
    return;
  }
  location.href = authenticatedUrl(`/tenant/pre-inspections/${sessionPublicId}`);
}

function continueGuidedPreInspection(sessionPublicId) {
  if (!sessionPublicId) return;
  location.href = authenticatedUrl(`/tenant/pre-inspections/${encodeURIComponent(sessionPublicId)}/capture`);
}

// Init
loadPreInspectionList();

// Expose to global
window.loadPreInspectionList = loadPreInspectionList;
window.startPreInspection = startPreInspection;
window.deletePreInspection = deletePreInspection;
window.cancelActivePreInspection = cancelActivePreInspection;
window.viewPreInspection = viewPreInspection;
window.continueGuidedPreInspection = continueGuidedPreInspection;
