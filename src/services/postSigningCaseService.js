const crypto = require('node:crypto');
const path = require('node:path');
const { createFileStorage, storageKey, readStoredFile } = require('./fileStorage');
const { detectImage } = require('./v2ListingImageFreezeService');
const contracts = require('./postSigningAssistantService');
const repairs = require('../repositories/v2RepairRepositoryAsync');
const notifications = require('./v2NotificationEventServiceAsync');
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei'}).format(new Date());
function same(a,b) { return a != null && b != null && String(a)===String(b); }
function fail(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; throw e; }
function key(value) { if (typeof value !== 'string' || !/^[\w-]{8,100}$/.test(value)) fail('請提供有效的操作識別碼'); return value; }
function eventDate(value, urgent) {
  if (!value && urgent) return today();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('請選擇事件發生日');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value > today()) fail('事件日期無效或在未來');
  return value;
}
async function party(db, input) { return contracts.requireParty(db, input); }
async function photos(db, ids, userId, contractId) {
  if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) fail('照片清單無效');
  const result = [];
  for (const publicId of ids) {
    const f = await db.get("SELECT f.id, f.public_id, f.original_name FROM files f JOIN post_signing_photos sp ON sp.file_id=f.id WHERE f.public_id=? AND sp.user_id=? AND sp.contract_id=? AND f.created_by_user_id=? AND f.status='active' AND f.mime_type LIKE 'image/%'", [publicId, userId, contractId, userId]);
    if (!f) fail('照片不存在或沒有分享權限', 403);
    result.push(f);
  }
  return result;
}
async function upload({db,lineUserId,contractPublicId,role,base64,filename}) {
  const p=await party(db,{lineUserId,contractPublicId,role});
  if(typeof base64!=='string' || base64.length>6990508 || base64.length%4 || /[^A-Za-z0-9+/=]/.test(base64)) fail('圖片內容無效或超過 5 MB');
  const bytes=Buffer.from(base64,'base64'); if(!bytes.length || bytes.length>5*1024*1024) fail('圖片內容無效或超過 5 MB');
  if (bytes.toString('base64') !== base64) fail('圖片編碼無效');
  let format; try { format=detectImage(bytes); } catch { fail('僅接受 JPEG、PNG 或 WEBP 圖片'); }
  if(!['image/jpeg','image/png','image/webp'].includes(format.mimeType)) fail('僅接受 JPEG、PNG 或 WEBP 圖片');
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const existing=await db.get("SELECT id,public_id,created_by_user_id FROM files WHERE sha256_hash=? AND size_bytes=? AND security_classification='private'",[hash,bytes.length]);
  let file=existing;
  if(existing && !same(existing.created_by_user_id,p.user_id)) fail('無法上傳這張圖片，請使用另一張圖片',409);
  if(!file) {
    const {provider,storage}=createFileStorage({localRoot:path.join(process.cwd(),'uploads','repair-web'),prefix:'private'});
    const name=`post-signing-${crypto.randomUUID()}.${format.extension}`;
    const stored=await storage.put(name,bytes,{contentType:format.mimeType});
    try { file=await repairs.addFile(db,{storageKey:storageKey(stored,provider),storageProvider:provider,originalName:String(filename||name).replace(/[\\/\x00-\x1f]/g,'_').slice(0,160),mimeType:format.mimeType,sizeBytes:bytes.length,sha256Hash:hash,createdByUserId:p.user_id}); }
    catch(e) { await storage.delete(name).catch(()=>{}); throw e; }
    const owner=await db.get('SELECT created_by_user_id FROM files WHERE id=?',[file.id]);
    if(!same(owner.created_by_user_id,p.user_id)) { await storage.delete(name).catch(()=>{}); fail('無法上傳這張圖片',409); }
  }
  await db.run(`${db.dialect.insertIgnore} INTO post_signing_photos (file_id,contract_id,user_id) VALUES (?,?,?)`,[file.id,p.contract_id,p.user_id]);
  return {publicId:file.public_id};
}
async function photo({db,lineUserId,contractPublicId,role,photoId}) {
  const p=await party(db,{lineUserId,contractPublicId,role});
  const f=await db.get(`SELECT f.* FROM files f JOIN post_signing_photos sp ON sp.file_id=f.id WHERE f.public_id=? AND sp.contract_id=? AND f.status='active' AND (sp.user_id=? OR EXISTS (SELECT 1 FROM file_links fl JOIN repair_updates ru ON ru.id=fl.entity_id AND fl.entity_type='repair_update' JOIN post_signing_cases pc ON pc.ticket_id=ru.repair_ticket_id WHERE fl.file_id=f.id AND pc.contract_id=sp.contract_id))`,[photoId,p.contract_id,p.user_id]);
  if(!f) fail('找不到照片',404);
  return {bytes:await readStoredFile(f),mimeType:f.mime_type};
}
async function preview({ db, lineUserId, contractPublicId, role, summary, urgent, occurredOn, photoIds = [], citations = [] }) {
  const p = await party(db, { lineUserId, contractPublicId, role });
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 2000 || typeof urgent !== 'boolean') fail('請填寫事件摘要及緊急程度');
  const occurred = eventDate(occurredOn, urgent);
  const lease = await db.get("SELECT * FROM leases WHERE contract_id=? AND status IN ('active','ended','terminated') AND start_date<=? AND end_date>=?", [p.contract_id,occurred,occurred]);
  if (!lease) fail('此合約沒有可建立新案件的有效租約', 409);
  const files = await photos(db, photoIds, p.user_id, p.contract_id);
  let version = null, bytes = null;
  try { ({ version, bytes } = await contracts.getSignedDocument(db, p.contract_id)); } catch (e) { if (!urgent || e.statusCode !== 409) throw e; }
  if(!Array.isArray(citations) || citations.length>3) fail('引用內容無效');
  if(citations.length) {
    if(!bytes) fail('無法確認已簽文件引用',409);
    const sections=contracts.documentSections(bytes);
    for(const c of citations) { const section=sections.find(x=>x.locator===c?.locator); if(!section || typeof c.quote!=='string' || c.quote.length<4 || c.quote.length>300 || !section.text.includes(c.quote)) fail('引用無法在已簽文件中確認'); }
  }
  const previewId = id('preview');
  await db.run('INSERT INTO post_signing_previews (public_id,contract_id,user_id,role,lease_id,version_id,document_hash,summary,occurred_on,urgent,photo_ids_json,citations_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [previewId,p.contract_id,p.user_id,role,lease.id,version?.version_id || null,version?.document_hash || null,summary.trim(),occurred,urgent ? 1 : 0,JSON.stringify(photoIds),JSON.stringify(citations)]);
  return { previewId, summary: summary.trim(), occurredOn: occurred, urgent, photoIds, citations, files, versionNumber: version?.version_number || null, documentHash: version?.document_hash || null };
}
async function findCase(db, p, caseId) {
  const c = await db.get(`SELECT pc.*, pr.summary, pr.occurred_on, pr.urgent, pr.citations_json, cv.version_number, rt.public_id AS ticket_public_id FROM post_signing_cases pc JOIN post_signing_previews pr ON pr.public_id=pc.preview_id LEFT JOIN contract_versions cv ON cv.id=pc.version_id JOIN repair_tickets rt ON rt.id=pc.ticket_id WHERE pc.public_id=? AND pc.contract_id=?`, [caseId,p.contract_id]);
  if (!c) fail('找不到案件',404);
  return c;
}
async function detail(db, p, caseId) {
  const c = await findCase(db,p,caseId);
  const events = await db.all('SELECT id,role,event_type,message,proposal_id,notification_status,created_at FROM post_signing_case_events WHERE case_id=? ORDER BY id', [c.id]);
  const files = await repairs.listRepairFiles(db,c.ticket_public_id);
  const state = { status:'open', repairProposal:null, costProposal:null, closeProposal:null, repairAgreements:[], costAgreements:[], closeConfirmations:[] };
  for (const e of events) {
    if (e.event_type==='repair_proposal') { state.repairProposal={id:e.id,text:e.message}; state.repairAgreements=[]; }
    if (e.event_type==='cost_proposal') { state.costProposal={id:e.id,text:e.message}; state.costAgreements=[]; }
    if (e.event_type==='repair_agree' && same(e.proposal_id,state.repairProposal?.id) && !state.repairAgreements.includes(e.role)) state.repairAgreements.push(e.role);
    if (e.event_type==='cost_agree' && same(e.proposal_id,state.costProposal?.id) && !state.costAgreements.includes(e.role)) state.costAgreements.push(e.role);
    if (e.event_type==='close_proposal') { state.closeProposal={id:e.id,text:e.message}; state.closeConfirmations=[]; }
    if (e.event_type==='close_confirm' && same(e.proposal_id,state.closeProposal?.id) && !state.closeConfirmations.includes(e.role)) { state.closeConfirmations.push(e.role); if(state.closeConfirmations.length===2) state.status='closed'; }
    if (e.event_type==='close_disagree' || e.event_type==='dispute' || e.event_type==='reject') { state.status='disputed'; state.closeProposal=null; state.closeConfirmations=[]; }
    if (e.event_type==='reopen') { state.status='open'; state.closeProposal=null; state.closeConfirmations=[]; }
  }
  return { case: c, state, events, files: files.map(({ public_id,original_name,mime_type }) => ({public_id,original_name,mime_type})), notification:{status:c.notification_status} };
}
async function list({db,lineUserId,contractPublicId,role}) {
  const p = await party(db,{lineUserId,contractPublicId,role});
  const cases = await db.all('SELECT pc.public_id, pc.notification_status, pc.document_hash, pr.summary, pr.urgent FROM post_signing_cases pc JOIN post_signing_previews pr ON pr.public_id=pc.preview_id WHERE pc.contract_id=? ORDER BY pc.id DESC',[p.contract_id]);
  return {cases};
}
async function get(input) { const p=await party(input.db,input); return detail(input.db,p,input.caseId); }
async function send(db, c, lineClient, event = null) {
  const table = event ? 'post_signing_case_events' : 'post_signing_cases';
  const rowId = event ? event.id : c.id;
  const claim = await db.run(`UPDATE ${table} SET notification_status='sending' WHERE id=? AND notification_status IN ('pending','failed')`,[rowId]);
  if (!claim.changes) return;
  let attempted=false, providerAccepted=false, definiteFailure=false;
  try {
    const p = await db.get('SELECT role FROM post_signing_previews WHERE public_id=?',[c.preview_id]);
    const citationText=JSON.parse(c.citations_json).map(citation=>`${citation.locator}：${citation.quote}`).join('\n');
    const opposite = (event ? event.role : p.role) === 'tenant' ? 'landlord' : 'tenant';
    const contract=await db.get('SELECT public_id FROM contracts WHERE id=?',[c.contract_id]);
    const url=`${(process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/,'')}/v2/contracts/${encodeURIComponent(contract.public_id)}/assistant?case=${encodeURIComponent(c.public_id)}`;
    const recipients = await db.all(`SELECT DISTINCT cp.user_id, li.id AS line_identity_id, li.line_user_id FROM contract_parties cp JOIN line_identities li ON li.user_id=cp.user_id WHERE cp.contract_id=? AND cp.status='active' AND cp.party_role=?`,[c.contract_id,opposite]);
    if (recipients.length !== 1) throw new Error('無法唯一確認通知對象');
    const recipient=recipients[0];
    const safeClient=lineClient && {pushMessage:async (...args)=>{ attempted=true; try { const response=await lineClient.pushMessage(...args); providerAccepted=true; return response; } catch(e) { const status=Number(e.statusCode || e.status); definiteFailure=status>=400 && status<500 && status!==408 && status!==429; throw e; } }};
    const eventName = {message:'新回覆',supplement:'補充資料',repair_proposal:'處理方式提案',cost_proposal:'費用提案',close_proposal:'處理結果待確認',repair_agree:'同意處理方式',cost_agree:'同意費用',reject:'拒絕',dispute:'提出爭議',close_confirm:'確認處理結果',close_disagree:'不同意結案',reopen:'重開案件'};
    const noticeKey = `post-${c.public_id}${event ? `-event-${event.id}` : ''}`;
    const result=await notifications.recordNotificationDelivery({db,lineClient:safeClient,message:{type:'text',text:`維修案件：${c.summary}\n${event ? `${eventName[event.event_type]}：${event.message || '請開啟案件查看對應提案。'}\n` : ''}發生日：${c.occurred_on}\n${citationText ? `合約依據：${citationText}\n` : ''}查看並回覆：${url}`},notification:{publicId:`notif-${noticeKey}`,eventType:event ? 'repair_updated' : 'repair_reported',entityType:'repair_ticket',entityId:c.ticket_public_id,templateCode:'line_repair_ticket',payload:{ticketPublicId:c.ticket_public_id}},recipient:{userId:recipient.user_id,lineIdentityId:recipient.line_identity_id,lineUserId:recipient.line_user_id},idempotencyKey:`${noticeKey}:${recipient.user_id}`});
    if (!result.pushed && result.skipped !== 'sent') throw new Error('通知尚未送出');
    await db.run(`UPDATE ${table} SET notification_status='sent' WHERE id=?`,[rowId]);
  } catch { await db.run(`UPDATE ${table} SET notification_status=? WHERE id=?`,[providerAccepted || (attempted && !definiteFailure) ? 'unknown' : 'failed',rowId]); }
}
async function create(input) {
  const {db,lineUserId,contractPublicId,role,previewId,confirmed,idempotencyKey,lineClient}=input;
  const p=await party(db,{lineUserId,contractPublicId,role}); key(idempotencyKey);
  if (confirmed !== true) fail('請先確認分享內容');
  const preview=await db.get('SELECT * FROM post_signing_previews WHERE public_id=? AND contract_id=? AND user_id=? AND role=?',[previewId,p.contract_id,p.user_id,role]);
  if (!preview) fail('找不到預覽內容',404);
  const lease=await db.get("SELECT * FROM leases WHERE id=? AND contract_id=? AND status IN ('active','ended','terminated') AND start_date<=? AND end_date>=?",[preview.lease_id,p.contract_id,preview.occurred_on,preview.occurred_on]);
  if (!lease) fail('租約已無法建立案件',409);
  const existing=await db.get('SELECT public_id,preview_id FROM post_signing_cases WHERE contract_id=? AND created_by_user_id=? AND idempotency_key=?',[p.contract_id,p.user_id,idempotencyKey]);
  if (existing && existing.preview_id!==previewId) fail('操作識別碼已用於其他預覽',409);
  let caseId=existing?.public_id;
  if (!caseId) {
    const files=await photos(db,JSON.parse(preview.photo_ids_json),p.user_id,p.contract_id);
    if (preview.version_id) { const {version}=await contracts.getSignedDocument(db,p.contract_id); if (!same(version.version_id,preview.version_id) || version.document_hash!==preview.document_hash) fail('簽署版本已變更，請重新預覽',409); }
    caseId=id('case');
    try { await db.transaction(async tx=>{
      const already=await tx.get('SELECT public_id FROM post_signing_cases WHERE preview_id=?',[previewId]);
      if(already){caseId=already.public_id;return;}
      const ticket=await repairs.createRepairTicket(tx,{leaseId:lease.id,rentalUnitId:lease.rental_unit_id,description:preview.summary,priority:preview.urgent?'urgent':'normal',reportedByUserId:p.user_id});
      const update=await repairs.addRepairUpdate(tx,{repairTicketId:ticket.id,updateType:'message',messageText:preview.summary,createdByUserId:p.user_id});
      for(const f of files) await tx.run("INSERT INTO file_links (file_id,entity_type,entity_id,purpose) VALUES (?,'repair_update',?,'damage_photo')",[f.id,update.id]);
      await tx.run('INSERT INTO post_signing_cases (public_id,preview_id,contract_id,lease_id,version_id,document_hash,ticket_id,created_by_user_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)',[caseId,previewId,p.contract_id,lease.id,preview.version_id,preview.document_hash,ticket.id,p.user_id,idempotencyKey]);
    }); } catch(e) { const row=await db.get('SELECT public_id FROM post_signing_cases WHERE preview_id=? AND created_by_user_id=?',[previewId,p.user_id]); if(!row) throw e; caseId=row.public_id; }
  }
  const c=await findCase(db,p,caseId); if(!existing) await send(db,c,lineClient);
  return detail(db,p,caseId);
}
async function event(input) {
  const {db,lineUserId,contractPublicId,role,caseId,type,text,idempotencyKey,proposalId,photoIds=[],confirmed}=input;
  const allowed=['message','read','repair_proposal','cost_proposal','close_proposal','repair_agree','cost_agree','reject','dispute','close_confirm','close_disagree','reopen','supplement'];
  if(!allowed.includes(type) || (text != null && (typeof text !== 'string' || text.length>2000))) fail('事件內容無效'); key(idempotencyKey);
  if (!Array.isArray(photoIds) || photoIds.length > 10) fail('照片清單無效');
  if (type !== 'read' && confirmed !== true) fail('請先確認內容將分享並通知另一方');
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify({role,type,text:text || null,proposalId:proposalId == null ? null : String(proposalId),photoIds})).digest('hex');
  const p=await party(db,{lineUserId,contractPublicId,role}); const c=await findCase(db,p,caseId);
  await db.transaction(async tx=>{
    if (tx.dialect.name === 'mysql') await tx.get('SELECT id FROM post_signing_cases WHERE id=? FOR UPDATE',[c.id]);
    const previous=await tx.get('SELECT payload_hash FROM post_signing_case_events WHERE case_id=? AND user_id=? AND idempotency_key=?',[c.id,p.user_id,idempotencyKey]);
    if(previous) { if(previous.payload_hash !== payloadHash) fail('操作識別碼已使用',409); return; }
    const current=await detail(tx,p,caseId);
    let shared=[];
    if(type==='supplement' && photoIds.length) { if(confirmed!==true) fail('請確認照片將分享給對方'); shared=await photos(tx,photoIds,p.user_id,p.contract_id); }
    if(type!=='supplement' && photoIds.length) fail('照片只能透過補件分享');
    if (type==='reopen' && current.state.status!=='closed') fail('僅已結案案件可重開',409);
    if (type!=='reopen' && type!=='read' && current.state.status==='closed') fail('請先重開案件',409);
    if (['repair_proposal','cost_proposal','close_proposal','message','supplement','reject','dispute','close_disagree'].includes(type) && !String(text||'').trim()) fail('請填寫具體內容');
    if (type==='repair_agree' && (!proposalId || !same(proposalId,current.state.repairProposal?.id))) fail('請確認目前維修提案',409);
    if (type==='cost_agree' && (!proposalId || !same(proposalId,current.state.costProposal?.id))) fail('請確認目前費用提案',409);
    if (type==='close_confirm' && (!proposalId || !same(proposalId,current.state.closeProposal?.id))) fail('請確認目前處理結果',409);
    const approvals={repair_agree:current.state.repairAgreements,cost_agree:current.state.costAgreements,close_confirm:current.state.closeConfirmations};
    if (approvals[type]?.includes(role)) fail('你已確認目前提案',409);
    await tx.run('INSERT INTO post_signing_case_events (case_id,user_id,role,event_type,message,proposal_id,idempotency_key,payload_hash,notification_status) VALUES (?,?,?,?,?,?,?,?,?)',[c.id,p.user_id,role,type,text || null,proposalId || null,idempotencyKey,payloadHash,type === 'read' ? 'none' : 'pending']);
    if(type !== 'read') {
      const update=await repairs.addRepairUpdate(tx,{repairTicketId:c.ticket_id,updateType:shared.length ? 'photo' : 'message',messageText:`${type}：${text || '確認目前提案'}`,createdByUserId:p.user_id});
      for(const file of shared) await repairs.linkFileToRepairUpdate(tx,{fileId:file.id,repairUpdateId:update.id,purpose:'damage_photo'});
    }
    if (['close_confirm','close_disagree','dispute','reject','reopen'].includes(type)) {
      const updated=await detail(tx,p,caseId);
      const closed=updated.state.status==='closed';
      await tx.run(`UPDATE repair_tickets SET case_status=?,status=?,closed_at=${closed ? tx.dialect.utcNow() : 'NULL'} WHERE id=?`,[closed ? 'closed' : 'open',closed ? 'tenant_confirmed' : 'reopened',c.ticket_id]);
    }
  });
  if (type !== 'read') {
    const entry = await db.get('SELECT * FROM post_signing_case_events WHERE case_id=? AND user_id=? AND idempotency_key=?',[c.id,p.user_id,idempotencyKey]);
    await send(db,c,input.lineClient,entry);
  }
  return detail(db,p,caseId);
}
async function retry(input) {
  const p=await party(input.db,input); const c=await findCase(input.db,p,input.caseId);
  let entry = null;
  if (input.eventId != null) {
    entry = await input.db.get('SELECT * FROM post_signing_case_events WHERE id=? AND case_id=? AND user_id=?',[input.eventId,c.id,p.user_id]);
    if (!entry) fail('沒有此通知的重試權限',403);
  } else if (!same(c.created_by_user_id,p.user_id)) fail('只有送出者能重試通知',403);
  await send(input.db,c,input.lineClient,entry); return detail(input.db,p,input.caseId);
}
module.exports={preview,create,get,list,event,retry,upload,photo};

