const crypto = require('node:crypto');
const { assertLandlordAnswerReusable } = require('../database/integrityGuards');
const { RULE_ORDER_STEP } = require('./v2LandlordRuleRepositoryAsync');

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function inTransaction(db, work) {
  return db.inTransaction ? work() : db.transaction(work).immediate();
}

function listLandlordListings(db, landlordUserId, { limit = 10, offset = 0 } = {}) {
  return db.prepare(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      COALESCE(valid.parse_status, latest.parse_status, 'partial') quality_status,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count,
      (SELECT COUNT(*) FROM knowledge_scope_links ksl
       JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
       JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
       WHERE ksl.rental_unit_id = l.rental_unit_id AND ki.status = 'active'
         AND kv.effective_until IS NULL) knowledge_count
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON (po.rental_unit_id = ru.id OR (po.rental_unit_id IS NULL AND po.property_id = ru.property_id))
    LEFT JOIN listing_snapshots valid ON valid.id = l.latest_valid_snapshot_id
    LEFT JOIN listing_snapshots latest ON latest.id = (
      SELECT ls.id FROM listing_snapshots ls WHERE ls.listing_id = l.id
      ORDER BY ls.captured_at DESC, ls.id DESC LIMIT 1
    )
    WHERE po.owner_user_id = ? AND po.effective_until IS NULL
    ORDER BY pending_count DESC, datetime(l.updated_at) DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(landlordUserId, limit, offset).map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    qualityStatus: row.quality_status,
    pendingQuestionCount: row.pending_count,
    knowledgeCount: row.knowledge_count
  }));
}

function listTenantsForListing(db, listingPublicId) {
  return db.prepare(`
    SELECT i.id inquiryId, li.display_name_cache displayName, li.line_user_id lineUserId
    FROM inquiries i
    JOIN line_identities li ON li.user_id = i.user_id
    JOIN listings l ON l.id = i.listing_id
    WHERE l.public_id = ? AND i.ended_at IS NULL
    GROUP BY i.id
    ORDER BY i.last_activity_at DESC LIMIT 10
  `).all(listingPublicId);
}

function listDemoListings(db, { limit = 10, offset = 0 } = {}) {
  return db.prepare(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      COALESCE(valid.parse_status, latest.parse_status, 'partial') quality_status,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count,
      (SELECT COUNT(*) FROM knowledge_scope_links ksl
       JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
       JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
       WHERE ksl.rental_unit_id = l.rental_unit_id AND ki.status = 'active'
         AND kv.effective_until IS NULL) knowledge_count
    FROM listings l
    LEFT JOIN listing_snapshots valid ON valid.id = l.latest_valid_snapshot_id
    LEFT JOIN listing_snapshots latest ON latest.id = (
      SELECT ls.id FROM listing_snapshots ls WHERE ls.listing_id = l.id
      ORDER BY ls.captured_at DESC, ls.id DESC LIMIT 1
    )
    WHERE l.public_id LIKE 'demo-591-listing-%'
    ORDER BY pending_count DESC, datetime(l.updated_at) DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset).map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    qualityStatus: row.quality_status,
    pendingQuestionCount: row.pending_count,
    knowledgeCount: row.knowledge_count
  }));
}

function getListingKnowledgeSummary(db, listingPublicId) {
  const row = db.prepare(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount, l.rental_unit_id,
      p.address_text, ru.floor_label, ru.room_count,
      COALESCE(valid.parse_status, latest.parse_status, 'partial') quality_status,
      COALESCE(valid.amenity_json, latest.amenity_json, '[]') amenity_json
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN properties p ON p.id = ru.property_id
    LEFT JOIN listing_snapshots valid ON valid.id = l.latest_valid_snapshot_id
    LEFT JOIN listing_snapshots latest ON latest.id = (
      SELECT ls.id FROM listing_snapshots ls WHERE ls.listing_id = l.id
      ORDER BY ls.captured_at DESC, ls.id DESC LIMIT 1
    )
    WHERE l.public_id = ?
  `).get(listingPublicId);
  if (!row) throw new Error('listing not found');
  const publicKnowledge = db.prepare(`
    SELECT ki.public_id, ki.knowledge_type, kv.topic_text, kv.content_text, kv.use_policy
    FROM knowledge_scope_links ksl
    JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
    JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
    WHERE ksl.rental_unit_id = ? AND ki.status = 'active'
      AND kv.visibility = 'public' AND kv.effective_until IS NULL
    ORDER BY ksl.priority DESC, kv.id DESC
  `).all(row.rental_unit_id).map((item) => ({
    publicId: item.public_id,
    type: item.knowledge_type,
    topic: item.topic_text,
    content: item.content_text,
    usePolicy: item.use_policy
  }));
  const internalCount = db.prepare(`
    SELECT COUNT(*) count FROM knowledge_scope_links ksl
    JOIN knowledge_versions kv ON kv.id = ksl.knowledge_version_id
    JOIN knowledge_items ki ON ki.id = kv.knowledge_item_id
    WHERE ksl.rental_unit_id = ? AND ki.status = 'active'
      AND kv.visibility = 'internal' AND kv.effective_until IS NULL
  `).get(row.rental_unit_id).count;
  const pendingCount = db.prepare(`
    SELECT COUNT(*) count FROM landlord_questions
    WHERE listing_id = ? AND status IN ('pending','notified')
  `).get(row.id).count;
  return {
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    address: row.address_text,
    floor: row.floor_label,
    roomCount: row.room_count,
    amenities: parseJson(row.amenity_json, []),
    qualityStatus: row.quality_status,
    publicKnowledge,
    internalKnowledgeCount: internalCount,
    pendingQuestionCount: pendingCount
  };
}

function listPendingQuestions(db, listingId) {
  return db.prepare(`
    SELECT public_id, question_text, asked_at, status, escalation_reason
    FROM landlord_questions
    WHERE listing_id = ? AND status IN ('pending','notified')
    ORDER BY datetime(asked_at), id
  `).all(listingId).map((row) => ({
    publicId: row.public_id,
    questionText: row.question_text,
    askedAt: row.asked_at,
    status: row.status,
    escalationReason: row.escalation_reason
  }));
}

function saveLandlordAnswer(db, input) {
  return inTransaction(db, () => {
    const question = db.prepare(`
      SELECT id, status, inquiry_id FROM landlord_questions WHERE public_id = ?
    `).get(input.questionPublicId);
    if (!question) throw new Error('question not found');
    if (!['pending', 'notified'].includes(question.status)) throw new Error('question is not pending');
    const publicId = `answer-${input.questionPublicId}-${crypto.randomUUID().slice(0, 8)}`;
    db.prepare(`
      INSERT INTO landlord_answers (
        public_id, landlord_question_id, landlord_user_id, answer_text,
        reuse_approved, visibility, answered_at, created_at
      ) VALUES (?, ?, ?, ?, 0, 'public', ?, ?)
    `).run(publicId, question.id, input.landlordUserId, input.answerText, input.answeredAt, input.answeredAt);
    db.prepare(`
      UPDATE landlord_questions SET status = 'answered', answered_at = ? WHERE id = ?
    `).run(input.answeredAt, question.id);
    return { publicId, inquiryId: question.inquiry_id, reuseApproved: false };
  });
}

function approveAnswerForReuse(db, input) {
  return inTransaction(db, () => {
    const row = db.prepare(`
      SELECT a.id answer_id, a.answer_text, a.reuse_approved,
        q.id question_id, q.public_id question_public_id, q.question_text,
        l.rental_unit_id
      FROM landlord_answers a
      JOIN landlord_questions q ON q.id = a.landlord_question_id
      JOIN listings l ON l.id = q.listing_id
      WHERE a.public_id = ?
    `).get(input.answerPublicId);
    if (!row) throw new Error('answer not found');
    const itemPublicId = `qa-${row.question_public_id}`;
    const existing = db.prepare('SELECT id FROM knowledge_items WHERE public_id = ?').get(itemPublicId);
    if (existing) return { publicId: itemPublicId, knowledgeType: 'approved_qa' };
    db.prepare('UPDATE landlord_answers SET reuse_approved = 1 WHERE id = ?').run(row.answer_id);
    db.prepare(`
      INSERT INTO knowledge_items (public_id, knowledge_type, status, created_at, updated_at)
      VALUES (?, 'approved_qa', 'active', ?, ?)
    `).run(itemPublicId, input.approvedAt, input.approvedAt);
    const itemId = db.prepare('SELECT id FROM knowledge_items WHERE public_id = ?').get(itemPublicId).id;
    const versionPublicId = `${itemPublicId}-v1`;
    db.prepare(`
      INSERT INTO knowledge_versions (
        public_id, knowledge_item_id, version_number, normalized_question,
        topic_text, content_text, visibility, use_policy, effective_from,
        approved_by_user_id, approved_at, created_at
      ) VALUES (?, ?, 1, ?, '房東核准問答', ?, 'public', 'answer_directly', ?, ?, ?, ?)
    `).run(versionPublicId, itemId, row.question_text, row.answer_text,
      input.approvedAt, input.approvedByUserId, input.approvedAt, input.approvedAt);
    const versionId = db.prepare('SELECT id FROM knowledge_versions WHERE public_id = ?').get(versionPublicId).id;
    assertLandlordAnswerReusable(db, { sourceType: 'landlord_answer', sourceId: row.answer_id });
    db.prepare(`INSERT INTO knowledge_sources
      (knowledge_version_id, source_type, source_id, created_at)
      VALUES (?, 'landlord_answer', ?, ?)
    `).run(versionId, row.answer_id, input.approvedAt);
    db.prepare(`INSERT INTO knowledge_scope_links
      (knowledge_version_id, rental_unit_id, priority, created_at)
      VALUES (?, ?, 100, ?)
    `).run(versionId, row.rental_unit_id, input.approvedAt);
    return { publicId: itemPublicId, knowledgeType: 'approved_qa' };
  });
}

const POLICY_PAIRS = new Set([
  'public:answer_directly',
  'public:must_escalate',
  'internal:negotiate_within_rule',
  'internal:must_escalate'
]);

function saveConfirmedRule(db, input) {
  if (!POLICY_PAIRS.has(`${input.visibility}:${input.usePolicy}`)) {
    throw new Error('policy is not allowed');
  }
  return inTransaction(db, () => {
    const listing = db.prepare(`SELECT rental_unit_id FROM listings WHERE public_id = ?`)
      .get(input.listingPublicId);
    if (!listing) throw new Error('listing not found');
    const suffix = crypto.randomUUID();
    const itemPublicId = `rule-${suffix}`;
    const knowledgeType = input.visibility === 'public' ? 'landlord_public_rule' : 'landlord_internal_rule';
    const createdAt = input.createdAt || new Date().toISOString();
    db.prepare(`INSERT INTO knowledge_items
      (public_id, knowledge_type, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run(itemPublicId, knowledgeType, createdAt, createdAt);
    const itemId = db.prepare('SELECT id FROM knowledge_items WHERE public_id = ?').get(itemPublicId).id;
    const versionPublicId = `${itemPublicId}-v1`;
    db.prepare(`INSERT INTO knowledge_versions (
      public_id, knowledge_item_id, version_number, topic_text, content_text,
      visibility, use_policy, effective_from, approved_by_user_id, approved_at, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(versionPublicId, itemId, input.ruleType, input.confirmedText,
      input.visibility, input.usePolicy, createdAt, input.createdByUserId, createdAt, createdAt);
    const versionId = db.prepare('SELECT id FROM knowledge_versions WHERE public_id = ?').get(versionPublicId).id;
    db.prepare(`INSERT INTO knowledge_scope_links
      (knowledge_version_id, rental_unit_id, priority, created_at) VALUES (?, ?, 50, ?)
    `).run(versionId, listing.rental_unit_id, createdAt);
    // sort_order 與 driver 版同一套規則:同一個 rental_unit 的 MAX + RULE_ORDER_STEP。
    // 兩份實作寫入的欄位必須完全一致,否則 v2LandlordKnowledgeRepositoryAsync.test.js
    // 的資料表快照比對會直接抓到分岔。
    const sortOrder = Number(db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) current_max FROM landlord_rules WHERE rental_unit_id = ?'
    ).get(listing.rental_unit_id).current_max || 0) + RULE_ORDER_STEP;
    db.prepare(`INSERT INTO landlord_rules (
      public_id, knowledge_item_id, rental_unit_id, rule_type, rule_value_json,
      visibility, status, created_by_user_id, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(`landlord-rule-${suffix}`, itemId, listing.rental_unit_id, input.ruleType,
      JSON.stringify({ originalText: input.originalText, confirmedText: input.confirmedText,
        usePolicy: input.usePolicy, adapter: input.adapter || 'deterministic-demo' }),
      input.visibility, input.createdByUserId, sortOrder, createdAt, createdAt);
    const ruleId = db.prepare('SELECT id FROM landlord_rules WHERE public_id = ?')
      .get(`landlord-rule-${suffix}`).id;
    db.prepare(`INSERT INTO knowledge_sources
      (knowledge_version_id, source_type, source_id, source_detail_json, created_at)
      VALUES (?, 'landlord_manual_input', ?, ?, ?)
    `).run(versionId, ruleId, JSON.stringify({ adapter: input.adapter || 'deterministic-demo' }), createdAt);
    return { publicId: itemPublicId, visibility: input.visibility, usePolicy: input.usePolicy };
  });
}

module.exports = {
  approveAnswerForReuse,
  getListingKnowledgeSummary,
  listDemoListings,
  listLandlordListings,
  listPendingQuestions,
  listTenantsForListing,
  saveConfirmedRule,
  saveLandlordAnswer
};
