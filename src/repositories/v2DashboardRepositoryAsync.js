function currentDateSql(db) {
  return db && db.dialect && db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";
}

async function monthKey(value) {
  if (typeof value === 'string') return value.slice(0, 7);
  const date = value instanceof Date ? value : new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}`;
}

async function findDashboardOwnerUserId(db, lineUserId) {
  if (!lineUserId) return null;
  const row = await db.get(`
    SELECT u.id AS user_id
    FROM line_identities li
    JOIN users u ON u.id = li.user_id
    WHERE li.line_user_id = ?
      AND u.status = 'active'
    LIMIT 1
  `, [lineUserId]);
  if (!row) return null;

  const dateExpr = currentDateSql(db);
  const portfolio = await db.get(`
    SELECT COUNT(*) AS count
    FROM property_owners
    WHERE owner_user_id = ?
      AND (effective_until IS NULL OR effective_until >= ${dateExpr})
  `, [row.user_id]);
  return portfolio && portfolio.count > 0 ? row.user_id : null;
}

async function getPortfolioSummary(db, ownerUserId) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.get(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id, ru.status
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    ),
    occupied_units AS (
      SELECT DISTINCT su.id
      FROM scoped_units su
      LEFT JOIN leases le
        ON le.rental_unit_id = su.id
       AND le.status IN ('scheduled', 'active')
      WHERE su.status = 'leased'
         OR le.id IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM scoped_units) AS total_unit_count,
      (SELECT COUNT(*) FROM occupied_units) AS occupied_unit_count,
      (SELECT COUNT(*) FROM scoped_units) - (SELECT COUNT(*) FROM occupied_units) AS vacant_unit_count
  `, { ownerUserId });
}

async function getMonthlyRentCollection(db, ownerUserId, targetMonth) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.get(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    ),
    scoped_charges AS (
      SELECT DISTINCT bc.id, bc.amount
      FROM billing_charges bc
      JOIN leases le ON le.id = bc.lease_id
      JOIN scoped_units su ON su.id = le.rental_unit_id
      WHERE bc.charge_type = 'rent'
        AND bc.status NOT IN ('cancelled', 'waived')
        AND substr(bc.billing_period_start, 1, 7) = @targetMonth
    )
    SELECT
      COALESCE(SUM(sc.amount), 0) AS expected_rent_amount,
      COALESCE((
        SELECT SUM(pr.amount)
        FROM payment_records pr
        JOIN scoped_charges sc2 ON sc2.id = pr.billing_charge_id
        WHERE pr.status != 'reversed'
      ), 0) AS received_rent_amount,
      COUNT(sc.id) AS rent_charge_count
    FROM scoped_charges sc
  `, { ownerUserId, targetMonth });
}

async function getOperationalSummary(db, ownerUserId) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.get(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      (
        SELECT COUNT(DISTINCT l.id)
        FROM listings l
        JOIN scoped_units su ON su.id = l.rental_unit_id
        WHERE l.status = 'published'
      ) AS published_listing_count,
      (
        SELECT COUNT(DISTINCT i.id)
        FROM inquiries i
        JOIN listings l ON l.id = i.listing_id
        JOIN scoped_units su ON su.id = l.rental_unit_id
        WHERE i.ended_at IS NULL
      ) AS open_inquiry_count,
      (
        SELECT COUNT(DISTINCT rt.id)
        FROM repair_tickets rt
        JOIN scoped_units su ON su.id = rt.rental_unit_id
        WHERE rt.status NOT IN ('tenant_confirmed', 'cancelled')
      ) AS open_repair_ticket_count,
      (
        SELECT COUNT(DISTINCT sr.id)
        FROM signature_requests sr
        JOIN contract_versions cv ON cv.id = sr.contract_version_id
        JOIN contracts c ON c.id = cv.contract_id
        JOIN scoped_units su ON su.id = c.rental_unit_id
        WHERE sr.status NOT IN ('signed', 'cancelled')
      ) AS pending_signature_count,
      (
        SELECT COUNT(DISTINCT bc.id)
        FROM billing_charges bc
        JOIN leases le ON le.id = bc.lease_id
        JOIN scoped_units su ON su.id = le.rental_unit_id
        WHERE bc.status = 'overdue'
      ) AS overdue_charge_count
  `, { ownerUserId });
}

async function getFunnelSummary(db, ownerUserId) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.get(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    ),
    scoped_listings AS (
      SELECT DISTINCT l.id
      FROM listings l
      JOIN scoped_units su ON su.id = l.rental_unit_id
    )
    SELECT
      (
        SELECT COUNT(DISTINCT lee.id)
        FROM listing_entry_events lee
        JOIN scoped_listings sl ON sl.id = lee.listing_id
        WHERE lee.result IN ('opened', 'created', 'restored', 'bound')
      ) AS entry_event_count,
      (
        SELECT COUNT(DISTINCT lee.id)
        FROM listing_entry_events lee
        JOIN scoped_listings sl ON sl.id = lee.listing_id
        WHERE lee.result IN ('bound', 'created', 'restored')
      ) AS bound_entry_count,
      (
        SELECT COUNT(DISTINCT i.id)
        FROM inquiries i
        JOIN scoped_listings sl ON sl.id = i.listing_id
      ) AS inquiry_count,
      (
        SELECT COUNT(DISTINCT ri.id)
        FROM rental_intentions ri
        JOIN scoped_listings sl ON sl.id = ri.listing_id
        WHERE ri.status NOT IN ('draft', 'rejected', 'withdrawn', 'leased_to_another_tenant', 'ended')
      ) AS intention_count,
      (
        SELECT COUNT(DISTINCT c.id)
        FROM contracts c
        JOIN scoped_units su ON su.id = c.rental_unit_id
        WHERE c.status IN ('awaiting_confirmation', 'signing', 'executed')
      ) AS contract_count,
      (
        SELECT COUNT(DISTINCT le.id)
        FROM leases le
        JOIN scoped_units su ON su.id = le.rental_unit_id
        WHERE le.status IN ('scheduled', 'active')
      ) AS lease_count
  `, { ownerUserId });
}

async function getKnowledgeSummary(db, ownerUserId) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.get(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id, ru.property_id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    ),
    scoped_listings AS (
      SELECT DISTINCT l.id
      FROM listings l
      JOIN scoped_units su ON su.id = l.rental_unit_id
    ),
    scoped_knowledge_versions AS (
      SELECT DISTINCT kv.id, kv.visibility, kv.use_policy
      FROM knowledge_versions kv
      JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
      JOIN knowledge_scope_links ksl ON ksl.knowledge_version_id = kv.id
      JOIN scoped_units su
        ON su.id = ksl.rental_unit_id
        OR su.property_id = ksl.property_id
      WHERE ki.status = 'active'
        AND kv.approved_at IS NOT NULL
        AND kv.effective_until IS NULL
    )
    SELECT
      (
        SELECT COUNT(DISTINCT skv.id)
        FROM scoped_knowledge_versions skv
        WHERE skv.visibility = 'public'
      ) AS public_knowledge_count,
      (
        SELECT COUNT(DISTINCT skv.id)
        FROM scoped_knowledge_versions skv
        WHERE skv.visibility = 'internal'
      ) AS internal_knowledge_count,
      (
        SELECT COUNT(DISTINCT skv.id)
        FROM scoped_knowledge_versions skv
        WHERE skv.use_policy = 'must_escalate'
      ) AS must_escalate_knowledge_count,
      (
        SELECT COUNT(DISTINCT lq.id)
        FROM landlord_questions lq
        JOIN scoped_listings sl ON sl.id = lq.listing_id
        WHERE lq.status IN ('pending', 'notified')
      ) AS pending_landlord_question_count,
      (
        SELECT COUNT(DISTINCT l.id)
        FROM listings l
        JOIN scoped_units su ON su.id = l.rental_unit_id
        WHERE l.status = 'published'
          AND NOT EXISTS (
            SELECT 1
            FROM knowledge_scope_links ksl
            JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
            JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
            WHERE ki.status = 'active'
              AND kv.visibility = 'public'
              AND kv.approved_at IS NOT NULL
              AND kv.effective_until IS NULL
              AND (ksl.rental_unit_id = su.id OR ksl.property_id = su.property_id)
          )
      ) AS listing_without_public_knowledge_count
  `, { ownerUserId });
}

async function getUnitStatusSummary(db, ownerUserId) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.get(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id, ru.status
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_unit_count,
      SUM(CASE WHEN status = 'marketing' THEN 1 ELSE 0 END) AS marketing_unit_count,
      SUM(CASE WHEN status = 'signing' THEN 1 ELSE 0 END) AS signing_unit_count,
      SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_status_unit_count,
      SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) AS maintenance_unit_count
    FROM scoped_units
  `, { ownerUserId });
}

async function getTenantWorkSummary(db, ownerUserId, nowIso) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.get(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    ),
    scoped_listings AS (
      SELECT DISTINCT l.id
      FROM listings l
      JOIN scoped_units su ON su.id = l.rental_unit_id
    )
    SELECT
      (
        SELECT COUNT(DISTINCT lq.id)
        FROM landlord_questions lq
        JOIN scoped_listings sl ON sl.id = lq.listing_id
        WHERE lq.status IN ('pending', 'notified')
      ) AS pending_question_count,
      (
        SELECT COUNT(DISTINCT lq.id)
        FROM landlord_questions lq
        JOIN scoped_listings sl ON sl.id = lq.listing_id
        WHERE lq.status = 'answered'
      ) AS answered_question_count,
      (
        SELECT COUNT(DISTINCT ce.id)
        FROM calendar_events ce
        LEFT JOIN listings l ON l.id = ce.listing_id
        LEFT JOIN inquiries i ON i.id = ce.inquiry_id
        LEFT JOIN listings il ON il.id = i.listing_id
        JOIN scoped_units su ON su.id = COALESCE(l.rental_unit_id, il.rental_unit_id)
        WHERE ce.event_type = 'showing'
          AND ce.status = 'scheduled'
          AND ce.starts_at >= @nowIso
      ) AS upcoming_showing_count,
      (
        SELECT COUNT(DISTINCT ri.id)
        FROM rental_intentions ri
        JOIN scoped_listings sl ON sl.id = ri.listing_id
        WHERE ri.status NOT IN ('draft', 'rejected', 'withdrawn', 'leased_to_another_tenant', 'ended')
      ) AS active_intention_count,
      (
        SELECT COUNT(DISTINCT pis.id)
        FROM pre_inspection_sessions pis
        JOIN scoped_listings sl ON sl.id = pis.listing_id
        WHERE pis.status = 'sealed'
          AND pis.confirmation_status = 'pending_landlord_confirmation'
      ) AS pending_inspection_confirmation_count,
      (
        -- 同步版把 leases 的 rental_unit_id 用純量子查詢塞在 JOIN 的 ON 條件裡,
        -- TiDB 不吃這種寫法,改成先 JOIN leases 再對 scoped_units 收斂。語意相同。
        SELECT COUNT(DISTINCT ic.id)
        FROM inspection_checklists ic
        JOIN leases le ON le.id = ic.lease_id
        JOIN scoped_units su ON su.id = le.rental_unit_id
        WHERE ic.status = 'awaiting_confirmation'
      ) AS pending_canonical_inspection_count
  `, { ownerUserId, nowIso });
}

async function getQuestionItems(db, ownerUserId, limit = 3) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.all(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      COALESCE(up.display_name, (
        SELECT li.display_name_cache FROM line_identities li WHERE li.user_id = i.user_id LIMIT 1
      ), '房客') AS tenant_name,
      COALESCE(ru.unit_label, l.title, '房源') AS unit_label,
      lq.question_text,
      lq.status,
      (
        SELECT COUNT(*) FROM landlord_answers la WHERE la.landlord_question_id = lq.id
      ) AS answer_count
    FROM landlord_questions lq
    JOIN inquiries i ON i.id = lq.inquiry_id
    JOIN listings l ON l.id = lq.listing_id
    JOIN scoped_units su ON su.id = l.rental_unit_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    LEFT JOIN user_profiles up ON up.user_id = i.user_id
    ORDER BY
      CASE WHEN lq.status IN ('pending', 'notified') THEN 0 ELSE 1 END,
      lq.asked_at DESC
    LIMIT @limit
  `, { ownerUserId, limit });
}

async function getShowingItems(db, ownerUserId, nowIso, limit = 3) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.all(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      COALESCE(up.display_name, (
        SELECT li.display_name_cache FROM line_identities li WHERE li.user_id = i.user_id LIMIT 1
      ), '房客') AS tenant_name,
      COALESCE(ru.unit_label, l.title, ce.title, '房源') AS unit_label,
      ce.title,
      ce.starts_at,
      ce.status
    FROM calendar_events ce
    LEFT JOIN inquiries i ON i.id = ce.inquiry_id
    LEFT JOIN listings l ON l.id = COALESCE(ce.listing_id, i.listing_id)
    LEFT JOIN rental_units ru ON ru.id = l.rental_unit_id
    LEFT JOIN user_profiles up ON up.user_id = i.user_id
    JOIN scoped_units su ON su.id = ru.id
    WHERE ce.event_type = 'showing'
      AND ce.status != 'cancelled'
    ORDER BY
      CASE WHEN ce.status = 'scheduled' AND ce.starts_at >= @nowIso THEN 0 ELSE 1 END,
      ce.starts_at ASC
    LIMIT @limit
  `, { ownerUserId, nowIso, limit });
}

async function getIntentionItems(db, ownerUserId, limit = 3) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.all(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    ),
    latest_versions AS (
      SELECT iv.*
      FROM intention_versions iv
      JOIN (
        SELECT rental_intention_id, MAX(version_number) AS version_number
        FROM intention_versions
        GROUP BY rental_intention_id
      ) latest
        ON latest.rental_intention_id = iv.rental_intention_id
       AND latest.version_number = iv.version_number
    )
    SELECT
      COALESCE(up.display_name, (
        SELECT li.display_name_cache FROM line_identities li WHERE li.user_id = ri.tenant_user_id LIMIT 1
      ), '房客') AS tenant_name,
      COALESCE(ru.unit_label, l.title, '房源') AS unit_label,
      ri.status,
      lv.rent_amount,
      lv.lease_start_date,
      lv.move_in_date,
      lv.pet_request_text,
      lv.equipment_request_text,
      lv.viewing_request_text,
      lv.special_request_text
    FROM rental_intentions ri
    JOIN listings l ON l.id = ri.listing_id
    JOIN scoped_units su ON su.id = l.rental_unit_id
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    LEFT JOIN latest_versions lv ON lv.rental_intention_id = ri.id
    LEFT JOIN user_profiles up ON up.user_id = ri.tenant_user_id
    WHERE ri.status NOT IN ('rejected', 'withdrawn', 'leased_to_another_tenant', 'ended')
    ORDER BY ri.updated_at DESC
    LIMIT @limit
  `, { ownerUserId, limit });
}

async function getRepairItems(db, ownerUserId, limit = 3) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.all(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      COALESCE(up.display_name, (
        SELECT li.display_name_cache FROM line_identities li WHERE li.user_id = rt.reported_by_user_id LIMIT 1
      ), '房客') AS tenant_name,
      ru.unit_label,
      rt.category,
      rt.description,
      rt.priority,
      rt.status,
      rt.reported_at
    FROM repair_tickets rt
    JOIN scoped_units su ON su.id = rt.rental_unit_id
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    LEFT JOIN user_profiles up ON up.user_id = rt.reported_by_user_id
    WHERE rt.status NOT IN ('tenant_confirmed', 'cancelled')
    ORDER BY
      CASE rt.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      rt.reported_at DESC
    LIMIT @limit
  `, { ownerUserId, limit });
}

async function getInspectionItems(db, ownerUserId, limit = 5) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  // 房客送簽時被推進 pending_landlord_confirmation 的屋況紀錄要有一個不依賴推播的落點。
  // 欄位與同步版 getInspectionItems 完全一致(presenter 兩邊共用):
  // source_type / public_id / tenant_name / unit_label / inspection_type / title / status / event_at。
  //
  // 與同步版的兩處差異都是 TiDB 相容性,不是語意:
  //   1. canonical 那支改成先 JOIN leases,不在 JOIN ON 裡放子查詢。
  //   2. UNION ALL 的衍生表必須有別名,MySQL 少了別名會 ER_DERIVED_MUST_HAVE_ALIAS。
  return await db.all(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    ),
    scoped_listings AS (
      SELECT DISTINCT l.id, l.rental_unit_id
      FROM listings l
      JOIN scoped_units su ON su.id = l.rental_unit_id
    ),
    pending_line_inspections AS (
      SELECT
        'line_pre_inspection' AS source_type,
        pis.public_id,
        COALESCE(up.display_name, li.display_name_cache, '房客') AS tenant_name,
        COALESCE(ru.unit_label, l.title, '房源') AS unit_label,
        pis.record_type AS inspection_type,
        pis.title,
        pis.confirmation_status AS status,
        COALESCE(pis.submitted_to_landlord_at, pis.sealed_at, pis.updated_at, pis.created_at) AS event_at
      FROM pre_inspection_sessions pis
      JOIN scoped_listings sl ON sl.id = pis.listing_id
      JOIN listings l ON l.id = pis.listing_id
      JOIN rental_units ru ON ru.id = l.rental_unit_id
      LEFT JOIN line_identities li ON li.line_user_id = pis.line_user_id
      LEFT JOIN user_profiles up ON up.user_id = li.user_id
      WHERE pis.status = 'sealed'
        AND pis.confirmation_status = 'pending_landlord_confirmation'
    ),
    pending_canonical_inspections AS (
      SELECT
        'inspection_checklist' AS source_type,
        ic.public_id,
        '房客' AS tenant_name,
        ru.unit_label,
        ic.checklist_type AS inspection_type,
        CASE ic.checklist_type WHEN 'move_in' THEN '入住點交' ELSE '退租點交' END AS title,
        ic.status,
        COALESCE(ic.performed_at, ic.scheduled_at, ic.updated_at, ic.created_at) AS event_at
      FROM inspection_checklists ic
      JOIN leases le ON le.id = ic.lease_id
      JOIN scoped_units su ON su.id = le.rental_unit_id
      JOIN rental_units ru ON ru.id = le.rental_unit_id
      WHERE ic.status = 'awaiting_confirmation'
    )
    SELECT *
    FROM (
      SELECT * FROM pending_line_inspections
      UNION ALL
      SELECT * FROM pending_canonical_inspections
    ) AS pending_inspections
    ORDER BY event_at DESC
    LIMIT @limit
  `, { ownerUserId, limit });
}

async function getCashflowItems(db, ownerUserId, targetMonth, limit = 4) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.all(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      ru.unit_label,
      bc.charge_type,
      bc.status,
      bc.amount,
      bc.due_date,
      (
        SELECT COALESCE(SUM(pr.amount), 0)
        FROM payment_records pr
        WHERE pr.billing_charge_id = bc.id
          AND pr.status != 'reversed'
      ) AS paid_amount
    FROM billing_charges bc
    JOIN leases le ON le.id = bc.lease_id
    JOIN scoped_units su ON su.id = le.rental_unit_id
    JOIN rental_units ru ON ru.id = le.rental_unit_id
    WHERE bc.status NOT IN ('cancelled', 'waived')
      AND substr(bc.billing_period_start, 1, 7) = @targetMonth
    ORDER BY
      CASE bc.status WHEN 'overdue' THEN 0 WHEN 'pending' THEN 1 WHEN 'partially_paid' THEN 2 ELSE 3 END,
      bc.due_date ASC
    LIMIT @limit
  `, { ownerUserId, targetMonth, limit });
}

async function getDashboardOverview(db, { lineUserId, now = new Date() } = {}) {
  const ownerUserId = await findDashboardOwnerUserId(db, lineUserId);
  const targetMonth = await monthKey(now);
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const portfolio = await getPortfolioSummary(db, ownerUserId);
  const collection = await getMonthlyRentCollection(db, ownerUserId, targetMonth);
  const operations = await getOperationalSummary(db, ownerUserId);
  const funnel = await getFunnelSummary(db, ownerUserId);
  const unitStatus = await getUnitStatusSummary(db, ownerUserId);
  const tenantWork = await getTenantWorkSummary(db, ownerUserId, nowIso);
  const totalUnitCount = Number(portfolio?.total_unit_count || 0);
  const occupiedUnitCount = Number(portfolio?.occupied_unit_count || 0);
  const vacantUnitCount = Number(portfolio?.vacant_unit_count || 0);
  const vacancyRate = totalUnitCount > 0 ? vacantUnitCount / totalUnitCount : 0;
  const expectedRentAmount = Number(collection?.expected_rent_amount || 0);
  const receivedRentAmount = Number(collection?.received_rent_amount || 0);

  return {
    targetMonth,
    scope: ownerUserId == null ? 'demo_all' : 'owner',
    ownerUserId,
    totalUnitCount,
    occupiedUnitCount,
    vacantUnitCount,
    vacancyRate,
    occupancyRate: totalUnitCount > 0 ? occupiedUnitCount / totalUnitCount : 0,
    expectedRentAmount,
    receivedRentAmount,
    outstandingRentAmount: Math.max(
      0,
      expectedRentAmount - receivedRentAmount,
    ),
    collectionRate: expectedRentAmount > 0 ? receivedRentAmount / expectedRentAmount : 0,
    rentChargeCount: Number(collection?.rent_charge_count || 0),
    publishedListingCount: Number(operations?.published_listing_count || 0),
    openInquiryCount: Number(operations?.open_inquiry_count || 0),
    openRepairTicketCount: Number(operations?.open_repair_ticket_count || 0),
    pendingSignatureCount: Number(operations?.pending_signature_count || 0),
    overdueChargeCount: Number(operations?.overdue_charge_count || 0),
    entryEventCount: Number(funnel?.entry_event_count || 0),
    boundEntryCount: Number(funnel?.bound_entry_count || 0),
    totalInquiryCount: Number(funnel?.inquiry_count || 0),
    intentionCount: Number(funnel?.intention_count || 0),
    contractCount: Number(funnel?.contract_count || 0),
    leaseCount: Number(funnel?.lease_count || 0),
    pendingLandlordQuestionCount: Number(tenantWork?.pending_question_count || 0),
    answeredLandlordQuestionCount: Number(tenantWork?.answered_question_count || 0),
    upcomingShowingCount: Number(tenantWork?.upcoming_showing_count || 0),
    activeIntentionCount: Number(tenantWork?.active_intention_count || 0),
    pendingInspectionConfirmationCount: Number(tenantWork?.pending_inspection_confirmation_count || 0) +
      Number(tenantWork?.pending_canonical_inspection_count || 0),
    availableUnitCount: Number(unitStatus?.available_unit_count || 0),
    marketingUnitCount: Number(unitStatus?.marketing_unit_count || 0),
    signingUnitCount: Number(unitStatus?.signing_unit_count || 0),
    leasedStatusUnitCount: Number(unitStatus?.leased_status_unit_count || 0),
    maintenanceUnitCount: Number(unitStatus?.maintenance_unit_count || 0),
    questionItems: await getQuestionItems(db, ownerUserId),
    showingItems: await getShowingItems(db, ownerUserId, nowIso),
    intentionItems: await getIntentionItems(db, ownerUserId),
    repairItems: await getRepairItems(db, ownerUserId),
    inspectionItems: await getInspectionItems(db, ownerUserId),
    cashflowItems: await getCashflowItems(db, ownerUserId, targetMonth),
    vacantUnits: await getVacantUnits(db, ownerUserId),
    propertyItems: await getPropertyItems(db, ownerUserId),
    chargeTypeBreakdown: await getChargeTypeBreakdown(db, ownerUserId, targetMonth),
  };
}

async function getVacantUnits(db, ownerUserId) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.all(`
    SELECT
      ru.unit_label,
      p.address_text,
      l.current_rent_amount AS rent,
      l.status AS listing_status
    FROM rental_units ru
    JOIN properties p ON p.id = ru.property_id
    LEFT JOIN property_owners po
      ON po.property_id = p.id
     AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
     AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    LEFT JOIN listings l ON l.rental_unit_id = ru.id AND l.status = 'published'
    WHERE ru.status IN ('available', 'marketing')
      ${ownerFilter}
    LIMIT 5
  `, { ownerUserId });
}

async function getPropertyItems(db, ownerUserId) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  // TiDB 不支援 JOIN ON 裡放子查詢,所以「每個 unit 取最新一筆 listing」先在
  // CTE 算完再 join。同一秒建立多筆時以較大的 id 為準,與原本 created_at DESC
  // 取第一筆的結果一致。
  const units = await db.all(`
    WITH latest_listing_ids AS (
      SELECT l.rental_unit_id, MAX(l.id) AS listing_id
      FROM listings l
      JOIN (
        SELECT rental_unit_id, MAX(created_at) AS created_at
        FROM listings
        GROUP BY rental_unit_id
      ) newest
        ON newest.rental_unit_id = l.rental_unit_id
       AND newest.created_at = l.created_at
      GROUP BY l.rental_unit_id
    )
    SELECT
      ru.id AS unit_id,
      ru.unit_label,
      p.address_text,
      ru.status AS unit_status,
      l.current_rent_amount AS rent
    FROM rental_units ru
    JOIN properties p ON p.id = ru.property_id
    LEFT JOIN property_owners po
      ON po.property_id = p.id
     AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
     AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    LEFT JOIN latest_listing_ids ll ON ll.rental_unit_id = ru.id
    LEFT JOIN listings l ON l.id = ll.listing_id
    WHERE ru.status != 'inactive'
      ${ownerFilter}
  `, { ownerUserId });

  const completionHoursSql = db.dialect?.name === 'mysql'
    ? 'TIMESTAMPDIFF(SECOND, rt.reported_at, rt.completed_at) / 3600.0'
    : '(julianday(rt.completed_at) - julianday(rt.reported_at)) * 24.0';
  return Promise.all(units.map(async (u) => {
    // TiDB 分支可能保留失效的 view definer，直接查本分支的資料表。
    const repair = await db.get(`
      SELECT COUNT(*) AS ticket_count,
        SUM(CASE WHEN rt.status IN ('tenant_confirmed', 'cancelled') THEN 1 ELSE 0 END) AS completed_count,
        ROUND(AVG(CASE WHEN rt.completed_at IS NOT NULL THEN ${completionHoursSql} END), 2) AS average_completion_hours
      FROM repair_tickets rt
      WHERE rt.rental_unit_id = ?
    `, [u.unit_id]);
    return {
      ...u,
      repair_ticket_count: repair ? Number(repair.ticket_count || 0) : 0,
      repair_completed_count: repair ? Number(repair.completed_count || 0) : 0,
      repair_avg_hours: repair ? Number(repair.average_completion_hours || 0) : 0,
    };
  }));
}

async function getChargeTypeBreakdown(db, ownerUserId, targetMonth) {
  const dateExpr = currentDateSql(db);
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return await db.all(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT charge_type, SUM(bc.amount) AS total_amount
    FROM billing_charges bc
    JOIN leases le ON le.id = bc.lease_id
    JOIN scoped_units su ON su.id = le.rental_unit_id
    WHERE bc.status NOT IN ('cancelled', 'waived')
      AND substr(bc.billing_period_start, 1, 7) = @targetMonth
    GROUP BY bc.charge_type
  `, { ownerUserId, targetMonth });
}

module.exports = {
  getDashboardOverview,
};
