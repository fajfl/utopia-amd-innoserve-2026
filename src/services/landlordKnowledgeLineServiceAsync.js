// 房東 LINE「AI 知識庫」service 的 driver 版本。
//
// 參數 `db` 收的是 sqlDriver 的 driver,不是原始的 better-sqlite3 連線,底下可掛
// SQLite 或 TiDB。同步版 (landlordKnowledgeLineService.js) 仍在 webhook 上服務,
// 兩份實作靠 repository 層的等價性測試綁在一起。
//
// 兩個重點:
//
// 1. 交易期間絕不呼叫外部服務。房客通知(LINE push)一律排在該次操作的所有資料庫
//    寫入完成之後才送出,而且不 await —— 房東的 reply 不該等 LINE push。
//
// 2. notifyTenant 可注入。預設仍是 tenantNotificationService.notifyTenantOfLandlordReply,
//    但那支還沒 driver 化:它用 openV2Database 自己開一條 better-sqlite3 連線
//    (process.env.V2_DATABASE_PATH),完全不看這裡傳進來的 db。也就是說在 TiDB
//    模式下它會去讀本機 SQLite,讀到的資料可能與剛剛寫入的雲端資料不一致。
//    這裡把它做成可注入的相依,好讓 tenantNotificationService 完成遷移後直接替換,
//    測試也能塞假的 notifier。

const { findOrCreateLineUser } = require('../repositories/v2InquiryRepositoryAsync');
const knowledge = require('../repositories/v2LandlordKnowledgeRepositoryAsync');
const flows = require('../repositories/v2LineFlowRepositoryAsync');
const negotiation = require('./ecsNeoRentNegotiationService');
const presenter = require('./landlordKnowledgeLinePresenter');
const { warningForLandlord } = require('./ecsNeoDepositWarning');
const { normalizeRuleInput } = require('./landlordRuleNormalizer');
const { notifyTenantOfLandlordReply } = require('./tenantNotificationServiceAsync');

function params(value) {
  return Object.fromEntries(new URLSearchParams(String(value || '')).entries());
}

function text(message) { return { type: 'text', text: message }; }

function createLandlordKnowledgeLineServiceAsync({
  db,
  now = () => new Date(),
  // 預設接 driver 版:同步版的 notifyTenantOfLandlordReply 不收 db,會自己開一條
  // 本機 SQLite 連線,在 V2_DB_DRIVER=mysql 之下等於寫雲端、讀本機。
  notifyTenant = (inquiryId, message, landlordLineUserId) =>
    notifyTenantOfLandlordReply(db, inquiryId, message, landlordLineUserId)
} = {}) {
  function identity(lineUserId, displayName) {
    return findOrCreateLineUser(db, { lineUserId, displayName });
  }

  // 刻意不 await:LINE push 是外部呼叫,只在所有資料庫寫入結束後才排進來,
  // 失敗只記 log,不影響房東當下收到的回覆。
  function scheduleTenantNotice(inquiryId, message, landlordLineUserId) {
    Promise.resolve()
      .then(() => notifyTenant(inquiryId, message, landlordLineUserId))
      .catch((error) => console.error(error.message));
  }

  async function openMenu(input) {
    const who = await identity(input.lineUserId, input.displayName);
    const at = now();
    // 取消舊 session 與建立新 session 併成一個交易:中途失敗就整個回捲,
    // 不會留下「舊的已取消、新的沒建立」的空窗。startFlowCore 假設自己已在交易裡。
    await db.transaction(async (tx) => {
      await flows.cancelFlow(tx, who.lineIdentityId, at);
      await flows.startFlowCore(tx, {
        lineIdentityId: who.lineIdentityId,
        stepCode: 'select_listing',
        now: at
      });
    });
    // 只列這位房東自己的房。以前列全部示範房源:真人的房子不在裡面,轉問永遠答不了,
    // 而且每位房東都看得到別人的房。
    const listings = await knowledge.listLandlordListings(db, who.userId, { limit: 10 });
    if (!listings.length) return { handled: true, messages: [text('你目前沒有登記為房東的房源。')] };
    return { handled: true, messages: [presenter.listingCarousel(listings)] };
  }

  async function handleText(input) {
    const value = String(input.text || '').trim();
    if (['AI知識庫', '待回答問題'].includes(value)) return openMenu(input);

    if (!input.lineUserId) return { handled: false, messages: [] };
    const who = await identity(input.lineUserId, input.displayName);
    const flow = await flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow) return { handled: false, messages: [] };
    if (value === '取消') {
      await flows.finishFlow(db, flow.publicId, 'cancelled', now());
      return { handled: true, messages: [text('已取消這次操作。')] };
    }
    if (flow.stepCode === 'await_rule_text') {
      let normalized;
      let candidate;
      try {
        normalized = normalizeRuleInput(value);
        candidate = normalized.candidates[0];
      } catch (error) {
        // 只吃 normalizeRuleInput 的輸入驗證錯誤。同步版把 advanceFlow 也包在
        // 同一個 try 裡,結果資料庫錯誤會被當成給房東看的提示訊息回出去。
        return { handled: true, messages: [text(error.message)] };
      }
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        stepCode: 'confirm_rule',
        listingId: flow.listingId,
        context: { ...flow.context, normalized, candidate },
        now: now()
      });
      return { handled: true, messages: [presenter.ruleConfirmationMessage(candidate, flow.publicId)] };
    }
    if (flow.stepCode === 'await_rent_floor') {
      const amount = Number(value.replace(/[,，s元]/g, ''));
      const offer = await negotiation.loadEscalatedOffer(db, flow.context.questionPublicId);
      if (!offer) {
        await flows.finishFlow(db, flow.publicId, 'cancelled', now());
        return { handled: true, messages: [text('這題已經不是待回答的出價，請重新點選「AI知識庫」。')] };
      }
      if (!Number.isInteger(amount) || amount <= 0 || amount > offer.listed) {
        return { handled: true, messages: [text(`請輸入一個不超過刊登租金 ${offer.listed} 元的整數金額，例如 ${Math.round(offer.listed * 0.9)}。`)] };
      }
      return settleRentQuestion({ flow, who, landlordLineUserId: input.lineUserId, offer,
        rule: { floorRentAmount: amount, bargainAllowed: true }, ruleText: `月租最低 ${amount} 元`,
        landlordText: `已設定最低月租 ${amount} 元。之後房客出價在這之上，我會先替你還價一次；低於這個價直接婉拒。` });
    }
    if (flow.stepCode === 'await_conditional_answer') {
      if (!value) return { handled: true, messages: [text('請輸入允許的條件。')] };
      return answerAndAskReuse({
        flow,
        who,
        landlordLineUserId: input.lineUserId,
        questionPublicId: flow.context.questionPublicId,
        answerText: `有條件：${value}`
      });
    }
    if (flow.stepCode === 'await_text_answer') {
      if (!value) return { handled: true, messages: [text('請輸入要回覆房客的文字。')] };
      return answerAndAskReuse({
        flow,
        who,
        landlordLineUserId: input.lineUserId,
        questionPublicId: flow.context.questionPublicId,
        answerText: value
      });
    }
    return { handled: false, messages: [] };
  }

  // 出價題的答案:存成只有系統看得到的議價規則,並依新規則回覆這位房客。
  // 不問「要不要沿用」—— 價格答案沿用給其他房客,等於公開房東的讓價。
  async function settleRentQuestion({ flow, who, landlordLineUserId, offer, rule, ruleText, landlordText, decision }) {
    if (rule) {
      await knowledge.saveConfirmedRule(db, {
        listingPublicId: flow.context.listingPublicId,
        createdByUserId: who.userId,
        originalText: ruleText,
        confirmedText: ruleText,
        ruleType: 'negotiation',
        ruleValue: rule,
        visibility: 'internal',
        usePolicy: 'negotiate_within_rule',
        createdAt: now().toISOString()
      });
    }
    const outcome = decision || negotiation.decideRentOffer({
      offered: offer.offered, listed: offer.listed,
      policy: { hasPolicy: true, unreadable: false, floor: rule.floorRentAmount ?? null, bargainAllowed: rule.bargainAllowed !== false },
      alreadyCountered: false
    });
    await negotiation.recordNegotiation(db, { ...offer, decision: outcome });
    const tenantText = negotiation.tenantReplyFor(outcome, offer);
    await knowledge.saveLandlordAnswer(db, {
      questionPublicId: flow.context.questionPublicId, landlordUserId: who.userId,
      answerText: tenantText, answeredAt: now().toISOString()
    });
    await flows.finishFlow(db, flow.publicId, 'completed', now());
    scheduleTenantNotice(offer.inquiryId, `房東已回覆你的出價：
${tenantText}`, landlordLineUserId);
    return { handled: true, messages: [text(landlordText)] };
  }

  // 三個分支(有條件／文字／是非)的動作完全一樣:寫答案、推進 flow、通知房客。
  // 通知排在兩次寫入都完成之後。
  async function answerAndAskReuse({ flow, who, landlordLineUserId, questionPublicId, answerText }) {
    const warning = await warningForLandlord(db, { questionPublicId, listingPublicId: flow.context.listingPublicId, text: answerText });
    if (warning) return { handled: true, messages: [text(warning)] };
    const answer = await knowledge.saveLandlordAnswer(db, {
      questionPublicId,
      landlordUserId: who.userId,
      answerText,
      answeredAt: now().toISOString()
    });
    await flows.advanceFlow(db, {
      publicId: flow.publicId,
      stepCode: 'confirm_reuse',
      listingId: flow.listingId,
      context: { ...flow.context, answerPublicId: answer.publicId },
      now: now()
    });
    scheduleTenantNotice(answer.inquiryId, `房東已回覆你的問題：\n${answerText}`, landlordLineUserId);
    return { handled: true, messages: [presenter.reuseConfirmationMessage(answer.publicId)] };
  }

  async function handlePostback(input) {
    if (!input.lineUserId) return { handled: false, messages: [] };
    const action = params(input.data);
    if (!action.action || !action.action.startsWith('knowledge_')) return { handled: false, messages: [] };
    const who = await identity(input.lineUserId, input.displayName);
    const flow = await flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow) return { handled: true, messages: [text('操作已逾時，請重新點選「AI知識庫」。')] };

    // 按鈕資料可以被改寫:房源要是自己的,回答的問題要是目前流程正在處理的那一題。
    // ponytail: 最多比對前 100 間房,房東超過再改成單筆查詢。
    if (action.listing && !(await knowledge.listLandlordListings(db, who.userId, { limit: 100 }))
      .some((listing) => listing.publicId === action.listing)) {
      return { handled: true, messages: [text('找不到這間房源，請重新點選「AI知識庫」。')] };
    }
    if (action.question && action.question !== flow.context.questionPublicId) {
      return { handled: true, messages: [text('這題已經不是目前要回答的問題，請重新點選「AI知識庫」。')] };
    }
    if (action.action === 'knowledge_change_listing') return openMenu(input);
    if (action.action === 'knowledge_cancel') {
      await flows.finishFlow(db, flow.publicId, 'cancelled', now());
      return { handled: true, messages: [text('已取消這次操作。')] };
    }

    if (action.action === 'knowledge_select_listing') {
      const summary = await knowledge.getListingKnowledgeSummary(db, action.listing);
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        listingId: summary.id,
        stepCode: 'listing_summary',
        context: { listingPublicId: summary.publicId },
        now: now()
      });
      return { handled: true, messages: [presenter.summaryCard(summary)] };
    }
    if (action.action === 'knowledge_add_rule') {
      const summary = await knowledge.getListingKnowledgeSummary(db, action.listing || flow.context.listingPublicId);
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        listingId: summary.id,
        stepCode: 'await_rule_text',
        context: { listingPublicId: summary.publicId },
        now: now()
      });
      return { handled: true, messages: [text('請直接告訴我這間房子的補充規則。輸入「取消」可離開。')] };
    }
    if (action.action === 'knowledge_pending') {
      const summary = await knowledge.getListingKnowledgeSummary(db, action.listing || flow.context.listingPublicId);
      const pending = await knowledge.listPendingQuestions(db, summary.id);
      if (!pending.length) return { handled: true, messages: [text('目前沒有待回答問題。')] };
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        listingId: summary.id,
        stepCode: 'answer_question',
        context: { listingPublicId: summary.publicId, questionPublicId: pending[0].publicId },
        now: now()
      });
      return { handled: true, messages: [presenter.pendingQuestionMessage(pending[0], 1, pending.length)] };
    }
    if (['knowledge_answer_yes', 'knowledge_answer_no'].includes(action.action)) {
      return answerAndAskReuse({
        flow,
        who,
        landlordLineUserId: input.lineUserId,
        questionPublicId: action.question,
        answerText: action.action === 'knowledge_answer_yes' ? '可以。' : '不可以。'
      });
    }
    if (['knowledge_rent_accept', 'knowledge_rent_no_bargain', 'knowledge_rent_floor'].includes(action.action)) {
      const offer = await negotiation.loadEscalatedOffer(db, action.question);
      if (!offer) return { handled: true, messages: [text('這題已經不是待回答的出價，請重新點選「AI知識庫」。')] };
      if (action.action === 'knowledge_rent_floor') {
        await flows.advanceFlow(db, {
          publicId: flow.publicId, stepCode: 'await_rent_floor', listingId: flow.listingId,
          context: { ...flow.context, questionPublicId: action.question }, now: now()
        });
        return { handled: true, messages: [text(`請輸入你能接受的最低月租（刊登 ${offer.listed} 元）。只有系統看得到，不會告訴房客。`)] };
      }
      if (action.action === 'knowledge_rent_accept') {
        return settleRentQuestion({ flow, who, landlordLineUserId: input.lineUserId, offer,
          decision: { outcome: 'accepted' },
          landlordText: `已同意這位房客每月 ${offer.offered} 元，只適用這一次，不會改變你之後的議價設定。` });
      }
      return settleRentQuestion({ flow, who, landlordLineUserId: input.lineUserId, offer,
        rule: { bargainAllowed: false }, ruleText: '不接受議價',
        landlordText: '已設定不接受殺價。之後低於刊登價的出價會直接婉拒。' });
    }
    if (action.action === 'knowledge_answer_conditional') {
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        stepCode: 'await_conditional_answer',
        listingId: flow.listingId,
        context: { ...flow.context, questionPublicId: action.question },
        now: now()
      });
      return { handled: true, messages: [text('可以，但有什麼條件？請直接輸入。')] };
    }
    if (action.action === 'knowledge_answer_text') {
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        stepCode: 'await_text_answer',
        listingId: flow.listingId,
        context: { ...flow.context, questionPublicId: action.question },
        now: now()
      });
      return { handled: true, messages: [text('請直接輸入你要回覆房客的內容。')] };
    }
    if (action.action === 'knowledge_answer_later') {
      await flows.finishFlow(db, flow.publicId, 'deferred', now());
      return { handled: true, messages: [text('問題已保留。想處理時請再點「AI知識庫」。')] };
    }
    if (action.action === 'knowledge_reuse_yes') {
      await knowledge.approveAnswerForReuse(db, {
        answerPublicId: action.answer,
        approvedByUserId: who.userId,
        approvedAt: now().toISOString()
      });
      await flows.finishFlow(db, flow.publicId, 'completed', now());
      return { handled: true, messages: [text('已保存，之後遇到相同問題可以直接回答。')] };
    }
    if (action.action === 'knowledge_reuse_no') {
      await flows.finishFlow(db, flow.publicId, 'completed', now());
      return { handled: true, messages: [text('已保存答案；之後遇到相同問題仍會先詢問你。')] };
    }
    if (action.action === 'knowledge_rule_retry') {
      await flows.advanceFlow(db, {
        publicId: flow.publicId,
        stepCode: 'await_rule_text',
        listingId: flow.listingId,
        context: { listingPublicId: flow.context.listingPublicId },
        now: now()
      });
      return { handled: true, messages: [text('請重新輸入要補充的規則。')] };
    }
    if (['knowledge_rule_direct', 'knowledge_rule_ask'].includes(action.action)) {
      if (action.flow !== flow.publicId || !flow.context.normalized || !flow.context.candidate) {
        return { handled: true, messages: [text('這個操作已失效，請重新輸入規則。')] };
      }
      const direct = action.action === 'knowledge_rule_direct';
      const warning = await warningForLandlord(db, { listingPublicId: flow.context.listingPublicId, text: flow.context.normalized.originalText });
      if (warning) {
        await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'await_rule_text', listingId: flow.listingId,
          context: { listingPublicId: flow.context.listingPublicId }, now: now() });
        return { handled: true, messages: [text(warning)] };
      }
      await knowledge.saveConfirmedRule(db, {
        listingPublicId: flow.context.listingPublicId,
        createdByUserId: who.userId,
        originalText: flow.context.normalized.originalText,
        confirmedText: flow.context.candidate.content,
        ruleType: flow.context.candidate.ruleType,
        visibility: 'public',
        usePolicy: direct ? 'answer_directly' : 'must_escalate',
        adapter: flow.context.normalized.adapter,
        createdAt: now().toISOString()
      });
      await flows.finishFlow(db, flow.publicId, 'completed', now());
      return {
        handled: true,
        messages: [text(direct
          ? '已加入知識庫，之後可直接回答。'
          : '已加入知識庫，遇到相關問題會先詢問你。')]
      };
    }
    return { handled: true, messages: [text('無法辨識這個操作，請重新點選「AI知識庫」。')] };
  }

  return { handlePostback, handleText };
}

// 同步版的 export 名稱是 createLandlordKnowledgeLineService,兩邊在不同模組裡,
// 所以同時給原名與 Async 別名:呼叫端換 require 路徑就能切換,不用改呼叫程式碼。
module.exports = {
  createLandlordKnowledgeLineService: createLandlordKnowledgeLineServiceAsync,
  createLandlordKnowledgeLineServiceAsync
};
