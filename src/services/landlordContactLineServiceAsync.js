const { findOrCreateLineUser, saveInquiryMessage } = require('../repositories/v2InquiryRepositoryAsync');
const contactRepo = require('../repositories/v2LandlordContactRepositoryAsync');
const knowledge = require('../repositories/v2LandlordKnowledgeRepositoryAsync');
const flows = require('../repositories/v2LineFlowRepositoryAsync');
const presenter = require('./landlordContactLinePresenter');
const { notifyTenantOfLandlordReply } = require('./tenantNotificationService');

function params(value) {
  return Object.fromEntries(new URLSearchParams(String(value || '')).entries());
}

function text(message) { return { type: 'text', text: message }; }

function createLandlordContactLineServiceAsync({ db, now = () => new Date() }) {
  async function identity(lineUserId, displayName) {
    return await findOrCreateLineUser(db, { lineUserId, displayName });
  }

  async function handleText(input) {
    const value = String(input.text || '').trim();
    
    // Entry points
    if (value === '房客訊息' || value === '聯絡房客') {
      const who = await identity(input.lineUserId, input.displayName);
      await flows.cancelFlow(db, who.lineIdentityId, now());
      await flows.startFlow(db, { lineIdentityId: who.lineIdentityId, stepCode: 'tenant_message_menu', now: now() });
      return { handled: true, messages: [presenter.mainMenu()] };
    }

    if (!input.lineUserId) return { handled: false, messages: [] };
    const who = await identity(input.lineUserId, input.displayName);
    const flow = await flows.getActiveFlow(db, who.lineIdentityId, now());
    
    // 全域取消 (Global Cancel)
    if (value === '取消') {
      if (flow) {
        await flows.finishFlow(db, flow.publicId, 'cancelled', now());
        return { handled: true, messages: [text('已取消目前的操作流程。')] };
      }
      return { handled: false, messages: [] };
    }

    if (!flow) return { handled: false, messages: [] };

    // Await states
    if (flow.stepCode === 'await_tenant_message_reply') {
      if (!value) return { handled: true, messages: [text('請輸入要回覆房客的文字。')] };
      if (!flow.context.questionPublicId) {
        await flows.finishFlow(db, flow.publicId, 'error', now());
        return { handled: true, messages: [text('找不到要回覆的問題，請重新從「房客訊息」開始操作。')] };
      }

      try {
        let answer;
        if (flow.context.answerPublicId) {
          // This is a retry reply! Update the existing answer instead of creating a new one.
          await contactRepo.updateLandlordAnswer(db, flow.context.answerPublicId, value);
          answer = { publicId: flow.context.answerPublicId, inquiryId: flow.context.inquiryId };
        } else {
          // This is a new reply!
          answer = await knowledge.saveLandlordAnswer(db, {
            questionPublicId: flow.context.questionPublicId,
            landlordUserId: who.userId,
            answerText: value,
            answeredAt: now().toISOString()
          });
          // note: await knowledge.saveLandlordAnswer already marks landlord_questions as answered.
        }

        if (answer.inquiryId) {
          await notifyTenantOfLandlordReply(answer.inquiryId, `房東已回覆你的問題：\n${value}`, input.lineUserId).catch(err => {
            console.error('Failed to notify tenant:', err.message);
          });
        }
        
        await flows.advanceFlow(db, {
          publicId: flow.publicId,
          stepCode: 'confirm_save_kb',
          listingId: flow.listingId,
          context: { ...flow.context, answerPublicId: answer.publicId, inquiryId: answer.inquiryId },
          now: now()
        });

        return {
          handled: true,
          messages: [
            text('已送出回覆給房客。'),
            presenter.askSaveToKnowledgeCard(flow.context.questionPublicId)
          ]
        };
      } catch (error) {
        console.error('await_tenant_message_reply error:', error.message, 'questionPublicId:', flow.context.questionPublicId);
        return { handled: true, messages: [text('回覆暫時無法送出，請稍後再試。')] };
      }
    }

    if (flow.stepCode === 'await_proactive_message') {
      if (!value) return { handled: true, messages: [text('請輸入要傳給房客的訊息。')] };
      await saveInquiryMessage(db, {
        inquiryId: flow.context.inquiryId,
        senderUserId: who.userId,
        senderLineIdentityId: who.lineIdentityId,
        direction: 'outbound',
        messageType: 'text',
        textContent: value
      });
      await notifyTenantOfLandlordReply(flow.context.inquiryId, `房東傳來訊息：\n${value}`, input.lineUserId).catch(err => console.error(err.message));
      await flows.finishFlow(db, flow.publicId, 'completed', now());
      return { handled: true, messages: [text('已成功發送訊息給該房客。')] };
    }

    return { handled: false, messages: [] };
  }

  async function handlePostback(input) {
    if (!input.lineUserId) return { handled: false, messages: [] };
    const action = params(input.data);
    if (!action.action || !(action.action.startsWith('tenant_message_') || action.action.startsWith('landlord_contact_'))) {
      return { handled: false, messages: [] };
    }

    const who = await identity(input.lineUserId, input.displayName);
    
    // Actions that can be performed even if flow expired
    if (action.action === 'tenant_message_return_main') {
      await flows.cancelFlow(db, who.lineIdentityId, now());
      await flows.startFlow(db, { lineIdentityId: who.lineIdentityId, stepCode: 'tenant_message_menu', now: now() });
      return { handled: true, messages: [presenter.mainMenu()] };
    }

    if (action.action === 'tenant_message_finish') {
      const existingFlow = await flows.getActiveFlow(db, who.lineIdentityId, now());
      if (existingFlow) {
        await flows.finishFlow(db, existingFlow.publicId, 'completed', now());
      }
      return { handled: true, messages: [text('已結束本次操作。')] };
    }

    const flow = await flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow) return { handled: true, messages: [text('操作已逾時，請重新操作。')] };

    // Main Menu Workflows
    if (action.action === 'tenant_message_start') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'tenant_message_select_listing', listingId: null, now: now() });
      const listings = contactRepo.listLandlordListingsWithPendingQuestions(db, who.userId, { limit: 10 });
      const finalResult = listings.length > 0 ? listings :
        (String(process.env.LANDLORD_KNOWLEDGE_DEMO_ENABLED).toLowerCase() === 'true' ? contactRepo.listDemoListingsWithPendingQuestions(db, { limit: 10 }) : []);
      if (finalResult.length === 0) return { handled: true, messages: [text('目前沒有待回覆的房客訊息。')] };
      return { handled: true, messages: [presenter.listingCarousel(finalResult, 'tenant_message_select_listing')] };
    }

    if (action.action === 'landlord_contact_start') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'landlord_contact_select_listing', listingId: null, now: now() });
      const listings = contactRepo.listLandlordListings(db, who.userId, { limit: 10 });
      const finalResult = listings.length > 0 ? listings :
        (String(process.env.LANDLORD_KNOWLEDGE_DEMO_ENABLED).toLowerCase() === 'true' ? contactRepo.listDemoListings(db, { limit: 10 }) : []);
      if (finalResult.length === 0) return { handled: true, messages: [text('找不到您管理的房源，無法聯絡房客。')] };
      return { handled: true, messages: [presenter.listingCarousel(finalResult, 'landlord_contact_select_listing')] };
    }

    if (action.action === 'tenant_message_history_start') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'tenant_message_history_select_listing', listingId: null, now: now() });
      const listings = contactRepo.listLandlordListings(db, who.userId, { limit: 10 });
      const finalResult = listings.length > 0 ? listings :
        (String(process.env.LANDLORD_KNOWLEDGE_DEMO_ENABLED).toLowerCase() === 'true' ? contactRepo.listDemoListings(db, { limit: 10 }) : []);
      if (finalResult.length === 0) return { handled: true, messages: [text('找不到您管理的房源，無法查看聯絡紀錄。')] };
      return { handled: true, messages: [presenter.listingCarousel(finalResult, 'tenant_message_history_select_listing')] };
    }

    // 查看聯絡紀錄 Workflow
    if (action.action === 'tenant_message_history_select_listing') {
      const historyRows = contactRepo.getListingContactHistory(db, action.listing, 100);
      
      let listingTitle = '房源';
      const allListings = contactRepo.listLandlordListings(db, who.userId, { limit: 10 });
      const match = allListings.find(l => l.publicId === action.listing);
      if (match) { listingTitle = match.title; }
      else if (String(process.env.LANDLORD_KNOWLEDGE_DEMO_ENABLED).toLowerCase() === 'true') {
        const demoMatch = contactRepo.listDemoListings(db, { limit: 10 }).find(l => l.publicId === action.listing);
        if (demoMatch) listingTitle = demoMatch.title;
      }
      const pendingQuestions = contactRepo.listPendingQuestions(db, action.listing);
      const pendingQuestionCount = pendingQuestions.length;
      
      await flows.finishFlow(db, flow.publicId, 'completed', now());
      return { 
        handled: true, 
        messages: [presenter.contactHistoryMessage(historyRows, listingTitle, true, pendingQuestionCount)],
        fallbackMessages: [
          text('系統暫時無法顯示卡片，已改用文字版聯絡紀錄。'),
          presenter.contactHistoryTextMessage(historyRows, listingTitle, true, pendingQuestionCount)
        ]
      };
    }

    // 房客訊息 Workflow
    if (action.action === 'tenant_message_select_listing') {
      const pendingQuestions = contactRepo.listPendingQuestions(db, action.listing);
      if (pendingQuestions.length === 0) {
        return { handled: true, messages: [text('此房源目前沒有待回覆的問題。')] };
      }
      const firstQ = pendingQuestions[0];
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'tenant_message_viewing', listingId: firstQ.listingId,
        context: { listingPublicId: action.listing, questionIndex: 0 }, now: now() });
      return { handled: true, messages: [presenter.pendingQuestionCard(firstQ, 1, pendingQuestions.length)] };
    }
    
    if (action.action === 'tenant_message_reply') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'await_tenant_message_reply', listingId: flow.listingId,
        context: { ...flow.context, questionPublicId: action.question }, now: now() });
      return { handled: true, messages: [text('請直接輸入你要回覆房客的內容。')] };
    }

    if (action.action === 'tenant_message_later' || action.action === 'tenant_message_next') {
      const pendingQuestions = contactRepo.listPendingQuestions(db, flow.context.listingPublicId);
      const nextIndex = (flow.context.questionIndex || 0) + 1;
      
      if (nextIndex >= pendingQuestions.length) {
        await flows.finishFlow(db, flow.publicId, 'completed', now());
        return { handled: true, messages: [text('已經沒有下一題了。')] };
      }
      
      const nextQ = pendingQuestions[nextIndex];
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'tenant_message_viewing', listingId: flow.listingId,
        context: { ...flow.context, questionIndex: nextIndex }, now: now() });
      return { handled: true, messages: [presenter.pendingQuestionCard(nextQ, nextIndex + 1, pendingQuestions.length)] };
    }

    if (action.action === 'tenant_message_save_kb') {
      knowledge.approveAnswerForReuse(db, { answerPublicId: flow.context.answerPublicId || action.question, approvedByUserId: who.userId,
        approvedAt: now().toISOString() });
      
      const pendingQuestions = contactRepo.listPendingQuestions(db, flow.context.listingPublicId || flow.listingId);
      const hasMore = pendingQuestions.length > 0;
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'tenant_message_after_reply_menu', listingId: flow.listingId,
        context: { ...flow.context, questionIndex: 0 }, now: now() });
      return { handled: true, messages: [presenter.afterReplyMenu(hasMore)] };
    }

    if (action.action === 'tenant_message_skip_kb') {
      const pendingQuestions = contactRepo.listPendingQuestions(db, flow.context.listingPublicId || flow.listingId);
      const hasMore = pendingQuestions.length > 0;
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'tenant_message_after_reply_menu', listingId: flow.listingId,
        context: { ...flow.context, questionIndex: 0 }, now: now() });
      return { handled: true, messages: [presenter.afterReplyMenu(hasMore)] };
    }

    if (action.action === 'tenant_message_next_after_reply') {
      const pendingQuestions = contactRepo.listPendingQuestions(db, flow.context.listingPublicId || flow.listingId);
      if (pendingQuestions.length === 0) {
        return { handled: true, messages: [presenter.afterReplyMenu(false)] };
      }
      const nextQ = pendingQuestions[0];
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'tenant_message_viewing', listingId: flow.listingId,
        context: { ...flow.context, questionIndex: 0, questionPublicId: nextQ.publicId, answerPublicId: null }, now: now() });
      return { handled: true, messages: [presenter.pendingQuestionCard(nextQ, 1, pendingQuestions.length)] };
    }



    if (action.action === 'tenant_message_retry_reply') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'await_tenant_message_reply', listingId: flow.listingId,
        context: { ...flow.context }, now: now() });
      return { handled: true, messages: [text('請重新輸入要回覆房客的內容。\n送出後會更新上一則回覆。')] };
    }

    // 聯絡房客 Workflow
    if (action.action === 'landlord_contact_select_listing') {
      const tenants = contactRepo.listTenantsForListing(db, action.listing);
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'landlord_contact_select_tenant', listingId: null, // need internal ID if strict, null is ok for simple flows
        context: { listingPublicId: action.listing }, now: now() });
      return { handled: true, messages: [presenter.tenantSelectionMessage(tenants)] };
    }

    if (action.action === 'landlord_contact_select_tenant') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'await_proactive_message', listingId: flow.listingId,
        context: { ...flow.context, inquiryId: action.inquiry }, now: now() });
      return { handled: true, messages: [text('請輸入你要傳給該房客的文字訊息：')] };
    }

    return { handled: false, messages: [] };
  }

  return { handleText, handlePostback };
}

module.exports = { createLandlordContactLineServiceAsync };
