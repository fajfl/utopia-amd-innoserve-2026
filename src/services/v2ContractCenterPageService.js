const { escapeHtml } = require('./v2ContractDocumentService');

const STAGES = ['協調完成', '草稿完成', '房客簽署', '房東簽署'];

function formatDate(value) {
  if (!value) return '尚未更新';
  const date = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10).replace(/-/g, '/');
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function roleLabel(roles) {
  const labels = { tenant: '房客', landlord: '房東', guarantor: '保證人', agent: '代理人', witness: '見證人' };
  return roles.map((role) => labels[role] || role).join('、');
}

function stageRail(contract) {
  return `<ol class="contract-rail" aria-label="合約進度">${STAGES.map((label, index) => {
    const state = contract.stage >= 4 || index < contract.stage ? 'done' : index === contract.stage ? 'active' : 'todo';
    return `<li data-state="${state}"><span class="rail-dot">${state === 'done' ? '✓' : index + 1}</span><b>${label}</b></li>`;
  }).join('')}</ol>`;
}

function contractAction(contract, primary = false) {
  if (!contract.action) return '';
  if (!primary) return `<a class="row-action" href="${escapeHtml(contract.action.url)}" aria-label="${escapeHtml(contract.action.label)}"><span aria-hidden="true">→</span></a>`;
  return `<a class="primary-action" href="${escapeHtml(contract.action.url)}">${escapeHtml(contract.action.label)}<span aria-hidden="true">→</span></a>`;
}

function contractRow(contract, index) {
  const asset = index % 2 === 0 ? '/assets/contract-center/home.png' : '/assets/contract-center/building.png';
  return `<article class="contract-row">
    <img src="${asset}" alt="" loading="lazy">
    <div class="contract-row-copy"><div class="contract-row-heading"><h3>${escapeHtml(contract.title)}</h3><span class="status ${escapeHtml(contract.tone)}">${escapeHtml(contract.statusLabel)}</span></div>
    <p>${escapeHtml(`住宅租賃合約${contract.latestVersionNumber ? `（第 ${contract.latestVersionNumber} 版）` : ''}`)}・你的身分：${escapeHtml(roleLabel(contract.roles))}</p>
    <strong>${escapeHtml(contract.headline)}</strong><small>更新時間 ${escapeHtml(formatDate(contract.updatedAt))}</small></div>
    ${contractAction(contract)}
  </article>`;
}

function emptyState() {
  return `<section class="empty-card"><img src="/assets/contract-center/home.png" alt=""><h2>目前沒有合約</h2><p>和合約助手談定承租條件後，草稿、簽署與完成紀錄都會集中在這裡。</p><a class="secondary-action" href="javascript:history.back()">回 LINE 繼續討論</a></section>`;
}

function page({ attention, currentContracts, history }) {
  const allContracts = [...currentContracts, ...history];
  const hero = attention ? `<section class="attention-card">
    <div class="attention-top"><div><span class="eyebrow">待你處理</span><h2>${escapeHtml(attention.title)}</h2><p>住宅租賃合約${attention.latestVersionNumber ? `（第 ${attention.latestVersionNumber} 版）` : ''}</p></div><span class="status ${escapeHtml(attention.tone)}">${escapeHtml(attention.statusLabel)}</span></div>
    <div class="attention-message"><div><strong>${escapeHtml(attention.headline)}</strong><p>${escapeHtml(attention.detail)}</p></div><img src="/assets/contract-center/draft-signing.png" alt="合約文件與簽署筆"></div>
    ${stageRail(attention)}
    ${contractAction(attention, true)}
    ${attention.contractPublicId && attention.status !== 'executed' ? `<a class="text-action" href="/v2/contracts/${encodeURIComponent(attention.contractPublicId)}/drafts">查看合約草稿</a>` : ''}
  </section>` : emptyState();
  const current = allContracts.length
    ? `<section class="contract-section"><div class="section-title"><h2>所有合約 <span>${allContracts.length}</span></h2></div>${allContracts.map(contractRow).join('')}</section>`
    : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>我的合約｜ECS NEO</title><style>
  :root{--navy:#082967;--blue:#1478f2;--blue-2:#e7f2ff;--ink:#14213d;--muted:#63718d;--line:#dfeaf6;--surface:#fff;--bg:#f5faff;--green:#078858}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Noto Sans TC","PingFang TC",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
  .page{width:min(100%,760px);margin:auto;padding:20px 14px 64px}.brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:26px}.brand img{width:154px;height:auto}.brand nav{display:flex;gap:8px}.icon-button{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#edf5ff;color:var(--navy);font-size:22px;text-decoration:none;font-weight:800}
  .intro{margin:0 8px 22px}.intro h1{font-size:40px;line-height:1.12;letter-spacing:-1.5px;color:var(--navy);margin:0 0 8px}.intro p{font-size:16px;color:var(--muted);margin:0}.attention-card,.contract-row,.empty-card,.history{background:var(--surface);border:1px solid #eaf0f7;box-shadow:0 14px 34px rgba(32,92,163,.08);border-radius:22px}.attention-card{padding:22px;margin-bottom:28px}.attention-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.eyebrow{display:block;border-left:5px solid var(--blue);padding-left:11px;color:var(--navy);font-size:20px;font-weight:900;margin-bottom:22px}.attention-top h2{color:var(--navy);font-size:25px;line-height:1.25;margin:0 0 4px}.attention-top p{margin:0;color:var(--muted);font-size:14px}.status{display:inline-flex;align-items:center;border-radius:999px;padding:7px 13px;font-size:12px;font-weight:800;white-space:nowrap;background:#eef2f7;color:#52617b}.status.active{background:#dcecff;color:#0768db}.status.warn{background:#fff1d8;color:#9a5d00}.status.done{background:#daf5e7;color:var(--green)}.status.stop{background:#fde8e8;color:#b13232}
  .attention-message{display:grid;grid-template-columns:1fr 112px;align-items:center;background:#f1f7ff;border-radius:17px;margin:20px 0;padding:15px 10px 15px 16px;min-height:118px}.attention-message strong{display:block;color:var(--navy);font-size:17px;line-height:1.45}.attention-message p{font-size:13px;line-height:1.6;color:var(--muted);margin:5px 0 0}.attention-message img{display:block;width:112px;height:112px;object-fit:contain}
  .contract-rail{list-style:none;display:grid;grid-template-columns:repeat(4,1fr);padding:0;margin:24px 0 22px}.contract-rail li{position:relative;text-align:center;color:#8290a9;font-size:11px}.contract-rail li:not(:last-child)::after{content:"";position:absolute;left:calc(50% + 18px);right:calc(-50% + 18px);top:15px;height:3px;background:#d6dfeb;z-index:0}.contract-rail li[data-state=done]:not(:last-child)::after{background:var(--blue)}.rail-dot{position:relative;z-index:1;display:grid;place-items:center;width:32px;height:32px;margin:0 auto 8px;border-radius:50%;background:#fff;border:4px solid #d6dfeb;color:#7c8ba4;font-weight:900}.contract-rail li[data-state=done] .rail-dot{background:var(--blue);border-color:var(--blue);color:#fff}.contract-rail li[data-state=active]{color:var(--blue)}.contract-rail li[data-state=active] .rail-dot{border-color:var(--blue);color:var(--blue);box-shadow:0 0 0 5px #dbeaff}.contract-rail b{display:block;line-height:1.35;color:inherit}
  .primary-action,.secondary-action{display:flex;align-items:center;justify-content:center;gap:12px;text-decoration:none;border-radius:14px;font-weight:900;min-height:54px}.primary-action{background:var(--blue);color:#fff;font-size:17px;box-shadow:0 10px 22px rgba(20,120,242,.2)}.primary-action:focus-visible,.row-action:focus-visible,.text-action:focus-visible{outline:3px solid #ffbf47;outline-offset:3px}.text-action{display:block;text-align:center;color:#1769b5;font-weight:700;text-decoration:none;padding:18px 0 2px}.contract-section{margin-top:8px}.section-title h2{color:var(--navy);font-size:21px;margin:0 0 14px;border-left:5px solid var(--blue);padding-left:11px}.section-title span{font-size:12px;background:var(--blue-2);color:var(--blue);padding:4px 8px;border-radius:999px;vertical-align:middle}
  .contract-row{display:grid;grid-template-columns:78px minmax(0,1fr) 30px;gap:12px;align-items:center;padding:14px;margin-bottom:12px}.contract-row>img{width:78px;height:78px;object-fit:contain;background:#f5faff;border-radius:15px}.contract-row-heading{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}.contract-row h3{color:var(--navy);font-size:16px;line-height:1.35;margin:0}.contract-row p{color:var(--muted);font-size:12px;margin:4px 0}.contract-row strong{display:block;color:#0870e3;font-size:13px;line-height:1.45}.contract-row small{display:block;color:#7b88a0;font-size:11px;margin-top:4px}.contract-row .status{font-size:10px;padding:5px 8px}.row-action{display:grid;place-items:center;width:30px;height:30px;color:var(--navy);font-size:24px;text-decoration:none}.history{margin-top:18px;padding:14px}.history summary{cursor:pointer;color:var(--navy);font-weight:800;padding:4px}.history .contract-row{box-shadow:none;border-color:var(--line);margin-top:12px}.empty-card{text-align:center;padding:28px 20px}.empty-card img{width:150px}.empty-card h2{color:var(--navy);margin:8px 0}.empty-card p{color:var(--muted);line-height:1.65}.secondary-action{background:#edf5ff;color:#1266bd;margin-top:18px}
  @media(max-width:420px){.intro h1{font-size:34px}.brand img{width:140px}.attention-card{padding:18px}.attention-message{grid-template-columns:1fr 90px}.attention-message img{width:90px;height:90px}.contract-rail b{font-size:10px}.contract-row{grid-template-columns:66px minmax(0,1fr) 26px}.contract-row>img{width:66px;height:66px}.contract-row-heading{display:block}.contract-row .status{margin-top:5px}}
  @media(prefers-reduced-motion:no-preference){.primary-action{transition:transform .15s ease,box-shadow .15s ease}.primary-action:active{transform:translateY(1px);box-shadow:0 5px 12px rgba(20,120,242,.18)}}
  </style></head><body><main class="page"><header class="brand"><img src="/assets/ecs-neo-logo.png" alt="ECS NEO"><nav aria-label="頁面操作"><a class="icon-button" href="javascript:history.back()" aria-label="返回">‹</a></nav></header><section class="intro"><h1>我的合約</h1><p>掌握每一份合約的進度，租賃更安心。</p></section>${hero}${current}</main></body></html>`;
}

module.exports = { page };
