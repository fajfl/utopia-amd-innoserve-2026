const { await findOrCreateLineUser } = require('../repositories/v2InquiryRepositoryAsync');
const reportRepository = require('../repositories/v2LandlordReportRepositoryAsync');
const flows = require('../repositories/v2LineFlowRepositoryAsync');
const presenter = require('./landlordReportLinePresenter');

function params(value) {
  return Object.fromEntries(new URLSearchParams(String(value || '')).entries());
}

function text(message) { return { type: 'text', text: message }; }

function createLandlordReportLineServiceAsync({ db, now = () => new Date() }) {
  async function identity(lineUserId, displayName) {
    return await findOrCreateLineUser(db, { lineUserId, displayName });
  }

  async function getEffectiveUserId(userId) {
    if (String(process.env.LANDLORD_REPORT_DEMO_ENABLED).toLowerCase() === 'true') {
      const demoUser = await db.get("SELECT id FROM users WHERE public_id = 'demo-user-landlord'");
      if (demoUser) return demoUser.id;
    }
    return userId;
  }

  async function openMenu(input) {
    const who = await identity(input.lineUserId, input.displayName);
    const effectiveUserId = await getEffectiveUserId(who.userId);
    await flows.cancelFlow(db, who.lineIdentityId, now());
    await flows.startFlow(db, { lineIdentityId: who.lineIdentityId, stepCode: 'report_menu', now: now() });
    
    const summary = await reportRepository.getPortfolioSummary(db, effectiveUserId);
    return { handled: true, messages: [presenter.reportMenuCard(summary)] };
  }

  async function handleText(input) {
    const value = String(input.text || '').trim();
    if (value === '報表分析') return await openMenu(input);
    if (!input.lineUserId) return { handled: false, messages: [] };
    
    const who = await identity(input.lineUserId, input.displayName);
    const flow = await flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow || !flow.publicId.startsWith('line-flow-')) return { handled: false, messages: [] };
    
    if (value === '取消') {
      await flows.finishFlow(db, flow.publicId, 'cancelled', now());
      return { handled: true, messages: [text('已離開報表分析。')] };
    }
    
    return { handled: false, messages: [] };
  }

  async function handlePostback(input) {
    if (!input.lineUserId) return { handled: false, messages: [] };
    const action = params(input.data);
    if (!action.action || !action.action.startsWith('report_')) return { handled: false, messages: [] };
    
    const who = await identity(input.lineUserId, input.displayName);
    const effectiveUserId = await getEffectiveUserId(who.userId);
    const flow = await flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow) return { handled: true, messages: [text('操作已逾時，請重新輸入「報表分析」。')] };

    if (action.action === 'report_menu') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_menu', now: now() });
      const summary = await reportRepository.getPortfolioSummary(db, effectiveUserId);
      return { handled: true, messages: [presenter.reportMenuCard(summary)] };
    }
    
    if (action.action === 'report_revenue') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_revenue', now: now() });
      const revenueData = await reportRepository.getRevenueOverview(db, effectiveUserId);
      return { handled: true, messages: [presenter.revenueCard(revenueData)] };
    }
    
    if (action.action === 'report_revenue_trend') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_revenue_trend', now: now() });
      const trendData = await reportRepository.getMonthlyRevenueTrend(db, effectiveUserId, 6);
      return { handled: true, messages: [presenter.revenueTrendCard(trendData)] };
    }
    
    if (action.action === 'report_rental') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_rental', now: now() });
      const rentalData = await reportRepository.getRentalTrend(db, effectiveUserId);
      return { handled: true, messages: [presenter.rentalTrendCard(rentalData)] };
    }
    
    if (action.action === 'report_property') {
      await flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_property', now: now() });
      const propertyData = await reportRepository.getPropertyPerformance(db, effectiveUserId);
      return { handled: true, messages: [presenter.propertyPerformanceCarousel(propertyData)] };
    }

    return { handled: true, messages: [text('無法辨識這個報表操作，請重新點選。')] };
  }

  return { handlePostback, handleText };
}

module.exports = { createLandlordReportLineServiceAsync };