const {
  contractDraftEntryCardMessage,
  electronicSignatureEntryCardMessage,
  profileCardMessage
} = require('./cardMessageService');
const { isUserRegistered } = require('./profileService');

const TEXT = {
  assistant: '\u5408\u7d04\u52a9\u624b',
  smartContract: '\u667a\u5951',
  viewContracts: '\u67e5\u770b\u5408\u7d04',
  inspectContracts: '\u5bdf\u770b\u5408\u7d04',
  inspectStatus: '\u5bdf\u770b\u72c0\u614b',
  viewStatus: '\u67e5\u770b\u72c0\u614b',
  profile: '\u500b\u4eba\u8cc7\u6599',
  help: '\u4f7f\u7528\u8aaa\u660e',
  sign: '\u767c\u8d77\u7c3d\u7f72',
  wantContract: '\u6211\u8981\u7c3d\u7d04',
  wantSign: '\u6211\u8981\u7c3d\u7f72',
  contractSign: '\u7c3d\u7d04',
  videoSign: '\u8996\u8a0a\u7c3d\u540d',
  review: '\u5be9\u95b1',
  contractDraft: '\u5408\u7d04\u8349\u7a3f',
  electronicSignature: '\u96fb\u5b50\u7c3d\u7f72',
  electronicSignatureTypo: '\u96fb\u5b50\u7c3d\u5c6c',
  contractCenter: '\u5408\u7d04\u4e2d\u5fc3',
  identityVerification: '\u8eab\u5206\u9a57\u8b49',
  leaseInsurance: '\u79df\u7d04\u4fdd\u96aa',
  customerSupport: '\u5ba2\u670d\u5354\u52a9',
  draftKeyword: '\u7522\u751f\u8349\u7a3f',
  paymentChange: '\u4ed8\u6b3e\u6539\u6210',
  paymentRecorded: '\u5df2\u8a18\u9304\u4ed8\u6b3e\u689d\u4ef6\u7684\u5019\u9078\u4fee\u6539\uff1a',
  paymentTerms: '\u4ed8\u6b3e\u689d\u4ef6\uff1a',
  originalPayment: '\u539f\u689d\u4ef6\uff1a\u7c3d\u7d04\u5f8c 7 \u65e5\u5167\u4ed8\u6b3e',
  newPayment: '\u65b0\u689d\u4ef6',
  missingValue: '\u5c1a\u672a\u63d0\u4f9b\u660e\u78ba\u5167\u5bb9',
  discussionOnly: '\u9019\u53ea\u662f\u7fa4\u7d44\u8a0e\u8ad6\u7d00\u9304\uff0c\u4ecd\u5efa\u8b70\u96d9\u65b9\u78ba\u8a8d\u5f8c\u518d\u5beb\u5165\u6b63\u5f0f\u5408\u7d04\u3002',
  draftReserved: '\u8349\u7a3f\u529f\u80fd\u76ee\u524d\u4fdd\u7559\u7d66\u5408\u7d04 v2\u3002',
  pocScope: '\u672c POC \u5148\u4fdd\u5b58\u7fa4\u7d44\u8a0a\u606f\u3001\u9644\u4ef6\u3001\u6307\u4ee4\u8207\u5019\u9078\u689d\u4ef6\u6458\u8981\u3002',
  gotCommand: '\u6211\u6536\u5230\u6307\u4ee4\u4e86\u3002',
  supported: '\u76ee\u524d\u652f\u63f4\uff1a\u67e5\u770b\u72c0\u614b\u3001\u500b\u4eba\u8cc7\u6599\u3001\u4f7f\u7528\u8aaa\u660e\u3001\u5408\u7d04\u8349\u7a3f\u3001\u96fb\u5b50\u7c3d\u7f72\u3001\u6211\u8981\u7c3d\u7d04\u3001\u6211\u8981\u7c3d\u7f72\u3001/draft\u3002',
  contractsCreated: '\u5df2\u5e6b\u4f60\u6574\u7406\u5408\u7d04\u72c0\u614b\u5361\u7247\uff0c\u8acb\u5de6\u53f3\u6ed1\u52d5\u67e5\u770b\u3002',
  profilePrompt: '\u8acb\u81f3\u5b98\u65b9\u5e33\u865f\u6216\u5716\u6587\u9078\u55ae\u586b\u5beb\u500b\u4eba\u8cc7\u6599\u3002\u9019\u5f35\u5361\u7247\u6703\u4ee5\u4f60\u7576\u4e0b\u9ede\u64ca\u7684 LINE \u8eab\u5206\u8f09\u5165\uff0c\u4e0d\u6703\u8b80\u5230\u5225\u4eba\u8cc7\u6599\u3002',
  profileReady: '\u4f60\u5df2\u5b8c\u6210\u500b\u4eba\u8cc7\u6599\uff0c\u5982\u9700\u8981\u53ef\u4ee5\u518d\u66f4\u65b0\u5167\u5bb9\u3002',
  profileRequiredForSign: '\u7c3d\u7d04\u524d\u9700\u8981\u5148\u5b8c\u6210\u500b\u4eba\u8cc7\u6599\u3002\u8acb\u5148\u586b\u5beb\u59d3\u540d\u3001\u771f\u5be6\u59d3\u540d\u3001\u624b\u6a5f\u8207\u6236\u7c4d\u5730\u5740\u3002',
  signCreated: '\u5df2\u5efa\u7acb\u7c3d\u7f72\u5361\u7247\uff0c\u8acb\u78ba\u8a8d\u5167\u5bb9\u5f8c\u518d\u767c\u8d77\u7c3d\u7f72\u3002'
};

const TRIGGERS = [
  `@${TEXT.assistant}`,
  TEXT.assistant,
  `@${TEXT.smartContract}Bot`,
  TEXT.smartContract,
  TEXT.viewContracts,
  TEXT.inspectContracts,
  TEXT.inspectStatus,
  TEXT.viewStatus,
  TEXT.profile,
  TEXT.help,
  TEXT.sign,
  TEXT.contractDraft,
  TEXT.electronicSignature,
  TEXT.electronicSignatureTypo,
  TEXT.contractCenter,
  TEXT.identityVerification,
  TEXT.leaseInsurance,
  TEXT.customerSupport,
  TEXT.wantContract,
  TEXT.wantSign,
  TEXT.contractSign,
  TEXT.videoSign,
  TEXT.review,
  '/draft',
  TEXT.draftKeyword
];

// 一對一聊天要整句就是指令才算:「熱水器很難點火，簽約前房東會修嗎」含「簽約」,
// 用包含比對會被當成指令,問題就到不了 Agent。群組裡要從聊天中撿指令,維持包含比對。
function isBotCommand(text, { exact = false } = {}) {
  const value = String(text || '').trim();
  return TRIGGERS.some((trigger) => (exact ? value === trigger : value.includes(trigger)));
}

function commandType(text) {
  if (text.includes(TEXT.help) || text.includes(TEXT.customerSupport)) return 'help';
  if (text.includes('/draft') || text.includes(TEXT.draftKeyword) || text.includes(TEXT.contractDraft)) return 'draft';
  if (
    text.includes(TEXT.viewContracts) ||
    text.includes(TEXT.inspectContracts) ||
    text.includes(TEXT.inspectStatus) ||
    text.includes(TEXT.viewStatus) ||
    text.includes(TEXT.contractCenter)
  ) return 'contracts';
  if (text.includes(TEXT.profile) || text.includes(TEXT.identityVerification)) return 'profile';
  if (
    text.includes(TEXT.sign) ||
    text.includes(TEXT.electronicSignature) ||
    text.includes(TEXT.electronicSignatureTypo) ||
    text.includes(TEXT.wantContract) ||
    text.includes(TEXT.wantSign) ||
    text.includes(TEXT.videoSign) ||
    text.trim() === TEXT.contractSign ||
    text.trim() === TEXT.review
  ) return 'sign';
  if (text.includes(TEXT.leaseInsurance)) return 'lease_insurance';
  if (text.includes(TEXT.paymentChange)) return 'update_payment';
  return 'unknown';
}

function paymentUpdateResponse(text) {
  const index = text.indexOf(TEXT.paymentChange);
  const value = index >= 0 ? text.slice(index + TEXT.paymentChange.length).trim() : '';

  return [
    TEXT.paymentRecorded,
    '',
    TEXT.paymentTerms,
    TEXT.originalPayment,
    `${TEXT.newPayment}\uff1a${value || TEXT.missingValue}`,
    '',
    TEXT.discussionOnly
  ].join('\n');
}

function draftResponse() {
  return '請從合約頁的「合約草稿」開啟新版流程。';
}

function unknownResponse() {
  return [
    TEXT.gotCommand,
    TEXT.supported
  ].join('\n');
}

function helpResponse() {
  return [
    '可以輸入「個人資料」取得填寫卡片。',
    '輸入「合約草稿」或「電子簽署」會收到對應的 Mini App 入口卡片。',
    TEXT.supported
  ].join('\n');
}

async function buildCommand(event) {
  const text = event.message.text || '';
  const type = commandType(text);
  const userId = event.source.userId || null;

  if (type === 'update_payment') {
    return { commandType: type, commandText: text, aiResponse: paymentUpdateResponse(text) };
  }

  if (type === 'contracts') {
    return {
      commandType: type,
      commandText: text,
      aiResponse: '請從 LINE 圖文選單的「合約草稿」或「電子簽署」開啟新版流程。'
    };
  }

  if (type === 'help') {
    return { commandType: type, commandText: text, aiResponse: helpResponse() };
  }

  if (type === 'lease_insurance') {
    return {
      commandType: type,
      commandText: text,
      aiResponse: '租約保險功能目前尚未開放；之後可以接保險方案說明、投保狀態與保單文件入口。'
    };
  }

  if (type === 'profile') {
    const registered = isUserRegistered(userId);
    return {
      commandType: type,
      commandText: text,
      aiResponse: registered ? TEXT.profileReady : TEXT.profilePrompt,
      followupMessage: profileCardMessage()
    };
  }

  if (type === 'sign') {
    return {
      commandType: type,
      commandText: text,
      aiResponse: '請點擊卡片開啟待簽合約。',
      followupMessage: electronicSignatureEntryCardMessage()
    };
  }

  if (type === 'draft') {
    return {
      commandType: type,
      commandText: text,
      aiResponse: draftResponse(),
      followupMessage: contractDraftEntryCardMessage()
    };
  }

  return { commandType: type, commandText: text, aiResponse: unknownResponse() };
}

module.exports = {
  buildCommand,
  commandType,
  isBotCommand
};
