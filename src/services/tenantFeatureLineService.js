const FEATURE_LABELS = {
  '\u623f\u5ba2\u529f\u80fd1': '\u79df\u5c4b\u901a\u77e5',
  '\u623f\u5ba2\u529f\u80fd2': '\u4e00\u9375\u5831\u4fee',
  '\u623f\u5ba2\u529f\u80fd3': '\u806f\u7d61\u623f\u6771',
  '\u623f\u5ba2\u529f\u80fd4': '\u5c4b\u6cc1\u9ede\u4ea4',
  '\u623f\u5ba2\u529f\u80fd5': '\u5e33\u55ae\u4e2d\u5fc3',
  '\u623f\u5ba2\u529f\u80fd6': '\u5ba2\u670d\u5354\u52a9',
  '\u623f\u5ba2\u529f\u80fd7': '\u79df\u5c4b\u7d00\u9304',
  '\u79df\u5c4b\u901a\u77e5': '\u79df\u5c4b\u901a\u77e5',
  '\u4e00\u9375\u5831\u4fee': '\u4e00\u9375\u5831\u4fee',
  '\u4e00\u4ef6\u5831\u4fee': '\u4e00\u9375\u5831\u4fee',
  '新增報修': '新增報修',
  '報修上傳': '新增報修',
  '報修進度': '報修進度',
  '查看報修': '報修進度',
  '報修歷史': '報修歷史',
  '修繕歷史': '報修歷史',
  '維修歷史': '報修歷史',
  '\u806f\u7d61\u623f\u6771': '\u806f\u7d61\u623f\u6771',
  '\u9023\u7d61\u623f\u6771': '\u806f\u7d61\u623f\u6771',
  '\u806f\u7d61\u623f\u5ba2': '\u806f\u7d61\u623f\u5ba2',
  '\u9023\u7d61\u623f\u5ba2': '\u806f\u7d61\u623f\u5ba2',
  '\u5c4b\u6cc1\u9ede\u4ea4': '\u5c4b\u6cc1\u9ede\u4ea4',
  '\u5e33\u55ae\u4e2d\u5fc3': '\u5e33\u55ae\u4e2d\u5fc3',
  '\u5ba2\u670d\u5354\u52a9': '\u5ba2\u670d\u5354\u52a9',
  '\u79df\u5c4b\u7d00\u9304': '\u79df\u5c4b\u7d00\u9304',
  '\u901a\u77e5\u6e2c\u8a66': '\u901a\u77e5\u6e2c\u8a66',
  '找房紀錄': '\u79df\u5c4b\u7d00\u9304',
  // 房東端入口。看房時段與房源規則是同一個管理頁的兩個分頁,三種說法都導到同一處。
  '看房時段': '房東管理台',
  '房源規則': '房東管理台',
  '房東管理台': '房東管理台',
  // 續約——房東房客都可能觸發,誰能對哪一題動作由 v2RenewalServiceAsync 內部的角色檢查決定,
  // 不在這裡判斷身分。
  '續約租約': '續約租約',
  '續約': '續約租約',
};

const FEATURE_REPLIES = {
  '\u79df\u5c4b\u901a\u77e5': [
    '\u79df\u5c4b\u901a\u77e5',
    '\u76ee\u524d\u6703\u5148\u4fdd\u7559\u4f60\u7684\u901a\u77e5\u5165\u53e3\u3002\u4e4b\u5f8c\u9019\u88e1\u6703\u6574\u5408\u770b\u5c4b\u3001\u7e73\u79df\u3001\u5408\u7d04\u5230\u671f\u3001\u5831\u4fee\u9032\u5ea6\u7b49\u63d0\u9192\u3002',
  ].join('\n'),
  '\u4e00\u9375\u5831\u4fee': [
    '\u4e00\u9375\u5831\u4fee',
    '\u8acb\u76f4\u63a5\u63cf\u8ff0\u8981\u5831\u4fee\u7684\u9805\u76ee\uff0c\u4f8b\u5982\uff1a\u300c\u51b7\u6c23\u4e0d\u51b7\u300d\u3001\u300c\u6c34\u9f8d\u982d\u6f0f\u6c34\u300d\uff0c\u4e5f\u53ef\u4ee5\u88dc\u5145\u7167\u7247\u6216\u5f71\u7247\u3002',
    '\u76ee\u524d\u5f8c\u7aef\u5df2\u6709\u5831\u4fee\u8cc7\u6599\u8868\uff0cLINE \u5831\u4fee\u6d41\u7a0b\u6703\u63a5\u5728\u9019\u500b\u5165\u53e3\u3002',
  ].join('\n'),
  '\u806f\u7d61\u623f\u6771': [
    '\u806f\u7d61\u623f\u6771',
    '\u6211\u6703\u628a\u9019\u88e1\u4f5c\u70ba\u623f\u5ba2\u806f\u7d61\u623f\u6771\u6216\u7ba1\u7406\u65b9\u7684\u5165\u53e3\u3002\u6b63\u5f0f\u6d41\u7a0b\u6703\u4f9d\u76ee\u524d\u79df\u7d04\u6216\u8a62\u554f\u4e2d\u7684\u623f\u6e90\u627e\u5230\u5c0d\u61c9\u623f\u6771\u3002',
  ].join('\n'),
  '\u5c4b\u6cc1\u9ede\u4ea4': [
    '\u5c4b\u6cc1\u9ede\u4ea4',
    '\u9019\u88e1\u6703\u7528\u4f86\u505a\u5165\u4f4f\uff0f\u9000\u79df\u9ede\u4ea4\u3001\u7167\u7247\u7d00\u9304\u8207\u96d9\u65b9\u78ba\u8a8d\u3002\u73fe\u5728\u5148\u4f5c\u70ba\u9ede\u4ea4\u5165\u53e3\u4fdd\u7559\u3002',
  ].join('\n'),
  '\u5e33\u55ae\u4e2d\u5fc3': [
    '\u5e33\u55ae\u4e2d\u5fc3',
    '\u9019\u88e1\u6703\u986f\u793a\u79df\u91d1\u3001\u7ba1\u7406\u8cbb\u3001\u6c34\u96fb\u8207\u4ed8\u6b3e\u7d00\u9304\u3002\u6b63\u5f0f\u5e33\u55ae\u67e5\u8a62\u6703\u4f9d\u4f60\u7684\u79df\u7d04\u8eab\u5206\u8f09\u5165\u3002',
  ].join('\n'),
  '\u5ba2\u670d\u5354\u52a9': [
    '\u5ba2\u670d\u5354\u52a9',
    '\u8acb\u8f38\u5165\u4f60\u9700\u8981\u5354\u52a9\u7684\u554f\u984c\uff0c\u6211\u6703\u5148\u8a18\u9304\u4e26\u5f15\u5c0e\u5230\u5c0d\u61c9\u529f\u80fd\uff1b\u672a\u4f86\u6703\u63a5\u5e38\u898b\u554f\u984c\u8207\u4eba\u5de5\u5354\u52a9\u3002',
  ].join('\n'),
  '\u79df\u5c4b\u7d00\u9304': [
    '\u79df\u5c4b\u7d00\u9304',
    '\u9019\u88e1\u6703\u6574\u7406\u4f60\u770b\u904e\u3001\u8a62\u554f\u4e2d\u3001\u7533\u8acb\u4e2d\u8207\u5df2\u627f\u79df\u7684\u623f\u6e90\u7d00\u9304\u3002\u6b63\u5f0f\u6d41\u7a0b\u6703\u4f9d LINE \u8eab\u5206\u8f09\u5165\u3002',
  ].join('\n'),
};

function normalizeText(value) {
  return String(value || '').trim();
}

function featureLabel(text) {
  return FEATURE_LABELS[normalizeText(text)] || null;
}

function urgentRepairContactTicketId(text) {
  const match = /^緊急報修聯絡房東\s*[:：]?\s*(repair-[a-z0-9-]+)\s*$/i.exec(normalizeText(text));
  return match ? match[1] : null;
}

async function handleActiveRenewalConditionInput({ lineUserId, text }) {
  const { withV2Driver } = require('../database/v2Driver');
  const sessionRepository = require('../repositories/v2RenewalLineSessionRepositoryAsync');
  const renewalRepository = require('../repositories/v2RenewalRepositoryAsync');
  const draftService = require('./v2RenewalConditionDraftService');
  const presenter = require('./v2RenewalLinePresenter');
  const session = await withV2Driver((db) => sessionRepository.getActive(db, lineUserId));
  if (!session) return { handled: false, messages: [] };
  const purpose = sessionRepository.purposeFrom(session);
  const isTenantChange = purpose === 'tenant_change' || purpose === 'tenant_initial';
  if (['取消', '取消編輯'].includes(normalizeText(text))) {
    await withV2Driver((db) => sessionRepository.finish(db, { publicId: session.publicId, reason: 'cancelled' }));
    return {
      handled: true,
      messages: isTenantChange
        ? [{ type: 'text', text: '已取消輸入，尚未將修改條件送給房東。' }]
        : [{ type: 'text', text: '已取消編輯，尚未將續約方案送給房客。' }, presenter.landlordRenewalMenuCard()]
    };
  }
  const summary = await withV2Driver((db) => renewalRepository.getRenewalRequestSummary(
    db, session.renewalRequestPublicId
  ));
  const parsedDraft = draftService.parseWithDiagnostics({
    text,
    currentRentAmount: summary.rentAmount,
    currentDepositAmount: summary.depositAmount,
    currentStartDate: summary.startDate,
    currentEndDate: summary.endDate
  });
  const draft = parsedDraft.draft;
  if (!draft) {
    return {
      handled: true,
      messages: [{
        type: 'text',
        text: parsedDraft.error || '我還無法整理這組條件。請用一句話包含租金與需要調整的內容，例如：「月租 20000，押金 40000，租期 2026-11-27 到 2027-11-26」。'
      }]
    };
  }
  await withV2Driver((db) => sessionRepository.saveDraft(db, {
    publicId: session.publicId, inputText: text, draft: { ...draft, _purpose: purpose }
  }));
  return {
    handled: true,
    messages: [presenter.renewalCustomDraftCard({
      sessionPublicId: session.publicId,
      propertyLabel: summary.propertyLabel,
      draft,
      actorRole: isTenantChange ? 'tenant' : 'landlord'
    })]
  };
}

function isTenantFeatureCommand(text) {
  return Boolean(featureLabel(text) || urgentRepairContactTicketId(text));
}

function miniAppUrl(path) {
  const liffId = process.env.LIFF_ID || process.env.LINE_LIFF_ID || '';
  if (liffId && liffId !== 'your_line_liff_app_id' && !liffId.includes('placeholder') && liffId.trim() !== '') {
    return `https://miniapp.line.me/${liffId.trim()}${path}`;
  }
  const baseUrl = process.env.WEB_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function getFindHousesLiffUrl() {
  return miniAppUrl('/findHouses');
}

function getLandlordManageLiffUrl() {
  return miniAppUrl('/landlordManage');
}

const {
  handlePreInspectionCommand,
  handleContactLandlord,
  handleActiveSessionInput,
  handlePostback: handlePreInspectionPostback
} = require('./preInspectionLineService');
const { confirmedShowingCard } = require('./showingAppointmentLinePresenter');

const {
  handleTenantNotification,
  handleTenantNotificationHistory,
  handleTenantNotificationTestMenu,
  handleTenantNotificationSingle
} = require('./tenantNotificationService');
const {
  handleRepairCommand,
  handleRepairHistoryCommandConfigured,
  handleRepairPostback,
  handleRepairProgressCommandConfigured,
  handleRepairStartCommand,
  handleUrgentRepairContact,
  handleTenantRepairPostback,
} = require('./tenantRepairLineService');

async function handleTenantFeatureText(input = {}) {
  const urgentTicketPublicId = urgentRepairContactTicketId(input.text);
  if (urgentTicketPublicId) {
    return handleUrgentRepairContact({
      lineUserId: input.lineUserId,
      ticketPublicId: urgentTicketPublicId,
      lineClient: input.lineClient,
    });
  }
  const label = featureLabel(input.text);

  if (!label) {
    return { handled: false, messages: [] };
  }

  if (label === '聯絡房東') {
    return await handleContactLandlord(input.lineUserId);
  }

  if (label === '聯絡房客') {
    return {
      handled: true,
      messages: [{
        type: 'text',
        text: '聯絡房客會依目前任務推送通知給房客；若是報修案件，請從報修詳情選「派修／房客自修／完成」，系統會自動通知房客。'
      }],
    };
  }

  if (label === '屋況點交') {
    return await handlePreInspectionCommand(input.lineUserId);
  }

  if (label === '一鍵報修') {
    return handleRepairCommand(input.lineUserId);
  }

  if (label === '新增報修') {
    return handleRepairStartCommand(input.lineUserId);
  }

  if (label === '報修進度') {
    return handleRepairProgressCommandConfigured(input.lineUserId);
  }

  if (label === '報修歷史') {
    return handleRepairHistoryCommandConfigured(input.lineUserId);
  }

  if (label === '通知測試') {
    const card = handleTenantNotificationTestMenu();
    return {
      handled: true,
      messages: [card]
    };
  }

  if (label === '租屋通知') {
    const card = await handleTenantNotification(input.lineUserId);
    return {
      handled: true,
      messages: [card]
    };
  }
  // 房東管理台。權限不在這張卡上判斷——卡片只是連結,真正的所有權檢查在
  // landlordManageRoutes 的每一條 API 裡,不是房東的人打開頁面只會看到空清單。
  if (label === '房東管理台') {
    return {
      handled: true,
      messages: [{
        type: 'flex',
        altText: '開啟房東管理台',
        contents: {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              { type: 'text', text: '房東管理台', weight: 'bold', size: 'lg', color: '#0F766E' },
              { type: 'text', text: '開放看房時段給房客選擇，或調整房源規則的順序與啟用狀態。', size: 'sm', color: '#4B5563', wrap: true }
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#0F766E',
                action: { type: 'uri', label: '開啟管理台', uri: getLandlordManageLiffUrl() }
              }
            ]
          }
        }
      }]
    };
  }

  if (label === '續約租約') {
    const { withV2Driver } = require('../database/v2Driver');
    const renewalService = require('./v2RenewalServiceAsync');
    const { renewalHomeCard, noActiveLeaseMessage } = require('./v2RenewalLinePresenter');
    const leases = await withV2Driver((db) => renewalService.listMyActiveLeasesForRenewal({
      db, lineUserId: input.lineUserId
    }));
    if (!leases.length) {
      return { handled: true, messages: [noActiveLeaseMessage()] };
    }
    return {
      handled: true,
      messages: [renewalHomeCard({
        roles: [...new Set(leases.flatMap((lease) => lease.roles))],
        contractsUrl: require('./cardMessageService').contractsUrl()
      })]
    };
  }

  if (label === '租屋紀錄' || label === '找房紀錄') {
    const findHousesUrl = getFindHousesLiffUrl();
    const flexCard = {
      type: 'flex',
      altText: '開啟找房紀錄',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            { type: 'text', text: '找房紀錄與預約', weight: 'bold', size: 'lg', color: '#0F766E' },
            { type: 'text', text: '請點擊下方按鈕開啟找房紀錄頁面，進行詢問情境切換或看房預約。', size: 'sm', color: '#4B5563', wrap: true }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#0F766E',
              action: {
                type: 'uri',
                label: '開啟找房紀錄',
                uri: findHousesUrl
              }
            }
          ]
        }
      }
    };
    return {
      handled: true,
      messages: [flexCard]
    };
  }

  return {
    handled: true,
    messages: [{ type: 'text', text: FEATURE_REPLIES[label] }],
  };
}

async function handleTenantFeaturePostback(event) {
  const data = event.postback && event.postback.data;
  if (!data) return { handled: false };
  const params = new URLSearchParams(data);
  const action = params.get('action');

  if (action === 'repair_update' || action === 'repair_landlord_negotiate') {
    return handleRepairPostback(event, require('../lineClient').client);
  }

  if (action === 'tenant_repair_close_start' || action === 'tenant_repair_response') {
    return handleTenantRepairPostback(event, require('../lineClient').client);
  }

  if (action && (action.startsWith('tenant_pre_inspection_') || action.startsWith('landlord_pre_inspection_'))) {
    return await handlePreInspectionPostback(event);
  }

  if (action === 'renewal_landlord_menu' || action === 'renewal_rules' || action === 'renewal_set_preference' || action === 'renewal_choose_lease' || action === 'renewal_pending' || action === 'renewal_resume' || action === 'renewal_select_lease' || action === 'renewal_start' || action === 'renewal_plan' || action === 'renewal_tenant_plan' || action === 'renewal_decline_confirm' || action === 'renewal_q1' || action === 'renewal_q2' || action === 'renewal_submit_custom' || action === 'renewal_restart_custom' || action === 'renewal_cancel_custom' || action === 'renewal_decision' || action === 'renewal_submit_tenant_changes' || action === 'renewal_restart_tenant_changes' || action === 'renewal_cancel_tenant_changes' || action === 'renewal_landlord_counter_decision' || action === 'renewal_landlord_counter_decline_confirm') {
    const { withV2Driver } = require('../database/v2Driver');
    const renewalService = require('./v2RenewalServiceAsync');
    const renewalRepository = require('../repositories/v2RenewalRepositoryAsync');
    const presenter = require('./v2RenewalLinePresenter');
    const lineUserId = event.source && event.source.userId;
    const renewalLineSessionRepository = require('../repositories/v2RenewalLineSessionRepositoryAsync');
    const hasBothRolesForLease = async (leasePublicId) => {
      const parties = await withV2Driver((db) => renewalRepository.listLeasePartiesForViewer(db, {
        lineUserId, leasePublicId
      }));
      const roles = new Set(parties.map((party) => party.party_role));
      return roles.has('landlord') && roles.has('tenant');
    };
    const renewalQ1CardForRequest = async (renewalRequestPublicId) => {
      const summary = await withV2Driver((db) => renewalRepository.getRenewalRequestSummary(
        db, renewalRequestPublicId
      ));
      const { contractsUrl } = require('./cardMessageService');
      return presenter.renewalQ1Card({
        renewalRequestPublicId,
        tenantName: summary.tenantName,
        propertyLabel: summary.propertyLabel,
        currentRentAmount: summary.rentAmount,
        currentDepositAmount: summary.depositAmount,
        currentStartDate: summary.startDate,
        currentEndDate: summary.endDate,
        contractsUrl: contractsUrl()
      });
    };
    const renewalQ2CardForRequest = async (renewalRequestPublicId) => {
      const summary = await withV2Driver((db) => renewalRepository.getRenewalRequestSummary(
        db, renewalRequestPublicId
      ));
      const { contractsUrl } = require('./cardMessageService');
      const preference = await withV2Driver((db) => renewalService.getLandlordRenewalPreference({ db, lineUserId }));
      return presenter.renewalQ2Card({
        renewalRequestPublicId,
        currentRentAmount: summary.rentAmount,
        currentDepositAmount: summary.depositAmount,
        currentStartDate: summary.startDate,
        currentEndDate: summary.endDate,
        unchangedTermsNegotiable: preference.unchangedTermsNegotiable,
        contractsUrl: contractsUrl()
      });
    };
    const renewalDecisionCardForRequest = async (renewalRequestPublicId) => {
      const summary = await withV2Driver((db) => renewalRepository.getRenewalRequestSummary(
        db, renewalRequestPublicId
      ));
      const { contractsUrl } = require('./cardMessageService');
      const preference = await withV2Driver((db) => renewalService.getLandlordRenewalPreference({ db, lineUserId }));
      return presenter.renewalLandlordDecisionCard({
        renewalRequestPublicId,
        tenantName: summary.tenantName,
        propertyLabel: summary.propertyLabel,
        currentRentAmount: summary.rentAmount,
        currentDepositAmount: summary.depositAmount,
        currentStartDate: summary.startDate,
        currentEndDate: summary.endDate,
        unchangedTermsNegotiable: preference.unchangedTermsNegotiable,
        contractsUrl: contractsUrl()
      });
    };
    const tenantCounterCardForRequest = async (renewalRequestPublicId, proposal, reused = false) => {
      const summary = await withV2Driver((db) => renewalRepository.getRenewalRequestSummary(
        db, renewalRequestPublicId
      ));
      return presenter.renewalTenantCounterProposalCard({
        renewalRequestPublicId,
        proposal,
        reused,
        tenantName: summary.tenantName,
        propertyLabel: summary.propertyLabel
      });
    };
    const beginCustomConditionInput = async (renewalRequestPublicId) => {
      const session = await withV2Driver(async (db) => {
        const request = await renewalRepository.getRenewalRequestByPublicId(db, renewalRequestPublicId);
        await renewalRepository.requireLeaseParty(db, {
          lineUserId, leasePublicId: request.lease_public_id, partyRole: 'landlord'
        });
        return renewalLineSessionRepository.start(db, {
          lineUserId, renewalRequestId: request.id, purpose: 'landlord_proposal'
        });
      });
      return {
        handled: true,
        messages: [{
          type: 'text',
          text: '請直接輸入調整後的續約條件。\n例如：月租 20000，押金 40000，租期 2026-11-27 到 2027-11-26，其他條件沿用。\n\n輸入「取消」可停止編輯。'
        }]
      };
    };
    const beginTenantChangeInput = async (renewalRequestPublicId, purpose = 'tenant_change') => {
      const context = await withV2Driver(async (db) => {
        const request = await renewalRepository.getRenewalRequestByPublicId(db, renewalRequestPublicId);
        await renewalRepository.requireLeaseParty(db, {
          lineUserId, leasePublicId: request.lease_public_id, partyRole: 'tenant'
        });
        const proposal = await renewalRepository.latestProposalForRequest(db, request.id);
        const nextPeriod = proposal
          ? { startDate: proposal.proposed_start_date, endDate: proposal.proposed_end_date }
          : renewalService.shiftLeasePeriod(request.lease_start_date, request.lease_end_date);
        await renewalLineSessionRepository.start(db, {
          lineUserId, renewalRequestId: request.id, purpose
        });
        return nextPeriod;
      });
      return {
        handled: true,
        messages: [{
          type: 'text',
          text: `${purpose === 'tenant_initial' ? '請輸入你希望提出的續約條件。' : '請輸入你希望修改的續約條件。'}\n例如：月租 18500，押金維持不變，租期 ${context.startDate} 到 ${context.endDate}，其他條件沿用。\n\n輸入「取消」可停止編輯。`
        }]
      };
    };

    // 錯誤翻譯表跟 ecsNeoConditionLineService 同一個形狀:authorization_denied
    // 一律回同一句,不揭露這筆續約申請存不存在、輪到誰動作。
    const errorReply = (error) => {
      switch (error && error.code) {
        case 'authorization_denied':
          return { handled: true, messages: [{ type: 'text', text: '這個操作不是給你做的，請確認是不是點到別人的卡片。' }] };
        case 'ambiguous_role':
          return { handled: true, messages: [{ type: 'text', text: '請重新輸入「續約租約」，並選擇這次要以房東或房客身分操作。' }] };
        case 'stale_version':
          return { handled: true, messages: [{ type: 'text', text: '這筆續約申請已經結束或有新的進度，請重新開啟最新的卡片。' }] };
        case 'invalid_state':
        case 'invalid_lease_status':
          return { handled: true, messages: [{ type: 'text', text: '目前還沒到這一步，請照卡片上的順序操作。' }] };
        case 'renewal_source_incomplete':
          return { handled: true, messages: [{ type: 'text', text: '找不到目前合約完整的租金條件，沒辦法自動沿用，請直接跟房客／房東協調後手動處理。' }] };
        case 'renewal_already_completed':
          return { handled: true, messages: [{ type: 'text', text: '這份租約已完成續約，不需要再次提出申請。' }] };
        case 'renewal_declined_by_landlord':
          return { handled: true, messages: [{ type: 'text', text: '房東已確認這份現行租約不續約，不能再次提出續約申請。' }] };
        case 'changes_not_allowed':
          return { handled: true, messages: [{ type: 'text', text: '這份續約方案採固定條件，請選擇接受續約或拒絕續約。' }] };
        case 'not_found':
          return { handled: true, messages: [{ type: 'text', text: '找不到這筆續約申請，可能已經被處理過了。' }] };
        default:
          console.error('renewal postback failed:', error && error.code, error && error.message);
          return { handled: true, messages: [{ type: 'text', text: '續約流程發生問題，請稍後再試一次。' }] };
      }
    };

    try {
      if (action === 'renewal_landlord_menu') {
        return { handled: true, messages: [presenter.landlordRenewalMenuCard()] };
      }

      if (action === 'renewal_rules') {
        const preference = await withV2Driver((db) => renewalService.getLandlordRenewalPreference({ db, lineUserId }));
        return { handled: true, messages: [presenter.renewalRulesCard(preference)] };
      }

      if (action === 'renewal_set_preference') {
        const unchangedTermsNegotiable = params.get('negotiable') === '1';
        const preference = await withV2Driver((db) => renewalService.setLandlordRenewalPreference({
          db, lineUserId, unchangedTermsNegotiable
        }));
        return { handled: true, messages: [
          { type: 'text', text: preference.unchangedTermsNegotiable
            ? '已設定：沿用原合約條件時，允許房客提出一次修改。'
            : '已設定：沿用原合約條件時不開放協商，房客可接受或不續約。' },
          presenter.landlordRenewalMenuCard()
        ] };
      }

      if (action === 'renewal_choose_lease') {
        const role = params.get('role');
        if (!['landlord', 'tenant'].includes(role)) return errorReply({ code: 'authorization_denied' });
        const leases = await withV2Driver((db) => renewalService.listMyActiveLeasesForRenewal({ db, lineUserId }));
        const available = leases.filter((lease) => lease.roles.includes(role));
        if (!available.length) return { handled: true, messages: [presenter.noActiveLeaseMessage()] };
        return { handled: true, messages: [presenter.renewalLeaseSelectionCarousel(available, { role })] };
      }

      if (action === 'renewal_pending') {
        const pending = await withV2Driver(async (db) => {
          const leases = await renewalService.listMyActiveLeasesForRenewal({ db, lineUserId });
          const items = [];
          for (const lease of leases.filter((item) => item.roles.includes('landlord'))) {
            const parties = await renewalRepository.listLeasePartiesForViewer(db, { lineUserId, leasePublicId: lease.leasePublicId });
            const landlord = parties.find((party) => party.party_role === 'landlord');
            if (!landlord) continue;
            const open = await renewalRepository.findOpenRenewalRequestForLease(db, landlord.lease_id);
            if (open) items.push({ lease, renewalRequestPublicId: open.public_id });
          }
          return items;
        });
        if (!pending.length) {
          return { handled: true, messages: [{ type: 'text', text: '目前沒有待處理的續約申請。' }] };
        }
        return { handled: true, messages: [presenter.pendingRenewalCarousel(pending)] };
      }

      if (action === 'renewal_resume') {
        const renewalRequestPublicId = params.get('id');
        const status = await withV2Driver((db) => renewalService.getRenewalStatusForViewer({
          db, lineUserId, renewalRequestPublicId
        }));
        if (!status.viewerRoles.includes('landlord')) return errorReply({ code: 'authorization_denied' });
        if (status.status !== 'pending') {
          return { handled: true, messages: [{ type: 'text', text: '這筆續約申請已經結束。' }] };
        }
        if (status.proposal && status.proposal.proposedByRole === 'tenant' && !status.decision) {
          return {
            handled: true,
            messages: [await tenantCounterCardForRequest(
              renewalRequestPublicId, status.proposal, status.proposal.reused
            )]
          };
        }
        if (status.landlordWilling === null || (status.landlordWilling && status.currentTermsReusable === null)) {
          return { handled: true, messages: [await renewalDecisionCardForRequest(renewalRequestPublicId)] };
        }
        if (status.landlordWilling && status.currentTermsReusable === false && !status.proposal) {
          return beginCustomConditionInput(renewalRequestPublicId);
        }
        if (status.decision && status.decision.decision === 'request_changes') {
          return { handled: true, messages: [{ type: 'text', text: '房客正在填寫希望修改的續約條件，送出後會顯示在待處理續約。' }] };
        }
        return { handled: true, messages: [{ type: 'text', text: '這筆續約已送出方案，目前正在等待房客回覆。' }] };
      }

      if (action === 'renewal_select_lease') {
        const leasePublicId = params.get('lease');
        const role = params.get('role');
        const leases = await withV2Driver((db) => renewalService.listMyActiveLeasesForRenewal({
          db, lineUserId
        }));
        const lease = leases.find((item) => item.leasePublicId === leasePublicId);
        if (!lease) {
          return errorReply({ code: 'authorization_denied' });
        }
        if (role && !lease.roles.includes(role)) return errorReply({ code: 'authorization_denied' });
        const { contractsUrl } = require('./cardMessageService');
        return {
          handled: true,
          messages: [presenter.renewalStartCard({
            leasePublicId: lease.leasePublicId,
            listingTitle: lease.listingTitle,
            propertyLabel: lease.propertyLabel,
            tenantName: lease.tenantName,
            startDate: lease.startDate,
            endDate: lease.endDate,
            rentAmount: lease.rentAmount,
            depositAmount: lease.depositAmount,
            viewerRole: role || undefined,
            viewerRoles: role ? [role] : lease.roles,
            contractsUrl: contractsUrl()
          })]
        };
      }

      if (action === 'renewal_start') {
        const leasePublicId = params.get('lease');
        const actingRole = params.get('role') || undefined;
        if (actingRole === 'tenant') {
          const leases = await withV2Driver((db) => renewalService.listMyActiveLeasesForRenewal({ db, lineUserId }));
          const lease = leases.find((item) => item.leasePublicId === leasePublicId && item.roles.includes('tenant'));
          if (!lease) return errorReply({ code: 'authorization_denied' });
          const { contractsUrl } = require('./cardMessageService');
          return {
            handled: true,
            messages: [presenter.renewalTenantPlanCard({
              leasePublicId,
              listingTitle: lease.listingTitle,
              propertyLabel: lease.propertyLabel,
              startDate: lease.startDate,
              endDate: lease.endDate,
              rentAmount: lease.rentAmount,
              depositAmount: lease.depositAmount,
              contractsUrl: contractsUrl()
            })]
          };
        }
        const result = await withV2Driver((db) => renewalService.initiateRenewal({
          db, lineUserId, leasePublicId, actingRole
        }));
        // 房東身分判斷:這個 LINE 身分在這份租約上的角色。只查一次,下面重複用。
        const party = await withV2Driver((db) => renewalRepository.requireLeaseParty(db, {
          lineUserId, leasePublicId, partyRole: actingRole
        }));
        const isLandlord = actingRole
          ? actingRole === 'landlord'
          : party.party_role === 'landlord';
        const sameAccountDualRole = await hasBothRolesForLease(leasePublicId);

        if (result.replayed) {
          // 已經有一筆進行中的申請。2026-09-21 實測發現:如果房東該回答的那張卡
          // 之前因為訊息格式錯誤送失敗(LINE reply 400),使用者會卡在原地,而且
          // 點同一顆「開始確認續約」按鈕只會重新落到這個 replayed 分支——原本
          // 只回一句「等對方回覆」,房東永遠拿不到該答的那張卡。這裡補回去:
          // 該回答的問題還沒答完,就重新把那張卡送一次,不是只回一句籠統的文字。
          if ((isLandlord || sameAccountDualRole)
              && (result.landlordWilling === null
                || (result.landlordWilling === true && result.currentTermsReusable === null))) {
            return { handled: true, messages: [await renewalDecisionCardForRequest(result.renewalRequestPublicId)] };
          }
          if (isLandlord && result.landlordWilling === true && result.currentTermsReusable === false) {
            return beginCustomConditionInput(result.renewalRequestPublicId);
          }
          return { handled: true, messages: [{ type: 'text', text: '這份租約已經有一筆進行中的續約申請了，等對方回覆即可，不用重複發起。' }] };
        }

        // 房東不再分 Q1/Q2，直接從三選一卡決定沿用、調整或不續約。
        // 房客發起時只回收件確認，同一張決策卡由 outbox 送給房東。
        const request = await withV2Driver((db) => renewalRepository.getRenewalRequestByPublicId(db, result.renewalRequestPublicId));
        if (request.action_status === 'pending' && (isLandlord || sameAccountDualRole)) {
          return { handled: true, messages: [await renewalDecisionCardForRequest(result.renewalRequestPublicId)] };
        }
        return { handled: true, messages: [{ type: 'text', text: '已通知房東，房東回覆後你會收到後續進度通知。' }] };
      }

      if (action === 'renewal_tenant_plan') {
        const leasePublicId = params.get('lease');
        const mode = params.get('mode');
        if (!['reuse', 'adjust'].includes(mode)) return errorReply({ code: 'invalid_state' });
        const initiated = await withV2Driver((db) => renewalService.initiateRenewal({
          db, lineUserId, leasePublicId, actingRole: 'tenant'
        }));
        const status = await withV2Driver((db) => renewalService.getRenewalStatusForViewer({
          db, lineUserId, renewalRequestPublicId: initiated.renewalRequestPublicId
        }));
        if (status.proposal) {
          if (status.proposal.proposedByRole === 'tenant' && !status.decision) {
            if (await hasBothRolesForLease(leasePublicId)) {
              return {
                handled: true,
                messages: [await tenantCounterCardForRequest(
                  initiated.renewalRequestPublicId, status.proposal, status.proposal.reused
                )]
              };
            }
            return { handled: true, messages: [{ type: 'text', text: '續約條件已送給房東，請等待房東回覆。' }] };
          }
          return { handled: true, messages: [{ type: 'text', text: '這份租約已有進行中的續約方案，請查看最新進度。' }] };
        }
        if (mode === 'adjust') {
          return beginTenantChangeInput(initiated.renewalRequestPublicId, 'tenant_initial');
        }
        const result = await withV2Driver((db) => renewalService.submitTenantOriginalTermsProposal({
          db, lineUserId, renewalRequestPublicId: initiated.renewalRequestPublicId
        }));
        if (await hasBothRolesForLease(leasePublicId)) {
          return {
            handled: true,
            messages: [await tenantCounterCardForRequest(
              initiated.renewalRequestPublicId, result.proposal, true
            )]
          };
        }
        return { handled: true, messages: [{ type: 'text', text: '已將沿用原條件的續約意願送給房東。' }] };
      }

      if (action === 'renewal_plan') {
        const mode = params.get('mode');
        if (!['reuse', 'adjust'].includes(mode)) return errorReply({ code: 'invalid_state' });
        let renewalRequestPublicId = params.get('id');
        if (!renewalRequestPublicId) {
          const leasePublicId = params.get('lease');
          const initiated = await withV2Driver((db) => renewalService.initiateRenewal({
            db, lineUserId, leasePublicId, actingRole: 'landlord'
          }));
          renewalRequestPublicId = initiated.renewalRequestPublicId;
        }

        let status = await withV2Driver((db) => renewalService.getRenewalStatusForViewer({
          db, lineUserId, renewalRequestPublicId
        }));
        if (!status.viewerRoles.includes('landlord')) return errorReply({ code: 'authorization_denied' });
        if (status.status !== 'pending') return errorReply({ code: 'stale_version' });
        if (status.landlordWilling === false) return errorReply({ code: 'stale_version' });
        if (status.landlordWilling === null) {
          await withV2Driver((db) => renewalService.answerLandlordWillingness({
            db, lineUserId, renewalRequestPublicId, willing: true, notifyTenant: false
          }));
          status = { ...status, landlordWilling: true };
        }

        const reusable = mode === 'reuse';
        if (status.currentTermsReusable !== null) {
          if (status.currentTermsReusable !== reusable) return errorReply({ code: 'stale_version' });
          if (!reusable) return beginCustomConditionInput(renewalRequestPublicId);
          return { handled: true, messages: [{ type: 'text', text: '這份原條件續約方案已經送給房客，不會重複送出。' }] };
        }

        const result = await withV2Driver((db) => renewalService.answerCurrentTermsReusable({
          db, lineUserId, renewalRequestPublicId, reusable
        }));
        if (!result.currentTermsReusable) return beginCustomConditionInput(renewalRequestPublicId);

        const request = await withV2Driver((db) => renewalRepository.getRenewalRequestByPublicId(
          db, renewalRequestPublicId
        ));
        if (await hasBothRolesForLease(request.lease_public_id)) {
          return {
            handled: true,
            messages: [presenter.renewalProposalCard({
              renewalRequestPublicId,
              proposal: result.proposal,
              reused: true,
              negotiable: result.negotiable
            })]
          };
        }
        return { handled: true, messages: [{ type: 'text', text: '已將沿用原條件的續約方案送給房客確認。' }] };
      }

      if (action === 'renewal_q1') {
        const renewalRequestPublicId = params.get('id');
        const willing = params.get('willing') === '1';
        const result = await withV2Driver((db) => renewalService.answerLandlordWillingness({ db, lineUserId, renewalRequestPublicId, willing }));
        if (result.replayed) {
          return { handled: true, messages: [{ type: 'text', text: '這一題你已經回答過了，不會再重複處理一次。' }] };
        }
        if (!result.landlordWilling) {
          return { handled: true, messages: [{ type: 'text', text: '已確認不續約，這筆續約申請已結束。' }] };
        }
        return {
          handled: true,
          messages: [await renewalQ2CardForRequest(renewalRequestPublicId)]
        };
      }

      if (action === 'renewal_decline_confirm') {
        let renewalRequestPublicId = params.get('id');
        if (!renewalRequestPublicId) {
          const leasePublicId = params.get('lease');
          const initiated = await withV2Driver((db) => renewalService.initiateRenewal({
            db, lineUserId, leasePublicId, actingRole: 'landlord'
          }));
          renewalRequestPublicId = initiated.renewalRequestPublicId;
        }
        const summary = await withV2Driver((db) => renewalRepository.getRenewalRequestSummary(
          db, renewalRequestPublicId
        ));
        await withV2Driver((db) => renewalRepository.requireLeaseParty(db, {
          lineUserId, leasePublicId: summary.leasePublicId, partyRole: 'landlord'
        }));
        return {
          handled: true,
          messages: [presenter.renewalDeclineConfirmationCard({
            renewalRequestPublicId,
            propertyLabel: summary.propertyLabel,
            tenantName: summary.tenantName
          })]
        };
      }

      if (action === 'renewal_q2') {
        const renewalRequestPublicId = params.get('id');
        const reusable = params.get('reusable') === '1';
        const result = await withV2Driver((db) => renewalService.answerCurrentTermsReusable({
          db, lineUserId, renewalRequestPublicId, reusable
        }));
        if (result.replayed) {
          if (!reusable && result.currentTermsReusable === false) {
            return beginCustomConditionInput(renewalRequestPublicId);
          }
          return { handled: true, messages: [{ type: 'text', text: '這一題你已經回答過了，不會再重複處理一次。' }] };
        }
        if (result.currentTermsReusable) {
          const request = await withV2Driver((db) => renewalRepository.getRenewalRequestByPublicId(db, renewalRequestPublicId));
          if (await hasBothRolesForLease(request.lease_public_id)) {
            return {
              handled: true,
              messages: [presenter.renewalProposalCard({
                renewalRequestPublicId,
                proposal: result.proposal,
                reused: true,
                negotiable: result.negotiable
              })]
            };
          }
          return { handled: true, messages: [{ type: 'text', text: '已產生沿用目前條件的續約提案，系統已通知房客確認。' }] };
        }
        return beginCustomConditionInput(renewalRequestPublicId);
      }

      if (action === 'renewal_restart_custom') {
        const sessionPublicId = params.get('session');
        const session = await withV2Driver((db) => renewalLineSessionRepository.getByPublicId(db, {
          lineUserId, publicId: sessionPublicId
        }));
        if (!session || session.finishedAt) return errorReply({ code: 'stale_version' });
        await withV2Driver((db) => renewalLineSessionRepository.restart(db, sessionPublicId, 'landlord_proposal'));
        return { handled: true, messages: [{ type: 'text', text: '請重新輸入調整後的續約條件；輸入「取消」可停止編輯。' }] };
      }

      if (action === 'renewal_restart_tenant_changes') {
        const sessionPublicId = params.get('session');
        const session = await withV2Driver((db) => renewalLineSessionRepository.getByPublicId(db, {
          lineUserId, publicId: sessionPublicId
        }));
        if (!session || session.finishedAt) return errorReply({ code: 'stale_version' });
        const purpose = renewalLineSessionRepository.purposeFrom(session);
        await withV2Driver((db) => renewalLineSessionRepository.restart(db, sessionPublicId, purpose));
        return { handled: true, messages: [{ type: 'text', text: '請重新輸入你希望修改的續約條件；輸入「取消」可停止編輯。' }] };
      }

      if (action === 'renewal_cancel_custom') {
        const sessionPublicId = params.get('session');
        const session = await withV2Driver((db) => renewalLineSessionRepository.getByPublicId(db, {
          lineUserId, publicId: sessionPublicId
        }));
        if (!session || session.finishedAt) return errorReply({ code: 'stale_version' });
        await withV2Driver((db) => renewalLineSessionRepository.finish(db, { publicId: sessionPublicId, reason: 'cancelled' }));
        return {
          handled: true,
          messages: [{ type: 'text', text: '已取消編輯，尚未將續約方案送給房客。' }, presenter.landlordRenewalMenuCard()]
        };
      }

      if (action === 'renewal_cancel_tenant_changes') {
        const sessionPublicId = params.get('session');
        const session = await withV2Driver((db) => renewalLineSessionRepository.getByPublicId(db, {
          lineUserId, publicId: sessionPublicId
        }));
        if (!session || session.finishedAt) return errorReply({ code: 'stale_version' });
        await withV2Driver((db) => renewalLineSessionRepository.finish(db, { publicId: sessionPublicId, reason: 'cancelled' }));
        return { handled: true, messages: [{ type: 'text', text: '已取消輸入，尚未將修改條件送給房東。' }] };
      }

      if (action === 'renewal_submit_custom') {
        const sessionPublicId = params.get('session');
        const session = await withV2Driver((db) => renewalLineSessionRepository.getByPublicId(db, {
          lineUserId, publicId: sessionPublicId
        }));
        if (!session || session.finishedAt || !session.draft) return errorReply({ code: 'stale_version' });
        const result = await withV2Driver((db) => renewalService.submitRenewalProposal({
          db,
          lineUserId,
          renewalRequestPublicId: session.renewalRequestPublicId,
          proposedStartDate: session.draft.startDate,
          proposedEndDate: session.draft.endDate,
          rentAmount: session.draft.rentAmount,
          depositAmount: session.draft.depositAmount,
          termsJson: { renewalConditionNote: session.draft.note }
        }));
        await withV2Driver((db) => renewalLineSessionRepository.finish(db, {
          publicId: sessionPublicId, reason: 'submitted'
        }));
        const request = await withV2Driver((db) => renewalRepository.getRenewalRequestByPublicId(
          db, session.renewalRequestPublicId
        ));
        if (await hasBothRolesForLease(request.lease_public_id)) {
          return {
            handled: true,
            messages: [presenter.renewalProposalCard({
              renewalRequestPublicId: session.renewalRequestPublicId,
              proposal: result.proposal,
              reused: false,
              negotiable: true
            })]
          };
        }
        return { handled: true, messages: [{ type: 'text', text: '續約方案已送出，系統已通知房客確認。' }] };
      }

      if (action === 'renewal_submit_tenant_changes') {
        const sessionPublicId = params.get('session');
        const session = await withV2Driver((db) => renewalLineSessionRepository.getByPublicId(db, {
          lineUserId, publicId: sessionPublicId
        }));
        if (!session || session.finishedAt || !session.draft
            || !['tenant_change', 'tenant_initial'].includes(renewalLineSessionRepository.purposeFrom(session))) {
          return errorReply({ code: 'stale_version' });
        }
        const result = await withV2Driver((db) => renewalService.submitTenantChangeProposal({
          db,
          lineUserId,
          renewalRequestPublicId: session.renewalRequestPublicId,
          proposedStartDate: session.draft.startDate,
          proposedEndDate: session.draft.endDate,
          rentAmount: session.draft.rentAmount,
          depositAmount: session.draft.depositAmount,
          termsJson: { renewalConditionNote: session.draft.note }
        }));
        await withV2Driver((db) => renewalLineSessionRepository.finish(db, {
          publicId: sessionPublicId, reason: 'submitted'
        }));
        const request = await withV2Driver((db) => renewalRepository.getRenewalRequestByPublicId(
          db, session.renewalRequestPublicId
        ));
        if (await hasBothRolesForLease(request.lease_public_id)) {
          return {
            handled: true,
            messages: [await tenantCounterCardForRequest(
              session.renewalRequestPublicId, result.proposal, result.reused
            )]
          };
        }
        return { handled: true, messages: [{ type: 'text', text: '修改條件已送給房東，房東回覆後會再通知你。' }] };
      }

      if (action === 'renewal_landlord_counter_decline_confirm') {
        const renewalRequestPublicId = params.get('id');
        return {
          handled: true,
          messages: [presenter.renewalCounterDeclineConfirmationCard({ renewalRequestPublicId })]
        };
      }

      if (action === 'renewal_landlord_counter_decision') {
        const renewalRequestPublicId = params.get('id');
        const decisionAction = params.get('decision');
        if (decisionAction === 'revise') {
          const status = await withV2Driver((db) => renewalService.getRenewalStatusForViewer({
            db, lineUserId, renewalRequestPublicId
          }));
          if (status.landlordWilling === null) {
            await withV2Driver((db) => renewalService.answerLandlordWillingness({
              db, lineUserId, renewalRequestPublicId, willing: true, notifyTenant: false
            }));
          }
          return beginCustomConditionInput(renewalRequestPublicId);
        }
        const result = await withV2Driver((db) => renewalService.decideTenantChangeProposal({
          db, lineUserId, renewalRequestPublicId, action: decisionAction
        }));
        if (result.replayed) {
          return { handled: true, messages: [{ type: 'text', text: '這個決定已經送出過了，不會重複處理。' }] };
        }
        if (decisionAction === 'accept') {
          return { handled: true, messages: [{ type: 'text', text: '已接受房客提出的續約條件。後續需建立續約合約，並由雙方完成簽署後才正式生效。' }] };
        }
        return { handled: true, messages: [{ type: 'text', text: '已確認不續約，這筆續約申請已結束。' }] };
      }

      if (action === 'renewal_decision') {
        const renewalRequestPublicId = params.get('id');
        const decisionAction = params.get('decision');
        const result = await withV2Driver((db) => renewalService.submitTenantRenewalDecision({
          db, lineUserId, renewalRequestPublicId, action: decisionAction
        }));
        if (result.replayed && decisionAction !== 'request_changes') {
          return { handled: true, messages: [{ type: 'text', text: '這個決定你已經送出過了，不會再重複處理一次。' }] };
        }
        if (decisionAction === 'accept') {
          return { handled: true, messages: [{ type: 'text', text: '續約條件已確認。後續需建立續約合約，並由雙方完成簽署後才正式生效。' }] };
        }
        if (decisionAction === 'reject') {
          return { handled: true, messages: [{ type: 'text', text: '已拒絕本次續約提案，這筆續約申請已結束。' }] };
        }
        return beginTenantChangeInput(renewalRequestPublicId);
      }
    } catch (error) {
      return errorReply(error);
    }
  }

  if (action === 'tenant_contact_finish') {
    const { withV2Driver } = require('../database/v2Driver');
    await withV2Driver(async (db) => {
      const row = await db.get('SELECT id FROM line_identities WHERE line_user_id = ?', [event.source.userId]);
      if (!row) return;
      await db.run(`
        UPDATE line_flow_sessions
        SET finished_at = CURRENT_TIMESTAMP, finish_reason = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE line_identity_id = ? AND finished_at IS NULL
      `, [row.id]);
    });
    return { handled: true, messages: [{ type: 'text', text: '已結束本次聯絡流程。' }] };
  }

  if (action === 'tenant_contact_history' || action === 'tenant_back_to_listing' || action === 'tenant_contact_landlord') {
    const { getTenantContactHistoryByInquiry } = require('../repositories/v2LandlordContactRepositoryAsync');
    const { processHistoryInteractions, formatHistoryTime } = require('./landlordContactLinePresenter');
    const { withV2Driver } = require('../database/v2Driver');

    const lineUserId = event.source.userId;
    // Support inquiry_id from postback (e.g. notification buttons)
    const postbackInquiryId = params.get('inquiry_id');

    // 資料庫的事一次做完就放掉連線。下面組卡片、算數量都不需要連線,
    // 而 tenant_contact_landlord 那條還會再進 handleContactLandlord,
    // 那支自己會取連線——握著不放等於一個請求佔兩條。
    const loaded = await withV2Driver(async (db) => {
      const row = await db.get('SELECT id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
      let activeCtx = null;
      let inquiryId = null;

      if (postbackInquiryId) {
        // Verify this inquiry belongs to this user
        const inqRow = row ? await db.get(`
          SELECT aic.id, i.id AS inquiry_id, l.title AS listing_title
          FROM inquiries i
          JOIN listings l ON l.id = i.listing_id
          JOIN active_inquiry_contexts aic ON aic.inquiry_id = i.id AND aic.line_identity_id = ?
          WHERE i.id = ?
        `, [row.id, postbackInquiryId]) : null;

        if (inqRow) {
          activeCtx = inqRow;
          inquiryId = inqRow.inquiry_id;
        } else if (row) {
          // Fallback: verify inquiry belongs to user even without active context
          const directRow = await db.get(`
            SELECT i.id AS inquiry_id, l.title AS listing_title
            FROM inquiries i
            JOIN listings l ON l.id = i.listing_id
            JOIN line_identities li ON li.user_id = i.user_id
            WHERE li.id = ? AND i.id = ?
          `, [row.id, postbackInquiryId]);
          if (directRow) {
            activeCtx = { listing_title: directRow.listing_title };
            inquiryId = directRow.inquiry_id;
          }
        }
      }

      if (!activeCtx && row) {
        const ctxRow = await db.get(`
          SELECT aic.id, aic.inquiry_id, l.title AS listing_title
          FROM active_inquiry_contexts aic
          JOIN inquiries i ON i.id = aic.inquiry_id
          JOIN listings l ON l.id = i.listing_id
          WHERE aic.line_identity_id = ? AND aic.cleared_at IS NULL
        `, [row.id]);
        if (ctxRow) {
          activeCtx = ctxRow;
          inquiryId = ctxRow.inquiry_id;
        }
      }

      const historyRows = (activeCtx && inquiryId && action === 'tenant_contact_history')
        ? await getTenantContactHistoryByInquiry(db, inquiryId, 100)
        : [];
      return { activeCtx, inquiryId, historyRows };
    });

    const { activeCtx, inquiryId, historyRows } = loaded;

    if (!activeCtx) {
      return { handled: true, messages: [{ type: 'text', text: '目前沒有選定房源，請先從 591 房源頁進入 ECS NEO，或從找房紀錄選擇一筆房源。' }] };
    }

    if (action === 'tenant_back_to_listing') {
      return {
        handled: true,
        messages: [{
          type: 'text',
          text: `目前房源：\n${activeCtx.listing_title}\n\n你可以繼續詢問房源問題，或返回找房紀錄選擇其他房源。`,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '聯絡房東', text: '聯絡房東' } },
              { type: 'action', action: { type: 'uri', label: '找房紀錄', uri: getFindHousesLiffUrl() } }
            ]
          }
        }]
      };
    }

    if (action === 'tenant_contact_landlord') {
       return handleContactLandlord(lineUserId);
    }

    if (action === 'tenant_contact_history') {

      if (!historyRows || historyRows.length === 0) {
        return { handled: true, messages: [{ type: 'text', text: '目前尚無聯絡紀錄。' }] };
      }

      const { validInteractions } = processHistoryInteractions(historyRows);
      if (validInteractions.length === 0) {
        return { handled: true, messages: [{ type: 'text', text: '目前尚無聯絡紀錄。' }] };
      }

      const pendingItems = validInteractions.filter(i => i.type === 'qa' && !i.aTime && !i.aText && (i.qStatus === 'pending' || i.qStatus === 'notified')).slice(-3);
      const answeredItems = validInteractions.filter(i => i.type === 'qa' && (i.aTime || i.aText)).slice(-2);
      const proactiveItems = validInteractions.filter(i => i.type === 'proactive').slice(-2);

      const pendingCount = pendingItems.length;
      const answeredCount = answeredItems.length;
      const landlordMessageCount = proactiveItems.length;
      const hasContent = pendingCount > 0 || answeredCount > 0 || landlordMessageCount > 0;

      if (!hasContent) {
        return { handled: true, messages: [{ type: 'text', text: '目前尚無詢問紀錄。' }] };
      }

      let historyText = `詢問進度\n房源：${activeCtx.listing_title}`;
      if (pendingCount > 0) {
        historyText += `\n\n等待房東回覆中\n`;
        pendingItems.forEach(item => {
          historyText += `• ${item.qText || '（無內容）'}（${formatHistoryTime(item.qTime)}）\n`;
        });
      }
      if (answeredCount > 0) {
        historyText += `\n\n已收到回覆\n`;
        answeredItems.forEach(item => {
          historyText += `你問：${item.qText || '（無內容）'}\n房東：${item.aText}\n（${formatHistoryTime(item.aTime)}）\n\n`;
        });
        historyText = historyText.trimEnd();
      }
      if (landlordMessageCount > 0) {
        historyText += `\n\n房東主動訊息\n`;
        proactiveItems.forEach(item => {
          historyText += `• ${item.content}（${formatHistoryTime(item.time)}）\n`;
        });
        historyText = historyText.trimEnd();
      }

      const bodyContents = [
        { type: 'text', text: '房源：', size: 'xs', color: '#64748B', weight: 'bold' },
        { type: 'text', text: activeCtx.listing_title || '（無名稱）', size: 'sm', color: '#1F2937', weight: 'bold', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'lg' },
        {
          type: 'box', layout: 'horizontal', margin: 'md',
          contents: [
            { type: 'text', text: `等待回覆：${pendingCount} 則`, size: 'xs', color: '#64748B', flex: 1 },
            { type: 'text', text: `已收到回覆：${answeredCount} 則`, size: 'xs', color: '#64748B', flex: 1 }
          ]
        },
        {
          type: 'box', layout: 'horizontal', margin: 'sm',
          contents: [
            { type: 'text', text: `房東訊息：${landlordMessageCount} 則`, size: 'xs', color: '#64748B', flex: 1 }
          ]
        },
        { type: 'separator', margin: 'lg' }
      ];

      bodyContents.push({ type: 'text', text: '最新回覆', size: 'sm', weight: 'bold', color: '#111827', margin: 'lg' });
      if (answeredCount > 0) {
        const latestAns = answeredItems[answeredItems.length - 1];
        bodyContents.push({
          type: 'box', layout: 'vertical', margin: 'sm', cornerRadius: 'md', backgroundColor: '#ECFDF5', paddingAll: 'md',
          contents: [
            { type: 'text', text: `你問：${latestAns.qText}`, size: 'xs', color: '#065F46', wrap: true },
            { type: 'text', text: `房東：${latestAns.aText}`, size: 'sm', color: '#064E3B', weight: 'bold', wrap: true, margin: 'sm' },
            { type: 'text', text: `時間：${formatHistoryTime(latestAns.aTime)}`, size: 'xxs', color: '#047857', margin: 'sm' }
          ]
        });
      } else {
        bodyContents.push({
          type: 'box', layout: 'vertical', margin: 'sm', cornerRadius: 'md', backgroundColor: '#F3F4F6', paddingAll: 'md',
          contents: [{ type: 'text', text: '尚無房東回覆', size: 'xs', color: '#6B7280' }]
        });
      }

      if (pendingCount > 0) {
        const latestPending = pendingItems[pendingItems.length - 1];
        bodyContents.push({ type: 'text', text: '待回覆', size: 'sm', weight: 'bold', color: '#111827', margin: 'lg' });
        bodyContents.push({
          type: 'box', layout: 'vertical', margin: 'sm', cornerRadius: 'md', backgroundColor: '#FEFCE8', paddingAll: 'md',
          contents: [
            { type: 'text', text: latestPending.qText, size: 'xs', color: '#854D0E', wrap: true },
            { type: 'text', text: '狀態：等待房東回覆', size: 'xxs', color: '#CA8A04', margin: 'sm' }
          ]
        });
      }

      if (landlordMessageCount > 0) {
        const latestProactive = proactiveItems[proactiveItems.length - 1];
        bodyContents.push({ type: 'text', text: '房東訊息', size: 'sm', weight: 'bold', color: '#111827', margin: 'lg' });
        bodyContents.push({
          type: 'box', layout: 'vertical', margin: 'sm', cornerRadius: 'md', backgroundColor: '#EFF6FF', paddingAll: 'md',
          contents: [
            { type: 'text', text: latestProactive.content, size: 'sm', color: '#1E40AF', weight: 'bold', wrap: true },
            { type: 'text', text: `時間：${formatHistoryTime(latestProactive.time)}`, size: 'xxs', color: '#2563EB', margin: 'sm' }
          ]
        });
      }

      const flexMessage = {
        type: 'flex',
        altText: historyText.length > 390 ? historyText.substring(0, 390) + '...' : historyText,
        contents: {
          type: 'bubble',
          header: {
            type: 'box', layout: 'vertical', backgroundColor: '#0F766E', paddingAll: 'lg',
            contents: [{ type: 'text', text: '詢問進度', weight: 'bold', size: 'xl', color: '#FFFFFF' }]
          },
          body: {
            type: 'box', layout: 'vertical', paddingAll: 'lg',
            contents: bodyContents
          },
          footer: {
            type: 'box', layout: 'vertical', spacing: 'sm',
            contents: [
              { type: 'button', style: 'primary', color: '#0F766E', action: { type: 'postback', label: '繼續詢問', data: `action=tenant_contact_landlord${inquiryId ? '&inquiry_id=' + inquiryId : ''}` } },
              { type: 'button', style: 'secondary', action: { type: 'postback', label: '返回房源', data: `action=tenant_back_to_listing${inquiryId ? '&inquiry_id=' + inquiryId : ''}` } },
              { type: 'button', style: 'link', action: { type: 'postback', label: '結束', data: 'action=tenant_contact_finish' }, color: '#9CA3AF' }
            ]
          }
        }
      };

      return {
        handled: true,
        messages: [flexMessage]
      };
    }
  }

  if (action === 'tenant_notification') {
    const options = { forceState: params.get('forceState') };
    const card = await handleTenantNotification(event.source.userId, options);
    return { handled: true, messages: [card] };
  }

  if (action === 'tenant_notification_test_menu') {
    const card = handleTenantNotificationTestMenu();
    return { handled: true, messages: [card] };
  }

  if (action === 'tenant_notification_single') {
    const card = await handleTenantNotificationSingle(event.source.userId, params.get('type'));
    return { handled: true, messages: [card] };
  }

  if (action === 'tenant_notification_history') {
    const card = await handleTenantNotificationHistory(event.source.userId);
    return { handled: true, messages: [card] };
  }

  if (action === 'calendar_navigate') {
    const { handleCalendarCommand } = require('./contractCalendarLineService');
    const year = parseInt(params.get('year')) || new Date().getFullYear();
    const month = parseInt(params.get('month')) || (new Date().getMonth() + 1);
    await handleCalendarCommand(event.source.userId, event.replyToken, year, month);
    return { handled: true, messages: [] };
  }

  if (action === 'landlord_showing_decision') {
    const crypto = require('node:crypto');
    const { withV2Driver } = require('../database/v2Driver');
    const { client: lineClient } = require('../lineClient');

    const {
      closeSlotForAppointmentCore,
      findOwnedListingById
    } = require('../repositories/v2ShowingSlotRepositoryAsync');
    const { localDate } = require('./showingSlotTime');

    const apptId = params.get('id');
    const decision = params.get('decision');
    const today = localDate();
    const findOwnedListingForLandlord = (db, input) =>
      findOwnedListingById(db, { ...input, today });

    // 讀取與早退判斷先做完再放掉連線。下面同意/拒絕各自還要再開一次連線寫入,
    // 但那兩段之後緊接著 LINE 推播,推播絕對不能包在連線或交易範圍內。
    const loaded = await withV2Driver(async (db) => {
      const appt = await db.get(`
        SELECT sa.*, ss.ends_at
        FROM showing_appointments sa
        LEFT JOIN showing_slots ss ON ss.id = sa.slot_id
        WHERE sa.public_id = ?
      `, [apptId]);
      if (!appt) return { appt: null };

      // 按下這個按鈕的人必須真的是這個房源的房東。postback data 是使用者可以自己
      // 送的,原本這裡完全沒有驗證:任何人只要送出一段
      // action=landlord_showing_decision&id=... 就能替別人的房源同意或拒絕預約,
      // 而房客會收到一則看起來完全正常的「房東已同意」。
      const owned = await findOwnedListingForLandlord(db, {
        listingId: appt.listing_id,
        lineUserId: event.source && event.source.userId
      });
      if (!owned) return { appt, forbidden: true };

      if (appt.status !== 'pending') return { appt, stale: true };

      const tenant = await db.get('SELECT line_user_id FROM line_identities WHERE user_id = ?', [appt.tenant_user_id]);
      const listing = await db.get('SELECT title FROM listings WHERE id = ?', [appt.listing_id]);
      return {
        appt,
        tenantLineUserId: tenant && tenant.line_user_id,
        listingTitle: (listing && listing.title) || '未提供房源'
      };
    });

    const appt = loaded.appt;

    if (!appt) {
      return { handled: true, messages: [{ type: 'text', text: '找不到此預約紀錄。' }] };
    }

    // 刻意與「找不到」給同一句話。分開講會讓外人用回應差異問出某個 appointment
    // public_id 存不存在。
    if (loaded.forbidden) {
      return { handled: true, messages: [{ type: 'text', text: '找不到此預約紀錄。' }] };
    }

    if (loaded.stale) {
      return {
        handled: true,
        messages: [{
          type: 'text',
          text: `此預約已被處理，目前狀態為：${appt.status === 'confirmed' ? '已同意' : appt.status === 'rejected' ? '已拒絕' : '已取消'}`
        }]
      };
    }

    const tenantLineUserId = loaded.tenantLineUserId;
    const listingTitle = loaded.listingTitle;
    const formattedTime = appt.starts_at.replace('T', ' ');
    
    if (decision === 'confirm') {
      // 改狀態與寫行事曆綁在同一個交易;推播在交易外面。
      const changed = await withV2Driver((db) => db.transaction(async (tx) => {
        const result = await tx.run(
          "UPDATE showing_appointments SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
          [appt.id]
        );
        if (result.changes !== 1) return false;
        await tx.run(`
          INSERT INTO calendar_events (public_id, event_type, title, starts_at, listing_id, inquiry_id, status)
          VALUES (?, 'showing', ?, ?, ?, ?, 'scheduled')
        `, [`cal-${crypto.randomUUID()}`, `預約看房: ${listingTitle}`, appt.starts_at, appt.listing_id, appt.inquiry_id]);
        return true;
      }));
      if (!changed) {
        return { handled: true, messages: [{ type: 'text', text: '此預約已被處理，請重新整理後再確認。' }] };
      }
      
      if (tenantLineUserId && !tenantLineUserId.includes('DEMO')) {
        lineClient.pushMessage(tenantLineUserId, confirmedShowingCard({
          appointmentPublicId: appt.public_id,
          listingTitle,
          startsAt: appt.starts_at,
          endsAt: appt.ends_at
        })).catch(err => console.error(err));
      }
      return { handled: true, messages: [{ type: 'text', text: `已同意看房預約：${formattedTime}。系統已通知房客並記入行事曆。` }] };
    } else if (decision === 'reject') {
      // 拒絕 → 預約改狀態,而且那個時段收起來(closed),不回到 open。
      // 房東按拒絕的意思就是「這個時間我不行」,再開放給下一位房客只會讓他也白跑一次。
      // 兩個寫入綁在同一個交易;推播在交易外面。
      const changed = await withV2Driver((db) => db.transaction(async (tx) => {
        const result = await tx.run(
          "UPDATE showing_appointments SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'",
          [appt.id]
        );
        if (result.changes !== 1) return false;
        await closeSlotForAppointmentCore(tx, { appointmentId: appt.id });
        return true;
      }));
      if (!changed) {
        return { handled: true, messages: [{ type: 'text', text: '此預約已被處理，請重新整理後再確認。' }] };
      }

      if (tenantLineUserId && !tenantLineUserId.includes('DEMO')) {
        const findHousesUrl = getFindHousesLiffUrl();
        const retryFlex = {
          type: 'flex',
          altText: '看房預約未成功',
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              spacing: 'md',
              contents: [
                { type: 'text', text: '【房東無法在此時間看房請改時間】', weight: 'bold', color: '#DC2626', wrap: true },
                { type: 'text', text: `房源：「${listingTitle}」\n原時間：${formattedTime}`, size: 'sm', color: '#4B5563' }
              ]
            },
            footer: {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'button',
                  style: 'primary',
                  color: '#2563EB',
                  action: {
                    type: 'uri',
                    label: '重新預約',
                    uri: findHousesUrl
                  }
                }
              ]
            }
          }
        };
        lineClient.pushMessage(tenantLineUserId, [
          { type: 'text', text: '【房東無法在此時間看房請改時間】' },
          retryFlex
        ]).catch(err => console.error(err));
      }
      return { handled: true, messages: [{ type: 'text', text: `已拒絕該預約時間。系統已通知房客重新選擇時間。` }] };
    }
  }

  return await handlePreInspectionPostback(event);
}

module.exports = {
  handleTenantFeatureText,
  isTenantFeatureCommand,
  handleActiveRenewalConditionInput,
  handleActivePreInspectionSession: handleActiveSessionInput,
  handleTenantFeaturePostback
};
