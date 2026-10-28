(() => {
  const root = document.getElementById('guided-inspection-root');
  const publicId = window.GUIDED_INSPECTION?.publicId;
  let state = null;
  let activeOperations = 0;
  let busyMessage = '';

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || '目前無法完成操作，請稍後再試。');
    return payload;
  }

  function itemSource(source) {
    return ({ unit_amenity: '房源設備', listing_reference: '591／房源參考', tenant_added: '房客新增' })[source] || '房源參考';
  }

  function statusText(item) {
    return ({ completed: '已完成', skipped: '暫時略過', not_present: '現場無此設備', pending: '待點交' })[item.status] || '待點交';
  }

  function progress(items) {
    return items.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, { pending: 0, completed: 0, skipped: 0, not_present: 0 });
  }

  function itemImages(item) {
    if (!item.imageUrls?.length) return '';
    return `<div class="item-images">${item.imageUrls.map((url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.name)} 點交照片">`).join('')}</div>`;
  }

  function referenceGallery() {
    if (!state.referenceImages?.length) return '';
    return `<details class="reference-gallery"><summary>查看刊登參考照片（非正式點交照片）</summary>
      <p>這些照片只用來幫助辨識現場設備，尚未逐項標記，因此不會被當作任一設備的原始屋況證據。</p>
      <div>${state.referenceImages.map((url) => `<img src="${escapeHtml(url)}" alt="房源刊登參考照片">`).join('')}</div>
    </details>`;
  }

  function pendingCard(item, isCurrent) {
    const actionLabel = isCurrent ? '現在點交' : '下一項';
    return `<article class="bubble ${isCurrent ? 'current' : 'next'}" data-item-id="${item.id}">
      <div class="bubble-top"><span class="bubble-number">${isCurrent ? '現在' : actionLabel}</span><span>${escapeHtml(itemSource(item.source))}</span></div>
      <h2>${escapeHtml(item.name)}</h2>
      <p>${isCurrent ? '拍一張近照，必要時補上瑕疵或使用狀況。' : '完成目前項目後，這個項目會自動往前。'}</p>
      ${isCurrent ? `<div class="capture-panel">
        ${itemImages(item)}
        <label class="camera-button">📷 拍攝／選擇照片<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" data-upload="${item.id}"></label>
        <textarea data-note="${item.id}" maxlength="1000" placeholder="選填：例如門邊有小刮痕、可正常運作">${escapeHtml(item.note)}</textarea>
        <div class="action-row">
          <button class="primary" data-complete="${item.id}">儲存並完成此項</button>
          <button class="secondary" data-skip="${item.id}">暫時略過</button>
        </div>
        <button class="link-button" data-absent="${item.id}">現場沒有這項設備</button>
      </div>` : ''}
    </article>`;
  }

  function foldedCard(item) {
    return `<details class="folded ${escapeHtml(item.status)}"><summary>
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(itemSource(item.source))}</small></span>
      <b>${statusText(item)}${item.imageCount ? ` · ${item.imageCount} 張` : ''}</b>
    </summary>
      ${item.note ? `<p class="saved-note">${escapeHtml(item.note)}</p>` : ''}
      ${itemImages(item)}
      <button class="link-button" data-reset="${item.id}">改回待點交</button>
    </details>`;
  }

  function render() {
    const items = state.items || [];
    const counts = progress(items);
    const pending = items.filter((item) => item.status === 'pending');
    const folded = items.filter((item) => item.status !== 'pending');
    root.innerHTML = `<style>
      :root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#18243a;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.page{width:min(720px,100%);margin:auto;padding:16px 14px 40px}.hero{background:linear-gradient(135deg,#0d766e,#223c31);color:white;padding:22px 18px;border-radius:22px;box-shadow:0 12px 32px #0f766e33}.hero p{margin:0 0 6px;color:#b9f2df;font-size:13px;font-weight:700}.hero h1{font-size:24px;margin:0;line-height:1.3}.progress{display:flex;flex-wrap:wrap;gap:8px;margin:15px 0 2px}.progress span{padding:5px 9px;border-radius:999px;background:#ffffff26;font-size:12px}.intro{margin:18px 3px;color:#58657a;font-size:14px;line-height:1.65}.bubble-stack{display:grid;gap:11px}.bubble{border:1px solid #dce4ed;border-radius:22px;background:#fff;padding:17px;box-shadow:0 4px 16px #17233a0a}.bubble.current{border:2px solid #f4b627;background:linear-gradient(145deg,#fffdf4,#fff);box-shadow:0 12px 28px #d39a1622}.bubble.next{opacity:.82;padding:14px 17px}.bubble-top{display:flex;justify-content:space-between;color:#748196;font-size:12px;font-weight:700}.bubble-number{color:#9a6510}.bubble h2{font-size:21px;margin:8px 0 5px}.bubble p{margin:0;color:#66758a;font-size:14px;line-height:1.5}.capture-panel{margin-top:16px}.camera-button{display:block;padding:14px;border:1px dashed #0d766e;border-radius:15px;color:#0a665f;background:#edfaf6;text-align:center;font-weight:800;cursor:pointer}.camera-button input{display:none}textarea{width:100%;min-height:82px;margin-top:10px;padding:12px;border:1px solid #d5dee8;border-radius:13px;font:inherit;font-size:14px;resize:vertical}.action-row{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}button{border:0;border-radius:13px;padding:13px 12px;font:inherit;font-weight:800;cursor:pointer}.primary{background:#16263d;color:#fff}.secondary{background:#f6c75a;color:#5f4200}.link-button{display:block;width:100%;background:transparent;color:#47718b;padding:10px;text-decoration:underline;font-size:13px}.item-images{display:flex;gap:8px;overflow:auto;margin:10px 0}.item-images img{width:88px;height:72px;object-fit:cover;border-radius:10px;border:1px solid #dae3ea}.section-head{display:flex;justify-content:space-between;align-items:center;margin:25px 2px 10px}.section-head h2{font-size:16px;margin:0}.add{background:#e9eef5;color:#243751;padding:9px 12px;font-size:13px}.folded{background:#fff;border:1px solid #dde4ec;border-radius:14px;margin:9px 0;padding:0 13px}.folded.completed{border-left:5px solid #17a673}.folded.skipped,.folded.not_present{border-left:5px solid #a5afbd}.folded summary{padding:14px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;list-style:none}.folded summary::-webkit-details-marker{display:none}.folded small{display:block;color:#7a8899;margin-top:3px}.folded b{font-size:12px;color:#4c7a68;text-align:right}.folded.skipped b,.folded.not_present b{color:#798494}.saved-note{background:#f5f8fa;border-radius:10px;padding:10px;margin:0;color:#526173;font-size:13px;white-space:pre-wrap}.reference-gallery{margin-top:18px;padding:13px;border-radius:14px;background:#eef3f7;color:#5d6d80;font-size:13px}.reference-gallery summary{font-weight:800;cursor:pointer}.reference-gallery p{line-height:1.55}.reference-gallery div{display:flex;gap:8px;overflow:auto}.reference-gallery img{width:100px;height:72px;object-fit:cover;border-radius:8px}.finish{position:sticky;bottom:8px;width:100%;margin-top:22px;background:#0d766e;color:#fff;box-shadow:0 8px 20px #0d766e44}.hint{font-size:12px;color:#7b8798;text-align:center;line-height:1.55;margin:10px 12px}.empty{padding:22px;background:#fff;border-radius:16px;color:#64748b;text-align:center}@media(max-width:390px){.action-row{grid-template-columns:1fr}.hero h1{font-size:21px}}
      .busy{position:fixed;inset:0;z-index:20;display:grid;place-items:center;background:#14203388;padding:24px}.busy[hidden]{display:none}.busy-card{width:min(320px,100%);background:#fff;border-radius:18px;padding:22px;box-shadow:0 16px 40px #0004;text-align:center}.busy-card strong{display:block;color:#17253b;margin-bottom:12px}.busy-bar{height:7px;overflow:hidden;border-radius:99px;background:#e4ebf0}.busy-bar::before{content:"";display:block;width:42%;height:100%;border-radius:inherit;background:#0d766e;animation:uploading 1.05s ease-in-out infinite}@keyframes uploading{from{transform:translateX(-120%)}to{transform:translateX(280%)}}button:disabled,.camera-button:has(input:disabled){opacity:.55;cursor:wait}
    </style><div class="page"><header class="hero"><p>入住前屋況點交</p><h1>${escapeHtml(state.session.title)}</h1><div class="progress"><span>✅ ${counts.completed} 已完成</span><span>⚡ ${counts.pending} 待點交</span><span>◌ ${(counts.skipped || 0) + (counts.not_present || 0)} 略過／無此設備</span></div></header>
    <p class="intro">先從眼前最重要的設備開始。你可隨時略過項目，最後只送出你實際想保留的屋況紀錄。</p>
    ${pending.length ? `<section class="bubble-stack">${pending.slice(0,3).map((item,index)=>pendingCard(item,index===0)).join('')}</section>` : '<div class="empty">目前沒有待處理設備。你可新增其他設備，或直接完成本次點交。</div>'}
    ${referenceGallery()}
    <div class="section-head"><h2>已處理項目</h2><button class="add" id="add-item">＋ 新增設備</button></div>
    <section>${folded.length ? folded.map(foldedCard).join('') : '<p class="hint">完成、略過或標記現場無此設備的項目會收合在這裡。</p>'}</section>
    <button class="finish" id="finish-inspection">完成點交並送房東確認</button><p class="hint">完成後不能修改，系統會建立房東通知與確認卡片。</p></div><div class="busy" id="inspection-busy" hidden><div class="busy-card"><strong id="inspection-busy-message">正在處理…</strong><div class="busy-bar"></div><p class="hint">請不要關閉頁面或送出點交。</p></div></div>`;
    bindEvents();
    if (activeOperations) setBusy(true, busyMessage);
  }

  function noteFor(itemId) { return document.querySelector(`[data-note="${itemId}"]`)?.value || ''; }
  function setBusy(isBusy, message = busyMessage) {
    busyMessage = message || busyMessage;
    const overlay = root.querySelector('#inspection-busy');
    const label = root.querySelector('#inspection-busy-message');
    if (overlay) overlay.hidden = !isBusy;
    if (label) label.textContent = busyMessage || '正在處理…';
    root.querySelectorAll('button,input,textarea').forEach((element) => { element.disabled = Boolean(isBusy); });
  }
  async function runBusy(message, operation) {
    activeOperations += 1;
    setBusy(true, message);
    try { return await operation(); }
    finally { activeOperations -= 1; if (!activeOperations) setBusy(false, ''); }
  }
  async function refresh() { const payload = await api(`/v2/api/tenant/pre-inspections/${encodeURIComponent(publicId)}/guided`); state = payload; render(); }
  async function setStatus(itemId, status) { await api(`/v2/api/tenant/pre-inspections/${encodeURIComponent(publicId)}/items/${itemId}`, { method:'POST', body:JSON.stringify({status,note:noteFor(itemId)}) }); await refresh(); }
  async function upload(itemId, file) {
    if (!file) return;
    file = await compressImage(file);
    if (file.size > 10 * 1024 * 1024) throw new Error('照片不可超過 10MB。');
    // Uploading a photo refreshes the guided card. Persist the in-progress note
    // first so a tenant never loses text just because the camera upload finished.
    await api(`/v2/api/tenant/pre-inspections/${encodeURIComponent(publicId)}/items/${itemId}`, {
      method:'POST', body:JSON.stringify({status:'pending',note:noteFor(itemId)})
    });
    busyMessage = '正在準備照片…'; setBusy(true, busyMessage);
    const dataUrl = await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
    busyMessage = '正在上傳照片…'; setBusy(true, busyMessage);
    await api(`/v2/api/tenant/pre-inspections/${encodeURIComponent(publicId)}/items/${itemId}/photo`, { method:'POST', body:JSON.stringify({dataUrl}) });
    await refresh();
  }
  function bindEvents() {
    root.querySelectorAll('[data-upload]').forEach((input)=>input.addEventListener('change', async (event)=>{try{await runBusy('正在保存備註與上傳照片…',()=>upload(input.dataset.upload,event.target.files[0]));}catch(error){alert(error.message);}}));
    root.querySelectorAll('[data-complete]').forEach((button)=>button.addEventListener('click',async()=>{try{await runBusy('正在完成這個設備…',()=>setStatus(button.dataset.complete,'completed'));}catch(error){alert(error.message);}}));
    root.querySelectorAll('[data-skip]').forEach((button)=>button.addEventListener('click',async()=>{try{await runBusy('正在更新設備狀態…',()=>setStatus(button.dataset.skip,'skipped'));}catch(error){alert(error.message);}}));
    root.querySelectorAll('[data-absent]').forEach((button)=>button.addEventListener('click',async()=>{try{await runBusy('正在更新設備狀態…',()=>setStatus(button.dataset.absent,'not_present'));}catch(error){alert(error.message);}}));
    root.querySelectorAll('[data-reset]').forEach((button)=>button.addEventListener('click',async()=>{try{await runBusy('正在恢復待點交項目…',()=>setStatus(button.dataset.reset,'pending'));}catch(error){alert(error.message);}}));
    root.querySelector('#add-item')?.addEventListener('click',async()=>{const itemName=prompt('新增要記錄的設備名稱');if(!itemName)return;try{await runBusy('正在新增設備…',async()=>{await api(`/v2/api/tenant/pre-inspections/${encodeURIComponent(publicId)}/items`,{method:'POST',body:JSON.stringify({itemName})});await refresh();});}catch(error){alert(error.message);}});
    root.querySelector('#finish-inspection')?.addEventListener('click',async()=>{if(activeOperations||!confirm('完成後這筆點交會封存並送房東確認，不能再修改。確定要完成嗎？'))return;try{const result=await runBusy('正在封存點交並通知房東…',()=>api(`/v2/api/tenant/pre-inspections/${encodeURIComponent(publicId)}/complete`,{method:'POST',body:'{}'}));alert(result.message);location.href=`/tenant/pre-inspections/${encodeURIComponent(publicId)}`;}catch(error){alert(error.message);}});
  }
  refresh().catch((error)=>{root.innerHTML=`<p style="padding:32px;color:#b91c1c">${escapeHtml(error.message)}</p>`;});
})();
