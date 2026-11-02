function postback(label, action, params = {}) {
  const data = new URLSearchParams({ action, ...params }).toString();
  return { type: 'postback', label, data, displayText: label };
}

function quickReply(text, actions) {
  return {
    type: 'text',
    text,
    quickReply: { items: actions.map(action => ({ type: 'action', action })) },
  };
}

function mainMenu() {
  return quickReply('房客訊息中心 v2\n請選擇要處理的項目：', [
    postback('查看待回覆問題', 'tenant_message_start'),
    postback('主動聯絡房客', 'landlord_contact_start'),
    postback('查看聯絡紀錄', 'tenant_message_history_start')
  ]);
}

function listingCarousel(listings, actionType) {
  if (!listings || listings.length === 0) {
    return { type: 'text', text: '找不到您管理的房源，或目前沒有待回覆的問題。' };
  }

  const bubbles = listings.map(listing => ({
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: listing.title, weight: 'bold', wrap: true },
        { type: 'text', text: `租金 NT$ ${Number(listing.rentAmount || 0).toLocaleString('zh-TW')}` },
        { type: 'text', text: `待回覆問題：${listing.pendingQuestionCount || 0} 則`, size: 'sm', wrap: true, color: '#ff0000' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        action: postback('選擇', actionType, { listing: listing.publicId }),
      }],
    },
  }));

  return { type: 'flex', altText: '請選擇房源', contents: { type: 'carousel', contents: bubbles } };
}

function tenantSelectionMessage(tenants) {
  if (!tenants || tenants.length === 0) {
    return { type: 'text', text: '此房源目前沒有對應的房客聯絡紀錄。' };
  }
  return quickReply(
    '請選擇要聯絡的房客：',
    tenants.map(t => postback(t.displayName || '未知房客', 'landlord_contact_select_tenant', { inquiry: t.inquiryId }))
  );
}

function pendingQuestionCard(question, index, total) {
  const timeStr = new Date(question.askedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  let displayQuestionText = question.questionText;
  if (!displayQuestionText && (question.questionText === null || question.questionText === '')) {
      displayQuestionText = '（房客上傳照片/檔案）';
  }

  const tName = question.tenantName || '房客';
  const text = `待回覆問題 ${index}/${total}\n\n房源：${question.listingTitle}\n房客：${tName}\n時間：${timeStr}\n\n問題：\n${displayQuestionText}`;

  const actions = [
    postback('回覆此問題', 'tenant_message_reply', { question: question.publicId }),
    postback('稍後處理', 'tenant_message_later', { question: question.publicId })
  ];

  if (total > 1) {
    actions.push(postback('下一題', 'tenant_message_next'));
  }

  return quickReply(text, actions);
}

function formatHistoryTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const now = new Date();
  
  const optionsDate = { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' };
  const dDate = d.toLocaleDateString('zh-TW', optionsDate); 
  const nowDate = now.toLocaleDateString('zh-TW', optionsDate);
  
  const optionsTime = { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' };
  const dTime = d.toLocaleTimeString('zh-TW', optionsTime);
  
  if (dDate === nowDate) {
    return dTime;
  } else {
    const parts = dDate.split('/');
    if (parts.length === 3) {
      return `${parts[1]}/${parts[2]} ${dTime}`;
    }
    return `${dDate} ${dTime}`;
  }
}

function processHistoryInteractions(historyRows) {
  let qaCount = 0;
  let proactiveCount = 0;
  let lastUpdatedAt = '';

  const reversedRows = [...historyRows].reverse();
  if (historyRows.length > 0) {
    lastUpdatedAt = formatHistoryTime(historyRows[0].time);
  }

  const interactions = [];
  for (const row of reversedRows) {
    if (row.role === 'tenant') {
       interactions.push({ type: 'qa', qId: row.question_id, qTime: row.time, qText: row.content, aTime: null, aText: null, qStatus: row.question_status });
    } else if (row.role === 'landlord_reply') {
       const qa = interactions.find(i => i.type === 'qa' && i.qId === row.question_id);
       if (qa) {
         qa.aTime = row.time;
         qa.aText = row.content;
       } else {
         interactions.push({ type: 'unpaired_reply', aTime: row.time, aText: row.content });
       }
    } else if (row.role === 'landlord_proactive') {
       interactions.push({ type: 'proactive', time: row.time, content: row.content });
    }
  }

  const validInteractions = [];
  for (const item of interactions) {
    if (item.type === 'qa') {
      let q = item.qText || '';
      q = q.replace(/^我想詢問：\s*/, '').replace(/^請輸入想詢問房東的內容\s*/, '').replace(/^聯絡房東\s*/, '').trim();
      if (q.length > 60) q = q.substring(0, 60) + '...';
      
      let a = item.aText || '';
      if (a) {
        a = a.trim();
        if (a.length > 60) a = a.substring(0, 60) + '...';
      }
      
      if (!q && a) q = '（圖片/檔案）';
      if (!q && !a) continue;
      
      validInteractions.push({ ...item, qText: q, aText: a });
      qaCount++;
    } else if (item.type === 'proactive') {
      let c = item.content || '';
      c = c.trim();
      if (!c) continue;
      if (c.length > 60) c = c.substring(0, 60) + '...';
      
      validInteractions.push({ ...item, content: c });
      proactiveCount++;
    }
  }

  return { validInteractions, qaCount, proactiveCount, lastUpdatedAt };
}

function contactHistoryTextMessage(historyRows, listingTitle, isLandlord = false, pendingQuestionCount = 0) {
  if (!historyRows || historyRows.length === 0) {
    return { type: 'text', text: '目前尚無聯絡紀錄。' };
  }
  
  const { validInteractions, qaCount, proactiveCount, lastUpdatedAt } = processHistoryInteractions(historyRows);

  if (validInteractions.length === 0) {
    return { type: 'text', text: '目前尚無聯絡紀錄。' };
  }

  const displayItems = validInteractions.slice(-3);
  const historyText = [];
  
  for (const item of displayItems) {
    if (item.type === 'qa') {
      let txt = `Q 房客｜${formatHistoryTime(item.qTime)}\n${item.qText || '（無內容）'}`;
      if (item.aTime && item.aText) {
        txt += `\n\nA 房東｜${formatHistoryTime(item.aTime)}\n${item.aText}`;
      }
      historyText.push(txt);
    } else if (item.type === 'proactive') {
      historyText.push(`房東主動｜${formatHistoryTime(item.time)}\n${item.content}`);
    }
  }
  
  const header = `聯絡紀錄\n房源：${listingTitle || '全部房源'}`;
  const summary = `摘要：\n問答 ${qaCount} 組\n主動訊息 ${proactiveCount} 則\n未回覆 ${pendingQuestionCount} 則\n最後更新：${lastUpdatedAt}`;
  const textMsg = `${header}\n\n${summary}\n\n最近互動：\n${historyText.join('\n\n---\n\n')}`;
  
  if (isLandlord) {
    return quickReply(textMsg, [
      postback('返回房客訊息中心', 'tenant_message_return_main'),
      postback('結束', 'tenant_message_finish')
    ]);
  }
  
  return { type: 'text', text: textMsg };
}

function contactHistoryMessage(historyRows, listingTitle, isLandlord = false, pendingQuestionCount = 0) {
  if (!historyRows || historyRows.length === 0) {
    return { type: 'text', text: '目前尚無聯絡紀錄。' };
  }
  
  const { validInteractions, qaCount, proactiveCount, lastUpdatedAt } = processHistoryInteractions(historyRows);

  if (validInteractions.length === 0) {
    return { type: 'text', text: '目前尚無聯絡紀錄。' };
  }

  const displayItems = validInteractions.slice(-3);
  
  const messageRows = displayItems.map((item) => {
    if (item.type === 'qa') {
      const qBlock = {
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#2563EB',
                cornerRadius: 'sm',
                paddingAll: 'sm',
                flex: 0,
                contents: [{ type: 'text', text: 'Q 房客', size: 'xxs', color: '#ffffff', weight: 'bold', align: 'center' }]
              },
              { type: 'text', text: formatHistoryTime(item.qTime), size: 'xs', color: '#9ca3af', flex: 1, gravity: 'center' }
            ]
          },
          { type: 'text', text: item.qText || '（無內容）', size: 'sm', wrap: true, color: '#374151' }
        ]
      };
      
      const contents = [qBlock];
      
      if (item.aTime && item.aText) {
        contents.push({
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'sm',
              contents: [
                {
                  type: 'box',
                  layout: 'vertical',
                  backgroundColor: '#16A34A',
                  cornerRadius: 'sm',
                  paddingAll: 'sm',
                  flex: 0,
                  contents: [{ type: 'text', text: 'A 房東', size: 'xxs', color: '#ffffff', weight: 'bold', align: 'center' }]
                },
                { type: 'text', text: formatHistoryTime(item.aTime), size: 'xs', color: '#9ca3af', flex: 1, gravity: 'center' }
              ]
            },
            { type: 'text', text: item.aText, size: 'sm', wrap: true, color: '#374151' }
          ]
        });
      }
      
      return {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#f9fafb',
        cornerRadius: 'md',
        paddingAll: 'md',
        spacing: 'sm',
        contents: contents
      };
      
    } else {
      return {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#f9fafb',
        cornerRadius: 'md',
        paddingAll: 'md',
        spacing: 'xs',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F97316',
                cornerRadius: 'sm',
                paddingAll: 'sm',
                flex: 0,
                contents: [{ type: 'text', text: '房東主動', size: 'xxs', color: '#ffffff', weight: 'bold', align: 'center' }]
              },
              { type: 'text', text: formatHistoryTime(item.time), size: 'xs', color: '#9ca3af', flex: 1, gravity: 'center' }
            ]
          },
          { type: 'text', text: item.content, size: 'sm', wrap: true, color: '#374151' }
        ]
      };
    }
  });
  
  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0F766E',
      paddingAll: 'lg',
      contents: [
        { type: 'text', text: '聯絡紀錄', weight: 'bold', size: 'xl', color: '#ffffff' },
        { type: 'text', text: '最近互動摘要', size: 'xs', color: '#ffffffcc', margin: 'xs' }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: listingTitle ? `房源：${listingTitle}` : '房源：全部房源', weight: 'bold', size: 'md', color: '#333333', wrap: true, maxLines: 2 },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          spacing: 'sm',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#f3f4f6',
              cornerRadius: 'sm',
              paddingAll: 'sm',
              contents: [
                { type: 'text', text: '問答', size: 'xxs', color: '#6b7280' },
                { type: 'text', text: String(qaCount), size: 'sm', weight: 'bold', color: '#374151' }
              ]
            },
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#f3f4f6',
              cornerRadius: 'sm',
              paddingAll: 'sm',
              contents: [
                { type: 'text', text: '主動訊息', size: 'xxs', color: '#6b7280' },
                { type: 'text', text: String(proactiveCount), size: 'sm', weight: 'bold', color: '#374151' }
              ]
            },
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: '#f3f4f6',
              cornerRadius: 'sm',
              paddingAll: 'sm',
              contents: [
                { type: 'text', text: '未回覆', size: 'xxs', color: '#6b7280' },
                { type: 'text', text: String(pendingQuestionCount), size: 'sm', weight: 'bold', color: '#374151' }
              ]
            }
          ]
        },
        { type: 'text', text: `最後更新 ${lastUpdatedAt}`, size: 'xxs', color: '#9ca3af', margin: 'md' },
        { type: 'separator', margin: 'lg' },
        {
          type: 'box',
          layout: 'vertical',
          margin: 'lg',
          spacing: 'lg',
          contents: messageRows
        }
      ]
    }
  };
  
  if (isLandlord) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          action: postback('返回房客訊息中心', 'tenant_message_return_main')
        },
        {
          type: 'button',
          style: 'link',
          color: '#e53935',
          action: postback('結束', 'tenant_message_finish')
        }
      ]
    };
  }
  
  return {
    type: 'flex',
    altText: '聯絡紀錄',
    contents: bubble
  };
}

function askSaveToKnowledgeCard(questionPublicId) {
  return quickReply('是否將這次回覆加入 AI 知識庫？', [
    postback('加入知識庫', 'tenant_message_save_kb', { question: questionPublicId }),
    postback('不加入', 'tenant_message_skip_kb', { question: questionPublicId }),
    postback('重新回覆', 'tenant_message_retry_reply', { question: questionPublicId }),
  ]);
}

function afterReplyMenu(hasMore) {
  const textMsg = hasMore 
    ? '已完成本次回覆。\n若還有待回覆問題，你可以繼續查看；也可以返回房客訊息中心或結束操作。'
    : '目前沒有其他待回覆問題。';

  const actions = [];
  if (hasMore) {
    actions.push(postback('查看下一題', 'tenant_message_next_after_reply'));
  }
  actions.push(postback('返回房客訊息中心', 'tenant_message_return_main'));
  actions.push(postback('結束', 'tenant_message_finish'));

  return quickReply(textMsg, actions);
}

module.exports = {
  mainMenu,
  listingCarousel,
  tenantSelectionMessage,
  pendingQuestionCard,
  contactHistoryMessage,
  contactHistoryTextMessage,
  askSaveToKnowledgeCard,
  afterReplyMenu,
  processHistoryInteractions,
  formatHistoryTime
};
