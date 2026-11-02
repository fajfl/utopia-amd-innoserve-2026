const { escapeHtml } = require('./v2ContractDocumentService');

function page({ contractPublicId, roles = [], subject = {}, lease = null, testRole = null, singlePhone = false }) {
  const allowed = roles.filter((role) => role === 'tenant' || role === 'landlord');
  const options = allowed.map((role) => `<option value="${role}"${singlePhone && role === testRole ? ' selected' : ''}>${role === 'tenant' ? '房客' : '房東'}</option>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合約與維修服務</title><style>
    :root{font-family:system-ui,sans-serif;color:#243530;background:#f4f7f5}*{box-sizing:border-box}body{margin:0;line-height:1.6}main{max-width:760px;margin:auto;padding:20px}h1,h2{line-height:1.3}h1{font-size:1.8rem}h2{font-size:1.25rem}.card{background:white;border:1px solid #dbe5df;border-radius:16px;padding:20px;margin:16px 0}.safety{background:#fff4e5;border-color:#e4b878}label{display:block;font-weight:700;margin:12px 0 4px}textarea,select,input,button{font:inherit}textarea,select,input{width:100%;padding:10px;border:1px solid #899c92;border-radius:8px;background:white}textarea{min-height:100px;resize:vertical}button,.link{display:inline-block;background:#225b48;color:white;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;text-decoration:none;margin-top:12px}button:disabled{opacity:.6;cursor:wait}a{color:#164d3b}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #d5881e;outline-offset:3px}.muted{color:#4d6056}.answer{white-space:pre-wrap;overflow-wrap:anywhere}.citation{border-left:3px solid #96b3a3;padding-left:12px;margin:12px 0}.hash{overflow-wrap:anywhere;font-size:.85rem} [hidden]{display:none!important}
    .case-status{background:#edf6f1;border-radius:12px;padding:16px;margin:16px 0}.case-status strong{display:block;font-size:1.15rem}.case-status p{margin:6px 0}.proposal{border:1px solid #dbe5df;border-radius:12px;padding:16px;margin:12px 0}.proposal h4{margin:0 0 8px;font-size:1.05rem}.actions{display:flex;flex-wrap:wrap;gap:8px}.actions button{margin:0;min-height:44px}.secondary{background:#e9efec;color:#243530}.editor{border:1px solid #96b3a3;background:#f7faf8;border-radius:12px;padding:16px;margin:16px 0}.editor textarea{display:block;margin-bottom:12px}details{margin:16px 0}summary{cursor:pointer;font-weight:600;padding:8px 0}.history-entry{border-bottom:1px solid #e8eeeb;padding:10px 0}.history-entry p{margin:4px 0}.case-photos img{max-width:140px;max-height:140px;margin:4px;border-radius:8px}button:disabled{cursor:default}.action-confirm{border:2px solid #96b3a3} @media(max-width:480px){main{padding:16px}.card{padding:16px}.actions button{flex:1 1 140px}.proposal button{width:100%}}
  </style></head><body><main data-contract-id="${escapeHtml(contractPublicId)}" data-single-phone="${singlePhone ? 'true' : 'false'}"><a href="/v2/contracts">← 回合約中心</a><h1>合約與維修服務</h1>${singlePhone ? `<p>單手機測試：${testRole === "landlord" ? "房東" : testRole === "tenant" ? "房客" : "請選擇角色"}；以最近一次切換為準。</p>` : ""}<p class="muted">${escapeHtml([subject.addressText,subject.unitLabel].filter(Boolean).join("・") || "這份合約")}｜${lease ? escapeHtml(String(lease.start_date).slice(0,10)+" ～ "+String(lease.end_date).slice(0,10)) : "尚無租約期間"}</p>
  <section class="card safety" aria-labelledby="safety-title"><h2 id="safety-title">緊急狀況請先確保安全</h2><p>遇到火災、瓦斯洩漏或其他立即危險，請遠離危險處到安全地點，不操作電器開關或自行修理，並在安全處撥打 119。系統通知不等於已通報救援單位。</p><p><a href="https://fsm.119.gov.taipei/w/fsm119/OtherDisasters_21103020413353504">查看消防局瓦斯漏氣應變資訊</a></p></section>
  <section class="card"><label for="role">這次以什麼身分使用？</label><select id="role" required><option value="">請選擇身分</option>${options}</select>${allowed.length ? '' : '<p>此合約目前沒有可使用的房東或房客身分，請聯絡客服協助。</p>'}</section>
  <section class="card"><h2>詢問已簽合約</h2><p>回答會依這份合約的已簽版本提供依據；單純提問不會通知對方。</p><form id="ask-form"><label for="question">想了解什麼？</label><textarea id="question" required maxlength="1000" placeholder="例如：冷氣故障時，合約如何約定？"></textarea><button type="submit">詢問合約</button></form><p id="ask-status" role="status" aria-live="polite"></p><div id="answer" hidden><h3>回答</h3><p id="answer-text" class="answer"></p><h3>合約依據</h3><details><summary>查看版本與文件雜湊</summary><p id="version" class="hash"></p></details><div id="citations"></div></div></section>
  <section class="card"><h2>回報維修問題</h2><p>先確認要分享給另一方的摘要，再建立案件。通知、處理方式及費用同意會分別記錄。</p><form id="preview-form"><label for="summary">問題摘要</label><textarea id="summary" required maxlength="2000" placeholder="請描述發生什麼事，以及需要協助的事項"></textarea><label for="occurred-on">事件發生日</label><input id="occurred-on" type="date" required><p>請選故障發生當天，依上方租約期間核對；緊急事件可略過日期。</p><label><input id="urgent" type="checkbox" style="width:auto"> 這是緊急事件</label><label for="photos">選擇故障照片（選填）</label><input id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><p>JPEG、PNG 或 WebP，每次最多 10 張，每張最多 5 MB。照片先供你預覽，確認建立案件後才分享給另一方。取消預覽不會刪除已上傳的私人照片；本版尚無自動清除或自行刪除功能，請勿上傳不必要的個資。</p><div id="local-photos"></div><button>預覽共享內容</button></form><p id="case-status" role="status" aria-live="polite"></p><div id="preview" hidden><h3>請確認要分享給另一方的內容</h3><p id="preview-summary" class="answer"></p><details><summary>查看版本與文件雜湊</summary><p id="preview-version" class="hash"></p></details><div id="preview-photos"></div><div id="preview-citations"></div><p>送出後將建立共同案件並安排通知；費用與處理方式仍需雙方另行確認。</p><button id="create-case" type="button">確認建立案件並通知</button><button id="cancel-preview" type="button">返回修改</button></div></section><section class="card"><h2>查看維修案件</h2><p>輸入案件編號查看處理進度及雙方紀錄。</p><button id="list-cases" type="button">查看我的案件</button><div id="case-list"></div><form id="load-case"><label for="case-id">案件編號</label><input id="case-id" required><button>查看案件</button></form><div id="case-detail" aria-live="polite"></div></section>
  <p class="muted">Demo 驗證不會發送簡訊，也不代表已驗證手機持有人或實名。</p>
  </main><script>
  (()=>{const main=document.querySelector('main'),role=document.querySelector('#role'),form=document.querySelector('#ask-form'),status=document.querySelector('#ask-status'),answer=document.querySelector('#answer');
  form.addEventListener('submit',async event=>{event.preventDefault();if(!role.value){role.focus();status.textContent='請先選擇這次使用的身分。';return}const button=form.querySelector('button');button.disabled=true;status.textContent='正在查詢已簽合約…';answer.hidden=true;
  try{const response=await fetch('/v2/api/contracts/'+encodeURIComponent(main.dataset.contractId)+'/assistant/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:role.value,question:document.querySelector('#question').value})});let data;try{data=await response.json()}catch{throw new Error('伺服器回應異常，請稍後再試。')}if(!response.ok)throw new Error(data.error||'查詢失敗，請稍後再試。');document.querySelector('#answer-text').textContent=data.answer||'目前無法提供回答，請稍後再試。';document.querySelector('#version').textContent='已簽合約第 '+data.versionNumber+' 版｜文件雜湊：'+data.documentHash;selectedCitations=[];const citations=document.querySelector('#citations');citations.replaceChildren();for(const citation of (Array.isArray(data.citations)?data.citations:[])){const item=document.createElement('div');item.className='citation';const locator=document.createElement('strong');locator.textContent=citation.locator||'合約原文';const quote=document.createElement('p');quote.className='answer';quote.textContent=citation.quote||'';const link=document.createElement('a');link.textContent='在已簽原文件查看';link.href='/v2/contracts/'+encodeURIComponent(main.dataset.contractId)+'/completed/document#:~:text='+encodeURIComponent(citation.quote||'');item.append(locator,quote,link);const choice=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.style.width='auto';checkbox.addEventListener('change',()=>{selectedCitations=selectedCitations.filter(c=>c!==citation);if(checkbox.checked)selectedCitations.push(citation)});choice.append(checkbox,' 建案時共享這段依據（最多三段）');item.append(choice);citations.append(item)}if(!citations.children.length)citations.textContent='目前沒有可顯示的引用。';answer.hidden=false;status.textContent='查詢完成。'}catch(error){status.textContent=error.message||'查詢失敗，請稍後再試。'}finally{button.disabled=false}});
  const base='/v2/api/contracts/'+encodeURIComponent(main.dataset.contractId)+'/assistant/cases',caseStatus=document.querySelector('#case-status'),preview=document.querySelector('#preview');let pending=null;let selectedCitations=[];const occurredInput=document.querySelector('#occurred-on'),urgentInput=document.querySelector('#urgent');urgentInput.addEventListener('change',()=>{occurredInput.required=!urgentInput.checked});
  const photoInput=document.querySelector('#photos');photoInput.addEventListener('change',()=>{const box=document.querySelector('#local-photos');box.replaceChildren();for(const file of photoInput.files){const image=document.createElement('img');image.alt='待分享照片：'+file.name;image.style.cssText='max-width:140px;max-height:140px;margin:4px';image.src=URL.createObjectURL(file);image.onload=()=>URL.revokeObjectURL(image.src);box.append(image)}});
  async function uploadPhotos(files,currentRole){if(files.length>10)throw new Error('每次最多上傳 10 張照片。');const ids=[];for(const file of files){if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5*1024*1024)throw new Error('照片須為 JPEG、PNG 或 WebP，且每張不超過 5 MB。');const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('無法讀取照片。'));reader.readAsDataURL(file)});const result=await request(base+'/photos',{role:currentRole,base64,filename:file.name});ids.push(result.publicId)}return ids}
  let authRecovery=null;
  function sessionExpired(){
    if(!authRecovery){
      authRecovery=document.createElement('section');authRecovery.className='card action-confirm';authRecovery.setAttribute('role','alert');
      const title=document.createElement('h2');title.textContent='請重新確認 LINE 身分';
      const note=document.createElement('p');note.textContent='登入已逾時或無法取得身分。重新驗證後會回到這筆案件；尚未確認的操作不會自動送出。';
      const button=document.createElement('button');button.type='button';button.textContent='重新確認 LINE 身分';
      button.onclick=()=>{const query=new URLSearchParams(location.search);query.set('_reauth',String(Date.now()));location.replace('/v2/contracts/'+encodeURIComponent(main.dataset.contractId)+'/assistant?'+query.toString())};
      authRecovery.append(title,note,button);main.append(authRecovery);
    }
    authRecovery.querySelector('button').focus({preventScroll:true});authRecovery.scrollIntoView({block:'center'});
  }
  async function request(url,body){const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});if(response.status===401){sessionExpired();throw new Error('LINE 登入已逾時，請按「重新確認 LINE 身分」。')}let data;try{data=await response.json()}catch{throw new Error('伺服器回應異常，請稍後再試。')}if(!response.ok)throw new Error(data.error||'操作失敗，請稍後再試。');return data}
  function selected(){if(!role.value){role.focus();throw new Error('請先選擇這次使用的身分。')}return role.value}
  document.querySelector('#preview-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;preview.hidden=true;try{pending=null;const input={role:selected(),summary:document.querySelector('#summary').value,urgent:urgentInput.checked,occurredOn:occurredInput.value,citations:selectedCitations,photoIds:[]};input.photoIds=await uploadPhotos(photoInput.files,input.role);if(selectedCitations.length>3)throw new Error('最多選擇三段共享合約依據。');const result=await request(base+'/preview',input);pending={role:input.role,previewId:result.previewId,confirmed:true,idempotencyKey:crypto.randomUUID()};const photos=document.querySelector('#preview-photos');photos.replaceChildren();if(!input.photoIds.length)photos.textContent='照片：無';for(const id of input.photoIds){const image=document.createElement('img');image.alt='將分享的照片';image.style.cssText='max-width:140px;max-height:140px;margin:4px';image.src=base+'/photos/'+encodeURIComponent(id)+'?role='+encodeURIComponent(input.role);photos.append(image)}document.querySelector('#preview-summary').textContent=(result.urgent?'緊急事件：':'')+result.summary+'；發生日：'+result.occurredOn;const sharedCitations=document.querySelector('#preview-citations');sharedCitations.replaceChildren();for(const citation of result.citations||[]){const p=document.createElement('p');p.textContent=citation.locator+'：'+citation.quote;sharedCitations.append(p)}document.querySelector('#preview-version').textContent=result.versionNumber ? '已簽合約第 '+result.versionNumber+' 版｜文件雜湊：'+result.documentHash : '目前無法確認已簽版本；本案僅記錄緊急通報，不判定合約責任。';preview.hidden=false;caseStatus.textContent='請確認摘要後再送出。'}catch(error){caseStatus.textContent=error.message}finally{button.disabled=false}});
  document.querySelector('#cancel-preview').addEventListener('click',()=>{preview.hidden=true;pending=null;caseStatus.textContent='已取消，尚未建立案件。'});
  role.addEventListener('change',async()=>{pending=null;preview.hidden=true;answer.hidden=true;selectedCitations=[];document.querySelector('#case-detail').replaceChildren();document.querySelector('#case-list').replaceChildren();if(main.dataset.singlePhone==='true'&&role.value){try{await request('/v2/api/test-role',{role:role.value});location.reload()}catch(error){caseStatus.textContent=error.message}}});
  document.querySelector('#create-case').addEventListener('click',async e=>{if(!pending)return;if(role.value!==pending.role){pending=null;preview.hidden=true;caseStatus.textContent='身分已變更，請重新預覽。';return}e.target.disabled=true;try{const result=await request(base,pending);caseStatus.textContent='案件已建立。';preview.hidden=true;pending=null;showCase(result)}catch(error){caseStatus.textContent=error.message+'；可再次確認，系統會沿用本次送出識別。'}finally{e.target.disabled=false}});
  document.querySelector('#load-case').addEventListener('submit',async e=>{e.preventDefault();try{const currentRole=selected(),id=document.querySelector('#case-id').value.trim();showCase(await request(base+'/'+encodeURIComponent(id)+'?role='+encodeURIComponent(currentRole)))}catch(error){document.querySelector('#case-detail').textContent=error.message}});
  document.querySelector('#list-cases').addEventListener('click',async()=>{const list=document.querySelector('#case-list');try{const data=await request(base+'?role='+encodeURIComponent(selected()));renderList(data)}catch(error){list.textContent=error.message}});
  function renderList(data){const list=document.querySelector('#case-list');list.replaceChildren();const cases=Array.isArray(data)?data:(data.cases||[]);if(!cases.length){list.textContent='目前沒有案件。';return}for(const item of cases){const button=document.createElement('button');button.type='button';button.textContent=item.summary||'查看維修案件';button.addEventListener('click',async()=>{try{showCase(await request(base+'/'+encodeURIComponent(item.publicId||item.public_id)+'?role='+encodeURIComponent(selected())))}catch(error){document.querySelector('#case-detail').textContent=error.message}});list.append(button)}}
  const eventNames={read:'已讀',message:'回覆',supplement:'補件',repair_proposal:'處理方式提案',cost_proposal:'費用提案',close_proposal:'處理結果',repair_agree:'同意處理方式',cost_agree:'同意費用',reject:'拒絕',dispute:'爭議',close_confirm:'確認處理結果',close_disagree:'不同意結案',reopen:'重開案件'};
  const noticeNames={none:'不另通知',pending:'等待發送',sending:'結果不明，請人工確認',unknown:'結果不明，請人工確認',sent:'已送出（不代表已讀或同意）',failed:'發送失敗，可重試'};
  function showCase(data){
    const detail=document.querySelector('#case-detail');detail.replaceChildren();const item=data.case||data,id=item.publicId||item.public_id,current=data.state||{};
    document.querySelector('#case-id').value=id||'';
    function line(text){const p=document.createElement('p');p.className='answer';p.textContent=text;detail.append(p);return p}
    const heading=document.createElement('h3');heading.textContent=item.summary||'維修案件';heading.tabIndex=-1;detail.append(heading);
    line('發生日：'+(item.occurred_on||'未記錄'));
    const roleName=value=>value==='tenant'?'房客':'房東';
    const stages=[
      {title:'處理方式',proposal:current.repairProposal,agreed:current.repairAgreements||[],agreeType:'repair_agree',editType:'repair_proposal',editLabel:'提出處理方式',placeholder:'例如：安排師傅檢查冷氣，時間再與房客確認。'},
      {title:'費用',proposal:current.costProposal,agreed:current.costAgreements||[],agreeType:'cost_agree',editType:'cost_proposal',editLabel:'提出費用',placeholder:'例如：本次檢查費由房東負擔，房客負擔 0 元。'},
      {title:'結案結果',proposal:current.closeProposal,agreed:current.closeConfirmations||[],agreeType:'close_confirm',editType:'close_proposal',editLabel:'提出結案結果',placeholder:'例如：冷氣已恢復正常，請確認處理結果。'}
    ];
    const repairAuthor=(data.events||[]).find(entry=>String(entry.id)===String(current.repairProposal?.id)&&entry.event_type==='repair_proposal')?.role;
    // A repair proposal needs the other party's response, not self-approval.
    // Cost and closure retain their existing explicit two-party confirmations.
    for(const stage of stages){
      stage.requiredRoles=stage.agreeType==='repair_agree'&&['landlord','tenant'].includes(repairAuthor)?['landlord','tenant'].filter(value=>value!==repairAuthor):['landlord','tenant'];
      stage.pendingRoles=stage.requiredRoles.filter(value=>!stage.agreed.includes(value));
    }
    const closed=current.status==='closed';
    const next=stages.find(stage=>!stage.proposal||stage.pendingRoles.length);
    const progress=document.createElement('section');progress.className='case-status';
    const progressTitle=document.createElement('strong');
    progressTitle.textContent=closed?'案件已結案':current.status==='disputed'?'案件有待釐清事項':!next?'目前提案已確認':!next.proposal?'下一步：'+next.editLabel:'等待'+next.pendingRoles.map(roleName).join('、')+'確認'+next.title;
    const progressNote=document.createElement('p');progressNote.textContent='處理方式、費用、結案結果分別確認；未回覆不代表同意。費用確認不會進行付款。';progress.append(progressTitle,progressNote);detail.append(progress);
    const state=line('建案通知：'+(noticeNames[(data.notification||{}).status]||'尚未確認'));state.setAttribute('role','status');
    if(!id)return;
    const actionPreview=document.createElement('section');actionPreview.className='card action-confirm';actionPreview.hidden=true;
    async function prepareAction(type,title,message,proposal,files=[],anchor=null){
      const currentRole=selected();
      const pendingEvent={role:currentRole,type,text:type==='read'?null:message||null,idempotencyKey:crypto.randomUUID(),confirmed:true,...(proposal?{proposalId:proposal.id}:{}),photoIds:[]};
      const pendingFiles=Array.from(files);
      async function submit(button){
        if(selected()!==currentRole){state.textContent='身分已變更，請重新開啟案件。';return}
        button.disabled=true;
        try{if(pendingFiles.length&&!pendingEvent.photoIds.length)pendingEvent.photoIds=await uploadPhotos(pendingFiles,currentRole);showCase(await request(base+'/'+encodeURIComponent(id)+'/events',pendingEvent))}
        catch(error){state.textContent=error.message+'；重試會沿用已確認內容。';button.disabled=false}
      }
      if(type==='read'){const button=detail.querySelector('[data-action="read"]');await submit(button);return}
      if(['message','supplement','repair_proposal','cost_proposal','close_proposal','reject','dispute','close_disagree'].includes(type)&&!String(message||'').trim()){state.textContent='請先填寫'+title+'的內容。';return}
      actionPreview.replaceChildren();(anchor||detail).append(actionPreview);actionPreview.hidden=false;
      const previewTitle=document.createElement('h4');previewTitle.textContent='確認'+title;
      const summary=document.createElement('p');summary.className='answer';summary.textContent=proposal?proposal.text:message||'確認目前提案';
      const note=document.createElement('p');note.textContent='確認後會分享內容並通知另一方。';actionPreview.append(previewTitle,summary,note);
      for(const file of pendingFiles){const image=document.createElement('img');image.alt='確認分享：'+file.name;image.style.cssText='max-width:140px;max-height:140px';image.src=URL.createObjectURL(file);image.onload=()=>URL.revokeObjectURL(image.src);actionPreview.append(image)}
      const confirmButton=document.createElement('button');confirmButton.type='button';confirmButton.textContent='確認分享並通知';confirmButton.onclick=()=>submit(confirmButton);
      const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='返回修改';cancel.onclick=()=>{actionPreview.hidden=true;actionPreview.replaceChildren()};actionPreview.append(confirmButton,cancel);confirmButton.focus({preventScroll:true});actionPreview.scrollIntoView({block:'center'});
    }
    function actionButton(parent,type,title,handler,secondary=false){
      const button=document.createElement('button');button.type='button';button.textContent=title;button.dataset.action=type;if(secondary)button.className='secondary';button.disabled=closed&&type!=='read'&&type!=='reopen';button.onclick=handler;parent.append(button);return button;
    }
    const editor=document.createElement('section');editor.className='editor';editor.hidden=true;
    function editAction(type,title,placeholder,withPhotos=false){
      editor.replaceChildren();editor.hidden=false;actionPreview.hidden=true;
      const label=document.createElement('label');label.textContent=title;const input=document.createElement('textarea');input.maxLength=2000;input.placeholder=placeholder;label.append(input);editor.append(label);
      let photos=null;
      if(withPhotos){const photoLabel=document.createElement('label');photoLabel.textContent='補充照片（選填，確認後分享）';photos=document.createElement('input');photos.type='file';photos.multiple=true;photos.accept='image/jpeg,image/png,image/webp';photoLabel.append(photos);editor.append(photoLabel)}
      const buttons=document.createElement('div');buttons.className='actions';
      actionButton(buttons,type,'預覽'+title,()=>prepareAction(type,title,input.value,null,photos?photos.files:[],editor));
      actionButton(buttons,'cancel-editor','取消編輯',()=>{editor.hidden=true;actionPreview.hidden=true},true);editor.append(buttons);input.focus({preventScroll:true});editor.scrollIntoView({block:'center'});
    }
    for(const stage of stages){
      const panel=document.createElement('section');panel.className='proposal';
      const title=document.createElement('h4');title.textContent=stage.title;panel.append(title);
      const text=document.createElement('p');text.className='answer';text.textContent=stage.proposal?stage.proposal.text:'尚未提出';panel.append(text);
      if(stage.proposal){
        const agreement=document.createElement('p');agreement.className='muted';agreement.textContent=['landlord','tenant'].map(value=>roleName(value)+'：'+(stage.agreeType==='repair_agree'&&value===repairAuthor?'已提出':stage.agreed.includes(value)?'已確認':'待確認')).join(' ／ ');panel.append(agreement);
        if(stage.requiredRoles.includes(role.value)&&!stage.agreed.includes(role.value)&&!closed)actionButton(panel,stage.agreeType,stage.agreeType==='close_confirm'?'確認結案':'同意'+stage.title,()=>prepareAction(stage.agreeType,stage.agreeType==='close_confirm'?'結案':'同意'+stage.title,null,stage.proposal,[],panel));
      }
      if(!closed)actionButton(panel,stage.editType,stage.proposal?'調整'+stage.title:stage.editLabel,()=>editAction(stage.editType,stage.title,stage.placeholder),true);
      detail.append(panel);
    }
    detail.append(editor);
    if(!closed){
      const reply=document.createElement('section');reply.className='proposal';
      const label=document.createElement('label');label.textContent='回覆對方';const text=document.createElement('textarea');text.maxLength=2000;text.placeholder='一般訊息請在這裡回覆；維修安排或費用請用上方對應的提案。';label.append(text);reply.append(label);
      actionButton(reply,'message','預覽回覆',()=>prepareAction('message','回覆',text.value,null,[],reply));detail.append(reply);
    }
    const other=document.createElement('details'),otherTitle=document.createElement('summary');otherTitle.textContent='其他操作';other.append(otherTitle);const otherActions=document.createElement('div');otherActions.className='actions';
    actionButton(otherActions,'read','僅標記已讀',()=>prepareAction('read','標記已讀',null),true);
    if(closed)actionButton(otherActions,'reopen','重開案件',()=>prepareAction('reopen','重開案件',null),true);
    else for(const [type,title] of [['supplement','補充說明與照片'],['reject','拒絕並說明原因'],['dispute','提出爭議'],['close_disagree','不同意結案']])actionButton(otherActions,type,title,()=>editAction(type,title,'請填寫要告知對方的具體內容。',type==='supplement'),true);
    other.append(otherActions);detail.append(other,actionPreview);
    const versions=document.createElement('details'),label=document.createElement('summary'),version=document.createElement('p');label.textContent='查看版本與文件雜湊';version.className='hash';version.textContent=item.version_number ? '已簽合約第 '+item.version_number+' 版｜'+item.document_hash : '本案無可確認的已簽版本，不作合約責任判定。';versions.append(label,version);detail.append(versions);
    const photos=document.createElement('details'),photoTitle=document.createElement('summary');photoTitle.textContent='問題照片與合約依據（'+(data.files||[]).length+' 張照片）';photos.append(photoTitle);photos.className='case-photos';for(const file of data.files||[]){const image=document.createElement('img');image.alt=file.original_name||'共享照片';image.src=base+'/photos/'+encodeURIComponent(file.public_id)+'?role='+encodeURIComponent(role.value);photos.append(image)}detail.append(photos);
    for(const citation of JSON.parse(item.citations_json||'[]'))line('合約依據：'+citation.locator+'：'+citation.quote);
    async function retryNotice(eventId){try{showCase(await request(base+'/'+encodeURIComponent(id)+'/retry-notification',{role:selected(),...(eventId?{eventId}:{})}))}catch(e){state.textContent=e.message}}
    const history=document.createElement('details'),historyTitle=document.createElement('summary');historyTitle.textContent='查看往來紀錄（'+(data.events||[]).length+' 筆）';history.append(historyTitle);
    for(const entry of data.events||[]){const row=document.createElement('div');row.className='history-entry';const text=document.createElement('p');text.className='answer';text.textContent=roleName(entry.role)+'・'+(eventNames[entry.event_type]||'紀錄')+'：'+(entry.message||'')+'｜通知：'+(noticeNames[entry.notification_status]||'尚未確認');row.append(text);if(entry.notification_status==='failed'&&entry.role===role.value){const retry=document.createElement('button');retry.type='button';retry.textContent='重試這筆通知';retry.onclick=()=>retryNotice(entry.id);row.append(retry)}history.append(row)}detail.append(history);
    if((data.notification||{}).status==='failed'){const retry=document.createElement('button');retry.type='button';retry.textContent='重試建案通知';retry.onclick=()=>retryNotice();detail.append(retry)}
    heading.focus({preventScroll:true});detail.scrollIntoView({block:'start'});
  }
  const linkedCase=new URLSearchParams(location.search).get('case');
  if(linkedCase){
    document.querySelector('#case-id').value=linkedCase;
    const caseSection=document.querySelector('#load-case').closest('section');
    const roleSection=role.closest('section');roleSection.after(caseSection);
    form.closest('section').hidden=true;document.querySelector('#preview-form').closest('section').hidden=true;
    if(!role.value&&role.options.length===2)role.value=role.options[1].value;
    if(role.value){
      document.querySelector('#case-detail').textContent='正在開啟通知中的案件…';
      request(base+'/'+encodeURIComponent(linkedCase)+'?role='+encodeURIComponent(role.value)).then(data=>{showCase(data);document.querySelector('#case-detail').scrollIntoView({block:'start'})}).catch(error=>{document.querySelector('#case-detail').textContent=error.message+'；可按「查看案件」重試。'});
    }else caseStatus.textContent='請先選擇身分，再按「查看案件」。';
  }
  })();</script></body></html>`;
}
module.exports = { page };

