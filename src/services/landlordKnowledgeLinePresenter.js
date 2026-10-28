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

function listingCarousel(listings, actionType = 'knowledge_select_listing') {
  const bubbles = listings.map(listing => ({
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: listing.title, weight: 'bold', wrap: true },
        { type: 'text', text: `租金 NT$ ${Number(listing.rentAmount || 0).toLocaleString('zh-TW')}` },
        { type: 'text', text: `資料品質：${listing.qualityStatus === 'valid' ? '完整' : '待補充'}`, size: 'sm' },
        { type: 'text', text: `知識 ${listing.knowledgeCount || 0} 則・待回答 ${listing.pendingQuestionCount || 0} 則`, size: 'sm', wrap: true },
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

function summaryCard(summary) {
  const publicRules = (summary.publicKnowledge || []).slice(0, 3).map(rule => ({
    type: 'text', text: `• ${rule.content}`, size: 'sm', wrap: true,
  }));
  const internalNotice = summary.internalKnowledgeCount
    ? [{ type: 'text', text: `另有 ${summary.internalKnowledgeCount} 則內部規則`, size: 'xs', color: '#777777' }]
    : [];
  return {
    type: 'flex',
    altText: `${summary.title} AI 知識摘要`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: summary.title, weight: 'bold', wrap: true },
          { type: 'text', text: `租金 NT$ ${Number(summary.rentAmount || 0).toLocaleString('zh-TW')}`, size: 'sm' },
          { type: 'text', text: summary.address || '地址待補', size: 'sm', wrap: true },
          ...publicRules,
          ...internalNotice,
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'button', action: postback(`回答問題（${summary.pendingQuestionCount || 0}）`, 'knowledge_pending', { listing: summary.publicId }) },
          { type: 'button', action: postback('快速補充', 'knowledge_add_rule', { listing: summary.publicId }) },
          { type: 'button', action: postback('換房源', 'knowledge_change_listing') },
        ],
      },
    },
  };
}

function pendingQuestionMessage(question, position, total) {
  // 出價題:答案會變成之後自動議價的依據,所以問的是價格政策,不是一般的可以/不可以。
  if (question.escalationReason === 'rent_offer') {
    return quickReply(
      `待回答 ${position}/${total}
${question.questionText}

設定最低價後，之後的出價我會先替你還價一次，低於最低價直接婉拒。`,
      [
        postback('接受這個價', 'knowledge_rent_accept', { question: question.publicId }),
        postback('不接受殺價', 'knowledge_rent_no_bargain', { question: question.publicId }),
        postback('輸入最低價', 'knowledge_rent_floor', { question: question.publicId }),
        postback('稍後回答', 'knowledge_answer_later', { question: question.publicId }),
      ],
    );
  }
  return quickReply(
    `待回答 ${position}/${total}\n${question.questionText}`,
    [
      postback('可以', 'knowledge_answer_yes', { question: question.publicId }),
      postback('不可以', 'knowledge_answer_no', { question: question.publicId }),
      postback('有條件', 'knowledge_answer_conditional', { question: question.publicId }),
      postback('文字回覆', 'knowledge_answer_text', { question: question.publicId }),
      postback('稍後回答', 'knowledge_answer_later', { question: question.publicId }),
    ],
  );
}

function reuseConfirmationMessage(answerPublicId) {
  return quickReply('這個答案之後遇到相同問題時，可以直接沿用嗎？\n沿用的話，之後問這間房的房客都看得到這個答案，請確認裡面沒有其他房客的資料或不想公開的內容。', [
    postback('可以沿用', 'knowledge_reuse_yes', { answer: answerPublicId }),
    postback('每次問我', 'knowledge_reuse_no', { answer: answerPublicId }),
  ]);
}

function ruleConfirmationMessage(candidate, flowPublicId) {
  return quickReply(`我整理成：\n${candidate.content}\n之後遇到相關問題要怎麼處理？`, [
    postback('可以直接回答', 'knowledge_rule_direct', { flow: flowPublicId }),
    postback('每次先問我', 'knowledge_rule_ask', { flow: flowPublicId }),
    postback('重新輸入', 'knowledge_rule_retry', { flow: flowPublicId }),
    postback('取消', 'knowledge_cancel', { flow: flowPublicId }),
  ]);
}

module.exports = {
  listingCarousel,
  summaryCard,
  pendingQuestionMessage,
  reuseConfirmationMessage,
  ruleConfirmationMessage,
};
