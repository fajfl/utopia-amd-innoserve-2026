CREATE VIEW vw_landlord_portfolio_summary AS
SELECT
  po.owner_user_id AS landlord_user_id,
  COUNT(DISTINCT po.property_id) AS property_count,
  COUNT(DISTINCT COALESCE(po.rental_unit_id, ru.id)) AS unit_count,
  COUNT(DISTINCT CASE WHEN l.status = 'published' THEN l.id END) AS active_listing_count,
  COUNT(DISTINCT CASE WHEN le.status IN ('scheduled', 'active') THEN le.id END) AS active_lease_count,
  COUNT(DISTINCT CASE WHEN i.ended_at IS NULL THEN i.id END) AS open_inquiry_count
FROM property_owners po
LEFT JOIN rental_units ru
  ON ru.property_id = po.property_id
 AND (po.rental_unit_id IS NULL OR ru.id = po.rental_unit_id)
LEFT JOIN listings l ON l.rental_unit_id = ru.id
LEFT JOIN inquiries i ON i.listing_id = l.id
LEFT JOIN leases le ON le.rental_unit_id = ru.id
WHERE po.effective_until IS NULL OR po.effective_until >= date('now')
GROUP BY po.owner_user_id;

CREATE VIEW vw_listing_funnel AS
SELECT
  l.id AS listing_id,
  l.public_id AS listing_public_id,
  l.rental_unit_id,
  l.status AS listing_status,
  (SELECT COUNT(*) FROM inquiries i WHERE i.listing_id = l.id) AS inquiry_count,
  (SELECT COUNT(*) FROM inquiries i WHERE i.listing_id = l.id AND i.ended_at IS NULL) AS active_inquiry_count,
  (SELECT COUNT(*) FROM rental_intentions ri WHERE ri.listing_id = l.id) AS intention_count,
  (
    SELECT COUNT(*)
    FROM rental_intentions ri
    WHERE ri.listing_id = l.id
      AND ri.status IN ('submitted', 'under_review', 'accepted', 'contracting')
  ) AS active_intention_count,
  (
    SELECT COUNT(*)
    FROM contracts c
    JOIN rental_intentions ri ON ri.id = c.selected_intention_id
    WHERE ri.listing_id = l.id
  ) AS contract_count,
  (
    SELECT COUNT(*)
    FROM leases le
    JOIN contracts c ON c.id = le.contract_id
    JOIN rental_intentions ri ON ri.id = c.selected_intention_id
    WHERE ri.listing_id = l.id
  ) AS lease_count
FROM listings l;

CREATE VIEW vw_monthly_collection AS
SELECT
  bc.lease_id,
  substr(bc.billing_period_start, 1, 7) AS billing_month,
  SUM(bc.amount) AS charged_amount,
  SUM(
    COALESCE((
      SELECT SUM(pr.amount)
      FROM payment_records pr
      WHERE pr.billing_charge_id = bc.id
        AND pr.status != 'reversed'
    ), 0)
  ) AS paid_amount,
  SUM(bc.amount) - SUM(
    COALESCE((
      SELECT SUM(pr.amount)
      FROM payment_records pr
      WHERE pr.billing_charge_id = bc.id
        AND pr.status != 'reversed'
    ), 0)
  ) AS outstanding_amount,
  COUNT(*) AS charge_count,
  SUM(CASE WHEN bc.status = 'overdue' THEN 1 ELSE 0 END) AS overdue_charge_count
FROM billing_charges bc
WHERE bc.status NOT IN ('cancelled', 'waived')
GROUP BY bc.lease_id, substr(bc.billing_period_start, 1, 7);

CREATE VIEW vw_repair_performance AS
SELECT
  rt.rental_unit_id,
  COUNT(*) AS ticket_count,
  SUM(CASE WHEN rt.status IN ('tenant_confirmed', 'cancelled') THEN 1 ELSE 0 END) AS completed_count,
  SUM(CASE WHEN rt.status NOT IN ('tenant_confirmed', 'cancelled') THEN 1 ELSE 0 END) AS open_count,
  ROUND(AVG(
    CASE
      WHEN rt.completed_at IS NOT NULL
      THEN (julianday(rt.completed_at) - julianday(rt.reported_at)) * 24.0
    END
  ), 2) AS average_completion_hours,
  SUM(CASE WHEN rt.priority = 'urgent' THEN 1 ELSE 0 END) AS urgent_count
FROM repair_tickets rt
GROUP BY rt.rental_unit_id;

CREATE VIEW vw_ai_knowledge_coverage AS
SELECT
  l.id AS listing_id,
  l.public_id AS listing_public_id,
  l.rental_unit_id,
  (
    SELECT COUNT(DISTINCT kv.id)
    FROM knowledge_versions kv
    JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
    JOIN knowledge_scope_links ksl ON ksl.knowledge_version_id = kv.id
    JOIN rental_units scoped_unit ON scoped_unit.id = l.rental_unit_id
    WHERE ki.status = 'active'
      AND kv.visibility = 'public'
      AND kv.approved_at IS NOT NULL
      AND kv.superseded_by_version_id IS NULL
      AND (kv.effective_until IS NULL OR kv.effective_until >= CURRENT_TIMESTAMP)
      AND (
        ksl.rental_unit_id = l.rental_unit_id
        OR ksl.property_id = scoped_unit.property_id
      )
  ) AS active_public_knowledge_count,
  (
    SELECT COUNT(DISTINCT kv.id)
    FROM knowledge_versions kv
    JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
    JOIN knowledge_scope_links ksl ON ksl.knowledge_version_id = kv.id
    JOIN rental_units scoped_unit ON scoped_unit.id = l.rental_unit_id
    WHERE ki.status = 'active'
      AND kv.visibility = 'internal'
      AND kv.superseded_by_version_id IS NULL
      AND (
        ksl.rental_unit_id = l.rental_unit_id
        OR ksl.property_id = scoped_unit.property_id
      )
  ) AS active_internal_knowledge_count,
  (
    SELECT COUNT(*)
    FROM landlord_questions lq
    WHERE lq.listing_id = l.id
      AND lq.status IN ('pending', 'notified')
  ) AS pending_landlord_question_count
FROM listings l;

CREATE VIEW vw_contract_attention AS
SELECT
  c.id AS contract_id,
  c.public_id AS contract_public_id,
  c.rental_unit_id,
  c.status AS contract_status,
  (
    SELECT COUNT(*)
    FROM signature_requests sr
    JOIN contract_versions cv ON cv.id = sr.contract_version_id
    JOIN contract_parties cp ON cp.id = sr.contract_party_id
    WHERE cv.contract_id = c.id
      AND cp.required_signer = 1
      AND sr.status NOT IN ('signed', 'cancelled')
  ) AS pending_signature_count,
  (
    SELECT MIN(sr.expires_at)
    FROM signature_requests sr
    JOIN contract_versions cv ON cv.id = sr.contract_version_id
    WHERE cv.contract_id = c.id
      AND sr.status NOT IN ('signed', 'cancelled')
  ) AS nearest_signature_expiry,
  le.end_date AS lease_end_date,
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM signature_requests sr
      JOIN contract_versions cv ON cv.id = sr.contract_version_id
      JOIN contract_parties cp ON cp.id = sr.contract_party_id
      WHERE cv.contract_id = c.id
        AND cp.required_signer = 1
        AND sr.status NOT IN ('signed', 'cancelled')
    ) THEN 'pending_signature'
    WHEN le.end_date IS NOT NULL AND date(le.end_date) <= date('now', '+30 days') THEN 'lease_expiring'
    ELSE NULL
  END AS attention_reason
FROM contracts c
LEFT JOIN leases le ON le.contract_id = c.id;
