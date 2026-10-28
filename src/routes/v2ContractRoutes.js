const express = require('express');
const path = require('node:path');
const { driverMode, withInjectedSqlite, withV2Driver } = require('../database/v2Driver');
const draftService = require('../services/v2ContractDraftServiceAsync');
const repository = require('../repositories/v2ContractRepositoryAsync');
const { renderContractHtml, escapeHtml } = require('../services/v2ContractDocumentService');
const { draftWebNarratives } = require('../services/ecsNeoDraftWebNarratives');
const conditionService = require('../services/v2ContractConditionServiceAsync');
const pages = require('../services/v2ContractPageService');
const signingService = require('../services/v2ContractSigningServiceAsync');
const otpService = require('../services/v2ContractOtpServiceAsync');
const notificationService = require('../services/v2ContractNotificationServiceAsync');
const contractCenterService = require('../services/v2ContractCenterServiceAsync');
const contractCenterPage = require('../services/v2ContractCenterPageService');
const deliveryService = require('../services/v2ContractDeliveryServiceAsync');
const landlordDecisionService = require('../services/ecsNeoLandlordDecisionServiceAsync');
const { processExecutedContract } = require('../services/contractAiParserService');
// 屋況審閱請求走屋況點交自己的那一套(卡片與 landlord_pre_inspection_confirm
// postback),不另造一套確認機制。
const preInspectionLine = require('../services/preInspectionLineService');
const { client: defaultLineClient } = require('../lineClient');
const { readStoredFile } = require('../services/fileStorage');
const { liffBootstrap, readSession, sessionSecret, setSessionCookie } = require('../services/liffSessionService');

// contractEvidenceStorage.resolveEvidenceDir 在缺少設定時報錯是對的:簽章證據不能
// 靜默寫到隨便的位置。問題是它只在「房客已經填完資料、錄完影、按下送出」的那一刻
// 才被呼叫。這裡把同一個條件搬到啟動/路由初始化時,讓誤設定在第一秒就被攔下來。
const EVIDENCE_DIR_MESSAGE = [
  'V2_DB_DRIVER=mysql 時必須同時設定 V2_CONTRACT_EVIDENCE_DIR。',
  '合約簽章證據（簽名影像、筆跡、本人錄影）沒有本機 SQLite 檔案可以推導存放位置，系統不會替你猜一個路徑。',
  '請在 .env 補上 V2_CONTRACT_EVIDENCE_DIR=<存放簽章證據的資料夾路徑> 後重新啟動。'
].join('\n');

function assertContractEvidenceDirConfigured() {
  if (driverMode() !== 'mysql') return;
  if (String(process.env.FILE_STORAGE_PROVIDER || '').trim().toLowerCase() === 'r2') return;
  if (String(process.env.V2_CONTRACT_EVIDENCE_DIR || '').trim()) return;
  throw new Error(EVIDENCE_DIR_MESSAGE);
}

function viewerId(req) {
  const id = String(req.v2LineUserId || '').trim();
  if (!id) { const error = new Error('LINE identity required'); error.statusCode = 401; throw error; }
  return id;
}

const hasViewer = (req) => Boolean(req.v2LineUserId);

const shell = pages.shell;
const documentBody = (html) => html.replace(/^.*?<body>|<\/body>.*$/gs, '');
const OVERLAY_SCRIPTS = `${pages.READ_JSON_SCRIPT}\n${pages.BUSY_OVERLAY_SCRIPT}`;

// 流程走完之後把畫面收掉並回 LINE。原本只 alert 一聲就停在原地,使用者不知道
// 已經完成,會回頭重按 —— 房東因此按了兩次簽署、再按拒絕,撞上 CHECK 約束。
// 先鎖住所有控制項再關閉,避免關閉前又被點到。
// silent=true 給送出遮罩用:遮罩上已經顯示「完成」與完成鈕,不需要再彈一次 alert。
const FINISH_SCRIPT = `function finishAndClose(message,silent){
  document.querySelectorAll('button,input,canvas').forEach(function(el){el.disabled=true;el.style.pointerEvents='none'});
  if(!silent)alert(message);
  try{ if(window.liff&&liff.isInClient&&liff.isInClient()){liff.closeWindow();return} }catch(e){}
  document.body.innerHTML='<main style="min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,sans-serif"><section style="max-width:420px;text-align:center"><h1 style="font-size:22px;margin:0 0 12px">'+message+'</h1><p style="color:#64748B;line-height:1.7;margin:0">可以關閉這個視窗回到 LINE。</p></section></main>';
}`;

function createV2ContractRoutes({
  getDb,
  lineClient = defaultLineClient
} = {}) {
  const router = express.Router();
  const allowTestIdentity = Boolean(getDb);
  // 注入 getDb 的測試一律走本機 SQLite,證據目錄由 driver 的檔案路徑推導,
  // 不需要 V2_CONTRACT_EVIDENCE_DIR;只有真正跑 runtime driver 時才檢查。
  if (!getDb) assertContractEvidenceDirConfigured();
  // 每個請求取一個 driver。mysql 時是從連線池取一條、用完歸還 —— 交易綁在
  // 單一 session,整個請求必須用同一條連線,否則交易保證會靜默消失。
  // 沒有注入 getDb 時走 V2_DB_DRIVER 決定的路徑(預設仍是 SQLite)。
  const withDriver = getDb ? withInjectedSqlite(getDb) : withV2Driver;
  router.use('/v2/api', express.json({ limit: '120mb' }));
  router.get('/', (req, res, next) => {
    const returnUrl = String(req.query['liff.state'] || '');
    if (!returnUrl.startsWith('/v2/')) return next();
    const decoded = decodeURIComponent(returnUrl);
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.code && req.query.state) return res.send(liffBootstrap(decoded));
    res.redirect(decoded);
  });
  router.use((req, res, next) => {
    req.v2LineUserId = readSession(req) || (allowTestIdentity ? String(req.query.lineUserId || req.get('x-line-user-id') || '').trim() : '');
    next();
  });

  router.post('/v2/api/liff-session', async (req, res, next) => {
    try {
      if (!sessionSecret()) throw new Error('LINE channel secret is not configured');
      const response = await fetch('https://api.line.me/v2/profile', { headers: { authorization: `Bearer ${String(req.body.accessToken || '')}` } });
      if (!response.ok) { const error = new Error('invalid LIFF access token'); error.statusCode = 401; throw error; }
      const profile = await response.json();
      setSessionCookie(req, res, profile.userId);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/v2/contracts/drafts', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const current = await repository.findCurrentContractForViewer(db, viewerId(req));
      if (!current) return res.status(404).send(pages.emptyPage('合約草稿', '目前沒有合約草稿', '請回 LINE 與 Agent 完成承租條件討論，系統會在雙方談定條件後產生草稿。', '想先留下屋況紀錄的話，可以先在 LINE 點「屋況點交」拍照存檔，之後草稿產生時會自動列入附件一。'));
      res.redirect(`/v2/contracts/${encodeURIComponent(current.contractPublicId)}/drafts`);
    }).catch(next);
  });

  router.get('/v2/contracts', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const center = await contractCenterService.getContractCenter({ db, lineUserId: viewerId(req) });
      res.setHeader('Cache-Control', 'no-store');
      res.send(contractCenterPage.page(center));
    }).catch(next);
  });

  router.get('/v2/api/contracts/center', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) {
        const error = new Error('unauthorized');
        error.statusCode = 401;
        throw error;
      }
      res.json(await contractCenterService.getContractCenter({ db, lineUserId: viewerId(req) }));
    }).catch(next);
  });

  router.get('/v2/contracts/:contractPublicId/completed', (req, res, next) => {
    withDriver(async (db) => {
      res.setHeader('Cache-Control', 'private, no-store');
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const delivery = await deliveryService.getCompletedContract({ db, lineUserId: viewerId(req), contractPublicId: req.params.contractPublicId });
      res.send(pages.completedContractPage(delivery));
    }).catch(next);
  });

  router.get('/v2/contracts/:contractPublicId/completed/document', (req, res, next) => {
    withDriver(async (db) => {
      res.setHeader('Cache-Control', 'private, no-store');
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const delivery = await deliveryService.getCompletedContract({ db, lineUserId: viewerId(req), contractPublicId: req.params.contractPublicId });
      res.set({ 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(delivery.bytes.length) });
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
      if (req.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="executed-contract.html"');
      res.end(delivery.bytes);
    }).catch(next);
  });

  router.get('/v2/sign', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const current = await repository.findPendingSignatureRequestForViewer(db, viewerId(req));
      if (!current) return res.status(404).send(pages.emptyPage('電子簽署', '目前沒有待簽署合約', '有新合約需要處理時會由 LINE 通知你。', '想先確認條款內容，可以回 LINE 開啟「合約草稿」查看最新版本。'));
      res.redirect(`/v2/sign/${encodeURIComponent(current.signatureRequestPublicId)}`);
    }).catch(next);
  });

  router.get('/v2/contracts/:contractPublicId/drafts', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const lineUserId = viewerId(req);
      const overview = await draftService.getDraftOverview({ db, lineUserId, contractPublicId: req.params.contractPublicId });
      if (!overview.versions.length) return res.status(404).send(pages.emptyPage('合約草稿', '這份合約還沒有任何版本', '請回 LINE 與 Agent 完成承租條件討論。'));
      const conditionPanel = await conditionService.getConditionPanel({ db, lineUserId, versionPublicId: overview.versions[0].publicId });
      const latest = overview.versions[0];
      res.send(pages.draftOverviewPage({
        contractPublicId: overview.contractPublicId,
        overview: overview.overview,
        versions: overview.versions,
        conditionPanel,
        // 用「這個人有沒有房客身分」判斷,不是用被壓成一個的 viewerRole ——
        // 同一個人同時是房東與房客時,viewerRole 只會是其中一個,另一邊的按鈕就消失了。
        canProposeSigning: (overview.overview.viewerRoles || []).includes('tenant') && latest.status === 'draft',
        latestVersionPublicId: latest.publicId,
        viewerRole: overview.overview.viewerRole,
        viewerRoles: overview.overview.viewerRoles || [],
        latestVersionNumber: latest.versionNumber,
        termsConfirmation: await landlordDecisionService.landlordTermsStatus(
          db,
          (await repository.getVersionForViewer(db, { lineUserId, versionPublicId: latest.publicId })).id
        ),
        // 房東最後一次「要求修改／拒絕」與他寫的理由。房客在 LINE 之外也看得到。
        landlordDecision: await landlordDecisionService.latestLandlordDecision(
          db,
          (await repository.getVersionForViewer(db, { lineUserId, versionPublicId: latest.publicId })).contract_id
        )
      }));
    }).catch(next);
  });

  router.get('/v2/contracts/:contractPublicId/drafts/:versionPublicId', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const version = await repository.getVersionForViewer(db, { lineUserId: viewerId(req), versionPublicId: req.params.versionPublicId });
      const party = await repository.requireVersionParty(db, { lineUserId: viewerId(req), versionPublicId: req.params.versionPublicId });
      if (version.contract_id !== party.contract_id) throw new Error('forbidden');
      const document = renderContractHtml({
        conditions: JSON.parse(version.condition_snapshot_json),
        watermark: '草稿・不可簽署',
        attachments: await conditionService.attachmentsForVersion(db, version.id),
        subject: await repository.getContractSubject(db, version.contract_id)
      });
      res.send(pages.draftVersionPage({ contractPublicId: req.params.contractPublicId, versionNumber: version.version_number, documentBody: documentBody(document), narrativesHtml: await draftWebNarratives(db, version.id) }));
    }).catch(next);
  });

  router.get('/v2/contracts/:contractPublicId/draft-diff', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const result = await draftService.compareDraftVersions({ db, lineUserId: viewerId(req), leftVersionPublicId: req.query.left, rightVersionPublicId: req.query.right });
      res.send(pages.diffPage({ result }));
    }).catch(next);
  });

  router.get('/v2/api/contracts/:contractPublicId/drafts', (req, res, next) => {
    withDriver(async (db) => {
      res.json(await draftService.getDraftOverview({ db, lineUserId: viewerId(req), contractPublicId: req.params.contractPublicId }));
    }).catch(next);
  });

  router.get('/v2/api/contracts/versions/:versionPublicId/condition-records', (req, res, next) => {
    withDriver(async (db) => {
      res.json(await conditionService.getConditionPanel({ db, lineUserId: viewerId(req), versionPublicId: req.params.versionPublicId }));
    }).catch(next);
  });
  router.post('/v2/api/contracts/versions/:versionPublicId/condition-records', (req, res, next) => {
    withDriver(async (db) => {
      res.json(await conditionService.attachConditionRecord({ db, lineUserId: viewerId(req), versionPublicId: req.params.versionPublicId, sessionPublicId: String(req.body.sessionPublicId || '') }));
    }).catch(next);
  });
  router.delete('/v2/api/contracts/versions/:versionPublicId/condition-records', (req, res, next) => {
    withDriver(async (db) => {
      res.json(await conditionService.detachConditionRecord({ db, lineUserId: viewerId(req), versionPublicId: req.params.versionPublicId, sessionPublicId: String(req.body.sessionPublicId || '') }));
    }).catch(next);
  });

  // 房東在草稿頁上對條件表態。這是房東第一次、也是唯一一次能在簽署之前說
  // 「條件我不同意」的地方；確認之後房客才送得出簽署。
  router.post('/v2/api/contracts/versions/:versionPublicId/landlord-terms', (req, res, next) => {
    withDriver(async (db) => {
      const decision = String(req.body.decision || '');
      const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
      const result = await landlordDecisionService.decideDraftTerms({
        db,
        lineUserId: viewerId(req),
        versionPublicId: req.params.versionPublicId,
        decision,
        reason
      });
      // 通知失敗不影響已經成立的決定：房客回到草稿頁一樣看得到最新狀態。
      try {
        await notificationService.notifyTenantTermsDecision({
          db, lineClient, versionPublicId: result.versionPublicId, decision: result.decision, reason
        });
      } catch { result.notificationPending = true; }
      res.json(result);
    }).catch(next);
  });

  // 「開簽署頁」必須是純讀取。只有房客明確按下草稿頁的按鈕，才可以把草稿發行成
  // 正式簽署文件；而且附件一內的每份屋況紀錄都必須已由房東確認。
  //
  // 未確認時不再只回一句錯誤:先把每一份未確認的附件推進「待房東審閱」並通知房東,
  // 再回 409 帶上等待清單。擋下送簽的規則沒有放寬——assertAttachmentsConfirmed
  // 仍在下面守著,只是使用者現在知道在等誰、房東那邊也真的收到了請求。
  router.post('/v2/api/contracts/versions/:versionPublicId/issue', (req, res, next) => {
    withDriver(async (db) => {
      const lineUserId = viewerId(req);
      const party = await repository.requireVersionParty(db, { lineUserId, versionPublicId: req.params.versionPublicId });
      if (party.party_role !== 'tenant') { const error = new Error('only the tenant can propose a contract for signing'); error.statusCode = 403; throw error; }
      const version = await repository.getVersionForViewer(db, { lineUserId, versionPublicId: req.params.versionPublicId });
      const latest = await db.get('SELECT public_id FROM contract_versions WHERE contract_id=? ORDER BY version_number DESC, id DESC LIMIT 1', [version.contract_id]);
      if (latest?.public_id !== version.public_id) { const error = new Error('只能送出最新草稿版本'); error.statusCode = 409; throw error; }
      if (version.status !== 'draft') { const error = new Error('這個版本已經送出或無法簽署'); error.statusCode = 409; throw error; }
      const review = await conditionService.requestLandlordConditionReview({
        db,
        lineUserId,
        versionPublicId: version.public_id,
        notify: (notices) => preInspectionLine.pushLandlordConditionReviewRequests(db, notices, { lineClient })
      });
      if (review.pending.length) {
        return res.status(409).json({ ok: false, error: review.message, review });
      }
      await conditionService.assertAttachmentsConfirmed(db, version.id);
      // 第二道關卡:房東要先確認**條件**本身。沒有這一關,房客會在房東對租金、
      // 租期表過態之前就交出身分證資料、錄影與簽名。同樣不是丟一句錯誤:
      // 請求真的送到房東那邊,回應也告訴房客在等什麼。
      const terms = await landlordDecisionService.requestLandlordTermsConfirmation({
        db,
        lineUserId,
        versionPublicId: version.public_id,
        notify: ({ versionPublicId }) => notificationService.notifyLandlordTermsConfirmationRequested({
          db, lineClient, versionPublicId
        })
      });
      if (!terms.confirmed) {
        return res.status(409).json({ ok: false, error: terms.message, terms });
      }
      res.json(await repository.issueVersion(db, { versionPublicId: version.public_id }));
    }).catch(next);
  });

  router.get('/v2/sign/:signatureRequestPublicId', (req, res, next) => {
    withDriver(async (db) => {
      if (!hasViewer(req)) return res.send(liffBootstrap(req.originalUrl));
      const request = await repository.requireSignatureRequest(db, { lineUserId: viewerId(req), signatureRequestPublicId: req.params.signatureRequestPublicId });
      const version = await db.get('SELECT * FROM contract_versions WHERE id=?', [request.contract_version_id]);
      const attachments = await conditionService.attachmentsForVersion(db, version.id);
      const document = renderContractHtml({
        conditions: JSON.parse(version.condition_snapshot_json),
        watermark: request.party_role === 'tenant' ? '正式簽署文件' : '房東確認文件',
        attachments,
        subject: await repository.getContractSubject(db, request.contract_id)
      });
      const requestId = JSON.stringify(req.params.signatureRequestPublicId);
      const photoCount = attachments.reduce((total, attachment) => total + attachment.imageCount, 0);
      const attachmentNote = attachments.length
        ? `本合約附件一已列入 ${attachments.length} 份入住前屋況紀錄、共 ${photoCount} 張照片，隨簽名一起納入文件雜湊。`
        : '本合約未附入住前屋況紀錄，交屋時以現況點交。';
      const otpCard = `<section class="card"><h2>OTP 驗證 <span class="pill warn">Demo</span></h2><p class="muted">Mock OTP，不會發送真實簡訊，也不代表已完成實名驗證。本次展示碼為 <strong>123456</strong>。</p><div class="field-row" style="margin-top:12px"><button class="button secondary" id="otp-start">取得 Demo 驗證碼</button></div><label>驗證碼<input id="otp-code" inputmode="numeric" maxlength="6" value="123456"></label><button class="button" id="otp-verify">驗證</button><p id="otp-status" class="status-line">尚未驗證</p></section>`;

      if (request.party_role === 'landlord') {
        return res.send(shell('房東合約確認', `${pages.stepList(['OTP 驗證', '閱讀合約', '本人錄影', '簽名確認', '完成決定'])}
      ${otpCard}
      <section class="card"><h2>合約全文</h2><p class="muted">${escapeHtml(attachmentNote)}</p></section>
      <section class="card document" id="contract">${documentBody(document)}<div id="contract-end"></div></section>
      <section class="card"><h2>本人錄影</h2><video id="camera" autoplay muted playsinline></video><button class="button secondary" id="record">開啟前鏡頭並錄影</button><p id="video-status" class="status-line">尚未完成</p></section>
      <section class="card"><h2>手寫簽名</h2><canvas id="signature" width="640" height="240" aria-label="房東手寫簽名區"></canvas><button class="button ghost" id="clear">清除重簽</button><p id="signature-status" class="status-line">尚未簽名</p></section>
      <section class="card"><h2>完成決定</h2><label class="checkbox"><input id="consent" type="checkbox">我確認本合約與原先授權條件一致</label><label style="margin-top:12px">理由（可不填，只有房客看得到）<textarea id="decision-reason" rows="2" maxlength="500" placeholder="例如：租金想再談，或這間打算自住"></textarea></label><div class="field-row"><button class="button" id="sign">簽署</button><button class="button secondary" id="request-changes">要求修改</button><button class="button danger" id="reject">拒絕</button></div><p class="muted" style="margin-top:10px">要求修改會讓房客回到 AI 協調並建立新版；拒絕會終止這一筆承租意向，但房客仍可以在原本的對話裡重新跟你談。</p></section>
      <script>${FINISH_SCRIPT}
      (()=>{${OVERLAY_SCRIPTS}
      const requestId=${requestId};let videoDataUrl='',strokes=[],drawing=false,challenge='',submitting=false;
      const setStep=(n,state)=>{const li=document.querySelector('[data-step="'+n+'"]');if(li)li.dataset.state=state};
      const doneStep=n=>{setStep(n,'done');setStep(n+1,'active')};
      const mark=(id,text)=>{const el=document.querySelector(id);el.textContent=text;el.dataset.state='done'};
      const post=(path,data)=>fetch('/v2/api/sign/'+encodeURIComponent(requestId)+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(readJson);
      document.querySelector('#otp-start').onclick=async()=>{try{const r=await post('/otp/start',{});challenge=r.challengePublicId;document.querySelector('#otp-status').textContent='驗證碼已建立，請按驗證'}catch(e){alert(e.message)}};
      document.querySelector('#otp-verify').onclick=async()=>{try{if(!challenge)throw new Error('請先取得 Demo 驗證碼');await post('/otp/verify',{challengePublicId:challenge,code:document.querySelector('#otp-code').value});mark('#otp-status','OTP 驗證完成');doneStep(1)}catch(e){alert(e.message)}};
      new IntersectionObserver(entries=>{if(entries[0].isIntersecting)doneStep(2)},{threshold:1}).observe(document.querySelector('#contract-end'));
      const toDataUrl=blob=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)});
      document.querySelector('#record').onclick=async()=>{try{const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:{facingMode:'user',width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}}),chunks=[],recorder=new MediaRecorder(stream);document.querySelector('#camera').srcObject=stream;document.querySelector('#video-status').textContent='錄影中…（5 秒）';recorder.ondataavailable=e=>e.data.size&&chunks.push(e.data);recorder.onstop=async()=>{videoDataUrl=await toDataUrl(new Blob(chunks,{type:recorder.mimeType||'video/webm'}));stream.getTracks().forEach(t=>t.stop());mark('#video-status','錄影完成');doneStep(3)};recorder.start();setTimeout(()=>recorder.stop(),5000)}catch{document.querySelector('#video-status').textContent='鏡頭無法開啟'}};
      const c=document.querySelector('#signature'),x=c.getContext('2d');x.lineWidth=3;x.lineCap='round';const p=e=>{const r=c.getBoundingClientRect(),q=e.touches?e.touches[0]:e;return[(q.clientX-r.left)*c.width/r.width,(q.clientY-r.top)*c.height/r.height]};
      const start=e=>{e.preventDefault();drawing=true;const q=p(e);strokes.push([q]);x.beginPath();x.moveTo(...q)},move=e=>{if(!drawing)return;e.preventDefault();const q=p(e);strokes.at(-1).push(q);x.lineTo(...q);x.stroke()},end=()=>{if(drawing&&strokes.length){mark('#signature-status','簽名完成');doneStep(4)}drawing=false};
      ['mousedown','touchstart'].forEach(n=>c.addEventListener(n,start));['mousemove','touchmove'].forEach(n=>c.addEventListener(n,move));['mouseup','mouseleave','touchend'].forEach(n=>c.addEventListener(n,end));
      document.querySelector('#clear').onclick=()=>{x.clearRect(0,0,c.width,c.height);strokes=[];const el=document.querySelector('#signature-status');el.textContent='尚未簽名';el.dataset.state=''};
      const reasonText=()=>{const el=document.querySelector('#decision-reason');return el?el.value.trim():''};
      const api=(decision,evidence)=>fetch('/v2/api/sign/'+encodeURIComponent(requestId)+'/landlord-decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,evidence,reason:reasonText()})}).then(readJson);
      document.querySelector('#sign').onclick=async()=>{if(!document.querySelector('#consent').checked||!videoDataUrl||!strokes.length)return alert('請完成確認、錄影與簽名');if(submitting)return;submitting=true;busy.start('處理中');try{await api('sign',{signatureDataUrl:c.toDataURL('image/png'),strokesJson:JSON.stringify(strokes),videoDataUrl,documentHash:${JSON.stringify(request.document_hash)}});doneStep(5);busy.done('合約已完成',m=>finishAndClose(m,true))}catch(e){submitting=false;busy.fail(e.message)}};
      document.querySelector('#request-changes').onclick=async()=>{if(!confirm('要請房客回到 AI 協調並建立新版嗎？'))return;if(submitting)return;submitting=true;busy.start('處理中');try{await api('request_changes');busy.done('已通知房客修改',m=>finishAndClose(m,true))}catch(e){submitting=false;busy.fail(e.message)}};document.querySelector('#reject').onclick=async()=>{if(!confirm('拒絕後這一筆承租意向會結束（房客仍可在原本的對話裡重談），確定拒絕？'))return;if(submitting)return;submitting=true;busy.start('處理中');try{await api('reject');busy.done('已拒絕此承租意向',m=>finishAndClose(m,true))}catch(e){submitting=false;busy.fail(e.message)}}})()</script>`));
      }

      res.send(shell('電子簽署', `${pages.stepList(['OTP 驗證', '閱讀合約', '填寫資料', '本人錄影', '手寫簽名', '完成預覽', '送出意向'])}
      ${otpCard}
      <section class="card"><h2>閱讀合約</h2><p class="muted">${escapeHtml(attachmentNote)}請捲動到合約末尾，系統會記錄你已讀完整份文件。</p></section>
      <section class="card document" id="contract">${documentBody(document)}<div id="contract-end"></div></section>
      <div class="version-actions" style="margin-bottom:14px"><button class="button" id="read-next" disabled>我已閱讀完整合約</button></div>
      <section class="card" id="personal"><h2>填寫資料</h2><p class="muted">這些欄位只會寫進你的正式合約文件，不會顯示在草稿頁。</p><form id="personal-form"><label>姓名<input required name="legalName" autocomplete="name"></label><label>電話<input required name="phone" autocomplete="tel" inputmode="tel" placeholder="09xxxxxxxx"></label><label>身分證字號<input required name="nationalId" autocomplete="off" autocapitalize="characters" placeholder="A123456789"></label><label>戶籍地址<input required name="householdAddress" autocomplete="street-address"></label><button class="button">建立正式預覽</button></form><p id="personal-status" class="status-line">尚未建立</p></section>
      <section class="card"><h2>本人錄影</h2><p class="muted">錄影用於證明是本人操作，長度 5 秒。</p><video id="camera" autoplay muted playsinline></video><div class="field-row"><button class="button secondary" id="camera-start">開啟前鏡頭並錄影</button><label class="button ghost" style="margin:0">無法開啟時上傳影片<input id="video-fallback" type="file" accept="video/*" capture="user" hidden></label></div><p id="video-status" class="status-line">尚未完成</p></section>
      <section class="card"><h2>手寫簽名</h2><p class="muted">用手指在框內簽名，簽壞了可以清除重簽。</p><canvas id="signature" width="640" height="240" aria-label="手寫簽名區"></canvas><button class="button ghost" id="signature-clear">清除重簽</button><p id="signature-status" class="status-line">尚未簽名</p></section>
      <section class="card"><h2>完成預覽</h2><iframe id="preview" title="完成合約預覽"></iframe><p class="muted">版本 ${version.version_number}｜文件雜湊 <span id="document-hash">尚未建立</span></p><label class="checkbox"><input id="consent" type="checkbox" required> 我已閱讀並同意以此簽名表達承租意向</label><button class="button" id="submit-signature">送出意向</button><p id="submit-status" class="status-line">尚未送出</p></section>
      <script>
      ${FINISH_SCRIPT}
      (()=>{${OVERLAY_SCRIPTS}
      const requestId=${requestId};let videoDataUrl='',strokes=[],drawing=false,lastSent=0,documentHash='',otpChallenge='',submitting=false;
      const setStep=(n,state)=>{const li=document.querySelector('[data-step="'+n+'"]');if(li)li.dataset.state=state};
      const doneStep=n=>{setStep(n,'done');setStep(n+1,'active')};
      const mark=(id,text)=>{const el=document.querySelector(id);el.textContent=text;el.dataset.state='done'};
      const api=(path,body)=>fetch('/v2/api/sign/'+encodeURIComponent(requestId)+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(readJson);
      document.querySelector('#otp-start').addEventListener('click',async()=>{try{const result=await api('/otp/start',{});otpChallenge=result.challengePublicId;document.querySelector('#otp-status').textContent='驗證碼已建立，請輸入展示碼'}catch(error){alert(error.message)}});
      document.querySelector('#otp-verify').addEventListener('click',async()=>{try{if(!otpChallenge)throw new Error('請先取得 Demo 驗證碼');await api('/otp/verify',{challengePublicId:otpChallenge,code:document.querySelector('#otp-code').value});mark('#otp-status','OTP 驗證完成');doneStep(1)}catch(error){alert(error.message)}});
      const sentinel=document.querySelector('#contract-end');new IntersectionObserver(entries=>{if(entries[0].isIntersecting){document.querySelector('#read-next').disabled=false;const now=Date.now();if(now-lastSent>5000){lastSent=now;api('/reading',{progress:100}).catch(()=>{})}}},{threshold:1}).observe(sentinel);
      document.querySelector('#read-next').addEventListener('click',()=>{doneStep(2);document.querySelector('#personal').scrollIntoView({behavior:'smooth'})});
      document.querySelector('#personal-form').addEventListener('submit',async e=>{e.preventDefault();const personalData=Object.fromEntries(new FormData(e.currentTarget));try{const r=await api('/personal-data',{personalData});documentHash=r.documentHash;document.querySelector('#document-hash').textContent=documentHash;document.querySelector('#preview').src=r.previewUrl;mark('#personal-status','正式預覽已建立');doneStep(3)}catch(error){alert(error.message)}});
      const mediaConstraints={audio:true,video:{facingMode:'user',width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}};
      const toDataUrl=blob=>new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)});
      document.querySelector('#camera-start').addEventListener('click',async()=>{try{const stream=await navigator.mediaDevices.getUserMedia(mediaConstraints);const video=document.querySelector('#camera');video.srcObject=stream;const chunks=[],recorder=new MediaRecorder(stream);document.querySelector('#video-status').textContent='錄影中…（5 秒）';recorder.ondataavailable=e=>e.data.size&&chunks.push(e.data);recorder.onstop=async()=>{videoDataUrl=await toDataUrl(new Blob(chunks,{type:recorder.mimeType||'video/webm'}));stream.getTracks().forEach(track=>track.stop());mark('#video-status','錄影完成');doneStep(4)};recorder.start();setTimeout(()=>recorder.stop(),5000)}catch(error){document.querySelector('#video-status').textContent='無法開啟鏡頭，請改用影片上傳'}});
      document.querySelector('#video-fallback').addEventListener('change',async e=>{if(e.target.files[0]){videoDataUrl=await toDataUrl(e.target.files[0]);mark('#video-status','影片已選擇');doneStep(4)}});
      const canvas=document.querySelector('#signature'),ctx=canvas.getContext('2d');ctx.lineWidth=3;ctx.lineCap='round';const point=e=>{const r=canvas.getBoundingClientRect(),p=e.touches?e.touches[0]:e;return[(p.clientX-r.left)*canvas.width/r.width,(p.clientY-r.top)*canvas.height/r.height]};const start=e=>{e.preventDefault();drawing=true;const p=point(e);strokes.push([p]);ctx.beginPath();ctx.moveTo(...p)};const move=e=>{if(!drawing)return;e.preventDefault();const p=point(e);strokes[strokes.length-1].push(p);ctx.lineTo(...p);ctx.stroke()};const end=()=>{if(drawing&&strokes.length){mark('#signature-status','簽名完成');doneStep(5)}drawing=false};['mousedown','touchstart'].forEach(x=>canvas.addEventListener(x,start));['mousemove','touchmove'].forEach(x=>canvas.addEventListener(x,move));['mouseup','mouseleave','touchend'].forEach(x=>canvas.addEventListener(x,end));document.querySelector('#signature-clear').onclick=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);strokes=[];const el=document.querySelector('#signature-status');el.textContent='尚未簽名';el.dataset.state=''};
      document.querySelector('#submit-signature').addEventListener('click',async()=>{if(!document.querySelector('#consent').checked)return alert('請先勾選同意');if(!videoDataUrl||!strokes.length||!documentHash)return alert('請完成資料、錄影與簽名');if(submitting)return;submitting=true;busy.start('處理中');try{const result=await api('/tenant-submit',{evidence:{signatureDataUrl:canvas.toDataURL('image/png'),strokesJson:JSON.stringify(strokes),videoDataUrl,documentHash}});doneStep(6);const message=result.waitingFor==='landlord'?'已送出，等待房東簽署':'已完成';mark('#submit-status',message);setStep(7,'done');busy.done(message,m=>finishAndClose(m,true))}catch(error){submitting=false;busy.fail(error.message);const el=document.querySelector('#submit-status');el.textContent=error.message;el.dataset.state='error'}});
      })();</script>`));
    }).catch(next);
  });

  router.get('/v2/repair-files/:filePublicId', (req, res, next) => {
    withDriver(async (db) => {
      const file = await db.get(`
        SELECT DISTINCT f.*
        FROM files f
        JOIN file_links fl
          ON fl.file_id = f.id
         AND fl.entity_type = 'repair_update'
        JOIN repair_updates ru ON ru.id = fl.entity_id
        JOIN repair_tickets rt ON rt.id = ru.repair_ticket_id
        WHERE f.public_id = ?
          AND f.status = 'active'
          AND f.storage_provider IN ('local', 's3')
          AND f.security_classification IN ('private', 'internal')
          AND COALESCE(fl.purpose, '') IN ('damage_photo', 'completion_photo', 'supplement')
        LIMIT 1
      `, [req.params.filePublicId]);
      if (!file) return res.status(404).send('file not found');
      // local rows must still resolve under uploads/ — storage_key isn't attacker-controlled
      // (it comes from our own writer), but this guard predates that trust and is cheap to keep.
      if (file.storage_provider === 'local') {
        const uploadsRoot = path.resolve(process.cwd(), 'uploads');
        const absolutePath = path.resolve(process.cwd(), file.storage_key);
        if (!absolutePath.startsWith(uploadsRoot + path.sep)) return res.status(403).send('forbidden');
      }
      let bytes;
      try {
        bytes = await readStoredFile(file);
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).send('file not found');
        throw error;
      }
      res.set({ 'Content-Type': file.mime_type || 'application/octet-stream', 'Content-Length': String(bytes.length) });
      res.end(bytes);
    }).catch(next);
  });

  router.get('/v2/files/:filePublicId', (req, res, next) => {
    withDriver(async (db) => {
      const file = await db.get("SELECT f.* FROM files f JOIN file_links fl ON fl.file_id=f.id AND fl.entity_type='contract_version' JOIN contract_versions cv ON cv.id=fl.entity_id JOIN contract_parties cp ON cp.contract_id=cv.contract_id AND cp.status='active' JOIN line_identities li ON li.user_id=cp.user_id WHERE f.public_id=? AND li.line_user_id=?", [req.params.filePublicId, viewerId(req)]);
      if (!file) return res.status(403).send('forbidden');
      let bytes;
      try {
        bytes = await readStoredFile(file);
      } catch (error) {
        if (error.code === 'ENOENT') return res.status(404).send('file not found');
        throw error;
      }
      res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(bytes);
    }).catch(next);
  });

  router.post('/v2/api/sign/:signatureRequestPublicId/reading', (req, res, next) => {
    withDriver(async (db) => {
      res.json(await signingService.recordReadingProgress({ db, lineUserId: viewerId(req), signatureRequestPublicId: req.params.signatureRequestPublicId, progress: req.body.progress }));
    }).catch(next);
  });
  router.post('/v2/api/sign/:signatureRequestPublicId/otp/start', (req, res, next) => {
    withDriver(async (db) => {
      res.json(await otpService.startMockOtp({ db, lineUserId: viewerId(req), signatureRequestPublicId: req.params.signatureRequestPublicId }));
    }).catch(next);
  });
  router.post('/v2/api/sign/:signatureRequestPublicId/otp/verify', (req, res, next) => {
    withDriver(async (db) => {
      res.json(await otpService.verifyMockOtp({ db, lineUserId: viewerId(req), challengePublicId: req.body.challengePublicId, code: req.body.code }));
    }).catch(next);
  });
  router.post('/v2/api/sign/:signatureRequestPublicId/personal-data', (req, res, next) => {
    withDriver(async (db) => {
      const result = await signingService.prepareTenantDocument({ db, lineUserId: viewerId(req), signatureRequestPublicId: req.params.signatureRequestPublicId, personalData: req.body.personalData });
      res.json({ previewUrl: result.previewUrl, documentHash: result.documentHash });
    }).catch(next);
  });
  router.post('/v2/api/sign/:signatureRequestPublicId/tenant-submit', (req, res, next) => {
    withDriver(async (db) => {
      const result = await signingService.submitTenantSignature({ db, lineUserId: viewerId(req), signatureRequestPublicId: req.params.signatureRequestPublicId, evidence: req.body.evidence, requestMeta: { ipAddress: req.ip, userAgent: req.get('user-agent') } });
      const context = await db.get('SELECT c.public_id contract_public_id,cv.public_id version_public_id FROM signature_requests sr JOIN contract_versions cv ON cv.id=sr.contract_version_id JOIN contracts c ON c.id=cv.contract_id WHERE sr.public_id=?', [req.params.signatureRequestPublicId]);
      // 通知失敗不影響簽署結果:簽章已經寫入,這裡只標記待補送。
      try { await notificationService.notifyLandlordTenantSigned({ db, lineClient, contractPublicId: context.contract_public_id, versionPublicId: context.version_public_id }); } catch { result.notificationPending = true; }
      if (result.executed) {
        processExecutedContract(db, result.contractId, result.contractVersionId).catch(console.error);
      }
      res.json(result);
    }).catch(next);
  });
  router.post('/v2/api/sign/:signatureRequestPublicId/landlord-decision', (req, res, next) => {
    withDriver(async (db) => {
      // 理由是房東自己輸入的自由文字，可選。上限只是防呆，不做任何改寫。
      const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
      const result = await signingService.submitLandlordDecision({ db, lineUserId: viewerId(req), signatureRequestPublicId: req.params.signatureRequestPublicId, decision: req.body.decision, evidence: req.body.evidence, reason, requestMeta: { ipAddress: req.ip, userAgent: req.get('user-agent') } });
      const context = await db.get('SELECT c.public_id contract_public_id FROM signature_requests sr JOIN contract_versions cv ON cv.id=sr.contract_version_id JOIN contracts c ON c.id=cv.contract_id WHERE sr.public_id=?', [req.params.signatureRequestPublicId]);
      try { await notificationService.notifyTenantLandlordDecision({ db, lineClient, contractPublicId: context.contract_public_id, decision: req.body.decision, reason }); } catch { result.notificationPending = true; }
      if (result.executed) {
        processExecutedContract(db, result.contractId, result.contractVersionId).catch(console.error);
      }
      res.json(result);
    }).catch(next);
  });

  // /v2/api 的呼叫端全部是 fetch + JSON.parse。任何 HTML 回應都會變成
  // "Unexpected token '<', \"<!DOCTYPE \"...",把真正的失敗原因蓋掉。
  // 兩個會漏 HTML 的路徑:
  //   1. 路徑打錯或方法不符 -> 一路落到 Express 的 finalhandler,回預設 HTML 404 頁。
  //   2. 錯誤沒有被上層 handler 接成 JSON(或上層 handler 回文字/HTML)。
  // 這兩個 handler 必須註冊在所有 /v2/api 路由之後。
  //
  // 404 只能收本 router 自己擁有的前綴:/v2/api/tenant、/v2/api/landlord、
  // /v2/api/pre-inspection 由後面掛載的 router 處理,攔下來會直接弄壞找房與房東管理台。
  router.use(['/v2/api/sign', '/v2/api/contracts'], (req, res) => {
    res.status(404).json({ ok: false, error: `找不到這個 API：${req.method} ${req.originalUrl.split('?')[0]}` });
  });
  router.use('/v2/api', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.statusCode || error.status || 500).json({ ok: false, error: error.message || 'Internal Server Error' });
  });

  return router;
}

module.exports = { assertContractEvidenceDirConfigured, createV2ContractRoutes };
