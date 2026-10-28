const { escapeHtml, conditionFieldLabel, formatConditionValue, formatDateTime, numberByKind } = require('./v2ContractDocumentService');

const CONTRACT_STATUS = {
  drafting: { label: '協商中', tone: 'neutral' },
  awaiting_confirmation: { label: '待確認', tone: 'warn' },
  signing: { label: '簽署中', tone: 'active' },
  executed: { label: '已成立', tone: 'done' },
  cancelled: { label: '已取消', tone: 'stop' },
  superseded: { label: '已被取代', tone: 'neutral' }
};

const VERSION_STATUS = {
  draft: { label: '草稿', tone: 'neutral' },
  issued: { label: '待簽署', tone: 'active' },
  superseded: { label: '已被取代', tone: 'neutral' },
  executed: { label: '已完成', tone: 'done' }
};

const PARTY_ROLES = { landlord: '出租人', tenant: '承租人', guarantor: '保證人', agent: '代理人', witness: '見證人' };

const STYLE = `<style>
*{box-sizing:border-box}
body{margin:0;background:#f2f5fa;color:#14213d;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans TC",sans-serif;-webkit-text-size-adjust:100%}
.page{max-width:760px;margin:auto;padding:18px 14px 56px}
.top{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.top img{width:40px;height:40px;object-fit:contain}
.top .muted{margin:0 0 2px}
h1{font-size:22px;margin:0;letter-spacing:.5px}
h2{font-size:16px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
h3{font-size:14px;margin:0 0 8px}
.card{background:#fff;border:1px solid #e5eaf1;border-radius:18px;padding:18px;box-shadow:0 6px 22px #14213d0a;margin-bottom:14px}
.card.flat{box-shadow:none;background:#fbfcfe}
.muted{color:#62708a;font-size:13.5px;line-height:1.65;margin:0}
.watermark{display:inline-block;background:#fff4d6;color:#875b00;border-radius:999px;padding:6px 11px;font-weight:700;font-size:12.5px;margin-bottom:10px}
.pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;white-space:nowrap}
.pill.neutral{background:#eef2f7;color:#4a5878}
.pill.active{background:#e8f1ff;color:#1559b8}
.pill.warn{background:#fff3e0;color:#9a5b00}
.pill.done{background:#e6f7f0;color:#0b7a58}
.pill.stop{background:#fdecec;color:#b03434}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:12px;margin-top:14px}
.summary div{background:#f7f9fc;border:1px solid #eaeff6;border-radius:13px;padding:11px 12px}
.summary dt{color:#62708a;font-size:12px;margin-bottom:4px}
.summary dd{margin:0;font-size:15px;font-weight:700;word-break:break-word}
.parties{display:grid;gap:8px;margin-top:14px}
.party{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;border:1px solid #eaeff6;border-radius:13px;font-size:14px}
.party b{font-weight:700}
.party .role{color:#62708a;font-size:12.5px;font-weight:400;margin-right:6px}
.versions{display:grid;gap:10px}
.version{border:1px solid #e5eaf1;border-radius:15px;padding:14px}
.version.current{border-color:#b9d4ff;background:#f7fbff}
.version-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.version-head strong{font-size:15px}
.version-meta{color:#62708a;font-size:12.5px;margin:0 0 10px;line-height:1.6}
.version-actions{display:flex;flex-wrap:wrap;gap:8px}
.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:#1677ff;color:#fff;text-decoration:none;border:0;border-radius:12px;padding:11px 15px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer}
.button.secondary{background:#eef5ff;color:#145fb9}
.button.ghost{background:#fff;color:#4a5878;border:1px solid #dfe6f0}
.button.danger{background:#fdecec;color:#b03434}
.button.small{padding:8px 12px;font-size:13px;border-radius:10px}
.button:disabled,.button[aria-disabled=true]{opacity:.45;cursor:not-allowed}
.document{line-height:1.8}
.diff{border-left:4px solid #1677ff;padding:10px 14px;background:#f4f8ff;border-radius:0 12px 12px 0;margin:10px 0}
.diff strong{display:block;margin-bottom:4px;font-size:14px}
.diff .change{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:14px}
.diff .before{color:#8b95ab;text-decoration:line-through}
.diff .after{font-weight:700}
.record-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:10px 0}
.record-grid figure{margin:0;border:1px solid #eaeff6;border-radius:11px;overflow:hidden;background:#f7f9fc}
.record-grid img,.record-grid video{display:block;width:100%;height:78px;object-fit:cover;background:#0f1729}
.record-grid figcaption{padding:5px 7px;font-size:11px;color:#62708a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.record-grid .note{grid-column:span 2}
.record-grid .note p{margin:0;padding:9px 10px;font-size:12.5px;color:#334063;max-height:78px;overflow:hidden}
.record{border:1px solid #e5eaf1;border-radius:15px;padding:14px;margin-bottom:10px}
.record-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:4px}
.record-head strong{font-size:14.5px;line-height:1.4}
.empty{color:#8b95ab;font-size:13.5px;margin:0}
.notice{background:#f7f9fc;border:1px dashed #d6dfeb;border-radius:12px;padding:12px;color:#4a5878;font-size:13px;line-height:1.65;margin-top:10px}
.picker{margin-top:14px;border:1px solid #e5eaf1;border-radius:14px;padding:12px 14px}
.picker summary{cursor:pointer;font-weight:700;font-size:14px}
.picker .record{margin-top:10px}
.steps{display:grid;gap:8px;padding:0;margin:0 0 14px;list-style:none;grid-template-columns:repeat(4,1fr)}
.steps li{background:#fff;border:1px solid #e5eaf1;border-radius:12px;padding:9px 8px;font-size:12px;color:#62708a;text-align:center;line-height:1.4}
.steps li span{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#e9eef6;color:#62708a;font-size:11px;font-weight:700;margin-bottom:4px}
.steps li[data-state=active]{border-color:#1677ff;color:#14213d;font-weight:700}
.steps li[data-state=active] span{background:#1677ff;color:#fff}
.steps li[data-state=done]{border-color:#bde7d5;background:#f2fbf7;color:#0b7a58}
.steps li[data-state=done] span{background:#0b7a58;color:#fff}
.status-line{display:flex;align-items:center;gap:7px;font-size:13px;color:#62708a;margin:10px 0 0}
.status-line[data-state=done]{color:#0b7a58;font-weight:700}
.status-line[data-state=error]{color:#b03434;font-weight:700}
/* 作者樣式的 display 會蓋掉 UA 的 [hidden]{display:none}，每個自訂 display 都要補回來，
   否則 hidden 屬性形同無效（錯誤訊息與遮罩都曾因此看起來像「沒反應」）。 */
.status-line[hidden]{display:none}
.alert{display:grid;gap:3px;background:#fdecec;border:1px solid #f2c6c6;color:#8c2b2b;border-radius:12px;padding:12px 14px;font-size:13.5px;line-height:1.65;margin-top:12px}
.alert[hidden]{display:none}
.alert strong{font-size:14px}
/* 等待房東審閱不是錯誤,是流程中的一站。用琥珀色與紅色錯誤區塊區隔,
   使用者才不會把「已轉交、正在等」讀成「失敗了」。 */
.waiting{display:grid;gap:6px;background:#fff8e6;border:1px solid #f0dcae;color:#7a5300;border-radius:12px;padding:12px 14px;font-size:13.5px;line-height:1.65;margin-top:12px}
.waiting[hidden]{display:none}
.waiting strong{font-size:14px}
.waiting ul{margin:0;padding-left:18px}
.waiting li{margin:2px 0}
/* 送出中／完成遮罩:蓋滿整個視窗,讓使用者無法進行下一個動作。
   慢的請求(錄影 data URL 上傳)被連點兩次時,第二次會撞到不同的伺服器狀態或
   Express 預設 HTML 錯誤頁,前端 JSON.parse 就爆掉。擋住輸入比事後補救可靠。 */
.busy{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;background:rgba(226,231,238,.86)}
.busy[hidden]{display:none}
.busy-box{background:#fff;border:1px solid #e5eaf1;border-radius:18px;box-shadow:0 12px 40px #14213d1f;padding:26px 24px;max-width:340px;width:100%;text-align:center}
.busy-spinner{width:42px;height:42px;margin:0 auto 14px;border-radius:50%;border:4px solid #dde4ee;border-top-color:#1677ff;animation:busy-spin .9s linear infinite}
.busy-spinner[hidden]{display:none}
.busy-text{margin:0;font-size:17px;font-weight:700}
.busy-hint{margin:8px 0 0;font-size:13px;color:#62708a;line-height:1.6}
.busy-box .button{margin-top:16px;width:100%}
.busy-box .button[hidden]{display:none}
@keyframes busy-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.busy-spinner{animation-duration:2.4s}}
label{display:grid;gap:6px;margin:12px 0;font-weight:600;font-size:14px}
input{font:inherit;padding:12px;border:1px solid #ccd5e3;border-radius:10px;background:#fff}
.field-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
video,canvas,iframe{width:100%;border:1px solid #dce3ed;border-radius:12px;background:#0f1729}
video{aspect-ratio:16/9;height:auto;object-fit:cover}
canvas{height:180px;background:#fff;touch-action:none}
iframe{height:420px;background:#fff}
.checkbox{display:flex;align-items:flex-start;gap:9px;font-weight:600;font-size:14px;margin:14px 0}
.checkbox input{width:20px;height:20px;flex:none;margin-top:1px}
@media(max-width:600px){.page{padding:14px 10px 44px}.card{border-radius:15px;padding:15px}.steps{grid-template-columns:repeat(3,1fr)}}
@media(max-width:380px){.steps{grid-template-columns:repeat(2,1fr)}}
</style>`;

// 遮罩本體掛在每一頁(預設 hidden)。只有引入 BUSY_OVERLAY_SCRIPT 的頁面會操作它。
const BUSY_OVERLAY_HTML = '<div class="busy" id="busy-overlay" hidden role="alertdialog" aria-modal="true" aria-live="assertive">'
  + '<div class="busy-box">'
  + '<div class="busy-spinner" id="busy-spinner"></div>'
  + '<p class="busy-text" id="busy-text">處理中</p>'
  + '<p class="busy-hint" id="busy-hint">請不要關閉或重新整理這個畫面。</p>'
  + '<button type="button" class="button" id="busy-finish" hidden>完成</button>'
  + '<button type="button" class="button ghost" id="busy-dismiss" hidden>關閉並修正</button>'
  + '</div></div>';

// busy.start() 之後畫面完全不可操作;busy.fail() 一定要能關掉,不能把人鎖死在遮罩裡。
const BUSY_OVERLAY_SCRIPT = `const busy=(()=>{
  const root=document.querySelector('#busy-overlay'),spinner=document.querySelector('#busy-spinner'),text=document.querySelector('#busy-text'),hint=document.querySelector('#busy-hint'),finish=document.querySelector('#busy-finish'),dismiss=document.querySelector('#busy-dismiss');
  const shown=()=>!root.hidden;
  const swallow=event=>{if(shown()&&!root.contains(event.target)){event.preventDefault();event.stopImmediatePropagation()}};
  ['click','mousedown','touchstart','keydown','submit'].forEach(name=>document.addEventListener(name,swallow,true));
  const open=()=>{root.hidden=false;document.documentElement.style.overflow='hidden'};
  const hide=()=>{root.hidden=true;document.documentElement.style.overflow=''};
  dismiss.addEventListener('click',hide);
  return{
    start(message){spinner.hidden=false;text.textContent=message||'處理中';hint.textContent='請不要關閉或重新整理這個畫面。';finish.hidden=true;dismiss.hidden=true;open()},
    done(message,onFinish){spinner.hidden=true;text.textContent=message||'完成';hint.textContent='可以按下完成回到 LINE。';dismiss.hidden=true;finish.hidden=false;finish.onclick=()=>onFinish(message);open();finish.focus()},
    fail(message){spinner.hidden=true;text.textContent='處理失敗';hint.textContent=message||'請稍後再試一次。';finish.hidden=true;dismiss.hidden=false;open();dismiss.focus()},
    hide
  }
})();`;

// fetch 的呼叫端不能假設回應一定是 JSON。伺服器或中間層回 HTML 時,直接 r.json()
// 會丟 "Unexpected token '<'",把真正的失敗原因蓋掉。
// error.data 保留原始 JSON:有些失敗其實是「已轉交房東審閱」這種帶結構的結果,
// 呼叫端要能認出它,而不是只拿到一句字串。
const READ_JSON_SCRIPT = `const readJson=async response=>{
  const raw=await response.text();let data={};
  try{data=raw?JSON.parse(raw):{}}catch(e){data={error:'伺服器回應異常（HTTP '+response.status+'），請回 LINE 重新開啟後再試一次。'}}
  if(!response.ok){const error=new Error(data.error||('操作失敗（HTTP '+response.status+'）'));error.status=response.status;error.data=data;throw error}
  return data;
};`;

function shell(title, body) {
  // 遮罩放在 <main> 之前:頁面腳本是行內腳本,執行時 DOM 只解析到腳本所在位置,
  // 若遮罩掛在 </main> 之後,querySelector('#busy-overlay') 會拿到 null。
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHtml(title)}</title>${STYLE}</head><body>${BUSY_OVERLAY_HTML}<main class="page"><header class="top"><img src="/assets/ecs-neo-logo.png" alt="ECS NEO"><div><p class="muted">合約助手</p><h1>${escapeHtml(title)}</h1></div></header>${body}</main></body></html>`;
}

const pill = (map, key) => {
  const entry = map[key] || { label: key, tone: 'neutral' };
  return `<span class="pill ${entry.tone}">${escapeHtml(entry.label)}</span>`;
};

function emptyPage(title, heading, message, hint = '') {
  return shell(title, `<section class="card"><h2>${escapeHtml(heading)}</h2><p class="muted">${escapeHtml(message)}</p>${hint ? `<div class="notice">${escapeHtml(hint)}</div>` : ''}</section>`);
}

function summaryFromConditions(conditions) {
  const pick = (...keys) => keys.map((key) => (conditions[key] === undefined ? null : { key, value: conditions[key] })).find(Boolean);
  const rent = pick('monthlyRent', 'rentAmount');
  const deposit = pick('depositAmount');
  const start = pick('leaseStartDate', 'leaseStart');
  const end = pick('leaseEndDate', 'leaseEnd');
  const items = [];
  if (rent) items.push(['每月租金', formatConditionValue(rent.key, rent.value)]);
  if (deposit) items.push(['押金', formatConditionValue(deposit.key, deposit.value)]);
  if (start) items.push(['租期起日', formatConditionValue(start.key, start.value)]);
  if (end) items.push(['租期迄日', formatConditionValue(end.key, end.value)]);
  return items;
}

function partyLine(party) {
  const signed = Number(party.signedCount) > 0;
  const state = party.status === 'declined'
    ? '<span class="pill stop">已拒絕</span>'
    : signed ? '<span class="pill done">已簽署</span>' : '<span class="pill neutral">待簽署</span>';
  return `<div class="party"><div><span class="role">${escapeHtml(PARTY_ROLES[party.partyRole] || party.partyRole)}</span><b>${escapeHtml(party.name || '尚未填寫姓名')}</b></div>${state}</div>`;
}

function recordThumbnails(entries) {
  const shown = numberByKind(entries).slice(0, 8).map((entry) => {
    if (entry.kind === 'image' && entry.url) return `<figure><img src="${escapeHtml(entry.url)}" alt="屋況照片 ${entry.kindIndex}" loading="lazy"><figcaption>照片 ${entry.kindIndex}</figcaption></figure>`;
    if (entry.kind === 'video' && entry.url) return `<figure><video preload="metadata" src="${escapeHtml(entry.url)}" muted></video><figcaption>影片 ${entry.kindIndex}</figcaption></figure>`;
    if (entry.kind === 'text') return `<figure class="note"><p>${escapeHtml(entry.text)}</p><figcaption>備註 ${entry.kindIndex}</figcaption></figure>`;
    return '';
  }).join('');
  const more = entries.length > 8 ? `<p class="empty">另有 ${entries.length - 8} 筆內容，完整清單見合約附件一。</p>` : '';
  return shown ? `<div class="record-grid">${shown}</div>${more}` : '<p class="empty">這份紀錄沒有內容。</p>';
}

function conditionRecordCard(panel) {
  const matchBadge = (matchSource) => (matchSource === 'party'
    ? '<span class="pill warn">非本案房源</span>'
    : '<span class="pill done">本案房源</span>');
  const recordMeta = (record) => `封存於 ${formatDateTime(record.sealedAt)}｜照片 ${record.imageCount}／影片 ${record.videoCount}／備註 ${record.textCount}`;
  // 附件一的每一份都要說得出「在等誰」。房客最常問的是「我還要做什麼」,
  // 答案通常是「什麼都不用做，在等房東」——那就要寫出來。
  const reviewBadge = (attachment) => {
    if (!attachment.reviewLabel) return '';
    if (attachment.reviewStatus === 'landlord_confirmed') return `<span class="pill done">${escapeHtml(attachment.reviewLabel)}</span>`;
    return `<span class="pill warn">${escapeHtml(attachment.reviewLabel)}</span>`;
  };
  const reviewLine = (attachment) => {
    if (!attachment.reviewStatus || attachment.reviewStatus === 'landlord_confirmed') return '';
    const who = attachment.reviewLandlordName ? `房東 ${attachment.reviewLandlordName}` : '房東';
    const when = attachment.reviewSubmittedAt ? `，送出時間 ${formatDateTime(attachment.reviewSubmittedAt)}` : '';
    const text = attachment.reviewStatus === 'pending_landlord_confirmation'
      ? `正在等 ${who} 在 LINE 確認這份紀錄${when}。你不需要再做任何操作。`
      : `這份紀錄還沒送交 ${who} 審閱；按下送出簽署時會自動轉交。`;
    return `<p class="muted">⏳ ${escapeHtml(text)}</p>`;
  };

  const attached = panel.attachments.map((attachment) => {
    const remove = panel.editable
      ? `<button class="button danger small" data-detach="${escapeHtml(attachment.sessionPublicId)}">移出附件</button>`
      : '';
    return `<article class="record"><div class="record-head"><strong>${escapeHtml(attachment.title || '入住前屋況紀錄')}</strong><span>${matchBadge(attachment.matchSource)}${reviewBadge(attachment)}</span></div><p class="muted">${escapeHtml(recordMeta(attachment))}</p>${reviewLine(attachment)}${recordThumbnails(attachment.entries || [])}<div class="version-actions"><a class="button ghost small" href="/tenant/pre-inspections/${encodeURIComponent(attachment.sessionPublicId)}">看完整紀錄</a>${remove}</div></article>`;
  }).join('');

  const candidates = panel.candidates.map((candidate) => `<article class="record"><div class="record-head"><strong>${escapeHtml(candidate.title || '入住前屋況紀錄')}</strong>${matchBadge(candidate.matchSource)}</div><p class="muted">${escapeHtml(recordMeta(candidate))}</p><div class="version-actions"><a class="button ghost small" href="/tenant/pre-inspections/${encodeURIComponent(candidate.sessionPublicId)}">先看內容</a><button class="button secondary small" data-attach="${escapeHtml(candidate.sessionPublicId)}">加入合約附件</button></div></article>`).join('');

  const attachedBlock = attached
    ? `<h3>已列入附件一</h3>${attached}`
    : '<p class="empty">本版本還沒有列入任何屋況紀錄，交屋時會以現況點交。</p>';

  // 房客端的等待落點:哪幾份在等、等哪個房東,直接寫在附件一區塊裡,
  // 不是只在送簽失敗的那一瞬間出現一行錯誤訊息。
  const pendingReview = panel.pendingReview || [];
  const waitingBlock = pendingReview.length
    ? `<div class="waiting" id="condition-waiting"><strong>這 ${pendingReview.length} 份附件還在等房東審閱</strong><ul>${pendingReview.map((row) => `<li>${escapeHtml(row.title)}｜等 ${escapeHtml(row.landlordName || '房東')}｜${escapeHtml(row.reviewLabel || '待房東審閱')}</li>`).join('')}</ul><span>房東會在 LINE 收到審閱請求，也可以在「屋況點交」與「數據總攬」看到待審閱清單。房東確認完成後回到這一頁即可送出簽署。</span></div>`
    : '';

  // 候選超過兩筆時收進 details，手機上才不會被一長串紀錄推走下面的版本歷程。
  const candidateList = panel.candidates.length > 2
    ? `<details class="picker"><summary>可加入的屋況紀錄（${panel.candidates.length} 筆）</summary>${candidates}</details>`
    : `<h3>可加入的屋況紀錄</h3>${candidates}`;

  const candidateBlock = panel.editable
    ? (candidates
      ? `${candidateList}<div class="notice">附件變動後，已建立的正式簽署預覽會失效，需要在簽署頁重新按一次「建立正式預覽」。</div>`
      : '<div class="notice">找不到其他可加入的屋況紀錄。請先在 LINE 點「屋況點交」拍照，完成後點「完成紀錄」封存。</div>')
    : '<div class="notice">本版本已有人完成簽署，屋況附件已鎖定。需要調整請回 LINE 與 Agent 協商後產生新版本。</div>';

  return `<section class="card" id="condition-record"><h2>屋況紀錄 <span class="pill neutral">附件一</span></h2><p class="muted">依住宅租賃契約書範本，租賃標的現況以附件一「租賃標的現況確認書」記載。這裡列入的入住前屋況紀錄會整份寫進合約，並隨簽名一起產生雜湊。</p>${attachedBlock}${waitingBlock}${candidateBlock}<p id="condition-status" class="status-line" hidden></p></section>`;
}

const CONDITION_SCRIPT = (versionPublicId) => `<script>(()=>{
const version=${JSON.stringify(versionPublicId)};
const status=document.querySelector('#condition-status');
const call=async(action,sessionPublicId)=>{
  status.hidden=false;status.textContent='處理中…';
  try{
    const response=await fetch('/v2/api/contracts/versions/'+encodeURIComponent(version)+'/condition-records',{method:action==='attach'?'POST':'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({sessionPublicId})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'操作失敗');
    location.reload();
  }catch(error){status.textContent=error.message}
};
document.querySelectorAll('[data-attach]').forEach(button=>button.addEventListener('click',()=>call('attach',button.dataset.attach)));
document.querySelectorAll('[data-detach]').forEach(button=>button.addEventListener('click',()=>{if(confirm('要把這份屋況紀錄移出合約附件嗎？'))call('detach',button.dataset.detach)}));
})()</script>`;

function draftOverviewPage({ contractPublicId, overview, versions, conditionPanel, canProposeSigning = false, latestVersionPublicId = '', viewerRole = '', viewerRoles = null, termsConfirmation = { confirmed: false }, landlordDecision = null }) {
  // 一個人可能同時是房東與房客;沒有給 viewerRoles 的舊呼叫端退回單一角色。
  const roles = Array.isArray(viewerRoles) && viewerRoles.length ? viewerRoles : [viewerRole];
  const subject = overview.subject || {};
  const latest = versions[0];
  const conditions = latest ? JSON.parse(latest.conditionSnapshotJson || '{}') : {};
  const summary = summaryFromConditions(conditions);
  const summaryHtml = summary.length
    ? `<dl class="summary">${summary.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`
    : '<div class="notice">Agent 還沒帶入租金與租期條件，請回 LINE 繼續討論。</div>';

  const versionList = versions.map((version, index) => {
    const previous = versions[index + 1];
    const record = version.conditionRecord || {};
    const recordBadge = record.attachmentCount
      ? `<span class="pill done">屋況附件 ${record.imageCount} 張照片</span>`
      : '<span class="pill neutral">未附屋況紀錄</span>';
    const compare = previous
      ? `<a class="button ghost small" href="/v2/contracts/${encodeURIComponent(contractPublicId)}/draft-diff?left=${encodeURIComponent(previous.publicId)}&amp;right=${encodeURIComponent(version.publicId)}">與第 ${previous.versionNumber} 版比較差異</a>`
      : '';
    return `<article class="version${index === 0 ? ' current' : ''}"><div class="version-head"><strong>第 ${version.versionNumber} 版</strong>${pill(VERSION_STATUS, version.status)}</div><p class="version-meta">建立於 ${escapeHtml(formatDateTime(version.createdAt))}<br>${recordBadge}</p><div class="version-actions"><a class="button secondary small" href="/v2/contracts/${encodeURIComponent(contractPublicId)}/drafts/${encodeURIComponent(version.publicId)}">查看全文</a>${compare}</div></article>`;
  }).join('');

  const topCompare = versions.length > 1
    ? `<a class="button" href="/v2/contracts/${encodeURIComponent(contractPublicId)}/draft-diff?left=${encodeURIComponent(versions[1].publicId)}&amp;right=${encodeURIComponent(versions[0].publicId)}">比較差異：第 ${versions[1].versionNumber} 版 → 第 ${versions[0].versionNumber} 版</a>`
    : '<span class="button" aria-disabled="true" title="只有一個版本時沒有差異可比">比較差異（只有一個版本）</span>';

  const scope = subject.unitLabel ? `租賃範圍：${subject.unitLabel}。` : '';
  const awaitingReview = (conditionPanel.pendingReview || []).length;
  // 送簽被擋(例如附件一還有未經房東確認的屋況紀錄)時,原本只把訊息寫進一行小灰字,
  // 使用者看不出差別,以為「按了沒反應」而重複按。錯誤改用紅色 alert 區塊並捲到畫面中央。
  // 附件未確認不算錯誤:按下送簽會自動把那幾份轉交房東審閱,畫面改成琥珀色等待區塊,
  // 明講在等哪幾份、等哪個房東,而不是叫使用者自己想辦法。
  const termsConfirmed = Boolean(termsConfirmation && termsConfirmation.confirmed);

  // 房東最後一次「要求修改／拒絕」。理由是他自己寫的,可能沒寫 —— 沒寫就只說結果,
  // 不編一個理由出來,也不寫「未提供理由」那種讓人更焦慮的空話。
  const decisionCard = landlordDecision
    ? `<section class="card"><h2>${landlordDecision.decision === 'rejected' ? '房東拒絕了這一版' : '房東要求修改'}</h2>`
      + `<p class="muted">${escapeHtml(landlordDecision.decision === 'rejected'
        ? '這一筆承租意向已經結束。你可以直接回 LINE 跟 Agent 重新討論條件，不必重新找房源。'
        : '這一版已經退回協調。回 LINE 跟 Agent 調整條件後會產生新的版本。')}</p>`
      + (landlordDecision.reason
        ? `<blockquote class="notice" style="margin-top:12px">房東寫的理由：${escapeHtml(landlordDecision.reason)}</blockquote>`
        : '')
      + '</section>'
    : '';
  const proposalNote = awaitingReview
    ? `附件一目前有 ${awaitingReview} 份屋況紀錄還在等房東審閱。按下送出會（重新）把審閱請求交給房東；房東確認後回到這一頁就能完成送簽。`
    : termsConfirmed
      ? '房東已確認這一版的條件。送出後會建立雙方的正式簽署文件。'
      : '房東還沒確認這一版的條件。按下送出會把條件交給房東確認（屋況附件未確認的也會一起轉交）；房東確認後回到這一頁就能完成送簽。';

  // 房東這一側:簽署之前唯一能對「條件」表態的地方。條件確認與屋況附件確認是
  // 兩件事,分開顯示 —— 房東確認照片不等於同意租金。
  const latestIsDraft = latest && latest.status === 'draft';
  const termsAction = roles.includes('landlord') && latestIsDraft
    ? (termsConfirmed
      ? `<section class="card"><h2>條件確認</h2><p class="muted">你已經確認第 ${latest.versionNumber} 版的條件，房客可以送出簽署了。實際簽署仍需要你本人完成最後簽名。</p></section>`
      : `<section class="card"><h2>條件確認</h2><p class="muted">${escapeHtml(`請先確認第 ${latest.versionNumber} 版的租金、押金、租期與責任條款。確認之後房客才能送出簽署；要調整就按「要求修改」，房客會回到 LINE 與 Agent 重新討論。`)}</p><label style="margin-top:12px">理由（可不填，只有房客看得到）<textarea id="terms-reason" rows="2" maxlength="500" placeholder="例如：租金想再談"></textarea></label><div class="version-actions"><button class="button" id="terms-confirm">確認第 ${latest.versionNumber} 版的條件</button><button class="button secondary" id="terms-changes">要求修改</button></div><p class="status-line" id="terms-status" hidden></p><div class="alert" id="terms-error" hidden role="alert"><strong>沒有送出去</strong><span id="terms-error-message"></span></div></section><script>${READ_JSON_SCRIPT}
(()=>{const confirmButton=document.querySelector('#terms-confirm'),changesButton=document.querySelector('#terms-changes'),status=document.querySelector('#terms-status'),failure=document.querySelector('#terms-error'),failureMessage=document.querySelector('#terms-error-message');
const send=async(decision,question)=>{if(!confirm(question))return;
failure.hidden=true;confirmButton.disabled=true;changesButton.disabled=true;status.hidden=false;status.textContent='送出中…';
try{await readJson(await fetch('/v2/api/contracts/versions/${encodeURIComponent(latestVersionPublicId)}/landlord-terms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,reason:(document.querySelector('#terms-reason')||{value:''}).value.trim()})}));location.reload()}
catch(error){confirmButton.disabled=false;changesButton.disabled=false;status.hidden=true;
failureMessage.textContent=error.message;failure.hidden=false;failure.scrollIntoView({block:'center',behavior:'smooth'})}};
confirmButton.addEventListener('click',()=>send('confirm','確認這一版的條件？確認後房客就可以送出簽署。'));
changesButton.addEventListener('click',()=>send('request_changes','要求修改條件？房客會回到 LINE 與 Agent 重新討論。'))})()</script>`)
    : '';
  const proposalAction = canProposeSigning
    ? `<section class="card"><h2>確認送出</h2><p class="muted">${escapeHtml(proposalNote)}</p><button class="button" id="propose-signing">以第 ${latest.versionNumber} 版進行簽署</button><p class="status-line" id="proposal-status" hidden></p><div class="waiting" id="proposal-waiting" hidden role="status"></div><div class="alert" id="proposal-error" hidden role="alert"><strong>送不出去</strong><span id="proposal-error-message"></span></div></section><script>${READ_JSON_SCRIPT}
(()=>{const button=document.querySelector('#propose-signing'),status=document.querySelector('#proposal-status'),failure=document.querySelector('#proposal-error'),failureMessage=document.querySelector('#proposal-error-message'),waiting=document.querySelector('#proposal-waiting');
const renderWaiting=review=>{waiting.textContent='';
const head=document.createElement('strong');head.textContent='已轉交房東審閱，等房東確認後即可送簽';
const list=document.createElement('ul');
review.pending.forEach(row=>{const li=document.createElement('li');li.textContent=(row.title||'入住前屋況紀錄')+'｜等 '+(row.landlordName||'房東')+'｜'+(row.reviewLabel||'待房東審閱');list.appendChild(li)});
const note=document.createElement('span');note.textContent=review.message||'';
const reload=document.createElement('button');reload.type='button';reload.className='button secondary small';reload.textContent='重新載入查看最新狀態';reload.addEventListener('click',()=>location.reload());
waiting.append(head,list,note,reload);waiting.hidden=false;waiting.scrollIntoView({block:'center',behavior:'smooth'})};
button.addEventListener('click',async()=>{if(!confirm('確定以此版本送出簽署？送出後將通知房東確認。'))return;
failure.hidden=true;waiting.hidden=true;button.disabled=true;status.hidden=false;status.dataset.state='';status.textContent='送出中…';
try{const data=await readJson(await fetch('/v2/api/contracts/versions/${encodeURIComponent(latestVersionPublicId)}/issue',{method:'POST'}));location.assign('/v2/sign/'+encodeURIComponent(data.tenantRequestPublicId))}
catch(error){button.disabled=false;status.hidden=true;status.textContent='';
const review=error.data&&error.data.review;
if(review&&review.pending&&review.pending.length){renderWaiting(review);return}
const terms=error.data&&error.data.terms;
if(terms&&!terms.confirmed){renderWaiting({pending:[],message:terms.message||error.message});return}
failureMessage.textContent=error.message;failure.hidden=false;failure.scrollIntoView({block:'center',behavior:'smooth'})}})})()</script>`
    : '';
  return shell('合約草稿', `<section class="card"><span class="watermark">草稿・不可簽署</span><h2>${escapeHtml(subject.addressText || subject.listingTitle || '租賃標的')} ${pill(CONTRACT_STATUS, overview.status)}</h2><p class="muted">${escapeHtml(`${scope}這裡只查看 Agent 與你協商後產生的版本，需要修改條件請回 LINE 繼續討論。`)}</p>${summaryHtml}<div class="parties">${overview.parties.map(partyLine).join('')}</div></section>
${decisionCard}${conditionRecordCard(conditionPanel)}${termsAction}${proposalAction}
<section id="history" class="card"><h2>版本歷程 <span class="pill neutral">共 ${versions.length} 版</span></h2><p class="muted">每次在 LINE 調整條件都會產生新版本，舊版本會保留下來可回看比對。</p><div class="version-actions" style="margin:12px 0 14px">${topCompare}</div><div class="versions">${versionList}</div></section>
${CONDITION_SCRIPT(conditionPanel.versionPublicId)}`);
}

function draftVersionPage({ contractPublicId, versionNumber, documentBody, narrativesHtml = '' }) {
  return shell(`合約草稿・第 ${versionNumber} 版`, `${narrativesHtml}<section class="card document">${documentBody}</section><div class="version-actions"><a class="button secondary" href="/v2/contracts/${encodeURIComponent(contractPublicId)}/drafts">回版本歷程</a></div>`);
}

function diffPage({ result }) {
  const changes = result.changes.map((change) => `<div class="diff"><strong>${escapeHtml(conditionFieldLabel(change.field))}</strong><div class="change"><span class="before">${escapeHtml(formatConditionValue(change.field, change.before))}</span><span>→</span><span class="after">${escapeHtml(formatConditionValue(change.field, change.after))}</span></div></div>`).join('');
  const attachment = result.attachmentChanges || { added: [], removed: [] };
  const attachmentHtml = attachment.added.length || attachment.removed.length
    ? `<div class="diff"><strong>屋況紀錄附件</strong><div class="change">${attachment.added.length ? `<span class="after">新增 ${attachment.added.length} 份</span>` : ''}${attachment.removed.length ? `<span class="before">移除 ${attachment.removed.length} 份</span>` : ''}</div></div>`
    : '';
  const body = changes || attachmentHtml
    ? `${changes}${attachmentHtml}`
    : '<p class="empty">兩個版本之間沒有差異。</p>';
  return shell('版本差異', `<section class="card"><h2>第 ${result.left.versionNumber} 版 → 第 ${result.right.versionNumber} 版</h2><p class="muted">左側為舊值，右側為新值。條款名稱依住宅租賃契約書範本。</p>${body}</section><div class="version-actions"><a class="button secondary" href="javascript:history.back()">回上一頁</a></div>`);
}

function completedContractPage(delivery) {
  const url = `/v2/contracts/${encodeURIComponent(delivery.contractPublicId)}/completed/document`;
  const signatures = delivery.signatures.map((record) => `<li>${escapeHtml(PARTY_ROLES[record.partyRole] || record.partyRole)}｜${escapeHtml(formatDateTime(record.signedAt))}<br>簽署紀錄：${escapeHtml(record.publicId)}<br>文件雜湊：<span class="hash">${escapeHtml(record.documentHash)}</span></li>`).join('');
  const attachments = delivery.attachments.map((attachment) => `<li>${escapeHtml(attachment.title || '入住前屋況紀錄')}｜照片 ${Number(attachment.imageCount)}／影片 ${Number(attachment.videoCount)}／備註 ${Number(attachment.textCount)}<br>附件雜湊：<span class="hash">${escapeHtml(attachment.manifestHash)}</span></li>`).join('');
  return shell('已完成合約', `<section class="card"><h2>雙方已完成簽署</h2><p>第 ${Number(delivery.versionNumber)} 版｜成立時間：${escapeHtml(formatDateTime(delivery.executedAt))}</p><p>以下為簽署時保存的原始 HTML，附件一保留於文件內。開啟後可使用瀏覽器列印功能。下載檔保留原始內容；附件照片與影片請在登入狀態下開啟原始文件查看。</p><p>文件雜湊：<span class="hash">${escapeHtml(delivery.documentHash)}</span></p><div class="version-actions"><a class="button" href="${url}">開啟原始文件與列印</a><a class="button secondary" href="${url}?download=1">下載原始 HTML</a></div></section><section class="card"><h2>附件一</h2>${attachments ? `<ul>${attachments}</ul>` : '<p>本版本未附屋況紀錄。</p>'}</section><section class="card"><h2>簽署歷程</h2><ul>${signatures}</ul></section><a class="button secondary" href="/v2/contracts">回合約中心</a>`);
}

function stepList(steps) {
  return `<ol class="steps">${steps.map((label, index) => `<li data-step="${index + 1}" data-state="${index === 0 ? 'active' : 'todo'}"><span>${index + 1}</span>${escapeHtml(label)}</li>`).join('')}</ol>`;
}

module.exports = {
  CONTRACT_STATUS,
  VERSION_STATUS,
  BUSY_OVERLAY_SCRIPT,
  READ_JSON_SCRIPT,
  shell,
  pill,
  emptyPage,
  conditionRecordCard,
  draftOverviewPage,
  draftVersionPage,
  completedContractPage,
  diffPage,
  stepList
};
