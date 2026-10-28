const { findOrCreateLineUser } = require('../repositories/v2InquiryRepository');
const knowledge = require('../repositories/v2LandlordKnowledgeRepository');
const flows = require('../repositories/v2LineFlowRepository');
const presenter = require('./landlordKnowledgeLinePresenter');
const { normalizeRuleInput } = require('./landlordRuleNormalizer');
const { notifyTenantOfLandlordReply } = require('./tenantNotificationService');

function params(value) {
  return Object.fromEntries(new URLSearchParams(String(value || '')).entries());
}

function text(message) { return { type: 'text', text: message }; }

function createLandlordKnowledgeLineService({ db, now = () => new Date() }) {
  function identity(lineUserId, displayName) {
    return findOrCreateLineUser(db, { lineUserId, displayName });
  }

  function openMenu(input) {
    const who = identity(input.lineUserId, input.displayName);
    flows.cancelFlow(db, who.lineIdentityId, now());
    flows.startFlow(db, { lineIdentityId: who.lineIdentityId, stepCode: 'select_listing', now: now() });
    return { handled: true, messages: [presenter.listingCarousel(knowledge.listDemoListings(db, { limit: 10 }))] };
  }

  function handleText(input) {
    const value = String(input.text || '').trim();
    const compactValue = value.replace(/\s+/g, '');
    if (compactValue === 'AI\u77e5\u8b58\u5eab' || ['AI知識庫', '待回答問題'].includes(value)) return openMenu(input);
    if (!input.lineUserId) return { handled: false, messages: [] };
    const who = identity(input.lineUserId, input.displayName);
    const flow = flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow) return { handled: false, messages: [] };
    if (value === '取消') {
      flows.finishFlow(db, flow.publicId, 'cancelled', now());
      return { handled: true, messages: [text('已取消這次操作。')] };
    }
    if (flow.stepCode === 'await_rule_text') {
      try {
        const normalized = normalizeRuleInput(value);
        const candidate = normalized.candidates[0];
        flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'confirm_rule', listingId: flow.listingId,
          context: { ...flow.context, normalized, candidate }, now: now() });
        return { handled: true, messages: [presenter.ruleConfirmationMessage(candidate, flow.publicId)] };
      } catch (error) {
        return { handled: true, messages: [text(error.message)] };
      }
    }
    if (flow.stepCode === 'await_conditional_answer') {
      if (!value) return { handled: true, messages: [text('請輸入允許的條件。')] };
      const answer = knowledge.saveLandlordAnswer(db, { questionPublicId: flow.context.questionPublicId,
        landlordUserId: who.userId, answerText: `有條件：${value}`, answeredAt: now().toISOString() });
      notifyTenantOfLandlordReply(answer.inquiryId, `房東已回覆你的問題：\n有條件：${value}`, input.lineUserId).catch(err => console.error(err.message));
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'confirm_reuse', listingId: flow.listingId,
        context: { ...flow.context, answerPublicId: answer.publicId }, now: now() });
      return { handled: true, messages: [presenter.reuseConfirmationMessage(answer.publicId)] };
    }
    if (flow.stepCode === 'await_text_answer') {
      if (!value) return { handled: true, messages: [text('請輸入要回覆房客的文字。')] };
      const answer = knowledge.saveLandlordAnswer(db, { questionPublicId: flow.context.questionPublicId,
        landlordUserId: who.userId, answerText: value, answeredAt: now().toISOString() });
      notifyTenantOfLandlordReply(answer.inquiryId, `房東已回覆你的問題：\n${value}`, input.lineUserId).catch(err => console.error(err.message));
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'confirm_reuse', listingId: flow.listingId,
        context: { ...flow.context, answerPublicId: answer.publicId }, now: now() });
      return { handled: true, messages: [presenter.reuseConfirmationMessage(answer.publicId)] };
    }
    return { handled: false, messages: [] };
  }

  function handlePostback(input) {
    if (!input.lineUserId) return { handled: false, messages: [] };
    const action = params(input.data);
    if (!action.action || !action.action.startsWith('knowledge_')) return { handled: false, messages: [] };
    const who = identity(input.lineUserId, input.displayName);
    const flow = flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow) return { handled: true, messages: [text('操作已逾時，請重新點選「AI知識庫」。')] };

    if (action.action === 'knowledge_change_listing') return openMenu(input);
    if (action.action === 'knowledge_cancel') {
      flows.finishFlow(db, flow.publicId, 'cancelled', now());
      return { handled: true, messages: [text('已取消這次操作。')] };
    }

    if (action.action === 'knowledge_select_listing') {
      const summary = knowledge.getListingKnowledgeSummary(db, action.listing);
      flows.advanceFlow(db, { publicId: flow.publicId, listingId: summary.id, stepCode: 'listing_summary',
        context: { listingPublicId: summary.publicId }, now: now() });
      return { handled: true, messages: [presenter.summaryCard(summary)] };
    }
    if (action.action === 'knowledge_add_rule') {
      const summary = knowledge.getListingKnowledgeSummary(db, action.listing || flow.context.listingPublicId);
      flows.advanceFlow(db, { publicId: flow.publicId, listingId: summary.id, stepCode: 'await_rule_text',
        context: { listingPublicId: summary.publicId }, now: now() });
      return { handled: true, messages: [text('請直接告訴我這間房子的補充規則。輸入「取消」可離開。')] };
    }
    if (action.action === 'knowledge_pending') {
      const summary = knowledge.getListingKnowledgeSummary(db, action.listing || flow.context.listingPublicId);
      const pending = knowledge.listPendingQuestions(db, summary.id);
      if (!pending.length) return { handled: true, messages: [text('目前沒有待回答問題。')] };
      flows.advanceFlow(db, { publicId: flow.publicId, listingId: summary.id, stepCode: 'answer_question',
        context: { listingPublicId: summary.publicId, questionPublicId: pending[0].publicId }, now: now() });
      return { handled: true, messages: [presenter.pendingQuestionMessage(pending[0], 1, pending.length)] };
    }
    if (['knowledge_answer_yes', 'knowledge_answer_no'].includes(action.action)) {
      const answerText = action.action === 'knowledge_answer_yes' ? '可以。' : '不可以。';
      const answer = knowledge.saveLandlordAnswer(db, { questionPublicId: action.question,
        landlordUserId: who.userId, answerText, answeredAt: now().toISOString() });
      notifyTenantOfLandlordReply(answer.inquiryId, `房東已回覆你的問題：\n${answerText}`, input.lineUserId).catch(err => console.error(err.message));
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'confirm_reuse', listingId: flow.listingId,
        context: { ...flow.context, answerPublicId: answer.publicId }, now: now() });
      return { handled: true, messages: [presenter.reuseConfirmationMessage(answer.publicId)] };
    }
    if (action.action === 'knowledge_answer_conditional') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'await_conditional_answer', listingId: flow.listingId,
        context: { ...flow.context, questionPublicId: action.question }, now: now() });
      return { handled: true, messages: [text('可以，但有什麼條件？請直接輸入。')] };
    }
    if (action.action === 'knowledge_answer_text') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'await_text_answer', listingId: flow.listingId,
        context: { ...flow.context, questionPublicId: action.question }, now: now() });
      return { handled: true, messages: [text('請直接輸入你要回覆房客的內容。')] };
    }
    if (action.action === 'knowledge_answer_later') {
      flows.finishFlow(db, flow.publicId, 'deferred', now());
      return { handled: true, messages: [text('問題已保留。想處理時請再點「AI知識庫」。')] };
    }
    if (action.action === 'knowledge_reuse_yes') {
      knowledge.approveAnswerForReuse(db, { answerPublicId: action.answer, approvedByUserId: who.userId,
        approvedAt: now().toISOString() });
      flows.finishFlow(db, flow.publicId, 'completed', now());
      return { handled: true, messages: [text('已保存，之後遇到相同問題可以直接回答。')] };
    }
    if (action.action === 'knowledge_reuse_no') {
      flows.finishFlow(db, flow.publicId, 'completed', now());
      return { handled: true, messages: [text('已保存答案；之後遇到相同問題仍會先詢問你。')] };
    }
    if (action.action === 'knowledge_rule_retry') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'await_rule_text', listingId: flow.listingId,
        context: { listingPublicId: flow.context.listingPublicId }, now: now() });
      return { handled: true, messages: [text('請重新輸入要補充的規則。')] };
    }
    if (['knowledge_rule_direct', 'knowledge_rule_ask'].includes(action.action)) {
      if (action.flow !== flow.publicId || !flow.context.normalized || !flow.context.candidate) {
        return { handled: true, messages: [text('這個操作已失效，請重新輸入規則。')] };
      }
      knowledge.saveConfirmedRule(db, { listingPublicId: flow.context.listingPublicId,
        createdByUserId: who.userId, originalText: flow.context.normalized.originalText,
        confirmedText: flow.context.candidate.content, ruleType: flow.context.candidate.ruleType,
        visibility: 'public', usePolicy: action.action === 'knowledge_rule_direct' ? 'answer_directly' : 'must_escalate',
        adapter: flow.context.normalized.adapter, createdAt: now().toISOString() });
      flows.finishFlow(db, flow.publicId, 'completed', now());
      return { handled: true, messages: [text(action.action === 'knowledge_rule_direct'
        ? '已加入知識庫，之後可直接回答。' : '已加入知識庫，遇到相關問題會先詢問你。')] };
    }
    return { handled: true, messages: [text('無法辨識這個操作，請重新點選「AI知識庫」。')] };
  }

  return { handlePostback, handleText };
}

module.exports = { createLandlordKnowledgeLineService };
