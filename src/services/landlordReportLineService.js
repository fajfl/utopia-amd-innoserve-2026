const { findOrCreateLineUser } = require('../repositories/v2InquiryRepository');
const reportRepository = require('../repositories/v2LandlordReportRepository');
const flows = require('../repositories/v2LineFlowRepository');
const presenter = require('./landlordReportLinePresenter');

function params(value) {
  return Object.fromEntries(new URLSearchParams(String(value || '')).entries());
}

function text(message) { return { type: 'text', text: message }; }

function createLandlordReportLineService({ db, now = () => new Date() }) {
  function identity(lineUserId, displayName) {
    return findOrCreateLineUser(db, { lineUserId, displayName });
  }

  function getEffectiveUserId(userId) {
    if (String(process.env.LANDLORD_REPORT_DEMO_ENABLED).toLowerCase() === 'true') {
      const demoUser = db.prepare("SELECT id FROM users WHERE public_id = 'demo-user-landlord'").get();
      if (demoUser) return demoUser.id;
    }
    return userId;
  }

  function openMenu(input) {
    const who = identity(input.lineUserId, input.displayName);
    const effectiveUserId = getEffectiveUserId(who.userId);
    flows.cancelFlow(db, who.lineIdentityId, now());
    flows.startFlow(db, { lineIdentityId: who.lineIdentityId, stepCode: 'report_menu', now: now() });
    
    const summary = reportRepository.getPortfolioSummary(db, effectiveUserId);
    return { handled: true, messages: [presenter.reportMenuCard(summary)] };
  }

  function handleText(input) {
    const value = String(input.text || '').trim();
    if (value === '報表分析') return openMenu(input);
    if (!input.lineUserId) return { handled: false, messages: [] };
    
    const who = identity(input.lineUserId, input.displayName);
    const flow = flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow || !flow.publicId.startsWith('line-flow-')) return { handled: false, messages: [] };
    
    if (value === '取消') {
      flows.finishFlow(db, flow.publicId, 'cancelled', now());
      return { handled: true, messages: [text('已離開報表分析。')] };
    }
    
    return { handled: false, messages: [] };
  }

  function handlePostback(input) {
    if (!input.lineUserId) return { handled: false, messages: [] };
    const action = params(input.data);
    if (!action.action || !action.action.startsWith('report_')) return { handled: false, messages: [] };
    
    const who = identity(input.lineUserId, input.displayName);
    const effectiveUserId = getEffectiveUserId(who.userId);
    const flow = flows.getActiveFlow(db, who.lineIdentityId, now());
    if (!flow) return { handled: true, messages: [text('操作已逾時，請重新輸入「報表分析」。')] };

    if (action.action === 'report_menu') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_menu', now: now() });
      const summary = reportRepository.getPortfolioSummary(db, effectiveUserId);
      return { handled: true, messages: [presenter.reportMenuCard(summary)] };
    }
    
    if (action.action === 'report_revenue') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_revenue', now: now() });
      const revenueData = reportRepository.getRevenueOverview(db, effectiveUserId);
      return { handled: true, messages: [presenter.revenueCard(revenueData)] };
    }
    
    if (action.action === 'report_revenue_trend') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_revenue_trend', now: now() });
      const trendData = reportRepository.getMonthlyRevenueTrend(db, effectiveUserId, 6);
      return { handled: true, messages: [presenter.revenueTrendCard(trendData)] };
    }
    
    if (action.action === 'report_rental') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_rental', now: now() });
      const rentalData = reportRepository.getRentalTrend(db, effectiveUserId);
      return { handled: true, messages: [presenter.rentalTrendCard(rentalData)] };
    }
    
    if (action.action === 'report_property') {
      flows.advanceFlow(db, { publicId: flow.publicId, stepCode: 'report_property', now: now() });
      const propertyData = reportRepository.getPropertyPerformance(db, effectiveUserId);
      return { handled: true, messages: [presenter.propertyPerformanceCarousel(propertyData)] };
    }

    return { handled: true, messages: [text('無法辨識這個報表操作，請重新點選。')] };
  }

  return { handlePostback, handleText };
}

module.exports = { createLandlordReportLineService };