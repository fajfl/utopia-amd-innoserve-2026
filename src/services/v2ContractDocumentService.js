const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFileStorage, storageKey: storageKeyForStored } = require('./fileStorage');

const UNKNOWN = '尚未確認';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-TW') : '';
}

// 資料庫混用 ISO（帶 Z）與 SQLite 的 'YYYY-MM-DD HH:MM:SS'（UTC 但沒有時區標記），一律當 UTC 轉台北時間。
function formatDateTime(value) {
  if (!value) return '未記錄';
  const text = String(value);
  const iso = /Z$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// 條次與名稱依 template/33-(113-07-08)住宅租賃契約書範本(企業或個人出租通用).docx。
// V2 目前只協商得到其中幾條，其餘條次仍依範本適用，頁面上以「依範本條款」標示。
const CLAUSES = [
  { key: 'subject', heading: '第一條　租賃標的', note: '附屬設備之有無及項目，詳如附件一租賃標的現況確認書。' },
  { key: 'term', heading: '第二條　租賃期間' },
  { key: 'rent', heading: '第三條　租金約定及支付' },
  { key: 'deposit', heading: '第四條　押金約定及返還' },
  { key: 'fees', heading: '第五條　租賃期間相關費用之約定' },
  { key: 'restrictions', heading: '第七條　使用租賃住宅之限制' },
  { key: 'other', heading: '第二十一條　其他約定' }
];

const CONDITION_FIELDS = {
  equipmentRequest: { label: '附屬設備約定', clause: 'subject' },
  leaseStart: { label: '租期起日', clause: 'term', format: 'date' },
  leaseStartDate: { label: '租期起日', clause: 'term', format: 'date' },
  leaseEnd: { label: '租期迄日', clause: 'term', format: 'date' },
  leaseEndDate: { label: '租期迄日', clause: 'term', format: 'date' },
  moveInDate: { label: '預計入住日', clause: 'term', format: 'date' },
  termMonths: { label: '租賃期間', clause: 'term', format: 'months' },
  monthlyRent: { label: '每月租金', clause: 'rent', format: 'money' },
  rentAmount: { label: '每月租金', clause: 'rent', format: 'money' },
  paymentDueDay: { label: '每月支付日', clause: 'rent', format: 'day' },
  paymentMethod: { label: '支付方式', clause: 'rent' },
  depositAmount: { label: '押金金額', clause: 'deposit', format: 'money' },
  depositMonths: { label: '押金月數', clause: 'deposit', format: 'months' },
  managementFee: { label: '管理費', clause: 'fees', format: 'money' },
  waterFee: { label: '水費', clause: 'fees' },
  electricityFee: { label: '電費', clause: 'fees' },
  gasFee: { label: '瓦斯費', clause: 'fees' },
  internetFee: { label: '網路費', clause: 'fees' },
  pets: { label: '寵物飼養', clause: 'restrictions', format: 'pets' },
  petRequest: { label: '寵物飼養', clause: 'restrictions' },
  sublease: { label: '轉租', clause: 'restrictions', format: 'allowed' },
  cooking: { label: '開伙', clause: 'restrictions', format: 'allowed' },
  specialRequest: { label: '特約事項', clause: 'other' },
  repairResponsibility: { label: '修繕責任', clause: 'other' },
  utilityCostAllocation: { label: '水電及費用負擔', clause: 'fees' },
  earlyTermination: { label: '提前終止', clause: 'other' },
  petAllowed: { label: '寵物飼養', clause: 'restrictions', format: 'allowed' },
  householdRegistrationAllowed: { label: '戶籍遷入', clause: 'restrictions', format: 'allowed' },
  specialTerms: { label: '特約事項', clause: 'other' },
  demo: { hidden: true }
};

const PET_VALUES = { none: '不得飼養寵物', one_cat: '得飼養貓 1 隻', one_dog: '得飼養犬 1 隻' };

// 附件一「租賃標的現況確認書」的十二個項次，取自範本表格的項目名稱。
const CONDITION_CHECKLIST = [
  '未登記之改建、增建、加建或違建部分',
  '建物型態、現況格局與出租型態',
  '汽車及機車停車位',
  '住宅用火災警報器與消防設施',
  '滲漏水情形及其處理方式',
  '輻射屋檢測',
  '鋼筋混凝土水溶性氯離子檢測',
  '本租賃住宅是否曾發生非自然死亡情事',
  '供水及排水是否正常',
  '公寓大廈規約或住戶應遵行事項',
  '管理委員會與管理費',
  '附屬設備項目'
];

function conditionFieldLabel(key) {
  return CONDITION_FIELDS[key]?.label || String(key);
}

function formatConditionValue(key, value) {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  const format = CONDITION_FIELDS[key]?.format;
  if (format === 'money') return `新臺幣 ${money(value)} 元`;
  if (format === 'months') return `${value} 個月`;
  if (format === 'day') return `每月 ${value} 日前`;
  if (format === 'date') {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `民國 ${Number(match[1]) - 1911} 年 ${Number(match[2])} 月 ${Number(match[3])} 日` : String(value);
  }
  if (format === 'pets') return PET_VALUES[String(value)] || String(value);
  if (format === 'allowed') return value ? '得為之' : '不得為之';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.join('、') : UNKNOWN;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function conditionRows(conditions) {
  return Object.entries(conditions)
    .filter(([key]) => key !== '__contractTemplate')
    .filter(([key]) => !CONDITION_FIELDS[key]?.hidden)
    .map(([key, value]) => ({
      key,
      clause: CONDITION_FIELDS[key]?.clause || 'other',
      mapped: Boolean(CONDITION_FIELDS[key]),
      label: conditionFieldLabel(key),
      display: formatConditionValue(key, value)
    }));
}

function renderVerifiedTemplate(snapshot, conditions, subject) {
  const manifest = snapshot.manifest;
  const { canonicalJson } = require('./ecsNeoContractAcceptanceServiceAsync');
  const digest = crypto.createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
  if (digest !== snapshot.manifestChecksum || manifest.sourceVerification !== 'official_source_verified'
      || manifest.coverage !== 'complete_source_text' || !manifest.fullText || !manifest.contractText) {
    throw new Error('Verified contract template snapshot is incomplete or changed');
  }
  if (crypto.createHash('sha256').update(canonicalJson(snapshot.rulePack.manifest), 'utf8').digest('hex') !== snapshot.rulePack.checksum) {
    throw new Error('Verified legal rule source snapshot changed');
  }
  const rows = conditionRows(conditions);
  const clauses = manifest.clauses.map((clause) => {
    const slots = manifest.slots.filter((slot) => slot.clauseRef === clause.clauseRef);
    const terms = slots.flatMap((slot) => rows.filter((row) => row.key === slot.clauseField)
      .map((row) => termHtml(row.label, row.display)));
    return terms.length ? `<section><h2>${escapeHtml(clause.clauseRef)} ${escapeHtml(clause.clauseTitle)}：本版填入內容</h2><dl>${terms.join('')}</dl></section>` : '';
  }).join('');
  const unmapped = rows.filter((row) => !manifest.slots.some((slot) => slot.clauseField === row.key));
  if (unmapped.length) throw new Error('Negotiated conditions are not covered by the verified template');
  return `<section><h2>租賃標的</h2><dl>${subjectTerms(subject).join('')}</dl></section>${clauses}`
    + `<section><h2>契約全文與完整附件範本</h2><p class="meta">範本版本：${escapeHtml(snapshot.versionPublicId)}<br>官方來源校驗：${escapeHtml(manifest.sourceChecksum)}</p><div class="official-text" style="white-space:pre-wrap">${escapeHtml(manifest.contractText)}</div></section>`
    + `<section><h2>現行應記載及不得記載事項</h2><p class="warn">${escapeHtml(snapshot.rulePack.manifest.coverageNote)}</p><div class="official-text" style="white-space:pre-wrap">${escapeHtml(snapshot.rulePack.manifest.fullText)}</div></section>`;
}

const termHtml = (label, value, unmapped = false) =>
  `<div class="term"${unmapped ? ' data-unmapped="true"' : ''}><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

function subjectTerms(subject = {}) {
  const address = subject.addressText || subject.normalizedAddress || '';
  const rentalTypes = { whole_home: '整棟（戶）出租', whole_floor: '分層出租', suite: '獨立套房', room: '分租雅房', other: '其他' };
  const terms = [termHtml('租賃住宅地址', address || UNKNOWN)];
  if (subject.unitLabel) terms.push(termHtml('租賃範圍', subject.unitLabel));
  if (subject.rentalType) terms.push(termHtml('出租型態', rentalTypes[subject.rentalType] || subject.rentalType));
  if (subject.areaPing) terms.push(termHtml('坪數', `${subject.areaPing} 坪`));
  if (subject.listingTitle) terms.push(termHtml('房源名稱', subject.listingTitle));
  return terms;
}

function renderClauses(conditions, subject) {
  const rows = conditionRows(conditions);
  const untouched = [];
  const sections = CLAUSES.map((clause) => {
    const extra = clause.key === 'subject' ? subjectTerms(subject) : [];
    const terms = extra.concat(rows.filter((row) => row.clause === clause.key).map((row) => termHtml(row.label, row.display, !row.mapped)));
    // 沒有協商到的條次不各給一個空區塊，集中列成一行，讀起來才不會全是「未另行約定」。
    if (!terms.length) { untouched.push(clause.heading); return ''; }
    const note = clause.note ? `<p class="clause-note">${escapeHtml(clause.note)}</p>` : '';
    return `<section><h2>${escapeHtml(clause.heading)}</h2><dl>${terms.join('')}</dl>${note}</section>`;
  }).join('');
  const rest = untouched.length
    ? `<section class="untouched"><h2>其餘條次</h2><p class="empty">${escapeHtml(untouched.join('、'))}：本次協商未另行約定，依契約範本條款辦理。</p></section>`
    : '';
  return `${sections}${rest}`;
}

// manifest 存的 index 是整份紀錄的流水號；標題要的是「第幾張照片」，所以另外依類型編號。
function numberByKind(entries) {
  const seen = {};
  return entries.map((entry) => {
    seen[entry.kind] = (seen[entry.kind] || 0) + 1;
    return { ...entry, kindIndex: seen[entry.kind] };
  });
}

function attachmentEntryHtml(entry) {
  const time = entry.recordedAt ? `<time>${escapeHtml(formatDateTime(entry.recordedAt))}</time>` : '';
  if (entry.kind === 'image' && entry.url) {
    return `<figure class="condition-item"><img src="${escapeHtml(entry.url)}" alt="屋況照片 ${entry.kindIndex}" loading="lazy"><figcaption><span>照片 ${entry.kindIndex}</span>${time}</figcaption></figure>`;
  }
  if (entry.kind === 'video' && entry.url) {
    return `<figure class="condition-item"><video controls preload="metadata" src="${escapeHtml(entry.url)}"></video><figcaption><span>影片 ${entry.kindIndex}</span>${time}</figcaption></figure>`;
  }
  if (entry.kind === 'text') {
    return `<figure class="condition-item note"><blockquote>${escapeHtml(entry.text)}</blockquote><figcaption><span>備註 ${entry.kindIndex}</span>${time}</figcaption></figure>`;
  }
  return `<figure class="condition-item note"><blockquote>已保存的附件</blockquote><figcaption><span>附件 ${entry.index}</span>${time}</figcaption></figure>`;
}

function renderChecklist() {
  const items = CONDITION_CHECKLIST.map((item, index) => `<li><span>${index + 1}</span>${escapeHtml(item)}</li>`).join('');
  return `<details class="checklist"><summary>範本確認項目（十二項）</summary><ol>${items}</ol><p class="empty">以上項次依契約範本附件一列示，本次以入住前屋況紀錄作為現況佐證，未逐項勾選者以現況交屋。</p></details>`;
}

function renderAttachmentSection(attachments) {
  const head = '<h2>附件一　租賃標的現況確認書</h2>';
  if (!attachments.length) {
    return `<section class="condition-appendix">${head}<p class="empty">本版本尚未附加入住前屋況紀錄，交屋時以現況點交。</p>${renderChecklist()}</section>`;
  }
  const blocks = attachments.map((attachment, index) => {
    const counts = `照片 ${attachment.imageCount} 張／影片 ${attachment.videoCount} 段／備註 ${attachment.textCount} 則`;
    const items = numberByKind(attachment.entries || []).map(attachmentEntryHtml).join('') || '<p class="empty">這份紀錄沒有內容。</p>';
    const offSubject = attachment.matchSource === 'party'
      ? '<p class="warn">此紀錄未對應到本契約的租賃標的，由當事人自行指定附加。</p>'
      : '';
    return `<article class="condition-record"><h3>附件一之${index + 1}　${escapeHtml(attachment.title || '入住前屋況紀錄')}</h3>${offSubject}<p class="meta">封存時間：${escapeHtml(formatDateTime(attachment.sealedAt))}｜${escapeHtml(counts)}</p><p class="meta">紀錄編號：${escapeHtml(attachment.sessionPublicId)}<br>內容雜湊：<span class="hash">${escapeHtml(attachment.manifestHash)}</span></p><div class="condition-grid">${items}</div></article>`;
  }).join('');
  return `<section class="condition-appendix">${head}<p class="meta">下列入住前屋況紀錄由承租人拍攝並封存，作為本契約交屋時的租賃標的現況依據。內容雜湊隨本契約一併簽署，事後變動即可辨識。</p>${blocks}${renderChecklist()}</section>`;
}

// style 放在 body 內：合約嵌入頁面時只取 <body> 之間的內容，head 的樣式會被剝掉。
const DOCUMENT_STYLE = `<style>
.lease-document{line-height:1.85;color:#1c2540;font-size:15px}
.lease-document h1{font-size:21px;text-align:center;letter-spacing:2px;margin:6px 0 4px}
.lease-document .doc-subtitle{text-align:center;color:#6b7794;font-size:12.5px;margin:0 0 18px;line-height:1.6}
.lease-document .watermark{display:inline-block;background:#fff4d6;color:#875b00;border-radius:999px;padding:5px 12px;font-weight:700;font-size:12px;margin:0}
.lease-document section{border-top:1px solid #e9edf4;padding-top:14px;margin-top:16px}
.lease-document h2{font-size:16px;margin:0 0 10px;color:#14213d}
.lease-document h3{font-size:14px;margin:16px 0 6px;color:#14213d}
.lease-document dl{margin:0;display:grid;gap:8px}
.lease-document .term{display:grid;grid-template-columns:104px 1fr;gap:10px;align-items:baseline}
.lease-document dt{color:#6b7794;font-size:13px}
.lease-document dd{margin:0;font-weight:600;word-break:break-word}
.lease-document .party-line{display:grid;grid-template-columns:104px 1fr;gap:10px;margin:0 0 8px}
.lease-document .party-line span:first-child{color:#6b7794;font-size:13px;font-weight:400}
.lease-document .meta{color:#6b7794;font-size:12.5px;margin:0 0 8px;line-height:1.6}
.lease-document .clause-note{color:#6b7794;font-size:12.5px;margin:10px 0 0;padding-left:12px;border-left:3px solid #e3e9f2}
.lease-document .warn{color:#9a4a00;background:#fff4e5;border-radius:10px;padding:8px 10px;font-size:12.5px;margin:0 0 8px}
.lease-document .hash{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
.lease-document .empty{color:#8b95ab;font-size:13.5px;margin:0}
.lease-document .condition-record{border:1px solid #e9edf4;border-radius:14px;padding:14px;margin-top:12px;background:#fbfcfe}
.lease-document .condition-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.lease-document .condition-item{margin:0;border:1px solid #e9edf4;border-radius:12px;overflow:hidden;background:#fff}
.lease-document .condition-item img,.lease-document .condition-item video{display:block;width:100%;height:132px;object-fit:cover;background:#0f1729}
.lease-document .condition-item.note{grid-column:1/-1}
.lease-document .condition-item blockquote{margin:0;padding:12px 14px;font-size:13.5px;white-space:pre-wrap;color:#334063}
.lease-document .condition-item figcaption{display:flex;justify-content:space-between;gap:8px;padding:7px 10px;background:#f4f7fb;color:#6b7794;font-size:11.5px}
.lease-document .checklist{margin-top:14px;border:1px solid #e9edf4;border-radius:12px;background:#fff;padding:10px 14px}
.lease-document .checklist summary{cursor:pointer;font-weight:700;font-size:13.5px;color:#14213d}
.lease-document .checklist ol{list-style:none;padding:0;margin:10px 0;display:grid;gap:6px}
.lease-document .checklist li{display:grid;grid-template-columns:22px 1fr;gap:8px;font-size:13px;color:#334063}
.lease-document .checklist li span{color:#8b95ab;font-size:12px}
</style>`;

function renderContractHtml({ conditions = {}, parties = {}, watermark = '', attachments = [], subject = {} }) {
  const landlord = parties.landlord || {};
  const tenant = parties.tenant || {};
  const template = conditions.__contractTemplate;
  const subtitle = template
    ? `依官方來源全文及本版已確認條件製作；未填選項仍須雙方審閱。${template.rulePack.manifest.coverageNote}`
    : '協商條件預覽；本版本未綁定已核對的完整官方契約範本，不能據此認定全文已完備。';
  const body = `<article class="lease-document">${DOCUMENT_STYLE}<p class="watermark">${escapeHtml(watermark)}</p><h1>住宅租賃契約書</h1><p class="doc-subtitle">${escapeHtml(subtitle)}</p>`
    + `<section><h2>立契約書人</h2><p class="party-line"><span>出租人（甲方）</span><span data-slot="landlord-name">${escapeHtml(landlord.legalName)}</span></p><p class="party-line"><span>承租人（乙方）</span><span data-slot="tenant-name">${escapeHtml(tenant.legalName)}</span></p><p class="party-line"><span>聯絡電話</span><span data-slot="tenant-phone">${escapeHtml(tenant.phone)}</span></p><p class="party-line"><span>身分證字號</span><span data-slot="tenant-national-id">${escapeHtml(tenant.nationalId)}</span></p><p class="party-line"><span>戶籍地址</span><span data-slot="tenant-address">${escapeHtml(tenant.householdAddress)}</span></p></section>`
    + (template ? renderVerifiedTemplate(template, conditions, subject) : renderClauses(conditions, subject))
    + renderAttachmentSection(attachments)
    + `<section><h2>簽署</h2><p class="party-line"><span>出租人簽章</span><span data-slot="landlord-signature">${escapeHtml(landlord.signature)}</span></p><p class="party-line"><span>承租人簽章</span><span data-slot="tenant-signature">${escapeHtml(tenant.signature)}</span></p></section></article>`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>住宅租賃契約</title></head><body>${body}</body></html>`;
}

// 重按「建立正式預覽」時內容雜湊與 storage_key 都會重複,見下方 async 版本的說明。
function writeProtectedContractFile({ db, html, publicId, createdByUserId = null, storageDir = path.join(process.cwd(), 'data', 'contracts') }) {
  const buffer = Buffer.from(html, 'utf8');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `${publicId}.html`;
  fs.mkdirSync(storageDir, { recursive: true });
  const absolutePath = path.join(storageDir, filename);
  fs.writeFileSync(absolutePath, buffer, { mode: 0o600 });
  const storageKey = path.relative(process.cwd(), absolutePath).replace(/\\/g, '/');
  const existing = db.prepare('SELECT id, public_id FROM files WHERE storage_key=?').get(storageKey);
  if (existing) {
    db.prepare('UPDATE files SET sha256_hash=?, size_bytes=?, mime_type=?, original_name=? WHERE id=?')
      .run(hash, buffer.length, 'text/html', filename, existing.id);
    return { fileId: existing.id, publicId: existing.public_id, storageKey, hash, absolutePath, reused: true };
  }
  const filePublicId = `file-${crypto.randomUUID()}`;
  const result = db.prepare(`INSERT INTO files (public_id,storage_key,storage_provider,original_name,mime_type,size_bytes,sha256_hash,security_classification,created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(filePublicId, storageKey, 'local', filename, 'text/html', buffer.length, hash, 'sensitive_contract', createdByUserId);
  return { fileId: Number(result.lastInsertRowid), publicId: filePublicId, storageKey, hash, absolutePath, reused: false };
}

// driver 版本。檔案寫入與雜湊計算與同步版完全相同,只有 files 那一列的
// 寫入改走 driver;抽出 buildProtectedContractFile 讓兩邊共用,避免分岔。
async function buildProtectedContractFile({ html, publicId, storageDir }) {
  const buffer = Buffer.from(html, 'utf8');
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const filename = `${publicId}.html`;
  const { provider, storage } = createFileStorage({ localRoot: storageDir, prefix: 'sensitive-contract' });
  const stored = await storage.put(filename, buffer, { contentType: 'text/html' });
  return {
    buffer,
    digest,
    filename,
    provider,
    absolutePath: stored.absolutePath,
    storageKey: storageKeyForStored(stored, provider),
    filePublicId: `file-${crypto.randomUUID()}`
  };
}

const INSERT_PROTECTED_FILE = `INSERT INTO files (public_id,storage_key,storage_provider,original_name,mime_type,size_bytes,sha256_hash,security_classification,created_by_user_id)
    VALUES (?,?,?,?,?,?,?,?,?)`;

// files 有 UNIQUE(storage_key) 與 UNIQUE(sha256_hash, size_bytes, security_classification)。
//
// 正式預覽的檔名固定是 `${版本}-tenant.html`,磁碟上**永遠只有一個檔案**——
// 重按時 fs.writeFileSync 直接覆蓋。所以資料庫那一列的身分是 storage_key,
// 重按時應該「更新」而不是「新增」:
//   - 同樣的個資 -> 內容與雜湊都相同,更新後值不變
//   - 改了個資   -> 內容與雜湊改變,必須更新成新的值
// 無條件 INSERT 兩種情況都會炸 ER_DUP_ENTRY(前者撞 uq_files_1,後者撞 uq_files_2)。
//
// 回傳的 fileId 維持不變,既有的 file_links 因此仍然有效。
async function writeProtectedContractFileAsync({ db, html, publicId, createdByUserId = null, storageDir = path.join(process.cwd(), 'data', 'contracts') }) {
  const built = await buildProtectedContractFile({ html, publicId, storageDir });
  const existing = await db.get('SELECT id, public_id FROM files WHERE storage_key=?', [built.storageKey]);
  if (existing) {
    await db.run('UPDATE files SET sha256_hash=?, size_bytes=?, mime_type=?, original_name=? WHERE id=?',
      [built.digest, built.buffer.length, 'text/html', built.filename, existing.id]);
    return { fileId: existing.id, publicId: existing.public_id, storageKey: built.storageKey, hash: built.digest, absolutePath: built.absolutePath, reused: true };
  }
  const result = await db.run(INSERT_PROTECTED_FILE, [
    built.filePublicId, built.storageKey, built.provider, built.filename, 'text/html',
    built.buffer.length, built.digest, 'sensitive_contract', createdByUserId
  ]);
  return { fileId: result.insertId, publicId: built.filePublicId, storageKey: built.storageKey, hash: built.digest, absolutePath: built.absolutePath, reused: false };
}

module.exports = {
  UNKNOWN,
  INSERT_PROTECTED_FILE,
  escapeHtml,
  money,
  formatDateTime,
  numberByKind,
  conditionFieldLabel,
  formatConditionValue,
  renderContractHtml,
  writeProtectedContractFile,
  writeProtectedContractFileAsync
};
