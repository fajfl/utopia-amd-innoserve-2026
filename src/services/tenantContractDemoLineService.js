const path = require('node:path');

const { liffUrl } = require('./liffSessionService');
const { confirmedShowingCard } = require('./showingAppointmentLinePresenter');

const DEMO_ACTION = 'tenant_contract_demo_confirm';
const DEMO_ASK_LANDLORD_ACTION = 'tenant_contract_demo_ask_landlord';

function enabled(env = process.env) {
  return String(env.ENABLE_TENANT_CONTRACT_DEMO).toLowerCase() === 'true';
}

function normalize(value) {
  return String(value || '').trim().replace(/[\s？?！!。]/g, '');
}

function isPetQuestion(text) {
  return ['可以養貓嗎', '能養貓嗎', '可以養寵物嗎'].includes(normalize(text));
}

function isRentIntent(text) {
  return ['我要租這間', '我想租這間'].includes(normalize(text));
}

function isRentOffer(text) {
  return ['租金可以算18000嗎', '18000可以嗎'].includes(normalize(text).replace(/,|，/g, ''));
}

function isCounterofferAccepted(text) {
  return ['18500可以', '18500可以接受', '好18500可以'].includes(normalize(text).replace(/,|，/g, ''));
}

function isMoveInQuestion(text) {
  return ['10/1可以入住嗎', '10月1日可以入住嗎'].includes(normalize(text));
}

function isLandlordReplyCheck(text) {
  return ['房東回覆了嗎', '房東回了嗎'].includes(normalize(text));
}

function isLandlordReviewCheck(text) {
  return ['房東確認條件了嗎', '房東核准條件了嗎'].includes(normalize(text));
}

function isShowingRequest(text) {
  return ['我想預約看房', '我要預約看房', '預約看房'].includes(normalize(text));
}

function isShowingApprovalCheck(text) {
  return ['房東核准看房了嗎', '房東確認看房了嗎'].includes(normalize(text));
}

function isInspectionApprovalCheck(text) {
  return ['房東確認屋況了嗎', '房東核准屋況了嗎'].includes(normalize(text));
}

function showingRequestMessages() {
  return [{
    type: 'template',
    altText: '選擇實際可預約的看房時段',
    template: {
      type: 'buttons',
      title: '預約看房',
      text: '請進入目前的看房頁，選房源與房東開放的時段。送出後會建立真的待核准預約。',
      actions: [{ type: 'uri', label: '選擇看房時段', uri: liffUrl('/findHouses') }]
    }
  }];
}

function petAnswerMessages() {
  return [
    {
      type: 'text',
      text: '可以，這間房東同意飼養 1 隻室內貓，不另外加收寵物押金。退租時若有寵物造成的損壞，仍需依實際修繕費用處理。\n\n這是依房源資料與房東已確認規則整理的結果。'
    }
  ];
}

function rentOfferMessages() {
  return [
    {
      type: 'text',
      text: '目前刊登租金是 19,000 元。18,000 元低於房東授權我直接確認的範圍，我不能替房東答應。要幫你把這個出價轉給房東嗎？'
    },
    {
      type: 'template',
      altText: '18,000 元需要房東確認',
      template: {
        type: 'confirm',
        text: '要將月租 18,000 元的出價轉給房東嗎？',
        actions: [
          {
            type: 'postback', label: '幫我問房東',
            data: `action=${DEMO_ASK_LANDLORD_ACTION}`,
            displayText: '請幫我問房東'
          },
          { type: 'message', label: '先不用', text: '先不用，我再想想' }
        ]
      }
    }
  ];
}

function landlordCounterofferMessage() {
  return {
    type: 'text',
    text: '房東已回覆\n\n房東可以接受每月 18,500 元，押金 2 個月共 37,000 元；養 1 隻室內貓、不加收寵物押金的條件維持不變。\n\n這是只適用於你這次詢問的個別反提案。'
  };
}

function counterofferAcceptedMessages() {
  return [{
    type: 'text',
    text: '收到，我先把月租 18,500 元、押金 37,000 元記為你接受的候選條件。入住日還要確認；你可以接著問希望的日期。'
  }];
}

function moveInMessages() {
  return [
    {
      type: 'text',
      text: '可以，最早可在 2026/10/01 入住。若租期為 1 年，預計到 2027/09/30；正式日期會寫進合約草稿，再由你確認與簽署。'
    }
  ];
}

function conditionCard() {
  const rows = [
    ['月租', '18,500 元'],
    ['押金', '37,000 元（2 個月）'],
    ['入住日', '2026/10/01'],
    ['租期', '1 年'],
    ['寵物', '1 隻室內貓']
  ];
  return {
    type: 'flex',
    altText: 'AI 已整理承租條件，請確認',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#0F766E', paddingAll: 'xl',
        contents: [
          { type: 'text', text: 'AI 已整理承租條件', color: '#FFFFFF', weight: 'bold', size: 'xl' },
          { type: 'text', text: 'DEMO 第 1 版｜待你確認', color: '#A7F3D0', size: 'xs', margin: 'sm' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: 'xl', spacing: 'md',
        contents: [
          { type: 'text', text: '591 精選｜近捷運採光套房', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: '以下是展示用假資料，確認後會建立可簽署草稿。', color: '#64748B', size: 'xs', wrap: true },
          { type: 'separator', margin: 'sm' },
          ...rows.map(([label, value]) => ({
            type: 'box', layout: 'baseline',
            contents: [
              { type: 'text', text: label, color: '#64748B', size: 'sm', flex: 3 },
              { type: 'text', text: value, color: '#111827', weight: 'bold', size: 'sm', flex: 7, align: 'end', wrap: true }
            ]
          }))
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'lg',
        contents: [{
          type: 'button', style: 'primary', color: '#0F766E',
          action: {
            type: 'postback', label: '確認並查看草稿',
            data: `action=${DEMO_ACTION}`,
            displayText: '我確認這份承租條件'
          }
        }]
      }
    }
  };
}

function signingReadyMessages() {
  return [
    {
      type: 'text',
      text: '房東已確認\n\n✓ 屋況附件一\n✓ 第 1 版承租條件\n\n這是展示用的預先核准資料，不代表房東已完成最終簽名。現在可以送簽並由你本人簽署。'
    },
    {
      type: 'template',
      altText: '房東前置確認完成，可以開始房客簽署',
      template: {
        type: 'buttons',
        title: '可以送簽了',
        text: '先查看草稿，再完成 OTP、閱讀、身分資料、錄影與簽名。',
        actions: [
          { type: 'uri', label: '查看合約草稿', uri: liffUrl('/v2/contracts/drafts') },
          { type: 'uri', label: '開始房客簽署', uri: liffUrl('/v2/sign/demo-current-user-request-tenant') }
        ]
      }
    }
  ];
}

function draftCoordinatedMessages() {
  return [
    {
      type: 'text',
      text: '房東已確認第 1 版承租條件，合約草稿協調完成。簽約前請先預約一次現場確認，並在看房時完成屋況拍照點交。'
    },
    ...showingRequestMessages()
  ];
}

function assertTestDatabase(env = process.env) {
  const dbPath = path.resolve(String(env.V2_DATABASE_PATH || ''));
  if (String(env.V2_DB_DRIVER).toLowerCase() !== 'sqlite' || !dbPath.endsWith('ecs-neo-v2.test.sqlite')) {
    throw new Error('房客簽約 demo 只能使用 ecs-neo-v2.test.sqlite');
  }
  return dbPath;
}

function openDemoDatabase(options = {}) {
  const dbPath = assertTestDatabase(options.env || process.env);
  const { openV2Database } = require('../database/v2Database');
  return openV2Database({ dbPath });
}

function confirmLatestShowingDemo(lineUserId, options = {}) {
  const db = openDemoDatabase(options);
  try {
    const appointment = db.prepare(`SELECT sa.id,sa.public_id,sa.starts_at,ss.ends_at,l.title
      FROM showing_appointments sa
      JOIN line_identities li ON li.user_id=sa.tenant_user_id
      JOIN listings l ON l.id=sa.listing_id
      LEFT JOIN showing_slots ss ON ss.id=sa.slot_id
      WHERE li.line_user_id=? AND sa.status='pending'
      ORDER BY sa.created_at DESC,sa.id DESC LIMIT 1`).get(lineUserId);
    if (!appointment) return null;
    db.prepare("UPDATE showing_appointments SET status='confirmed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'")
      .run(appointment.id);
    return confirmedShowingCard({
      appointmentPublicId: appointment.public_id,
      listingTitle: appointment.title,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at
    });
  } finally {
    db.close();
  }
}

function confirmLatestInspectionDemo(lineUserId, options = {}) {
  const db = openDemoDatabase(options);
  try {
    const session = db.prepare(`SELECT pis.id,pis.public_id,li.user_id
      FROM pre_inspection_sessions pis
      JOIN line_identities li ON li.line_user_id=pis.line_user_id
      WHERE pis.line_user_id=? AND pis.record_type='main' AND pis.status='sealed'
        AND confirmation_status='pending_landlord_confirmation'
      ORDER BY sealed_at DESC,pis.id DESC LIMIT 1`).get(lineUserId);
    if (!session) return false;
    db.prepare(`UPDATE pre_inspection_sessions SET confirmation_status='landlord_confirmed',
      landlord_confirmed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(session.id);
    const version = db.prepare("SELECT id FROM contract_versions WHERE public_id='demo-current-user-contract-v1'").get();
    if (!version) throw new Error('找不到已協調完成的合約草稿，請先輸入「我要租這間」。');
    require('../repositories/v2ContractConditionRepository').attachSession(db, {
      contractVersionId: version.id,
      sessionPublicId: session.public_id,
      matchSource: 'inquiry',
      attachedByUserId: session.user_id
    });
    // 這份 issued demo 版本可能已在屋況點交前建立過簽署預覽。附件變更後必須
    // 讓舊 HTML 失效，下一次開啟簽署頁才會依最新 manifest 重建並讀到照片。
    db.prepare('UPDATE contract_versions SET document_file_id=NULL,document_hash=NULL WHERE id=?')
      .run(version.id);
    return true;
  } finally {
    db.close();
  }
}

function seedSigningDemo(lineUserId, options = {}) {
  const { seedCurrentUserContractDemo } = require('../../scripts/seed-current-user-contract-demo');
  const db = openDemoDatabase(options);
  try {
    const contract = seedCurrentUserContractDemo(db, lineUserId);
    // 測試 fixture 預先準備好「房東已確認條件」的結果；房東最終簽名仍維持 pending。
    db.prepare(`UPDATE contract_versions SET landlord_terms_confirmed_at=CURRENT_TIMESTAMP
      WHERE public_id='demo-current-user-contract-v1'`).run();
    db.prepare(`UPDATE intention_versions SET rent_amount=18500, deposit_amount=37000,
      move_in_date='2026-10-01' WHERE public_id='demo-current-user-intention-v1'`).run();
    db.prepare(`UPDATE contract_versions SET condition_snapshot_json=?
      WHERE public_id='demo-current-user-contract-v1'`).run(JSON.stringify({
      monthlyRent: 18500,
      depositAmount: 37000,
      moveInDate: '2026-10-01',
      leaseEndDate: '2027-09-30',
      pets: 'one_cat',
      specialRequest: 'LINE 房客簽約展示',
      demo: true
    }));
    return { contract };
  } finally {
    db.close();
  }
}

async function handleTenantContractDemoText(input = {}, options = {}) {
  if (!enabled(options.env || process.env)) return { handled: false, messages: [] };
  if (isShowingRequest(input.text)) return { handled: true, messages: showingRequestMessages() };
  if (isShowingApprovalCheck(input.text)) {
    const confirm = options.confirmLatestShowingDemo || confirmLatestShowingDemo;
    const card = confirm(input.lineUserId, options);
    return { handled: true, messages: card
      ? [{ type: 'text', text: '房東剛剛核准了這筆預約。看房時請用下面的既有流程開始屋況點交。' }, card]
      : [{ type: 'text', text: '目前沒有待房東核准的看房預約。請先從「預約看房」送出一個時段。' }] };
  }
  if (isInspectionApprovalCheck(input.text)) {
    const confirm = options.confirmLatestInspectionDemo || confirmLatestInspectionDemo;
    const confirmed = confirm(input.lineUserId, options);
    return { handled: true, messages: confirmed
      ? signingReadyMessages()
      : [{ type: 'text', text: '目前沒有已送交、等待房東確認的屋況紀錄。請先拍照或輸入備註，點「完成紀錄」，再送交房東。' }] };
  }
  if (isPetQuestion(input.text)) return { handled: true, messages: petAnswerMessages() };
  if (isRentOffer(input.text)) return { handled: true, messages: rentOfferMessages() };
  if (isLandlordReplyCheck(input.text)) return { handled: true, messages: [landlordCounterofferMessage()] };
  if (isLandlordReviewCheck(input.text)) return { handled: true, messages: draftCoordinatedMessages() };
  if (isCounterofferAccepted(input.text)) return { handled: true, messages: counterofferAcceptedMessages() };
  if (isMoveInQuestion(input.text)) return { handled: true, messages: moveInMessages() };
  if (!isRentIntent(input.text)) return { handled: false, messages: [] };

  const seed = options.seedSigningDemo || seedSigningDemo;
  try {
    seed(input.lineUserId, options);
  } catch (error) {
    return { handled: true, messages: [{ type: 'text', text: error.message }] };
  }
  return {
    handled: true,
    messages: [
      { type: 'text', text: '好，我已依這筆房源與剛才確認的養貓條件，整理成一份承租條件。請確認卡片內容。' },
      conditionCard()
    ]
  };
}

function isTenantContractDemoPostback(data, env = process.env) {
  if (!enabled(env)) return false;
  return [DEMO_ACTION, DEMO_ASK_LANDLORD_ACTION]
    .includes(new URLSearchParams(String(data || '')).get('action'));
}

async function handleTenantContractDemoPostback(input = {}, options = {}) {
  if (!isTenantContractDemoPostback(input.data, options.env || process.env)) {
    return { handled: false, messages: [] };
  }
  const action = new URLSearchParams(String(input.data || '')).get('action');
  if (action === DEMO_ASK_LANDLORD_ACTION) {
    return {
      handled: true,
      messages: [{
        type: 'text',
        text: '已把「月租 18,000 元」的出價連同這筆房源脈絡轉給房東。房東回覆後會留在這筆詢問裡；稍後可以輸入「房東回覆了嗎？」查看。'
      }]
    };
  }
  if (action === DEMO_ACTION) {
    return {
      handled: true,
      messages: [{
        type: 'text',
        text: '已記錄你的確認，條件第 1 版與合約草稿已建立，現在送請房東確認。稍後輸入「房東確認條件了嗎？」查看結果。'
      }]
    };
  }
  return { handled: false, messages: [] };
}

module.exports = {
  DEMO_ACTION,
  DEMO_ASK_LANDLORD_ACTION,
  assertTestDatabase,
  confirmLatestInspectionDemo,
  confirmLatestShowingDemo,
  conditionCard,
  handleTenantContractDemoPostback,
  handleTenantContractDemoText,
  isTenantContractDemoPostback,
  moveInMessages,
  petAnswerMessages,
  rentOfferMessages
};
