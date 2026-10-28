function postback(label, action, params = {}) {
  const data = new URLSearchParams({ action, ...params }).toString();
  return { type: 'postback', label, data, displayText: label };
}

/**
 * 產生 icon-row 版面：左側圓角圖示 + 右側標題與說明文字
 * 色系呼應數據總攬 (dashboardLinePresenter)
 */
function iconRow(icon, title, description) {
  return {
    type: 'box', layout: 'horizontal', margin: 'lg', spacing: 'md',
    contents: [
      {
        type: 'box', layout: 'vertical',
        width: '40px', height: '40px',
        cornerRadius: '8px',
        backgroundColor: '#F1F5F9',
        justifyContent: 'center', alignItems: 'center',
        contents: [{ type: 'text', text: icon, size: 'xl', align: 'center', gravity: 'center' }]
      },
      {
        type: 'box', layout: 'vertical', flex: 1,
        justifyContent: 'center',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'sm', color: '#111827' },
          { type: 'text', text: description, size: 'xs', color: '#64748B', margin: 'xs', wrap: true }
        ]
      }
    ]
  };
}

function dateText(value) {
  if (!value) return '-';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return String(value);
  return match[4] ? `${match[2]}/${match[3]} ${match[4]}:${match[5]}` : `${match[2]}/${match[3]}`;
}

function repairStatusText(status, repair = {}) {
  if (status === 'landlord_completed') {
    return Number(repair.completion_photo_count || 0) > 0
      ? '修好照片已回傳，待房東確認'
      : '房東標記修復，請回傳修好後照片';
  }
  return ({
    reported: '已通報，待房東處理',
    accepted: '房東已受理',
    in_progress: '處理中',
    tenant_confirmed: '房東已確認結案',
    reopened: '已重新開啟',
  })[status] || '進度待確認';
}

function repairProgressStep(repair = {}) {
  const status = String(repair.status || '');
  if (status === 'tenant_confirmed') return 4;
  if (status === 'landlord_completed') return 3;
  if (['accepted', 'in_progress', 'reopened'].includes(status)) return 2;
  if (status === 'reported') return 1;
  return 0;
}

function repairStepTone(step) {
  return ({
    1: { color: '#2563EB' },
    2: { color: '#D97706' },
    3: { color: '#7C3AED' },
    4: { color: '#059669' },
  })[step] || { color: '#94A3B8' };
}

function repairProgressRow(repair = {}) {
  const current = repairProgressStep(repair);
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    spacing: 'xs',
    contents: ['通報', '處理', '回傳', '確認'].map((label, index) => {
      const step = index + 1;
      const done = current >= step;
      const tone = repairStepTone(step);
      return {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        alignItems: 'center',
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '18px',
            height: '18px',
            cornerRadius: '999px',
            backgroundColor: done ? tone.color : '#FFFFFF',
            borderColor: done ? tone.color : '#CBD5E1',
            borderWidth: '1px',
            justifyContent: 'center',
            alignItems: 'center',
            contents: [{ type: 'text', text: done ? '✓' : '○', size: 'xxs', color: done ? '#FFFFFF' : '#CBD5E1', weight: 'bold', align: 'center' }],
          },
          { type: 'text', text: label, size: 'xxs', color: done ? tone.color : '#94A3B8', align: 'center' },
        ],
      };
    }),
  };
}

function preLeasingCard(data) {
  const { landlordAnswers = [], upcomingShowings = [] } = data;
  
  const contents = [
    { type: 'text', text: '租屋通知 (租屋前)', weight: 'bold', size: 'lg', color: '#1F2937' },
    { type: 'separator', margin: 'md' }
  ];

  // 1. 轉問房東回覆通知（最多顯示 5 則）
  const qnaHeaderContents = [
    { type: 'text', text: ' 最新房東回覆', weight: 'bold', size: 'sm', color: '#1F2937', flex: 0 },
    {
      type: 'box', layout: 'vertical', flex: 0, margin: 'sm',
      cornerRadius: '4px', backgroundColor: '#3F4A2F',
      paddingStart: '6px', paddingEnd: '6px', paddingTop: '2px', paddingBottom: '2px',
      contents: [{ type: 'text', text: 'Q&A', size: 'xxs', color: '#FFFFFF', weight: 'bold' }]
    },
    { type: 'filler' }
  ];
  if (landlordAnswers.length > 0) {
    qnaHeaderContents.push({
      type: 'text',
      text: `顯示最新 ${Math.min(landlordAnswers.length, 5)} 則（最多 5 則）`,
      size: 'xxs', color: '#64748B', align: 'end', flex: 0, gravity: 'center'
    });
  }
  contents.push({
    type: 'box', layout: 'horizontal', margin: 'md',
    contents: qnaHeaderContents
  });
  if (landlordAnswers.length > 0) {
    const displayAnswers = landlordAnswers.slice(0, 5);
    displayAnswers.forEach((ans, idx) => {
      contents.push({
        type: 'box', layout: 'horizontal', margin: 'md', spacing: 'md',
        contents: [
          {
            type: 'box', layout: 'vertical', width: '3px',
            backgroundColor: '#3F4A2F', cornerRadius: '2px',
            contents: [{ type: 'filler' }]
          },
          {
            type: 'box', layout: 'vertical', flex: 1,
            contents: [
              { type: 'text', text: `${ans.unit_title || '房源'}`, size: 'xs', color: '#111827', weight: 'bold', wrap: true },
              { type: 'text', text: `Q：${ans.question_text}`, size: 'xs', color: '#64748B', wrap: true, margin: 'sm' },
              { type: 'text', text: `A：${ans.answer_text}`, size: 'md', color: '#1F2937', weight: 'bold', wrap: true, margin: 'sm' },
              { type: 'text', text: `回覆時間: ${dateText(ans.answered_at)}`, size: 'xxs', color: '#94A3B8', margin: 'sm' }
            ]
          }
        ]
      });
    });
  } else {
    contents.push({ type: 'text', text: '目前沒有最新回覆', size: 'xs', color: '#64748B', margin: 'sm' });
  }
  contents.push({ type: 'separator', margin: 'md' });


  // 2. 看房提醒 — icon-row 版面
  if (upcomingShowings.length > 0) {
    upcomingShowings.forEach(showing => {
      contents.push(iconRow('🗓️', `已預約看房：${showing.title}`, `時間: ${showing.starts_at}`));
    });
  } else {
    contents.push(iconRow('🗓️', '已預約看房', '目前沒有已預約的看房行程'));
  }

  // 3. 簽約通知 — icon-row 版面
  contents.push(iconRow('✏️', '簽約通知', '目前沒有待簽署合約'));
  
  return {
    type: 'flex',
    altText: '您的租屋通知',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', backgroundColor: '#F8FAFC', contents },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: postback('查看歷史通知', 'tenant_notification_history') },
          { type: 'button', style: 'secondary', height: 'sm', action: postback('通知測試', 'tenant_notification_test_menu') },
          { type: 'button', style: 'primary', height: 'sm', color: '#3F4A2F', action: postback('切換至租屋後 (Demo)', 'tenant_notification', { forceState: 'post_leasing' }) }
        ]
      }
    }
  };
}

function postLeasingCard(data) {
  const { currentMonthRent, activeLease, latestRepair } = data;

  const contents = [
    { type: 'text', text: '租屋通知 (租屋後)', weight: 'bold', size: 'lg', color: '#1F2937' },
    { type: 'separator', margin: 'md' }
  ];

  // 1. 當月租金繳費通知 — icon-row 版面
  if (currentMonthRent) {
    const isPending = currentMonthRent.status === 'pending';
    
    // Check if within 7 days
    let dueWarning = '';
    if (isPending && currentMonthRent.due_date) {
      const dueDate = new Date(currentMonthRent.due_date);
      const now = new Date();
      const diffTime = Math.abs(dueDate - now);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
      if (diffDays <= 7) {
        dueWarning = ' ⚠️ 即將到期';
      }
    }

    const statusText = currentMonthRent.status === 'paid' ? '已繳費' : '未繳費';
    const desc = `NT$ ${Number(currentMonthRent.amount).toLocaleString()} ∣ ${statusText}${dueWarning} \n 截止 ${currentMonthRent.due_date}`;
    contents.push(iconRow('💰', '當月租金繳費通知', desc));
  } else {
    contents.push(iconRow('💰', '當月租金繳費通知', '本月尚無帳單資料'));
  }

  // 2. 報修項目與修繕進度 — icon-row 版面
  if (latestRepair) {
    contents.push(iconRow(
      '🛠️',
      '報修項目',
      `${latestRepair.unit_label || '租屋物件'}｜${latestRepair.description || latestRepair.category || '報修內容待確認'}`,
    ));
    contents.push(iconRow(
      '📸',
      '修繕進度',
      repairStatusText(latestRepair.status, latestRepair),
    ));
    contents.push(repairProgressRow(latestRepair));
  } else {
    contents.push(iconRow('🛠️', '報修項目', '目前沒有進行中的報修單'));
    contents.push(iconRow('📸', '修繕進度', '尚無待回傳或待確認的修繕照片'));
  }

  // 3. 續約通知 — icon-row 版面
  contents.push(iconRow('📄', '續約通知', '尚無續約通知'));

  // 4. 租約到期日
  if (activeLease && activeLease.end_date) {
    contents.push({
      type: 'box', layout: 'horizontal', margin: 'md',
      contents: [
        { type: 'text', text: '合約到期日', size: 'xs', color: '#64748B', flex: 1 },
        { type: 'text', text: activeLease.end_date, size: 'xs', color: '#1F2937', weight: 'bold', align: 'end', flex: 2 }
      ]
    });
  } else {
    contents.push({ type: 'text', text: '無有效合約紀錄', size: 'xs', color: '#64748B', align: 'center', margin: 'md' });
  }

  return {
    type: 'flex',
    altText: '您的租屋通知',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', backgroundColor: '#F8FAFC', contents },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: postback('查看歷史通知', 'tenant_notification_history') },
          { type: 'button', style: 'secondary', height: 'sm', action: postback('通知測試', 'tenant_notification_test_menu') },
          { type: 'button', style: 'primary', height: 'sm', color: '#3F4A2F', action: postback('切換至租屋前 (Demo)', 'tenant_notification', { forceState: 'pre_leasing' }) }
        ]
      }
    }
  };
}

function notificationHistoryCard(historyList) {
  const contents = [
    { type: 'text', text: '📜 歷史通知紀錄', weight: 'bold', size: 'lg', color: '#1F2937' },
    { type: 'separator', margin: 'md' }
  ];

  if (!historyList || historyList.length === 0) {
    contents.push({ type: 'text', text: '目前沒有歷史通知', size: 'sm', color: '#888888', margin: 'md' });
  } else {
    historyList.forEach((item, index) => {
      let previewText = item.event_type;
      try {
        if (item.payload_json) {
          const payload = JSON.parse(item.payload_json);
          previewText = payload.message || payload.title || item.event_type;
        }
      } catch (e) {
        // ignore
      }

      contents.push(
        { type: 'text', text: previewText, size: 'sm', color: '#111111', wrap: true, margin: 'sm' },
        { type: 'text', text: `${item.created_at} | ${item.status}`, size: 'xxs', color: '#888888' }
      );
      if (index < historyList.length - 1) {
        contents.push({ type: 'separator', margin: 'sm' });
      }
    });
  }

  return {
    type: 'flex',
    altText: '歷史通知紀錄',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [
          { type: 'button', style: 'primary', height: 'sm', action: postback('返回目前通知', 'tenant_notification') }
        ]
      }
    }
  };
}

function testNotificationMenuCard() {
  return {
    type: 'flex',
    altText: '通知測試選單',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🛠️ 通知測試選單', weight: 'bold', size: 'lg', color: '#1F2937' },
          { type: 'text', text: '請選擇要單獨測試跳出的通知卡片：', size: 'xs', color: '#64748B', margin: 'sm', wrap: true }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', action: postback('當月租金繳費通知', 'tenant_notification_single', { type: 'billing' }) },
          { type: 'button', style: 'secondary', height: 'sm', action: postback('簽約通知', 'tenant_notification_single', { type: 'contract' }) },
          { type: 'button', style: 'secondary', height: 'sm', action: postback('最新房東回覆', 'tenant_notification_single', { type: 'landlord_answer' }) },
          { type: 'button', style: 'secondary', height: 'sm', action: postback('已預約看房通知', 'tenant_notification_single', { type: 'showing' }) },
          { type: 'button', style: 'secondary', height: 'sm', action: postback('續約通知', 'tenant_notification_single', { type: 'renewal' }) }
        ]
      }
    }
  };
}

function singleBillingCard(currentMonthRent) {
  const contents = [];

  if (currentMonthRent) {
    const isPending = currentMonthRent.status === 'pending';
    let dueWarning = '';
    if (isPending && currentMonthRent.due_date) {
      const dueDate = new Date(currentMonthRent.due_date);
      const now = new Date();
      const diffTime = Math.abs(dueDate - now);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
      if (diffDays <= 7) dueWarning = ' ⚠️ 即將到期';
    }

    const statusText = currentMonthRent.status === 'paid' ? '已繳費' : '未繳費';
    const desc = `NT$ ${Number(currentMonthRent.amount).toLocaleString()} ∣ ${statusText}${dueWarning} \n 截止 ${currentMonthRent.due_date}`;
    contents.push(iconRow('💰', '當月租金繳費通知', desc));
  } else {
    contents.push(iconRow('💰', '當月租金繳費通知', '本月尚無帳單資料'));
  }

  return { type: 'flex', altText: '當月租金繳費通知', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents } } };
}

function singleContractCard() {
  return {
    type: 'flex', altText: '簽約通知',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [ iconRow('✏️', '簽約通知', '目前沒有待簽署合約') ]
      }
    }
  };
}

function singleLandlordAnswerCard(landlordAnswers = []) {
  if (!landlordAnswers || landlordAnswers.length === 0) {
    return { type: 'text', text: '目前沒有最新回覆' };
  }
  const ans = landlordAnswers[0];
  const textMsg = `房東已回覆\n\n房源：${ans.unit_title || '未提供房源'}\n\n你的問題：\n${ans.question_text}\n\n房東回覆：\n${ans.answer_text}\n\n回覆時間：${dateText(ans.answered_at)}`;

  return {
    type: 'text',
    text: textMsg,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '查看聯絡紀錄', text: '查看聯絡紀錄' } },
        { type: 'action', action: { type: 'message', label: '繼續詢問房東', text: '聯絡房東' } }
      ]
    }
  };
}

function singleShowingCard(upcomingShowings = []) {
  const contents = [];

  if (upcomingShowings.length > 0) {
    upcomingShowings.forEach(showing => {
      contents.push(iconRow('🗓️', `已預約看房：${showing.title}`, `時間: ${showing.starts_at}`));
    });
  } else {
    contents.push(iconRow('🗓️', '已預約看房', '目前沒有已預約的看房行程'));
  }

  return { type: 'flex', altText: '已預約看房通知', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents } } };
}

function singleRenewalCard() {
  return {
    type: 'flex', altText: '續約通知',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [ iconRow('📄', '續約通知', '尚無續約通知') ]
      }
    }
  };
}

module.exports = {
  preLeasingCard,
  postLeasingCard,
  notificationHistoryCard,
  testNotificationMenuCard,
  singleBillingCard,
  singleContractCard,
  singleLandlordAnswerCard,
  singleShowingCard,
  singleRenewalCard
};
