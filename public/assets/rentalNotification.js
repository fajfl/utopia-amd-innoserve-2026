document.addEventListener('DOMContentLoaded', async () => {
  const { liffId, publicDemo } = window.APP_CONFIG || {};

  try {
    if (!publicDemo && liffId) {
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }
    }
    
    await loadData();
  } catch (err) {
    showError(err.message || '初始化失敗，請稍後再試。');
  }
});

function showError(msg) {
  document.getElementById('loading').style.display = 'none';
  const errEl = document.getElementById('error');
  errEl.style.display = 'block';
  errEl.textContent = msg;
}

function formatDate(isoString) {
  if (!isoString) return '尚未提供';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function loadData() {
  try {
    let headers = {};
    let apiUrl = '/v2/api/tenant/rental-notification';
    if (window.liff && liff.isLoggedIn()) {
      headers['Authorization'] = `Bearer ${liff.getAccessToken()}`;
    }
    const urlParams = new URLSearchParams(location.search);
    const qLineUserId = urlParams.get('lineUserId');
    if (qLineUserId) apiUrl += `?lineUserId=${encodeURIComponent(qLineUserId)}`;

    const res = await fetch(apiUrl, { headers });
    const json = await res.json();

    if (!json.ok) {
      throw new Error(json.error || '無法取得租屋資料');
    }

    render(json.data);
  } catch (err) {
    showError(err.message);
  }
}

function render(data) {
  document.getElementById('loading').style.display = 'none';
  const container = document.getElementById('app-container');
  container.style.display = 'grid';
  container.innerHTML = ''; // clear

  if (!data.lease && !data.signing?.hasDraft) {
    container.innerHTML = `<div class="card"><div style="text-align:center; padding: 20px; color: #6b7280;">目前無生效合約或進行中的簽約。</div></div>`;
    return;
  }

  // 1. Renewal Alert
  if (data.renewal && data.renewal.inRenewalPeriod) {
    container.innerHTML += `
      <div class="renewal-alert">
        <strong>⚠️ 續約提醒</strong>
        您的租約將於 ${formatDate(data.renewal.endDate)} 到期，目前已進入續約考慮期（到期前兩個月）。請與房東確認是否續約。
      </div>
    `;
  } else if (data.renewal && data.renewal.isExpired) {
    container.innerHTML += `
      <div class="renewal-alert" style="color:#dc2626; border-color:#fca5a5; background:#fef2f2;">
        <strong>⚠️ 租約已到期</strong>
        您的租約已於 ${formatDate(data.renewal.endDate)} 到期。
      </div>
    `;
  }

  // 2. Property & Status
  let statusHtml = '';
  if (data.lease) {
    if (data.lease.status === 'active') statusHtml = `<span class="status-badge status-active">履行中</span>`;
    else if (data.lease.status === 'ended') statusHtml = `<span class="status-badge status-expired">已結束</span>`;
    else if (data.lease.status === 'scheduled') statusHtml = `<span class="status-badge status-pending">即將生效</span>`;
  } else if (data.signing && data.signing.hasDraft) {
    if (data.signing.contractStatus === 'drafting') statusHtml = `<span class="status-badge status-warning">草稿擬定中</span>`;
    else if (data.signing.contractStatus === 'awaiting_confirmation') statusHtml = `<span class="status-badge status-warning">等待確認中</span>`;
    else if (data.signing.contractStatus === 'signing') statusHtml = `<span class="status-badge status-pending">簽署中</span>`;
  }

  const prop = data.property;
  if (prop) {
    const address = (prop.addressText || '') + (prop.buildingName ? ` (${prop.buildingName})` : '');
    container.innerHTML += `
      <div class="card">
        <h2 class="card-title">房屋資訊</h2>
        <div class="info-row"><span class="info-label">狀態</span><span class="info-value">${statusHtml}</span></div>
        <div class="info-row"><span class="info-label">地址</span><span class="info-value">${address || '未提供'}</span></div>
        <div class="info-row"><span class="info-label">房號</span><span class="info-value">${prop.unitLabel || '無'}</span></div>
        <div class="info-row"><span class="info-label">類型</span><span class="info-value">${prop.rentalType === 'whole' ? '整層住家' : prop.rentalType === 'suite' ? '獨立套房' : prop.rentalType === 'shared_suite' ? '分租套房' : prop.rentalType === 'room' ? '雅房' : '其他'}</span></div>
      </div>
    `;
  }

  // 3. Contract Info
  if (data.contract) {
    const c = data.contract;
    const rent = c.monthlyRent ? \`\${c.monthlyRent.toLocaleString()} 元/月\` : '尚未提供';
    const deposit = c.depositAmount ? \`\${c.depositAmount.toLocaleString()} 元\` : '尚未提供';
    const startDate = data.lease?.startDate ? formatDate(data.lease.startDate) : '尚未提供';
    const endDate = data.lease?.endDate ? formatDate(data.lease.endDate) : '尚未提供';
    const dueDay = data.lease?.rentDueDay ? \`每月 \${data.lease.rentDueDay} 日\` : (c.paymentDueDay ? \`每月 \${c.paymentDueDay} 日\` : '尚未提供');
    
    container.innerHTML += `
      <div class="card">
        <h2 class="card-title">合約與租金</h2>
        <div class="info-row"><span class="info-label">租期起日</span><span class="info-value">${startDate}</span></div>
        <div class="info-row"><span class="info-label">租期迄日</span><span class="info-value">${endDate}</span></div>
        <div class="info-row"><span class="info-label">每月租金</span><span class="info-value">${rent}</span></div>
        <div class="info-row"><span class="info-label">押金金額</span><span class="info-value">${deposit}</span></div>
        <div class="info-row"><span class="info-label">繳租日</span><span class="info-value">${dueDay}</span></div>
      </div>
    `;
  } else if (data.signing && data.signing.hasDraft) {
    container.innerHTML += `
      <div class="card">
        <h2 class="card-title">簽約進度</h2>
        <div class="info-row"><span class="info-label">房東簽署</span><span class="info-value">${data.signing.landlordSigned ? '✅ 已簽署' : '⏳ 尚未'}</span></div>
        <div class="info-row"><span class="info-label">房客簽署</span><span class="info-value">${data.signing.tenantSigned ? '✅ 已簽署' : '⏳ 尚未'}</span></div>
        <div style="font-size:12px; color:#6b7280; margin-top:8px;">正式合約生效後，此處將顯示詳細租約與租金資訊。</div>
      </div>
    `;
  }

  // 4. Parties
  const landlord = data.landlord;
  const tenant = data.tenant;
  if (landlord || tenant) {
    container.innerHTML += `
      <div class="card">
        <h2 class="card-title">當事人</h2>
        <div class="info-row"><span class="info-label">房東</span><span class="info-value">${landlord?.displayName || landlord?.legalName || '尚未提供'}</span></div>
        <div class="info-row"><span class="info-label">房客</span><span class="info-value">${tenant?.displayName || tenant?.legalName || '尚未提供'}</span></div>
      </div>
    `;
  }

  // 5. Viewing Reservation
  if (data.viewingReservation) {
    const v = data.viewingReservation;
    const timeStr = new Date(v.startsAt).toLocaleString('zh-TW', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    container.innerHTML += `
      <div class="card">
        <h2 class="card-title">預約看房</h2>
        <div class="viewing-item">
          <div style="font-weight:600; font-size:15px; margin-bottom:4px;">${v.listingTitle || '未命名房源'}</div>
          <div style="font-size:14px; color:#4b5563;">時間：${timeStr}</div>
          <div style="margin-top:8px;"><span class="status-badge status-active">已確認</span></div>
        </div>
      </div>
    `;
  }

  // 6. Repairs
  if (data.repairs && data.repairs.length > 0) {
    let repairsHtml = '';
    for (const r of data.repairs) {
      let rStatus = '';
      if (r.status === 'reported') rStatus = '<span class="status-badge status-warning" style="font-size:11px;">待處理</span>';
      else if (r.status === 'accepted') rStatus = '<span class="status-badge status-pending" style="font-size:11px;">已受理</span>';
      else if (r.status === 'in_progress') rStatus = '<span class="status-badge status-pending" style="font-size:11px;">處理中</span>';
      else if (r.status === 'landlord_completed' || r.status === 'tenant_confirmed') rStatus = '<span class="status-badge status-active" style="font-size:11px;">已完成</span>';
      else if (r.status === 'rejected') rStatus = '<span class="status-badge status-expired" style="font-size:11px;">已拒絕</span>';
      
      const rTime = new Date(r.reportedAt).toLocaleDateString('zh-TW');
      repairsHtml += `
        <div class="repair-item">
          <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
            <strong style="font-size:14px; color:#111827;">${r.category || '報修'}</strong>
            ${rStatus}
          </div>
          <div style="font-size:13px; color:#4b5563; margin-bottom:4px;">${r.description || '無描述'}</div>
          <div style="font-size:12px; color:#9ca3af;">回報日期：${rTime}</div>
        </div>
      `;
    }
    
    container.innerHTML += `
      <div class="card">
        <h2 class="card-title">最新報修進度</h2>
        ${repairsHtml}
      </div>
    `;
  }
}
