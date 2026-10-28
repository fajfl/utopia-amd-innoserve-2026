// v2RepairRepository.js 的 driver 版本。所有新寫入都必須走這份介面，避免
// 身分/租約在 TiDB、報修案件卻被寫進本機 SQLite 的分裂狀態。
//
// TiDB 可攜性:同步版的 landlord_name 把子查詢放在 LEFT JOIN 的 ON 裡,TiDB 直接丟例外,
// 所以這裡拆成先取擁有者、必要時再查一次 LINE 顯示名稱。

function currentDateSql(db) {
  return db && db.dialect && db.dialect.name === 'mysql' ? 'CURRENT_DATE()' : "date('now')";
}

function inferPriority(text) {
  return /(瓦斯|漏氣|冒煙|火花|觸電|電線|淹水|漏水|水管爆|斷電|門鎖壞|無法關門)/.test(String(text || '')) ? 'urgent' : 'normal';
}

async function getLineIdentity(db, lineUserId) {
  if (!lineUserId) return null;
  return db.get(`
    SELECT li.id AS line_identity_id, li.user_id, li.line_user_id, li.display_name_cache
    FROM line_identities li JOIN users u ON u.id = li.user_id
    WHERE li.line_user_id = ? AND u.status = 'active' LIMIT 1
  `, [lineUserId]);
}

async function findActiveTenantLease(db, userId) {
  return db.get(`
    SELECT le.id AS lease_id, le.public_id AS lease_public_id, le.contract_id,
      le.rental_unit_id, ru.unit_label, ru.property_id
    FROM lease_parties lp
    JOIN leases le ON le.id = lp.lease_id
    JOIN rental_units ru ON ru.id = le.rental_unit_id
    WHERE lp.user_id = ? AND lp.party_role = 'tenant'
      AND le.status IN ('active', 'scheduled')
      AND (lp.effective_until IS NULL OR lp.effective_until >= ${currentDateSql(db)})
    ORDER BY CASE le.status WHEN 'active' THEN 0 ELSE 1 END, le.start_date DESC LIMIT 1
  `, [userId]);
}

async function listRepairAssetsForUnit(db, rentalUnitId) {
  return db.all(`
    SELECT id, asset_name, asset_type, source_type, source_id FROM rental_unit_assets
    WHERE rental_unit_id = ? AND status = 'active'
    ORDER BY CASE asset_type WHEN 'appliance' THEN 0 WHEN 'plumbing' THEN 1
      WHEN 'electrical' THEN 2 WHEN 'fixture' THEN 3 WHEN 'furniture' THEN 4
      WHEN 'surface' THEN 5 WHEN 'service' THEN 6 ELSE 9 END, asset_name
  `, [rentalUnitId]);
}

async function findRepairAssetForDescription(db, { rentalUnitId, description }) {
  if (!rentalUnitId) return null;
  const assets = await db.all(`
    SELECT * FROM rental_unit_assets
    WHERE rental_unit_id = ? AND status = 'active'
    ORDER BY CASE asset_type WHEN 'appliance' THEN 0 WHEN 'plumbing' THEN 1
      WHEN 'electrical' THEN 2 WHEN 'furniture' THEN 3 ELSE 9 END,
      length(asset_name) DESC
  `, [rentalUnitId]);
  return assets.find((asset) => String(description || '').includes(asset.asset_name)) || null;
}

function legacyDamageToCause(damageType) {
  return {
    natural_wear: 'natural_wear', normal_use: 'normal_failure', tenant_fault: 'tenant_negligence',
    malicious_damage: 'intentional_damage', unknown: 'unknown',
  }[damageType] || 'unknown';
}

function normalizeRepairRule(row) {
  if (!row) return null;
  const cause = row.cause_classification || legacyDamageToCause(row.damage_type);
  const liability = row.liability_party || row.responsible_party || 'review_required';
  const dispatch = row.dispatch_party || row.repair_executor || 'review_required';
  return { ...row, cause_classification: cause, liability_party: liability, dispatch_party: dispatch,
    responsible_party: row.responsible_party || liability, repair_executor: row.repair_executor || dispatch,
    payer_party: row.payer_party || 'review_required' };
}

async function findLeaseRepairRule(db, { leaseId, rentalUnitId, assetId = null, damageType = 'unknown' }) {
  if (!rentalUnitId) return null;
  const causeClassification = legacyDamageToCause(damageType);
  const normalDamage = ['natural_wear', 'normal_use'].includes(damageType) ? 1 : 0;
  const normalCause = ['natural_wear', 'normal_failure'].includes(causeClassification) ? 1 : 0;
  const matching = `AND status = 'active' AND (asset_id = ? OR asset_id IS NULL)
    AND (cause_classification IN (?, 'unknown') OR damage_type IN (?, 'unknown')
      OR (? = 1 AND cause_classification IN ('natural_wear', 'normal_failure'))
      OR (? = 1 AND damage_type IN ('natural_wear', 'normal_use')))`;
  const order = `ORDER BY CASE WHEN asset_id = ? THEN 0 ELSE 1 END,
    CASE WHEN ? = 1 AND cause_classification IN ('natural_wear', 'normal_failure') THEN 0
      WHEN ? = 1 AND damage_type IN ('natural_wear', 'normal_use') THEN 0 ELSE 1 END,
    CASE WHEN cause_classification = ? THEN 0 ELSE 1 END,
    CASE WHEN damage_type = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`;
  const values = [assetId, causeClassification, damageType, normalCause, normalDamage,
    assetId, normalCause, normalDamage, causeClassification, damageType];
  const leaseRule = leaseId ? await db.get(`SELECT *, 'lease_rule' AS rule_origin FROM lease_repair_rules
    WHERE lease_id = ? AND rental_unit_id = ? ${matching} ${order}`, [leaseId, rentalUnitId, ...values]) : null;
  if (leaseRule) return normalizeRepairRule(leaseRule);
  return normalizeRepairRule(await db.get(`SELECT *, 'unit_default' AS rule_origin FROM rental_unit_repair_rule_defaults
    WHERE rental_unit_id = ? ${matching} ${order}`, [rentalUnitId, ...values]));
}

async function findLeaseMoveInInspectionEvidence(db, { leaseId, rentalUnitId }) {
  const attached = leaseId ? await db.all(`
    SELECT pis.public_id AS session_public_id, pis.confirmation_status, cca.image_count
    FROM leases le JOIN contract_versions cv ON cv.contract_id = le.contract_id
    JOIN contract_condition_attachments cca ON cca.contract_version_id = cv.id
    JOIN pre_inspection_sessions pis ON pis.id = cca.pre_inspection_session_id
    WHERE le.id = ? AND pis.status = 'sealed' AND cca.image_count > 0
    ORDER BY CASE WHEN pis.confirmation_status = 'landlord_confirmed' THEN 0 ELSE 1 END,
      COALESCE(pis.landlord_confirmed_at, pis.sealed_at, pis.updated_at, pis.created_at) DESC
  `, [leaseId]) : [];
  const fallback = attached.length || !rentalUnitId ? [] : await db.all(`
    SELECT pis.public_id AS session_public_id, pis.confirmation_status,
      COUNT(CASE WHEN pie.entry_type = 'image' THEN 1 END) AS image_count
    FROM pre_inspection_sessions pis JOIN listings l ON l.id = pis.listing_id
    LEFT JOIN pre_inspection_entries pie ON pie.session_id = pis.id
    WHERE l.rental_unit_id = ? AND pis.status = 'sealed'
    GROUP BY pis.id HAVING COUNT(CASE WHEN pie.entry_type = 'image' THEN 1 END) > 0
    ORDER BY CASE WHEN pis.confirmation_status = 'landlord_confirmed' THEN 0 ELSE 1 END,
      COALESCE(pis.landlord_confirmed_at, pis.sealed_at, pis.updated_at, pis.created_at) DESC
  `, [rentalUnitId]);
  const rows = attached.length ? attached : fallback;
  const imageCount = rows.reduce((total, row) => total + Number(row.image_count || 0), 0);
  if (!rows.length) return { status: 'unavailable', source: 'none', imageCount: 0,
    label: '尚無已完成點交照片可比對', detail: '系統會保留目前照片；後續可由維修紀錄或其他證據補強。' };
  const source = attached.length ? 'contract_attachment' : 'sealed_inspection';
  const landlordConfirmed = rows.some((row) => row.confirmation_status === 'landlord_confirmed');
  return { status: 'available', source, imageCount, sessionCount: rows.length,
    sessionPublicIds: rows.map((row) => row.session_public_id), landlordConfirmed,
    label: source === 'contract_attachment' ? `已找到租約附件點交照片（${imageCount} 張）` : `已找到已封存點交照片（${imageCount} 張）`,
    detail: landlordConfirmed ? '此紀錄已由房東確認，系統會作為原始物況比對依據。' : '此紀錄已封存，系統會作為原始物況的參考依據。' };
}

async function listLandlordRecipients(db, rentalUnitId) {
  const owners = await db.all(`
    SELECT DISTINCT po.owner_user_id AS user_id
    FROM rental_units ru JOIN property_owners po
      ON po.property_id = ru.property_id
     AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
     AND (po.effective_until IS NULL OR po.effective_until >= ${currentDateSql(db)})
    WHERE ru.id = ?
  `, [rentalUnitId]);
  const recipients = [];
  for (const owner of owners) {
    const identity = await db.get(`
      SELECT id AS line_identity_id, line_user_id FROM line_identities
      WHERE user_id = ? ORDER BY CASE WHEN line_user_id LIKE '%DEMO%' THEN 1 ELSE 0 END, id DESC LIMIT 1
    `, [owner.user_id]);
    if (identity) recipients.push({ user_id: owner.user_id, ...identity, scope: 'unit_owner' });
  }
  return recipients;
}

async function createRepairTicket(db, input) {
  const publicId = `repair-${require('node:crypto').randomUUID()}`;
  await db.run(`
    INSERT INTO repair_tickets (
      public_id, lease_id, rental_unit_id, category, description, priority, status,
      reported_by_user_id, assigned_owner_user_id, asset_id, damage_type,
      cause_classification, tenant_preference
    ) VALUES (?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?)
  `, [publicId, input.leaseId, input.rentalUnitId, input.category || '一般報修', input.description,
    input.priority || inferPriority(input.description), input.reportedByUserId, input.assignedOwnerUserId || null,
    input.assetId || null, input.damageType || 'unknown', input.causeClassification || 'unknown', input.tenantPreference || 'no_preference']);
  return db.get('SELECT * FROM repair_tickets WHERE public_id = ?', [publicId]);
}

async function addRepairUpdate(db, input) {
  const publicId = `repair-update-${require('node:crypto').randomUUID()}`;
  await db.run(`INSERT INTO repair_updates (
    public_id, repair_ticket_id, update_type, from_status, to_status, message_text, created_by_user_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [publicId, input.repairTicketId, input.updateType,
    input.fromStatus || null, input.toStatus || null, input.messageText || null, input.createdByUserId]);
  return db.get('SELECT * FROM repair_updates WHERE public_id = ?', [publicId]);
}

async function changeRepairStatus(db, input) {
  const ticket = await db.get('SELECT * FROM repair_tickets WHERE public_id = ?', [input.ticketPublicId]);
  if (!ticket) throw new Error('repair ticket not found');
  const toStatus = input.toStatus;
  await db.run(`UPDATE repair_tickets SET status=?, repair_status=CASE
      WHEN ? IN ('landlord_completed', 'repair_completed', 'tenant_confirmed') THEN 'completed'
      WHEN ? IN ('accepted', 'in_progress', 'tenant_self_repair', 'tenant_pays', 'reopened') THEN 'awaiting_execution'
      WHEN ?='reported' THEN 'reported' ELSE repair_status END,
      completed_at=CASE WHEN ?='landlord_completed' THEN COALESCE(completed_at, ${db.dialect.utcNow()}) ELSE completed_at END,
      closed_at=CASE WHEN ?='tenant_confirmed' THEN COALESCE(closed_at, ${db.dialect.utcNow()}) ELSE closed_at END,
      updated_at=${db.dialect.utcNow()} WHERE id=?`, [toStatus, toStatus, toStatus, toStatus, toStatus, toStatus, ticket.id]);
  await addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'status_change', fromStatus: ticket.status,
    toStatus, messageText: input.messageText, createdByUserId: input.createdByUserId });
  return db.get('SELECT * FROM repair_tickets WHERE id = ?', [ticket.id]);
}

async function updateRepairWorkflowState(db, input) {
  const ticket = await db.get('SELECT * FROM repair_tickets WHERE public_id = ?', [input.ticketPublicId]);
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
  const pick = (key, column) => input[key] === undefined || !allowed[key].includes(input[key]) ? ticket[column] : input[key];
  await db.run(`UPDATE repair_tickets SET repair_status=?, liability_status=?, dispatch_party=?, appointment_status=?,
    repair_verification_status=?, safety_status=?, action_owner=?, waiting_on=?, dispute_scope=?, case_status=?,
    updated_at=${db.dialect.utcNow()} WHERE id=?`, [pick('repairStatus', 'repair_status'),
    pick('liabilityStatus', 'liability_status'), pick('dispatchParty', 'dispatch_party'),
    pick('appointmentStatus', 'appointment_status'), pick('repairVerificationStatus', 'repair_verification_status'),
    pick('safetyStatus', 'safety_status'), pick('actionOwner', 'action_owner'), pick('waitingOn', 'waiting_on'),
    pick('disputeScope', 'dispute_scope'), pick('caseStatus', 'case_status'), ticket.id]);
  return getRepairContext(db, input.ticketPublicId);
}

async function recordTenantReportedRepairCost(db, input) {
  const ticket = await db.get('SELECT * FROM repair_tickets WHERE public_id = ?', [input.ticketPublicId]);
  if (!ticket) throw new Error('repair ticket not found');
  const raw = String(input.reportedCostAmount ?? '').trim();
  const amount = raw === '' ? null : Number(raw);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('invalid tenant reported repair cost');
  await db.run(`UPDATE repair_tickets SET tenant_reported_cost_amount=?, updated_at=${db.dialect.utcNow()} WHERE id=?`, [amount === null ? null : Math.round(amount), ticket.id]);
  return getRepairContext(db, input.ticketPublicId);
}

async function addFile(db, input) {
  const publicId = `file-${require('node:crypto').randomUUID()}`;
  await db.run(`${db.dialect.insertIgnore} INTO files (
    public_id, storage_key, storage_provider, original_name, mime_type,
    size_bytes, sha256_hash, security_classification, status, created_by_user_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 'active', ?)`, [publicId,
    input.storageKey, input.storageProvider || 'local', input.originalName || 'repair-upload',
    input.mimeType || 'application/octet-stream', input.sizeBytes || 0, input.sha256Hash,
    input.createdByUserId || null]);
  return db.get(`SELECT id, public_id FROM files WHERE storage_key = ?
    OR (sha256_hash = ? AND size_bytes = ? AND security_classification = 'private')
    ORDER BY id DESC LIMIT 1`, [input.storageKey, input.sha256Hash, input.sizeBytes || 0]);
}

async function linkFileToRepairUpdate(db, { fileId, repairUpdateId, purpose }) {
  await db.run(`INSERT INTO file_links (file_id, entity_type, entity_id, purpose)
    VALUES (?, 'repair_update', ?, ?)`, [fileId, repairUpdateId, purpose || null]);
}

async function createRepairAiAssessment(db, input) {
  const publicId = `repair-ai-${require('node:crypto').randomUUID()}`;
  const liabilityParty = input.liabilityParty || input.responsibilityGuess || 'pending';
  const dispatchParty = input.recommendedDispatchParty || input.recommendedExecutor || 'review_required';
  const payerParty = input.recommendedPayerParty || input.recommendedPayer || 'review_required';
  await db.run(`INSERT INTO repair_ai_assessments (
    public_id, repair_ticket_id, lease_id, asset_id, lease_repair_rule_id,
    rental_unit_repair_rule_default_id, risk_level, responsibility_guess,
    recommended_executor, recommended_payer, confidence, rule_match_status,
    evidence_status, cause_classification, liability_party, recommended_dispatch_party,
    recommended_payer_party, legal_basis_summary, contract_basis_summary,
    missing_info_json, rule_refs_json, raw_result_json, model_or_rule_version
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    publicId, input.repairTicketId, input.leaseId || null, input.assetId || null,
    input.leaseRepairRuleId || null, input.rentalUnitRepairRuleDefaultId || null,
    input.riskLevel || 'normal', input.responsibilityGuess || 'insufficient_info', dispatchParty,
    payerParty, input.confidence ?? null, input.ruleMatchStatus || 'not_evaluated',
    input.evidenceStatus || 'insufficient', input.causeClassification || 'unknown', liabilityParty,
    dispatchParty, payerParty, input.legalBasisSummary || null, input.contractBasisSummary || null,
    JSON.stringify(input.missingInfo || []), JSON.stringify(input.ruleRefs || []),
    JSON.stringify(input.rawResult || {}), input.modelOrRuleVersion || 'repair-agent-rule-v1'
  ]);
  const row = await db.get('SELECT * FROM repair_ai_assessments WHERE public_id = ?', [publicId]);
  await db.run(`UPDATE repair_tickets SET latest_assessment_id = ?, updated_at = ${db.dialect.utcNow()} WHERE id = ?`, [row.id, input.repairTicketId]);
  return row;
}

async function listRepairFiles(db, ticketPublicId, purpose = null) {
  const purposeFilter = purpose ? 'AND fl.purpose = ?' : '';
  const params = purpose ? [ticketPublicId, purpose] : [ticketPublicId];
  return await db.all(`
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
    WHERE rt.public_id = ?
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
  `, params);
}

async function listRepairUpdates(db, ticketPublicId, limit = 100) {
  return db.all(`
    SELECT ru.id, ru.public_id, ru.update_type, ru.from_status, ru.to_status, ru.message_text, ru.created_at,
      COALESCE(up.display_name, (
        SELECT li2.display_name_cache FROM line_identities li2
        WHERE li2.user_id = ru.created_by_user_id
        ORDER BY li2.id DESC LIMIT 1
      ), '系統') AS actor_name
    FROM repair_tickets rt JOIN repair_updates ru ON ru.repair_ticket_id = rt.id
    LEFT JOIN user_profiles up ON up.user_id = ru.created_by_user_id
    WHERE rt.public_id = ?
    ORDER BY ru.created_at ASC, ru.id ASC LIMIT ?
  `, [ticketPublicId, limit]);
}

async function listTenantRepairTickets(db, tenantUserId, limit = 50, { history = false } = {}) {
  return db.all(`
    SELECT rt.public_id, rt.lease_id, rt.rental_unit_id, rt.category, rt.description, rt.priority,
      rt.status, rt.repair_status, rt.repair_verification_status, rt.settlement_status, rt.case_status,
      rt.dispatch_party, rt.reported_at, rt.updated_at, ru.unit_label,
      (SELECT COUNT(*) FROM repair_updates u JOIN file_links fl ON fl.entity_type='repair_update'
        AND fl.entity_id=u.id AND fl.purpose='damage_photo' JOIN files f ON f.id=fl.file_id
        WHERE u.repair_ticket_id=rt.id AND f.status='active') AS damage_photo_count,
      (SELECT COUNT(*) FROM repair_updates u JOIN file_links fl ON fl.entity_type='repair_update'
        AND fl.entity_id=u.id AND fl.purpose='completion_photo' JOIN files f ON f.id=fl.file_id
        WHERE u.repair_ticket_id=rt.id AND f.status='active') AS completion_photo_count,
      (SELECT ce.public_id FROM calendar_events ce WHERE ce.repair_ticket_id=rt.id
        AND ce.event_type='repair_appointment' AND ce.status='scheduled' ORDER BY ce.id DESC LIMIT 1) AS active_appointment_public_id,
      (SELECT u.message_text FROM repair_updates u WHERE u.repair_ticket_id=rt.id
        AND u.update_type='appointment' ORDER BY u.id DESC LIMIT 1) AS latest_appointment_message
    FROM repair_tickets rt JOIN leases le ON le.id=rt.lease_id
    JOIN lease_parties lp ON lp.lease_id=le.id AND lp.party_role='tenant' AND lp.user_id=?
    JOIN rental_units ru ON ru.id=rt.rental_unit_id
    WHERE ${history ? "rt.status = 'tenant_confirmed'" : "rt.status NOT IN ('tenant_confirmed', 'cancelled')"}
    ORDER BY COALESCE(rt.updated_at, rt.reported_at) DESC, rt.id DESC LIMIT ?
  `, [tenantUserId, limit]);
}

async function listLandlordRepairActiveTickets(db, ownerUserId, { unitId = null, limit = 50, history = false } = {}) {
  const dateExpr = currentDateSql(db);
  const params = [ownerUserId];
  let unitFilter = '';
  if (unitId != null) { unitFilter = 'AND rt.rental_unit_id = ?'; params.push(unitId); }
  params.push(limit);
  return db.all(`
    SELECT DISTINCT rt.id AS ticket_id, rt.public_id, rt.lease_id, rt.rental_unit_id, rt.category, rt.description, rt.priority,
      rt.status, rt.reported_at, rt.updated_at, ru.unit_label,
      COALESCE(up.display_name, (
        SELECT li2.display_name_cache FROM line_identities li2
        WHERE li2.user_id = rt.reported_by_user_id
        ORDER BY li2.id DESC LIMIT 1
      ), '房客') AS tenant_name,
      (SELECT COUNT(*) FROM repair_updates u JOIN file_links fl ON fl.entity_type='repair_update'
        AND fl.entity_id=u.id AND fl.purpose='damage_photo' JOIN files f ON f.id=fl.file_id
        WHERE u.repair_ticket_id=rt.id AND f.status='active') AS damage_photo_count,
      (SELECT COUNT(*) FROM repair_updates u JOIN file_links fl ON fl.entity_type='repair_update'
        AND fl.entity_id=u.id AND fl.purpose='completion_photo' JOIN files f ON f.id=fl.file_id
        WHERE u.repair_ticket_id=rt.id AND f.status='active') AS completion_photo_count
    FROM repair_tickets rt JOIN rental_units ru ON ru.id=rt.rental_unit_id
    JOIN property_owners po ON po.property_id=ru.property_id
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id=ru.id)
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    LEFT JOIN user_profiles up ON up.user_id=rt.reported_by_user_id
    WHERE po.owner_user_id=? AND ru.status != 'inactive'
      AND ${history ? "rt.status = 'tenant_confirmed'" : "rt.status NOT IN ('tenant_confirmed', 'cancelled')"}
      ${unitFilter}
    ORDER BY COALESCE(rt.updated_at, rt.reported_at) DESC, rt.id DESC LIMIT ?
  `, params);
}

async function getRepairAppointmentEvent(db, repairTicketId, eventPublicId = '') {
  if (!eventPublicId) return db.get(`SELECT * FROM calendar_events
    WHERE repair_ticket_id = ? AND event_type = 'repair_appointment' AND status = 'scheduled'
    ORDER BY starts_at DESC, id DESC LIMIT 1`, [repairTicketId]);
  return db.get(`SELECT * FROM calendar_events WHERE repair_ticket_id = ? AND public_id = ?
    AND event_type = 'repair_appointment' LIMIT 1`, [repairTicketId, eventPublicId]);
}

async function createRepairResolutionRecord(db, input) {
  const publicId = `repair-resolution-${crypto.randomUUID()}`;
  const liabilityParty = input.liabilityParty || input.responsibleParty || 'pending';
  const dispatchParty = input.dispatchParty || input.repairExecutor || 'pending';
  await db.run(`INSERT INTO repair_resolution_records (
    public_id, repair_ticket_id, basis_type, responsible_party, repair_executor, payer_party,
    liability_party, dispatch_party, settlement_basis, payment_settlement_method,
    cost_limit_amount, receipt_required, tax_id_required, resolution_text, ai_summary,
    source_assessment_id, source_rule_refs_json, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    publicId, input.repairTicketId, input.basisType || 'manual_review',
    input.responsibleParty || 'review_required', dispatchParty, input.payerParty || 'review_required',
    liabilityParty, dispatchParty, input.settlementBasis || 'manual', input.paymentSettlementMethod || 'none',
    input.costLimitAmount ?? null, input.receiptRequired ? 1 : 0, input.taxIdRequired ? 1 : 0,
    input.resolutionText || '', input.aiSummary || null, input.sourceAssessmentId || null,
    JSON.stringify(input.sourceRuleRefs || []), input.status || 'draft',
  ]);
  const row = await db.get('SELECT * FROM repair_resolution_records WHERE public_id = ?', [publicId]);
  await db.run(`UPDATE repair_tickets SET latest_resolution_id = ?, updated_at = ${db.dialect.utcNow()} WHERE id = ?`, [row.id, input.repairTicketId]);
  return row;
}

async function createRepairAppointmentEvent(db, input) {
  const publicId = `cal-${crypto.randomUUID()}`;
  await db.run(`INSERT INTO calendar_events (
    public_id, event_type, title, starts_at, ends_at, lease_id, repair_ticket_id, status
  ) VALUES (?, 'repair_appointment', ?, ?, ?, ?, ?, 'scheduled')`, [
    publicId, input.title, input.startsAt, input.endsAt || null, input.leaseId || null, input.repairTicketId,
  ]);
  return db.get('SELECT * FROM calendar_events WHERE public_id = ?', [publicId]);
}

async function respondToRepairAppointmentEvent(db, input) {
  const event = await getRepairAppointmentEvent(db, input.repairTicketId, input.eventPublicId);
  if (!event) throw new Error('repair appointment not found');
  const response = input.response === 'accept' ? 'accept' : 'reschedule';
  if (response === 'reschedule') await db.run('DELETE FROM repair_slot_reservations WHERE calendar_event_id = ?', [event.id]);
  await db.run('UPDATE calendar_events SET status = ? WHERE id = ?', [response === 'reschedule' ? 'cancelled' : 'scheduled', event.id]);
  return db.get('SELECT * FROM calendar_events WHERE id = ?', [event.id]);
}

const sharedRepairSlotSql = `
  SELECT s.id, s.public_id, s.starts_at, s.ends_at
  FROM showing_slots s
  JOIN repair_tickets rt ON rt.id = ?
  JOIN leases le ON le.id = rt.lease_id
  JOIN (
    SELECT id, rental_unit_id FROM (
      SELECT id, rental_unit_id,
        ROW_NUMBER() OVER (PARTITION BY rental_unit_id ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END, id DESC) AS rn
      FROM listings
    ) ranked_listings WHERE rn = 1
  ) l ON l.rental_unit_id = le.rental_unit_id AND l.id = s.listing_id
  WHERE s.status = 'open' AND s.held_appointment_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = s.id)`;

async function listAvailableSlotsForRepair(db, repairTicketId, limit = 40) {
  const now = db.dialect.name === 'mysql' ? 'UTC_TIMESTAMP()' : "strftime('%Y-%m-%dT%H:%M', 'now', '+8 hours')";
  return db.all(`${sharedRepairSlotSql} AND s.starts_at > ${now} ORDER BY s.starts_at ASC, s.id ASC LIMIT ?`, [repairTicketId, limit]);
}

async function reserveRepairSharedSlot(db, input, currentEvent = null) {
  const slot = await db.get(`${sharedRepairSlotSql} AND s.public_id = ? LIMIT 1`, [input.repairTicketId, input.slotPublicId]);
  if (!slot) throw new Error('repair shared slot unavailable');
  const locked = await db.run(`UPDATE showing_slots SET updated_at = ${db.dialect.utcNow()}
    WHERE id = ? AND status = 'open' AND held_appointment_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM repair_slot_reservations rs WHERE rs.showing_slot_id = showing_slots.id)`, [slot.id]);
  if (Number(locked.changes || locked.affectedRows || 0) !== 1) throw new Error('repair shared slot unavailable');
  if (currentEvent) {
    await db.run('DELETE FROM repair_slot_reservations WHERE calendar_event_id = ?', [currentEvent.id]);
    await db.run("UPDATE calendar_events SET status = 'cancelled' WHERE id = ?", [currentEvent.id]);
  } else {
    await db.run("UPDATE calendar_events SET status = 'cancelled' WHERE repair_ticket_id = ? AND event_type = 'repair_appointment' AND status = 'scheduled'", [input.repairTicketId]);
  }
  const event = await createRepairAppointmentEvent(db, { ...input, startsAt: slot.starts_at, endsAt: slot.ends_at || null });
  await db.run('INSERT INTO repair_slot_reservations (public_id, showing_slot_id, calendar_event_id) VALUES (?, ?, ?)', [`repair-slot-${crypto.randomUUID()}`, slot.id, event.id]);
  return { ...event, shared_slot_public_id: slot.public_id, ...(currentEvent ? { previous_event_public_id: currentEvent.public_id } : {}) };
}

async function createRepairAppointmentFromSharedSlot(db, input) {
  return db.transaction(() => reserveRepairSharedSlot(db, input));
}

async function rescheduleRepairAppointmentToSharedSlot(db, input) {
  return db.transaction(async () => {
    const currentEvent = await getRepairAppointmentEvent(db, input.repairTicketId, input.eventPublicId);
    if (!currentEvent || currentEvent.status !== 'scheduled') throw new Error('repair appointment not found');
    return reserveRepairSharedSlot(db, input, currentEvent);
  });
}

async function recordRepairSettlement(db, input) {
  const ticket = await db.get('SELECT * FROM repair_tickets WHERE public_id = ?', [input.ticketPublicId]);
  if (!ticket) throw new Error('repair ticket not found');
  const money = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null;
  const settlementStatus = ['completed', 'not_required', 'waived'].includes(input.settlementStatus) ? input.settlementStatus : 'pending';
  const method = ['direct_pay', 'tenant_prepay_reimburse', 'rent_deduction', 'other', 'none'].includes(input.paymentSettlementMethod) ? input.paymentSettlementMethod : 'none';
  await db.run(`UPDATE repair_tickets SET actual_cost_amount=?, tenant_liability_amount=?, payment_settlement_method=?, settlement_status=?, settlement_note=?, updated_at=${db.dialect.utcNow()} WHERE id=?`, [money(input.actualCostAmount), money(input.tenantLiabilityAmount), method, settlementStatus, input.note || null, ticket.id]);
  await addRepairUpdate(db, { repairTicketId: ticket.id, updateType: 'message', messageText: input.messageText || `已更新費用結算：${settlementStatus}`, createdByUserId: input.createdByUserId });
  return getRepairContext(db, input.ticketPublicId);
}

// 同步版用一組巢狀子查詢挑「非 DEMO 優先、id 最大」的那筆 LINE 身分當房東顯示名稱。
// 拆成兩段查詢,語意相同但不會在 JOIN ON 出現子查詢。
async function getLandlordContact(db, { propertyId, rentalUnitId }) {
  const dateExpr = currentDateSql(db);
  const owner = await db.get(`
    SELECT po.owner_user_id, up.display_name, up.phone
    FROM property_owners po
    LEFT JOIN user_profiles up ON up.user_id = po.owner_user_id
    WHERE po.property_id = ?
      AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ?)
      AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    ORDER BY po.id DESC
    LIMIT 1
  `, [propertyId, rentalUnitId]);
  if (!owner) return { landlord_name: '房東', landlord_phone: null };

  let name = owner.display_name;
  if (!name) {
    const line = await db.get(`
      SELECT display_name_cache
      FROM line_identities
      WHERE user_id = ?
      ORDER BY
        CASE WHEN line_user_id LIKE '%DEMO%' THEN 1 ELSE 0 END,
        id DESC
      LIMIT 1
    `, [owner.owner_user_id]);
    name = line ? line.display_name_cache : null;
  }
  return { landlord_name: name || '房東', landlord_phone: owner.phone || null };
}

async function getRepairContext(db, ticketPublicId) {
  const row = await db.get(`
    SELECT
      rt.*,
      ru.unit_label,
      ru.property_id AS rental_unit_property_id,
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
      li.line_user_id AS tenant_line_user_id
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
  `, [ticketPublicId]);
  if (!row) return row;

  const landlord = await getLandlordContact(db, {
    propertyId: row.rental_unit_property_id,
    rentalUnitId: row.rental_unit_id,
  });
  return { ...row, ...landlord };
}

async function canManageRepairTicket(db, ticketPublicId, userId) {
  if (!ticketPublicId || !userId) return false;
  const dateExpr = currentDateSql(db);
  const row = await db.get(`
    SELECT 1 AS allowed
    FROM repair_tickets rt
    JOIN rental_units ru ON ru.id = rt.rental_unit_id
    LEFT JOIN property_owners po
      ON po.property_id = ru.property_id
     AND (po.rental_unit_id IS NULL OR po.rental_unit_id = ru.id)
     AND (po.effective_until IS NULL OR po.effective_until >= ${dateExpr})
    WHERE rt.public_id = ?
      AND (
        rt.assigned_owner_user_id = ?
        OR po.owner_user_id = ?
      )
    LIMIT 1
  `, [ticketPublicId, userId, userId]);
  return Boolean(row);
}

module.exports = {
  getLineIdentity,
  findActiveTenantLease,
  listRepairAssetsForUnit,
  findRepairAssetForDescription,
  findLeaseRepairRule,
  findLeaseMoveInInspectionEvidence,
  listLandlordRecipients,
  createRepairTicket,
  addRepairUpdate,
  changeRepairStatus,
  updateRepairWorkflowState,
  recordTenantReportedRepairCost,
  addFile,
  linkFileToRepairUpdate,
  createRepairAiAssessment,
  listRepairFiles,
  listRepairUpdates,
  listTenantRepairTickets,
  listLandlordRepairActiveTickets,
  getRepairAppointmentEvent,
  createRepairResolutionRecord,
  createRepairAppointmentEvent,
  respondToRepairAppointmentEvent,
  listAvailableSlotsForRepair,
  createRepairAppointmentFromSharedSlot,
  rescheduleRepairAppointmentToSharedSlot,
  recordRepairSettlement,
  getRepairContext,
  canManageRepairTicket,
};
