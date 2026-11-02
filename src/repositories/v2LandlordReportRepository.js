const crypto = require('node:crypto');

function getRevenueOverview(db, landlordUserId) {
  const currentMonth = new Date().toISOString().slice(0, 7); // e.g. "2026-07"
  
  // Get all active leases for this landlord
  const activeLeasesQuery = db.prepare(`
    SELECT le.id 
    FROM leases le
    JOIN rental_units ru ON ru.id = le.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id 
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    WHERE po.owner_user_id = ? 
      AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
  `).all(landlordUserId);

  const activeLeaseIds = activeLeasesQuery.map(r => r.id);
  
  if (activeLeaseIds.length === 0) {
    return {
      currentMonth,
      chargedAmount: 0,
      paidAmount: 0,
      outstandingAmount: 0,
      collectionRate: 0,
      chargeCount: 0,
      overdueChargeCount: 0,
      chargeTypes: []
    };
  }

  const placeholders = activeLeaseIds.map(() => '?').join(',');

  // Aggregate monthly collection for these leases
  const collectionData = db.prepare(`
    SELECT 
      SUM(charged_amount) as total_charged,
      SUM(paid_amount) as total_paid,
      SUM(outstanding_amount) as total_outstanding,
      SUM(charge_count) as total_charges,
      SUM(overdue_charge_count) as total_overdue
    FROM vw_monthly_collection
    WHERE lease_id IN (${placeholders}) AND billing_month = ?
  `).get(...activeLeaseIds, currentMonth);

  // Breakdown by charge type for the current month
  const chargeTypesData = db.prepare(`
    SELECT charge_type, SUM(amount) as total_amount
    FROM billing_charges
    WHERE lease_id IN (${placeholders}) 
      AND substr(billing_period_start, 1, 7) = ?
      AND status NOT IN ('cancelled', 'waived')
    GROUP BY charge_type
  `).all(...activeLeaseIds, currentMonth);

  const charged = collectionData?.total_charged || 0;
  const paid = collectionData?.total_paid || 0;
  const collectionRate = charged > 0 ? Math.round((paid / charged) * 100) : 0;

  return {
    currentMonth,
    chargedAmount: charged,
    paidAmount: paid,
    outstandingAmount: collectionData?.total_outstanding || 0,
    collectionRate,
    chargeCount: collectionData?.total_charges || 0,
    overdueChargeCount: collectionData?.total_overdue || 0,
    chargeTypes: chargeTypesData
  };
}

function getMonthlyRevenueTrend(db, landlordUserId, months = 6) {
  // Get active leases
  const activeLeasesQuery = db.prepare(`
    SELECT le.id 
    FROM leases le
    JOIN rental_units ru ON ru.id = le.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id 
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    WHERE po.owner_user_id = ? 
      AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
  `).all(landlordUserId);

  const activeLeaseIds = activeLeasesQuery.map(r => r.id);
  if (activeLeaseIds.length === 0) return [];

  const placeholders = activeLeaseIds.map(() => '?').join(',');

  const trendData = db.prepare(`
    SELECT 
      billing_month,
      SUM(charged_amount) as charged,
      SUM(paid_amount) as paid
    FROM vw_monthly_collection
    WHERE lease_id IN (${placeholders})
    GROUP BY billing_month
    ORDER BY billing_month DESC
    LIMIT ?
  `).all(...activeLeaseIds, months);

  return trendData.reverse();
}

function getRentalTrend(db, landlordUserId) {
  const summary = db.prepare(`
    SELECT * FROM vw_landlord_portfolio_summary WHERE landlord_user_id = ?
  `).get(landlordUserId);

  if (!summary) {
    return { summary: null, funnel: null, vacantUnits: [] };
  }

  const funnel = db.prepare(`
    SELECT 
      SUM(inquiry_count) as total_inquiries,
      SUM(intention_count) as total_intentions,
      SUM(contract_count) as total_contracts,
      SUM(lease_count) as total_leases
    FROM vw_listing_funnel f
    JOIN listings l ON l.id = f.listing_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.property_id = ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    WHERE po.owner_user_id = ?
  `).get(landlordUserId);

  const vacantUnits = db.prepare(`
    SELECT 
      ru.public_id as unit_public_id,
      ru.unit_label,
      p.address_text,
      l.current_rent_amount as rent,
      l.status as listing_status
    FROM rental_units ru
    JOIN properties p ON p.id = ru.property_id
    JOIN property_owners po ON po.property_id = p.id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    LEFT JOIN listings l ON l.rental_unit_id = ru.id AND l.status = 'published'
    WHERE po.owner_user_id = ? 
      AND ru.status IN ('available', 'marketing')
    LIMIT 3
  `).all(landlordUserId);

  return { summary, funnel, vacantUnits };
}

function getPropertyPerformance(db, landlordUserId) {
  const properties = db.prepare(`
    SELECT 
      ru.id as unit_id,
      ru.public_id as unit_public_id,
      ru.unit_label,
      p.address_text,
      ru.status as unit_status,
      l.id as listing_id,
      l.current_rent_amount as rent
    FROM rental_units ru
    JOIN properties p ON p.id = ru.property_id
    JOIN property_owners po ON po.property_id = p.id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
    LEFT JOIN listings l ON l.rental_unit_id = ru.id 
      AND l.id = (
        SELECT id FROM listings sub_l 
        WHERE sub_l.rental_unit_id = ru.id 
        ORDER BY sub_l.created_at DESC LIMIT 1
      )
    WHERE po.owner_user_id = ? 
      AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
  `).all(landlordUserId);

  const result = [];
  for (const prop of properties) {
    const repair = db.prepare(`SELECT * FROM vw_repair_performance WHERE rental_unit_id = ?`).get(prop.unit_id);
    let knowledge = null;
    if (prop.listing_id) {
       knowledge = db.prepare(`SELECT * FROM vw_ai_knowledge_coverage WHERE listing_id = ?`).get(prop.listing_id);
    }
    
    // Get active lease for this unit to check contract attention
    const activeLease = db.prepare(`
      SELECT le.contract_id 
      FROM leases le 
      WHERE le.rental_unit_id = ? AND le.status IN ('scheduled', 'active')
      ORDER BY le.start_date DESC LIMIT 1
    `).get(prop.unit_id);

    let contractAttention = null;
    if (activeLease && activeLease.contract_id) {
       contractAttention = db.prepare(`SELECT * FROM vw_contract_attention WHERE contract_id = ?`).get(activeLease.contract_id);
    }

    result.push({
      ...prop,
      repair: repair || { ticket_count: 0, completed_count: 0, average_completion_hours: 0 },
      knowledge: knowledge || { active_public_knowledge_count: 0, active_internal_knowledge_count: 0 },
      contractAttention
    });
  }

  return result;
}

function getPortfolioSummary(db, landlordUserId) {
  return db.prepare(`SELECT * FROM vw_landlord_portfolio_summary WHERE landlord_user_id = ?`).get(landlordUserId);
}

module.exports = {
  getRevenueOverview,
  getMonthlyRevenueTrend,
  getRentalTrend,
  getPropertyPerformance,
  getPortfolioSummary
};