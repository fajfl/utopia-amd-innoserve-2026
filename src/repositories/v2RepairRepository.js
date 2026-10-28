const crypto = require('node:crypto');

function iso(value) { return new Date(value || Date.now()).toISOString(); }
function addMinutes(value, minutes) { return new Date(new Date(value).getTime() + minutes * 60000).toISOString(); }
function json(value) { return JSON.stringify(value || {}); }
function parseJson(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }

function legacyDamageToCause(damageType) {
  return {
    natural_wear: 'natural_wear',
    normal_use: 'normal_failure',
    tenant_fault: 'tenant_negligence',
    malicious_damage: 'intentional_damage',
    unknown: 'unknown',
  }[damageType] || 'unknown';
}

function causeToLegacyDamage(causeClassification) {
  return {
    natural_wear: 'natural_wear',
    normal_failure: 'normal_use',
    tenant_negligence: 'tenant_fault',
    intentional_damage: 'malicious_damage',
    external_cause: 'unknown',
    unknown: 'unknown',
  }[causeClassification] || 'unknown';
}

function normalizeRepairRule(row) {
  if (!row) return null;
  const cause = row.cause_classification || legacyDamageToCause(row.damage_type);
  const liability = row.liability_party || (
    row.damage_type === 'natural_wear' || row.damage_type === 'normal_use'
      ? 'none'
      : row.responsible_party
  ) || 'review_required';
  const dispatch = row.dispatch_party || row.repair_executor || 'review_required';
  return {
    ...row,
    cause_classification: cause,
    liability_party: liability,
    dispatch_party: dispatch,
    responsible_party: row.responsible_party || (liability === 'none' ? 'review_required' : liability),
    repair_executor: row.repair_executor || dispatch,
    payer_party: row.payer_party || 'review_required',
  };
}

function sessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    lineIdentityId: row.line_identity_id,
    repairTicketId: row.repair_ticket_id,
    leaseId: row.lease_id,
    rentalUnitId: row.rental_unit_id,
    flowType: row.flow_type,
    stepCode: row.step_code,
    context: parseJson(row.context_json),
    expiresAt: row.expires_at,
  };
}

function getLineIdentity(db, lineUserId) {
  if (!lineUserId) return null;
  return db.prepare(`
    SELECT li.id AS line_identity_id, li.user_id, li.line_user_id, li.display_name_cache
    FROM line_identities li
    JOIN users u ON u.id = li.user_id
    WHERE li.line_user_id = ?
      AND u.status = 'active'
    LIMIT 1
  `).get(lineUserId);
}

function findActiveTenantLease(db, userId) {
  return db.prepare(`
    SELECT
      le.id AS lease_id,
      le.public_id AS lease_public_id,
      le.contract_id,
      le.rental_unit_id,
      ru.unit_label,
      ru.property_id
    FROM lease_parties lp
    JOIN leases le ON le.id = lp.lease_id
    JOIN rental_units ru ON ru.id = le.rental_unit_id
    WHERE lp.user_id = ?
      AND lp.party_role = 'tenant'
      AND le.status IN ('active', 'scheduled')
      AND (lp.effective_until IS NULL OR lp.effective_until >= date('now'))
    ORDER BY CASE le.status WHEN 'active' THEN 0 ELSE 1 END, le.start_date DESC
    LIMIT 1
  `).get(userId);
}

// 原始物況是系統證據，不由房客在報修時自行宣告。優先採用已附在
// 該租約版本的封存點交紀錄；舊租約尚未附檔時，才退回同房源的封存紀錄。
function findLeaseMoveInInspectionEvidence(db, { leaseId, rentalUnitId }) {
  const attached = leaseId ? db.prepare(`
    SELECT pis.public_id AS session_public_id, pis.confirmation_status,
      cca.image_count
    FROM leases le
    JOIN contract_versions cv ON cv.contract_id = le.contract_id
    JOIN contract_condition_attachments cca ON cca.contract_version_id = cv.id
    JOIN pre_inspection_sessions pis ON pis.id = cca.pre_inspection_session_id
    WHERE le.id = ? AND pis.status = 'sealed' AND cca.image_count > 0
    ORDER BY CASE WHEN pis.confirmation_status = 'landlord_confirmed' THEN 0 ELSE 1 END,
      COALESCE(pis.landlord_confirmed_at, pis.sealed_at, pis.updated_at, pis.created_at) DESC
  `).all(leaseId) : [];
  const fallback = attached.length || !rentalUnitId ? [] : db.prepare(`
    SELECT pis.public_id AS session_public_id, pis.confirmation_status,
      COUNT(CASE WHEN pie.entry_type = 'image' THEN 1 END) AS image_count
    FROM pre_inspection_sessions pis
    JOIN listings l ON l.id = pis.listing_id
    LEFT JOIN pre_inspection_entries pie ON pie.session_id = pis.id
    WHERE l.rental_unit_id = ? AND pis.status = 'sealed'
    GROUP BY pis.id
    HAVING COUNT(CASE WHEN pie.entry_type = 'image' THEN 1 END) > 0
    ORDER BY CASE WHEN pis.confirmation_status = 'landlord_confirmed' THEN 0 ELSE 1 END,
      COALESCE(pis.landlord_confirmed_at, pis.sealed_at, pis.updated_at, pis.created_at) DESC
  `).all(rentalUnitId);
  const rows = attached.length ? attached : fallback;
  const imageCount = rows.reduce((total, row) => total + Number(row.image_count || 0), 0);
  if (!rows.length) return {
    status: 'unavailable', source: 'none', imageCount: 0,
    label: '尚無已完成點交照片可比對',
    detail: '系統會保留目前照片；後續可由維修紀錄或其他證據補強。',
  };
  const source = attached.length ? 'contract_attachment' : 'sealed_inspection';
  const landlordConfirmed = rows.some((row) => row.confirmation_status === 'landlord_confirmed');
  return {
    status: 'available', source, imageCount, sessionCount: rows.length,
    sessionPublicIds: rows.map((row) => row.session_public_id), landlordConfirmed,
    label: source === 'contract_attachment'
      ? `已找到租約附件點交照片（${imageCount} 張）`
      : `已找到已封存點交照片（${imageCount} 張）`,
    detail: landlordConfirmed
      ? '此紀錄已由房東確認，系統會作為原始物況比對依據。'
      : '此紀錄已封存，系統會作為原始物況的參考依據。',
  };
}

// 正式屋況點交資料有「點交項目 -> 證據檔」的關聯，才能做逐設備比對。
// 不使用看房階段的泛用照片，且只採用同一租約、已確認的入住前點交項目。
function listLeaseMoveInEvidenceForAsset(db, { leaseId, rentalUnitId, assetId }) {
  if (!leaseId || !rentalUnitId || !assetId) return [];
  const asset = db.prepare(`
    SELECT id, asset_name, source_type, source_id
    FROM rental_unit_assets
    WHERE id = ? AND rental_unit_id = ? AND status = 'active'
    LIMIT 1
  `).get(assetId, rentalUnitId);
  if (!asset) return [];

  const rows = db.prepare(`
    SELECT
      ii.id AS inspection_item_id,
      ii.area_label,
      ii.item_label,
      ii.condition_code,
      ii.note AS item_note,
      f.public_id AS file_public_id,
      f.storage_key,
      f.storage_provider,
      f.original_name,
      f.mime_type,
      ie.note AS evidence_note,
      ie.captured_at
    FROM inspection_checklists ic
    JOIN inspection_items ii ON ii.inspection_checklist_id = ic.id
    JOIN inspection_evidence ie
      ON ie.inspection_item_id = ii.id
     AND ie.evidence_type = 'photo'
    JOIN files f
      ON f.id = ie.file_id
     AND f.status = 'active'
    WHERE ic.lease_id = ?
      AND ic.checklist_type = 'move_in'
      AND ic.status = 'confirmed'
    ORDER BY ii.sort_order, ie.captured_at, ie.id
  `).all(leaseId);

  const normaliseName = (value) => String(value || '')
    .toLowerCase()
    .replace(/[\s\-_/、，,，。．()（）\[\]【】]/g, '');
  const assetName = normaliseName(asset.asset_name);
  return rows.filter((row) => {
    if (asset.source_type === 'inspection_item' && Number(asset.source_id) === Number(row.inspection_item_id)) {
      return true;
    }
    // 舊資料尚未建立 source_id 時，只接受完全一致的名稱，不猜測相近家具。
    return Boolean(assetName) && assetName === normaliseName(row.item_label);
  }).map((row) => ({
    ...row,
    asset_name: asset.asset_name,
  }));
}

function listLandlordRecipients(db, rentalUnitId) {
  return db.prepare(`
    SELECT DISTINCT
      po.owner_user_id AS user_id,
      li.id AS line_identity_id,
      li.line_user_id
    FROM rental_units ru
    JOIN property_owners po
      ON po.property_id = ru.property_id
     AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
     AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
    JOIN line_identities li
      ON li.id = (
        SELECT selected_li.id
        FROM line_identities selected_li
        WHERE selected_li.user_id = po.owner_user_id
        ORDER BY
          CASE
            WHEN selected_li.line_user_id LIKE 'U-DEMO%' THEN 1
            WHEN selected_li.line_user_id LIKE '%DEMO%' THEN 1
            ELSE 0
          END,
          selected_li.id DESC
        LIMIT 1
      )
    WHERE ru.id = ?
  `).all(rentalUnitId);
}

function startRepairSession(db, input) {
  const now = iso(input.now);
  return db.transaction(() => {
    db.prepare(`
      UPDATE repair_line_sessions
      SET finished_at = ?, finish_reason = 'replaced', updated_at = ?
      WHERE line_identity_id = ? AND finished_at IS NULL
    `).run(now, now, input.lineIdentityId);
    const publicId = `repair-flow-${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO repair_line_sessions (
        public_id, line_identity_id, repair_ticket_id, lease_id, rental_unit_id,
        flow_type, step_code, context_json, started_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      publicId,
      input.lineIdentityId,
      input.repairTicketId || null,
      input.leaseId || null,
      input.rentalUnitId || null,
      input.flowType,
      input.stepCode,
      json(input.context),
      now,
      now,
      addMinutes(now, input.ttlMinutes || 30),
    );
    return sessionRow(db.prepare('SELECT * FROM repair_line_sessions WHERE public_id = ?').get(publicId));
  }).immediate();
}

function getActiveRepairSession(db, lineIdentityId, at = new Date()) {
  const now = iso(at);
  const row = db.prepare(`
    SELECT * FROM repair_line_sessions
    WHERE line_identity_id = ? AND finished_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(lineIdentityId);
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare(`
      UPDATE repair_line_sessions
      SET finished_at = ?, finish_reason = 'expired', updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);
    return null;
  }
  return sessionRow(row);
}

function advanceRepairSession(db, input) {
  const now = iso(input.now);
  const result = db.prepare(`
    UPDATE repair_line_sessions
    SET step_code = COALESCE(?, step_code),
        context_json = ?,
        repair_ticket_id = COALESCE(?, repair_ticket_id),
        updated_at = ?,
        expires_at = ?
    WHERE public_id = ? AND finished_at IS NULL
  `).run(
    input.stepCode || null,
    json(input.context),
    input.repairTicketId || null,
    now,
    addMinutes(now, input.ttlMinutes || 30),
    input.publicId,
  );
  if (!result.changes) throw new Error('active repair session not found');
  return sessionRow(db.prepare('SELECT * FROM repair_line_sessions WHERE public_id = ?').get(input.publicId));
}

function finishRepairSession(db, publicId, reason = 'completed', at = new Date()) {
  const now = iso(at);
  return db.prepare(`
    UPDATE repair_line_sessions
    SET finished_at = ?, finish_reason = ?, updated_at = ?
    WHERE public_id = ? AND finished_at IS NULL
  `).run(now, reason, now, publicId).changes > 0;
}

function inferPriority(text) {
  return /(漏水|淹水|火花|危險|瓦斯|沒電|爆|燒焦|緊急)/.test(String(text || '')) ? 'urgent' : 'normal';
}

function createRepairTicket(db, input) {
  const publicId = `repair-${crypto.randomUUID()}`;
  const priority = input.priority || inferPriority(input.description);
  db.prepare(`
    INSERT INTO repair_tickets (
      public_id, lease_id, rental_unit_id, category, description, priority,
      status, reported_by_user_id, assigned_owner_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'reported', ?, ?)
  `).run(
    publicId,
    input.leaseId,
    input.rentalUnitId,
    input.category || '一般報修',
    input.description,
    priority,
    input.reportedByUserId,
    input.assignedOwnerUserId || null,
  );
  return db.prepare('SELECT * FROM repair_tickets WHERE public_id = ?').get(publicId);
}

function addRepairUpdate(db, input) {
  const publicId = `repair-update-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO repair_updates (
      public_id, repair_ticket_id, update_type, from_status, to_status, message_text, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    publicId,
    input.repairTicketId,
    input.updateType,
    input.fromStatus || null,
    input.toStatus || null,
    input.messageText || null,
    input.createdByUserId,
  );
  return db.prepare('SELECT * FROM repair_updates WHERE public_id = ?').get(publicId);
}

function changeRepairStatus(db, input) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE public_id = ?').get(input.ticketPublicId);
  if (!ticket) throw new Error('repair ticket not found');
  const now = iso(input.now);
  db.prepare(`
    UPDATE repair_tickets
    SET status = ?,
        repair_status = CASE
          WHEN ? IN ('landlord_completed', 'repair_completed', 'tenant_confirmed') THEN 'completed'
          WHEN ? IN ('accepted', 'in_progress', 'tenant_self_repair', 'tenant_pays', 'reopened') THEN 'awaiting_execution'
          WHEN ? IN ('reported', 'landlord_notified', 'need_info', 'vendor_judgement') THEN 'reported'
          ELSE repair_status
        END,
        completed_at = CASE WHEN ? = 'landlord_completed' THEN COALESCE(completed_at, ?) ELSE completed_at END,
        closed_at = CASE WHEN ? = 'tenant_confirmed' THEN COALESCE(closed_at, ?) ELSE closed_at END,
        updated_at = ?
    WHERE id = ?
  `).run(input.toStatus, input.toStatus, input.toStatus, input.toStatus, input.toStatus, now, input.toStatus, now, now, ticket.id);
  addRepairUpdate(db, {
    repairTicketId: ticket.id,
    updateType: 'status_change',
    fromStatus: ticket.status,
    toStatus: input.toStatus,
    messageText: input.messageText,
    createdByUserId: input.createdByUserId,
  });
  return db.prepare('SELECT * FROM repair_tickets WHERE id = ?').get(ticket.id);
}

function addFile(db, input) {
  const publicId = `file-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT OR IGNORE INTO files (
      public_id, storage_key, storage_provider, original_name, mime_type,
      size_bytes, sha256_hash, security_classification, status, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 'active', ?)
  `).run(
    publicId,
    input.storageKey,
    input.storageProvider || 'local',
    input.originalName || 'line-attachment',
    input.mimeType || 'application/octet-stream',
    input.sizeBytes || 0,
    input.sha256Hash,
    input.createdByUserId || null,
  );
  return db.prepare(`
    SELECT id, public_id FROM files
    WHERE storage_key = ?
       OR (sha256_hash = ? AND size_bytes = ? AND security_classification = 'private')
    ORDER BY id DESC LIMIT 1
  `).get(input.storageKey, input.sha256Hash, input.sizeBytes || 0);
}

function linkFileToRepairUpdate(db, { fileId, repairUpdateId, purpose }) {
  db.prepare(`
    INSERT INTO file_links (file_id, entity_type, entity_id, purpose)
    VALUES (?, 'repair_update', ?, ?)
  `).run(fileId, repairUpdateId, purpose || null);
}

function listRepairFiles(db, ticketPublicId, purpose = null) {
  const purposeFilter = purpose ? 'AND fl.purpose = @purpose' : '';
  return db.prepare(`
    SELECT
      f.id,
      f.public_id,
      f.storage_key,
      f.storage_provider,
      f.original_name,
      f.mime_type,
      f.size_bytes,
      fl.purpose,
      ru.public_id AS repair_update_public_id,
      ru.update_type,
      ru.created_at
    FROM repair_tickets rt
    JOIN repair_updates ru ON ru.repair_ticket_id = rt.id
    JOIN file_links fl
      ON fl.entity_type = 'repair_update'
     AND fl.entity_id = ru.id
    JOIN files f ON f.id = fl.file_id
    WHERE rt.public_id = @ticketPublicId
      AND f.status = 'active'
      ${purposeFilter}
    ORDER BY
      CASE fl.purpose
        WHEN 'damage_photo' THEN 0
        WHEN 'completion_photo' THEN 1
        ELSE 2
      END,
      ru.created_at ASC,
      f.id ASC
  `).all({ ticketPublicId, purpose });
}

function listTenantRepairTickets(db, tenantUserId, limit = 5) {
  return db.prepare(`
    SELECT
      rt.public_id,
      rt.lease_id,
      rt.rental_unit_id,
      rt.category,
      rt.description,
      rt.priority,
      rt.status,
      rt.repair_status,
      rt.repair_verification_status,
      rt.settlement_status,
      rt.case_status,
      rt.dispatch_party,
      rt.reported_at,
      rt.updated_at,
      ru.unit_label,
      (
        SELECT COUNT(*)
        FROM repair_updates ru2
        JOIN file_links fl2
          ON fl2.entity_type = 'repair_update'
         AND fl2.entity_id = ru2.id
         AND fl2.purpose = 'damage_photo'
        JOIN files f ON f.id = fl2.file_id
        WHERE ru2.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS damage_photo_count,
      (
        SELECT COUNT(*)
        FROM repair_updates ru3
        JOIN file_links fl3
          ON fl3.entity_type = 'repair_update'
         AND fl3.entity_id = ru3.id
         AND fl3.purpose = 'completion_photo'
        JOIN files f ON f.id = fl3.file_id
        WHERE ru3.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS completion_photo_count,
      (
        SELECT ce.public_id
        FROM calendar_events ce
        WHERE ce.repair_ticket_id = rt.id
          AND ce.event_type = 'repair_appointment'
          AND ce.status = 'scheduled'
        ORDER BY ce.id DESC
        LIMIT 1
      ) AS active_appointment_public_id,
      (
        SELECT ru4.message_text
        FROM repair_updates ru4
        WHERE ru4.repair_ticket_id = rt.id
          AND ru4.update_type = 'appointment'
        ORDER BY ru4.id DESC
        LIMIT 1
      ) AS latest_appointment_message
    FROM repair_tickets rt
    JOIN leases le ON le.id = rt.lease_id
    JOIN lease_parties lp
      ON lp.lease_id = le.id
     AND lp.party_role = 'tenant'
     AND lp.user_id = ?
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    WHERE rt.status NOT IN ('tenant_confirmed', 'cancelled')
    ORDER BY
      datetime(COALESCE(rt.updated_at, rt.reported_at)) DESC,
      rt.id DESC
    LIMIT ?
  `).all(tenantUserId, limit);
}

function listTenantRepairHistoryTickets(db, tenantUserId, limit = 10) {
  return db.prepare(`
    SELECT
      rt.public_id,
      rt.lease_id,
      rt.rental_unit_id,
      rt.category,
      rt.description,
      rt.priority,
      rt.status,
      rt.repair_status,
      rt.repair_verification_status,
      rt.settlement_status,
      rt.case_status,
      rt.dispatch_party,
      rt.reported_at,
      rt.updated_at,
      ru.unit_label,
      (
        SELECT COUNT(*)
        FROM repair_updates ru2
        JOIN file_links fl2
          ON fl2.entity_type = 'repair_update'
         AND fl2.entity_id = ru2.id
         AND fl2.purpose = 'damage_photo'
        JOIN files f ON f.id = fl2.file_id
        WHERE ru2.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS damage_photo_count,
      (
        SELECT COUNT(*)
        FROM repair_updates ru3
        JOIN file_links fl3
          ON fl3.entity_type = 'repair_update'
         AND fl3.entity_id = ru3.id
         AND fl3.purpose = 'completion_photo'
        JOIN files f ON f.id = fl3.file_id
        WHERE ru3.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS completion_photo_count,
      (
        SELECT ce.public_id
        FROM calendar_events ce
        WHERE ce.repair_ticket_id = rt.id
          AND ce.event_type = 'repair_appointment'
          AND ce.status = 'scheduled'
        ORDER BY ce.id DESC
        LIMIT 1
      ) AS active_appointment_public_id,
      (
        SELECT ru4.message_text
        FROM repair_updates ru4
        WHERE ru4.repair_ticket_id = rt.id
          AND ru4.update_type = 'appointment'
        ORDER BY ru4.id DESC
        LIMIT 1
      ) AS latest_appointment_message
    FROM repair_tickets rt
    JOIN leases le ON le.id = rt.lease_id
    JOIN lease_parties lp
      ON lp.lease_id = le.id
     AND lp.party_role = 'tenant'
     AND lp.user_id = ?
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    WHERE rt.status = 'tenant_confirmed'
    ORDER BY rt.updated_at DESC, rt.reported_at DESC
    LIMIT ?
  `).all(tenantUserId, limit);
}

function listLandlordRepairHistoryTickets(db, ownerUserId, { unitId = null, limit = 50 } = {}) {
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  const unitFilter = unitId == null ? '' : 'AND rt.rental_unit_id = @unitId';
  return db.prepare(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      rt.public_id,
      rt.lease_id,
      rt.rental_unit_id,
      rt.category,
      rt.description,
      rt.priority,
      rt.status,
      rt.reported_at,
      rt.updated_at,
      ru.unit_label,
      COALESCE(up.display_name, (
        SELECT li.display_name_cache FROM line_identities li WHERE li.user_id = rt.reported_by_user_id LIMIT 1
      ), '房客') AS tenant_name,
      (
        SELECT COUNT(*)
        FROM repair_updates ru2
        JOIN file_links fl2
          ON fl2.entity_type = 'repair_update'
         AND fl2.entity_id = ru2.id
         AND fl2.purpose = 'damage_photo'
        JOIN files f ON f.id = fl2.file_id
        WHERE ru2.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS damage_photo_count,
      (
        SELECT COUNT(*)
        FROM repair_updates ru3
        JOIN file_links fl3
          ON fl3.entity_type = 'repair_update'
         AND fl3.entity_id = ru3.id
         AND fl3.purpose = 'completion_photo'
        JOIN files f ON f.id = fl3.file_id
        WHERE ru3.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS completion_photo_count,
      (
        SELECT ce.public_id
        FROM calendar_events ce
        WHERE ce.repair_ticket_id = rt.id
          AND ce.event_type = 'repair_appointment'
          AND ce.status = 'scheduled'
        ORDER BY ce.id DESC
        LIMIT 1
      ) AS active_appointment_public_id,
      (
        SELECT ru4.message_text
        FROM repair_updates ru4
        WHERE ru4.repair_ticket_id = rt.id
          AND ru4.update_type = 'appointment'
        ORDER BY ru4.id DESC
        LIMIT 1
      ) AS latest_appointment_message
    FROM repair_tickets rt
    JOIN scoped_units su ON su.id = rt.rental_unit_id
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    LEFT JOIN user_profiles up ON up.user_id = rt.reported_by_user_id
    WHERE rt.status = 'tenant_confirmed'
      ${unitFilter}
    ORDER BY datetime(COALESCE(rt.updated_at, rt.reported_at)) DESC, rt.id DESC
    LIMIT @limit
  `).all({ ownerUserId, unitId, limit });
}

function listLandlordRepairActiveTickets(db, ownerUserId, { unitId = null, limit = 50 } = {}) {
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  const unitFilter = unitId == null ? '' : 'AND rt.rental_unit_id = @unitId';
  return db.prepare(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      rt.public_id,
      rt.lease_id,
      rt.rental_unit_id,
      rt.category,
      rt.description,
      rt.priority,
      rt.status,
      rt.reported_at,
      rt.updated_at,
      ru.unit_label,
      COALESCE(up.display_name, (
        SELECT li.display_name_cache FROM line_identities li WHERE li.user_id = rt.reported_by_user_id LIMIT 1
      ), '房客') AS tenant_name,
      (
        SELECT COUNT(*)
        FROM repair_updates ru2
        JOIN file_links fl2
          ON fl2.entity_type = 'repair_update'
         AND fl2.entity_id = ru2.id
         AND fl2.purpose = 'damage_photo'
        JOIN files f ON f.id = fl2.file_id
        WHERE ru2.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS damage_photo_count,
      (
        SELECT COUNT(*)
        FROM repair_updates ru3
        JOIN file_links fl3
          ON fl3.entity_type = 'repair_update'
         AND fl3.entity_id = ru3.id
         AND fl3.purpose = 'completion_photo'
        JOIN files f ON f.id = fl3.file_id
        WHERE ru3.repair_ticket_id = rt.id
          AND f.status = 'active'
      ) AS completion_photo_count
    FROM repair_tickets rt
    JOIN scoped_units su ON su.id = rt.rental_unit_id
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    LEFT JOIN user_profiles up ON up.user_id = rt.reported_by_user_id
    WHERE rt.status NOT IN ('tenant_confirmed', 'cancelled')
      ${unitFilter}
    ORDER BY
      datetime(COALESCE(rt.updated_at, rt.reported_at)) DESC,
      rt.id DESC
    LIMIT @limit
  `).all({ ownerUserId, unitId, limit });
}

function listLandlordRecentRepairUpdates(db, ownerUserId, { limit = 10 } = {}) {
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return db.prepare(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      ru.public_id,
      ru.update_type,
      ru.from_status,
      ru.to_status,
      ru.message_text,
      ru.created_at,
      rt.public_id AS repair_public_id,
      rt.description,
      rt.status AS repair_status,
      rnu.unit_label,
      COALESCE(up.display_name, li.display_name_cache, '系統') AS actor_name
    FROM repair_updates ru
    JOIN repair_tickets rt ON rt.id = ru.repair_ticket_id
    JOIN scoped_units su ON su.id = rt.rental_unit_id
    JOIN rental_units rnu ON rnu.id = rt.rental_unit_id
    LEFT JOIN user_profiles up ON up.user_id = ru.created_by_user_id
    LEFT JOIN line_identities li ON li.user_id = ru.created_by_user_id
    ORDER BY datetime(ru.created_at) DESC, ru.id DESC
    LIMIT @limit
  `).all({ ownerUserId, limit });
}

function listLandlordRepairHistoryUnits(db, ownerUserId) {
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return db.prepare(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id, ru.unit_label
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      su.id,
      su.unit_label,
      COUNT(rt.id) AS repair_count
    FROM scoped_units su
    JOIN repair_tickets rt
      ON rt.rental_unit_id = su.id
     AND rt.status = 'tenant_confirmed'
    GROUP BY su.id, su.unit_label
    ORDER BY repair_count DESC, su.unit_label
  `).all({ ownerUserId });
}

function listLandlordRepairActiveUnits(db, ownerUserId) {
  const ownerFilter = ownerUserId == null ? '' : 'AND po.owner_user_id = @ownerUserId';
  return db.prepare(`
    WITH scoped_units AS (
      SELECT DISTINCT ru.id, ru.unit_label
      FROM rental_units ru
      JOIN properties p ON p.id = ru.property_id
      LEFT JOIN property_owners po
        ON po.property_id = p.id
       AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
       AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
      WHERE ru.status != 'inactive'
        ${ownerFilter}
    )
    SELECT
      su.id,
      su.unit_label,
      COUNT(rt.id) AS repair_count
    FROM scoped_units su
    JOIN repair_tickets rt
      ON rt.rental_unit_id = su.id
     AND rt.status NOT IN ('tenant_confirmed', 'cancelled')
    GROUP BY su.id, su.unit_label
    ORDER BY repair_count DESC, su.unit_label
  `).all({ ownerUserId });
}

function listRepairUpdates(db, ticketPublicId, limit = 100) {
  return db.prepare(`
    SELECT
      ru.id,
      ru.public_id,
      ru.update_type,
      ru.from_status,
      ru.to_status,
      ru.message_text,
      ru.created_at,
      COALESCE(up.display_name, li.display_name_cache, '系統') AS actor_name
    FROM repair_tickets rt
    JOIN repair_updates ru ON ru.repair_ticket_id = rt.id
    LEFT JOIN user_profiles up ON up.user_id = ru.created_by_user_id
    LEFT JOIN line_identities li ON li.user_id = ru.created_by_user_id
    WHERE rt.public_id = ?
    GROUP BY ru.id
    ORDER BY ru.created_at ASC, ru.id ASC
    LIMIT ?
  `).all(ticketPublicId, limit);
}

function confirmRepair(db, input) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE public_id = ?').get(input.ticketPublicId);
  if (!ticket) throw new Error('repair ticket not found');
  db.prepare(`
    INSERT INTO repair_confirmations (repair_ticket_id, confirmed_by_user_id, result, note)
    VALUES (?, ?, ?, ?)
  `).run(ticket.id, input.confirmedByUserId, input.result, input.note || null);
  if (input.result === 'resolved') {
    return changeRepairStatus(db, {
      ticketPublicId: input.ticketPublicId,
      toStatus: 'tenant_confirmed',
      messageText: input.note || '房客確認已解決',
      createdByUserId: input.confirmedByUserId,
    });
  }
  return changeRepairStatus(db, {
    ticketPublicId: input.ticketPublicId,
    toStatus: 'reopened',
    messageText: input.note || '房客回報仍有問題',
    createdByUserId: input.confirmedByUserId,
  });
}

function getRepairContext(db, ticketPublicId) {
  return db.prepare(`
    SELECT
      rt.*,
      ru.unit_label,
      COALESCE(up.display_name, li.display_name_cache, '房客') AS tenant_name,
      li.id AS tenant_line_identity_id,
      li.user_id AS tenant_user_id,
      li.line_user_id AS tenant_line_user_id,
      (
        SELECT COALESCE(owner_profile.display_name, owner_line.display_name_cache, '房東')
        FROM property_owners owner_link
        LEFT JOIN user_profiles owner_profile ON owner_profile.user_id = owner_link.owner_user_id
        LEFT JOIN line_identities owner_line ON owner_line.id = (
          SELECT selected_owner_line.id
          FROM line_identities selected_owner_line
          WHERE selected_owner_line.user_id = owner_link.owner_user_id
          ORDER BY
            CASE
              WHEN selected_owner_line.line_user_id LIKE 'U-DEMO%' THEN 1
              WHEN selected_owner_line.line_user_id LIKE '%DEMO%' THEN 1
              ELSE 0
            END,
            selected_owner_line.id DESC
          LIMIT 1
        )
        WHERE owner_link.property_id = ru.property_id
          AND (owner_link.rental_unit_id IS NULL OR owner_link.rental_unit_id = ru.id)
          AND (owner_link.effective_until IS NULL OR owner_link.effective_until >= date('now'))
        ORDER BY owner_link.id DESC
        LIMIT 1
      ) AS landlord_name,
      (
        SELECT owner_profile.phone
        FROM property_owners owner_link
        LEFT JOIN user_profiles owner_profile ON owner_profile.user_id = owner_link.owner_user_id
        WHERE owner_link.property_id = ru.property_id
          AND (owner_link.rental_unit_id IS NULL OR owner_link.rental_unit_id = ru.id)
          AND (owner_link.effective_until IS NULL OR owner_link.effective_until >= date('now'))
        ORDER BY owner_link.id DESC
        LIMIT 1
      ) AS landlord_phone
    FROM repair_tickets rt
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    LEFT JOIN user_profiles up ON up.user_id = rt.reported_by_user_id
    LEFT JOIN line_identities li ON li.user_id = rt.reported_by_user_id
    WHERE rt.public_id = ?
    ORDER BY li.id DESC
    LIMIT 1
  `).get(ticketPublicId);
}

function canManageRepairTicket(db, ticketPublicId, userId) {
  if (!ticketPublicId || !userId) return false;
  const row = db.prepare(`
    SELECT 1
    FROM repair_tickets rt
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    LEFT JOIN property_owners po
      ON po.property_id = ru.property_id
     AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
     AND (po.effective_until IS NULL OR po.effective_until >= date('now'))
    WHERE rt.public_id = ?
      AND (
        rt.assigned_owner_user_id = ?
        OR po.owner_user_id = ?
      )
    LIMIT 1
  `).get(ticketPublicId, userId, userId);
  return Boolean(row);
}

function inferPriority(text) {
  return /(瓦斯|漏氣|冒煙|火花|觸電|電線|淹水|漏水|水管爆|斷電|門鎖壞|無法關門)/.test(String(text || '')) ? 'urgent' : 'normal';
}

function createRepairTicket(db, input) {
  const publicId = `repair-${crypto.randomUUID()}`;
  const priority = input.priority || inferPriority(input.description);
  const damageType = input.damageType || causeToLegacyDamage(input.causeClassification || 'unknown');
  const causeClassification = input.causeClassification || legacyDamageToCause(damageType);
  db.prepare(`
    INSERT INTO repair_tickets (
      public_id, lease_id, rental_unit_id, category, description, priority,
      status, reported_by_user_id, assigned_owner_user_id,
      asset_id, damage_type, cause_classification, tenant_preference
    ) VALUES (?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?)
  `).run(
    publicId,
    input.leaseId,
    input.rentalUnitId,
    input.category || '一般報修',
    input.description,
    priority,
    input.reportedByUserId,
    input.assignedOwnerUserId || null,
    input.assetId || null,
    damageType,
    causeClassification,
    input.tenantPreference || 'no_preference',
  );
  return db.prepare('SELECT * FROM repair_tickets WHERE public_id = ?').get(publicId);
}

function findRepairAssetForDescription(db, { rentalUnitId, description }) {
  if (!rentalUnitId) return null;
  const text = String(description || '');
  const assets = db.prepare(`
    SELECT *
    FROM rental_unit_assets
    WHERE rental_unit_id = ?
      AND status = 'active'
    ORDER BY
      CASE asset_type
        WHEN 'appliance' THEN 0
        WHEN 'plumbing' THEN 1
        WHEN 'electrical' THEN 2
        WHEN 'furniture' THEN 3
        ELSE 9
      END,
      length(asset_name) DESC
  `).all(rentalUnitId);
  return assets.find((asset) => text.includes(asset.asset_name)) || null;
}

function findLeaseRepairRule(db, { leaseId, rentalUnitId, assetId = null, damageType = 'unknown' }) {
  if (!rentalUnitId) return null;
  const causeClassification = legacyDamageToCause(damageType);
  // 支援舊資料中的 natural_wear 與新版 normal_use / normal_failure 互通。
  // 不然房客選「正常使用中突然異常」時，會找不到資產層的正常故障規則，
  // 誤退回 unknown 規則而一直要求補件。
  const isNormalUseFamily = ['natural_wear', 'normal_use'].includes(damageType);
  const isNormalCauseFamily = ['natural_wear', 'normal_failure'].includes(causeClassification);
  const params = {
    leaseId,
    rentalUnitId,
    assetId,
    damageType,
    causeClassification,
    isNormalUseFamily: isNormalUseFamily ? 1 : 0,
    isNormalCauseFamily: isNormalCauseFamily ? 1 : 0,
  };
  const matchingClause = `
    AND status = 'active'
    AND (asset_id = @assetId OR asset_id IS NULL)
    AND (
      cause_classification IN (@causeClassification, 'unknown')
      OR damage_type IN (@damageType, 'unknown')
      OR (@isNormalCauseFamily = 1 AND cause_classification IN ('natural_wear', 'normal_failure'))
      OR (@isNormalUseFamily = 1 AND damage_type IN ('natural_wear', 'normal_use'))
    )
  `;
  const ordering = `
    ORDER BY
      CASE WHEN asset_id = @assetId THEN 0 ELSE 1 END,
      CASE
        WHEN @isNormalCauseFamily = 1 AND cause_classification IN ('natural_wear', 'normal_failure') THEN 0
        WHEN @isNormalUseFamily = 1 AND damage_type IN ('natural_wear', 'normal_use') THEN 0
        ELSE 1
      END,
      CASE WHEN cause_classification = @causeClassification THEN 0 ELSE 1 END,
      CASE WHEN damage_type = @damageType THEN 0 ELSE 1 END,
      id DESC
    LIMIT 1
  `;
  const leaseRule = leaseId ? db.prepare(`
    SELECT *, 'lease_rule' AS rule_origin
    FROM lease_repair_rules
    WHERE lease_id = @leaseId
      AND rental_unit_id = @rentalUnitId
      ${matchingClause}
    ${ordering}
  `).get(params) : null;
  if (leaseRule) return normalizeRepairRule(leaseRule);

  const unitDefault = db.prepare(`
    SELECT *, 'unit_default' AS rule_origin
    FROM rental_unit_repair_rule_defaults
    WHERE rental_unit_id = @rentalUnitId
      ${matchingClause}
    ${ordering}
  `).get(params);
  return normalizeRepairRule(unitDefault);
}

function createRepairAiAssessment(db, input) {
  const publicId = `repair-ai-${crypto.randomUUID()}`;
  const liabilityParty = input.liabilityParty || input.responsibilityGuess || 'pending';
  const recommendedDispatchParty = input.recommendedDispatchParty || input.recommendedExecutor || 'review_required';
  const recommendedPayerParty = input.recommendedPayerParty || input.recommendedPayer || 'review_required';
  db.prepare(`
    INSERT INTO repair_ai_assessments (
      public_id, repair_ticket_id, lease_id, contract_version_id, asset_id, lease_repair_rule_id, rental_unit_repair_rule_default_id,
      risk_level, responsibility_guess, recommended_executor, recommended_payer, confidence,
      rule_match_status, evidence_status, cause_classification, liability_party,
      recommended_dispatch_party, recommended_payer_party,
      legal_basis_summary, contract_basis_summary, missing_info_json, rule_refs_json,
      raw_result_json, model_or_rule_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publicId,
    input.repairTicketId,
    input.leaseId || null,
    input.contractVersionId || null,
    input.assetId || null,
    input.leaseRepairRuleId || null,
    input.rentalUnitRepairRuleDefaultId || null,
    input.riskLevel || 'normal',
    input.responsibilityGuess || 'insufficient_info',
    recommendedDispatchParty,
    recommendedPayerParty,
    input.confidence ?? null,
    input.ruleMatchStatus || 'not_evaluated',
    input.evidenceStatus || 'insufficient',
    input.causeClassification || 'unknown',
    liabilityParty,
    recommendedDispatchParty,
    recommendedPayerParty,
    input.legalBasisSummary || null,
    input.contractBasisSummary || null,
    JSON.stringify(input.missingInfo || []),
    JSON.stringify(input.ruleRefs || []),
    JSON.stringify(input.rawResult || {}),
    input.modelOrRuleVersion || 'repair-agent-rule-v1',
  );
  const row = db.prepare('SELECT * FROM repair_ai_assessments WHERE public_id = ?').get(publicId);
  db.prepare(`
    UPDATE repair_tickets
    SET latest_assessment_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(row.id, input.repairTicketId);
  return row;
}

function createRepairResolutionRecord(db, input) {
  const publicId = `repair-resolution-${crypto.randomUUID()}`;
  const liabilityParty = input.liabilityParty || input.responsibleParty || 'pending';
  const dispatchParty = input.dispatchParty || input.repairExecutor || 'pending';
  db.prepare(`
    INSERT INTO repair_resolution_records (
      public_id, repair_ticket_id, basis_type, responsible_party, repair_executor, payer_party,
      liability_party, dispatch_party, settlement_basis, payment_settlement_method,
      cost_limit_amount, receipt_required, tax_id_required, resolution_text, ai_summary,
      source_assessment_id, source_rule_refs_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    publicId,
    input.repairTicketId,
    input.basisType || 'manual_review',
    input.responsibleParty || 'review_required',
    dispatchParty,
    input.payerParty || 'review_required',
    liabilityParty,
    dispatchParty,
    input.settlementBasis || 'manual',
    input.paymentSettlementMethod || 'none',
    input.costLimitAmount ?? null,
    input.receiptRequired ? 1 : 0,
    input.taxIdRequired ? 1 : 0,
    input.resolutionText,
    input.aiSummary || null,
    input.sourceAssessmentId || null,
    JSON.stringify(input.sourceRuleRefs || []),
    input.status || 'draft',
  );
  const row = db.prepare('SELECT * FROM repair_resolution_records WHERE public_id = ?').get(publicId);
  db.prepare(`
    UPDATE repair_tickets
    SET latest_resolution_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(row.id, input.repairTicketId);
  return row;
}

function createRepairAppointmentEvent(db, input) {
  const publicId = `cal-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO calendar_events (
      public_id, event_type, title, starts_at, ends_at, lease_id, repair_ticket_id, status
    ) VALUES (?, 'repair_appointment', ?, ?, ?, ?, ?, 'scheduled')
  `).run(
    publicId,
    input.title,
    input.startsAt,
    input.endsAt || null,
    input.leaseId || null,
    input.repairTicketId,
  );
  return db.prepare('SELECT * FROM calendar_events WHERE public_id = ?').get(publicId);
}

function getRepairAppointmentEvent(db, repairTicketId, eventPublicId) {
  if (!eventPublicId) {
    return db.prepare(`
      SELECT *
      FROM calendar_events
      WHERE repair_ticket_id = ?
        AND event_type = 'repair_appointment'
        AND status = 'scheduled'
      ORDER BY datetime(starts_at) DESC, id DESC
      LIMIT 1
    `).get(repairTicketId);
  }
  return db.prepare(`
    SELECT *
    FROM calendar_events
    WHERE repair_ticket_id = ?
      AND public_id = ?
      AND event_type = 'repair_appointment'
    LIMIT 1
  `).get(repairTicketId, eventPublicId);
}

function respondToRepairAppointmentEvent(db, input) {
  const event = getRepairAppointmentEvent(db, input.repairTicketId, input.eventPublicId);
  if (!event) throw new Error('repair appointment not found');
  const response = ['accept', 'reschedule'].includes(input.response) ? input.response : 'reschedule';
  // 改期時要立刻放回原本占用的共用時段，否則一次改期會永久吃掉兩個時段。
  if (response === 'reschedule') {
    db.prepare('DELETE FROM repair_slot_reservations WHERE calendar_event_id = ?').run(event.id);
  }
  // calendar_events 只保存目前預約是否仍有效；房客回覆本身由 repair_updates 留存。
  const status = response === 'reschedule' ? 'cancelled' : 'scheduled';
  db.prepare(`
    UPDATE calendar_events
    SET status = ?
    WHERE id = ?
  `).run(status, event.id);
  return db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(event.id);
}

function listAvailableSlotsForRepair(db, repairTicketId, limit = 40) {
  return db.prepare(`
    SELECT s.public_id, s.starts_at, s.ends_at
    FROM showing_slots s
    JOIN repair_tickets rt ON rt.id = ?
    JOIN leases le ON le.id = rt.lease_id
    JOIN listings l ON l.id = (
      SELECT l2.id FROM listings l2
      WHERE l2.rental_unit_id = le.rental_unit_id
      ORDER BY CASE WHEN l2.status = 'published' THEN 0 ELSE 1 END, l2.id DESC
      LIMIT 1
    ) AND l.id = s.listing_id
    WHERE s.status = 'open'
      AND s.held_appointment_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = s.id
      )
      AND s.starts_at > strftime('%Y-%m-%dT%H:%M', 'now', '+8 hours')
    ORDER BY s.starts_at ASC, s.id ASC
    LIMIT ?
  `).all(repairTicketId, limit);
}

function createRepairAppointmentFromSharedSlot(db, input) {
  return db.transaction(() => {
    const slot = db.prepare(`
      SELECT s.id, s.public_id, s.starts_at, s.ends_at
      FROM showing_slots s
      JOIN repair_tickets rt ON rt.id = ?
      JOIN leases le ON le.id = rt.lease_id
      JOIN listings l ON l.id = (
        SELECT l2.id FROM listings l2
        WHERE l2.rental_unit_id = le.rental_unit_id
        ORDER BY CASE WHEN l2.status = 'published' THEN 0 ELSE 1 END, l2.id DESC
        LIMIT 1
      ) AND l.id = s.listing_id
      WHERE s.public_id = ?
        AND s.status = 'open'
        AND s.held_appointment_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = s.id
        )
      LIMIT 1
    `).get(input.repairTicketId, input.slotPublicId);
    if (!slot) throw new Error('repair shared slot unavailable');

    // UPDATE 本身是跨「看房占用／修繕 reservation」的鎖點；搶輸者整筆交易回滾。
    const locked = db.prepare(`
      UPDATE showing_slots
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'open'
        AND held_appointment_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = showing_slots.id
        )
    `).run(slot.id);
    if (locked.changes !== 1) throw new Error('repair shared slot unavailable');

    db.prepare(`
      UPDATE calendar_events
      SET status = 'cancelled'
      WHERE repair_ticket_id = ? AND event_type = 'repair_appointment' AND status = 'scheduled'
    `).run(input.repairTicketId);
    const event = createRepairAppointmentEvent(db, {
      title: input.title,
      startsAt: slot.starts_at,
      endsAt: slot.ends_at || null,
      leaseId: input.leaseId,
      repairTicketId: input.repairTicketId,
    });
    db.prepare(`
      INSERT INTO repair_slot_reservations (public_id, showing_slot_id, calendar_event_id)
      VALUES (?, ?, ?)
    `).run(`repair-slot-${crypto.randomUUID()}`, slot.id, event.id);
    return { ...event, shared_slot_public_id: slot.public_id };
  })();
}

// 房客改期時，舊時段與新時段必須在同一筆交易內交換：新時段搶不到，舊預約就完全不動。
function rescheduleRepairAppointmentToSharedSlot(db, input) {
  return db.transaction(() => {
    const currentEvent = getRepairAppointmentEvent(db, input.repairTicketId, input.eventPublicId);
    if (!currentEvent || currentEvent.status !== 'scheduled') throw new Error('repair appointment not found');
    const slot = db.prepare(`
      SELECT s.id, s.public_id, s.starts_at, s.ends_at
      FROM showing_slots s
      JOIN repair_tickets rt ON rt.id = ?
      JOIN leases le ON le.id = rt.lease_id
      JOIN listings l ON l.id = (
        SELECT l2.id FROM listings l2
        WHERE l2.rental_unit_id = le.rental_unit_id
        ORDER BY CASE WHEN l2.status = 'published' THEN 0 ELSE 1 END, l2.id DESC
        LIMIT 1
      ) AND l.id = s.listing_id
      WHERE s.public_id = ?
        AND s.status = 'open'
        AND s.held_appointment_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = s.id
        )
      LIMIT 1
    `).get(input.repairTicketId, input.slotPublicId);
    if (!slot) throw new Error('repair shared slot unavailable');

    const locked = db.prepare(`
      UPDATE showing_slots
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'open'
        AND held_appointment_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = showing_slots.id
        )
    `).run(slot.id);
    if (locked.changes !== 1) throw new Error('repair shared slot unavailable');

    db.prepare('DELETE FROM repair_slot_reservations WHERE calendar_event_id = ?').run(currentEvent.id);
    db.prepare(`UPDATE calendar_events SET status = 'cancelled' WHERE id = ?`).run(currentEvent.id);
    const event = createRepairAppointmentEvent(db, {
      title: input.title,
      startsAt: slot.starts_at,
      endsAt: slot.ends_at || null,
      leaseId: input.leaseId,
      repairTicketId: input.repairTicketId,
    });
    db.prepare(`
      INSERT INTO repair_slot_reservations (public_id, showing_slot_id, calendar_event_id)
      VALUES (?, ?, ?)
    `).run(`repair-slot-${crypto.randomUUID()}`, slot.id, event.id);
    return { ...event, shared_slot_public_id: slot.public_id, previous_event_public_id: currentEvent.public_id };
  })();
}

function updateRepairWorkflowState(db, input) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE public_id = ?').get(input.ticketPublicId);
  if (!ticket) throw new Error('repair ticket not found');

  const allowed = {
    repairStatus: ['reported', 'awaiting_execution', 'in_progress', 'completed'],
    liabilityStatus: ['pending', 'proposed', 'confirmed', 'disputed', 'not_required'],
    dispatchParty: ['landlord', 'tenant', 'vendor', 'pending', 'review_required', 'none'],
    appointmentStatus: ['not_required', 'pending_schedule', 'proposed', 'confirmed', 'reschedule_requested', 'cancelled', 'completed', 'no_show'],
    repairVerificationStatus: ['pending', 'confirmed', 'disputed', 'not_required'],
    safetyStatus: ['normal', 'urgent_detected', 'emergency_action_in_progress', 'risk_contained'],
    actionOwner: ['landlord', 'tenant', 'system', 'manual_reviewer', 'none'],
    waitingOn: ['tenant', 'landlord', 'vendor', 'appointment_time', 'payment', 'manual_review', 'none'],
    disputeScope: ['liability', 'settlement', 'repair_result', 'appointment', 'rule_interpretation', 'other', null],
    caseStatus: ['open', 'closed', 'cancelled'],
  };
  const pick = (key, column) => {
    if (input[key] === undefined) return ticket[column];
    return allowed[key].includes(input[key]) ? input[key] : ticket[column];
  };
  db.prepare(`
    UPDATE repair_tickets
    SET repair_status = ?, liability_status = ?, dispatch_party = ?, appointment_status = ?, repair_verification_status = ?,
        safety_status = ?, action_owner = ?, waiting_on = ?, dispute_scope = ?, case_status = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    pick('repairStatus', 'repair_status'),
    pick('liabilityStatus', 'liability_status'),
    pick('dispatchParty', 'dispatch_party'),
    pick('appointmentStatus', 'appointment_status'),
    pick('repairVerificationStatus', 'repair_verification_status'),
    pick('safetyStatus', 'safety_status'),
    pick('actionOwner', 'action_owner'),
    pick('waitingOn', 'waiting_on'),
    pick('disputeScope', 'dispute_scope'),
    pick('caseStatus', 'case_status'),
    ticket.id,
  );
  return getRepairContext(db, input.ticketPublicId);
}

function recordRepairSettlement(db, input) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE public_id = ?').get(input.ticketPublicId);
  if (!ticket) throw new Error('repair ticket not found');
  const actualCostAmount = Number.isFinite(Number(input.actualCostAmount))
    ? Math.max(0, Math.round(Number(input.actualCostAmount)))
    : null;
  const tenantLiabilityAmount = Number.isFinite(Number(input.tenantLiabilityAmount))
    ? Math.max(0, Math.round(Number(input.tenantLiabilityAmount)))
    : null;
  const settlementStatus = ['completed', 'not_required', 'waived'].includes(input.settlementStatus)
    ? input.settlementStatus
    : 'pending';
  const paymentSettlementMethod = ['direct_pay', 'tenant_prepay_reimburse', 'rent_deduction', 'other', 'none'].includes(input.paymentSettlementMethod)
    ? input.paymentSettlementMethod
    : 'none';
  db.prepare(`
    UPDATE repair_tickets
    SET actual_cost_amount = ?,
        tenant_liability_amount = ?,
        payment_settlement_method = ?,
        settlement_status = ?,
        settlement_note = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    actualCostAmount,
    tenantLiabilityAmount,
    paymentSettlementMethod,
    settlementStatus,
    input.note || null,
    ticket.id,
  );
  addRepairUpdate(db, {
    repairTicketId: ticket.id,
    updateType: 'message',
    messageText: input.messageText || `已更新費用結算：${settlementStatus === 'completed' ? '已完成' : settlementStatus === 'not_required' ? '不需結算' : '待處理'}`,
    createdByUserId: input.createdByUserId,
  });
  return getRepairContext(db, input.ticketPublicId);
}

function recordTenantReportedRepairCost(db, input) {
  const ticket = db.prepare('SELECT * FROM repair_tickets WHERE public_id = ?').get(input.ticketPublicId);
  if (!ticket) throw new Error('repair ticket not found');

  const rawAmount = String(input.reportedCostAmount ?? '').trim();
  const amount = rawAmount === '' ? null : Number(rawAmount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    throw new Error('invalid tenant reported repair cost');
  }

  db.prepare(`
    UPDATE repair_tickets
    SET tenant_reported_cost_amount = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(amount === null ? null : Math.round(amount), ticket.id);

  return getRepairContext(db, input.ticketPublicId);
}

function getRepairContext(db, ticketPublicId) {
  return db.prepare(`
    SELECT
      rt.*,
      ru.unit_label,
      rua.asset_name,
      rua.asset_type,
      ai.risk_level AS ai_risk_level,
      ai.responsibility_guess AS ai_responsibility_guess,
      ai.recommended_executor AS ai_recommended_executor,
      ai.recommended_payer AS ai_recommended_payer,
      ai.rule_match_status AS ai_rule_match_status,
      ai.evidence_status AS ai_evidence_status,
      ai.cause_classification AS ai_cause_classification,
      ai.liability_party AS ai_liability_party,
      ai.recommended_dispatch_party AS ai_recommended_dispatch_party,
      ai.recommended_payer_party AS ai_recommended_payer_party,
      ai.confidence AS ai_confidence,
      ai.legal_basis_summary AS ai_legal_basis_summary,
      ai.contract_basis_summary AS ai_contract_basis_summary,
      ai.missing_info_json AS ai_missing_info_json,
      COALESCE(lrr.public_id, urd.public_id) AS ai_rule_public_id,
      COALESCE(lrr.source_clause_path, urd.source_clause_path) AS ai_rule_source_clause_path,
      COALESCE(lrr.source_text, urd.source_text) AS ai_rule_source_text,
      CASE WHEN urd.id IS NOT NULL THEN 'unit_default' ELSE 'lease_rule' END AS ai_rule_origin,
      COALESCE(up.display_name, li.display_name_cache, '房客') AS tenant_name,
      li.id AS tenant_line_identity_id,
      li.user_id AS tenant_user_id,
      li.line_user_id AS tenant_line_user_id,
      (
        SELECT COALESCE(owner_profile.display_name, owner_line.display_name_cache, '房東')
        FROM property_owners owner_link
        LEFT JOIN user_profiles owner_profile ON owner_profile.user_id = owner_link.owner_user_id
        LEFT JOIN line_identities owner_line ON owner_line.id = (
          SELECT selected_owner_line.id
          FROM line_identities selected_owner_line
          WHERE selected_owner_line.user_id = owner_link.owner_user_id
          ORDER BY
            CASE
              WHEN selected_owner_line.line_user_id LIKE 'U-DEMO%' THEN 1
              WHEN selected_owner_line.line_user_id LIKE '%DEMO%' THEN 1
              ELSE 0
            END,
            selected_owner_line.id DESC
          LIMIT 1
        )
        WHERE owner_link.property_id = ru.property_id
          AND (owner_link.rental_unit_id IS NULL OR owner_link.rental_unit_id = ru.id)
          AND (owner_link.effective_until IS NULL OR owner_link.effective_until >= date('now'))
        ORDER BY owner_link.id DESC
        LIMIT 1
      ) AS landlord_name,
      (
        SELECT owner_profile.phone
        FROM property_owners owner_link
        LEFT JOIN user_profiles owner_profile ON owner_profile.user_id = owner_link.owner_user_id
        WHERE owner_link.property_id = ru.property_id
          AND (owner_link.rental_unit_id IS NULL OR owner_link.rental_unit_id = ru.id)
          AND (owner_link.effective_until IS NULL OR owner_link.effective_until >= date('now'))
        ORDER BY owner_link.id DESC
        LIMIT 1
      ) AS landlord_phone
    FROM repair_tickets rt
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    LEFT JOIN rental_unit_assets rua ON rua.id = rt.asset_id
    LEFT JOIN repair_ai_assessments ai ON ai.id = rt.latest_assessment_id
    LEFT JOIN lease_repair_rules lrr ON lrr.id = ai.lease_repair_rule_id
    LEFT JOIN rental_unit_repair_rule_defaults urd ON urd.id = ai.rental_unit_repair_rule_default_id
    LEFT JOIN user_profiles up ON up.user_id = rt.reported_by_user_id
    LEFT JOIN line_identities li ON li.user_id = rt.reported_by_user_id
    WHERE rt.public_id = ?
    ORDER BY li.id DESC
    LIMIT 1
  `).get(ticketPublicId);
}

module.exports = {
  addFile,
  addRepairUpdate,
  advanceRepairSession,
  canManageRepairTicket,
  changeRepairStatus,
  confirmRepair,
  createRepairTicket,
  createRepairAiAssessment,
  createRepairAppointmentEvent,
  createRepairAppointmentFromSharedSlot,
  rescheduleRepairAppointmentToSharedSlot,
  getRepairAppointmentEvent,
  listAvailableSlotsForRepair,
  respondToRepairAppointmentEvent,
  updateRepairWorkflowState,
  recordTenantReportedRepairCost,
  recordRepairSettlement,
  createRepairResolutionRecord,
  findActiveTenantLease,
  findLeaseMoveInInspectionEvidence,
  listLeaseMoveInEvidenceForAsset,
  findLeaseRepairRule,
  findRepairAssetForDescription,
  finishRepairSession,
  getActiveRepairSession,
  getLineIdentity,
  getRepairContext,
  listLandlordRepairActiveTickets,
  listLandlordRepairActiveUnits,
  listLandlordRecentRepairUpdates,
  listLandlordRepairHistoryTickets,
  listLandlordRepairHistoryUnits,
  listRepairFiles,
  listRepairUpdates,
  listTenantRepairHistoryTickets,
  listTenantRepairTickets,
  linkFileToRepairUpdate,
  listLandlordRecipients,
  startRepairSession,
};
