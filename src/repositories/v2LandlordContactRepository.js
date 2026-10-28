function listLandlordListings(db, landlordUserId, { limit = 10, offset = 0 } = {}) {
  return db.prepare(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON (po.rental_unit_id = ru.id OR (po.rental_unit_id IS NULL AND po.property_id = ru.property_id))
    WHERE po.owner_user_id = ? AND po.effective_until IS NULL
    ORDER BY pending_count DESC, datetime(l.updated_at) DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(landlordUserId, limit, offset).map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    pendingQuestionCount: row.pending_count
  }));
}

function listDemoListings(db, { limit = 10, offset = 0 } = {}) {
  return db.prepare(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count
    FROM listings l
    ORDER BY pending_count DESC, datetime(l.updated_at) DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset).map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    pendingQuestionCount: row.pending_count
  }));
}

function listLandlordListingsWithPendingQuestions(db, landlordUserId, { limit = 10, offset = 0 } = {}) {
  return db.prepare(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON (po.rental_unit_id = ru.id OR (po.rental_unit_id IS NULL AND po.property_id = ru.property_id))
    WHERE po.owner_user_id = ? AND po.effective_until IS NULL
      AND EXISTS (
        SELECT 1 FROM landlord_questions q
        WHERE q.listing_id = l.id AND q.status IN ('pending','notified')
      )
    ORDER BY pending_count DESC, datetime(l.updated_at) DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(landlordUserId, limit, offset).map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    pendingQuestionCount: row.pending_count
  }));
}

function listDemoListingsWithPendingQuestions(db, { limit = 10, offset = 0 } = {}) {
  return db.prepare(`
    SELECT l.id, l.public_id, l.title, l.current_rent_amount,
      (SELECT COUNT(*) FROM landlord_questions q
       WHERE q.listing_id = l.id AND q.status IN ('pending','notified')) pending_count
    FROM listings l
    WHERE EXISTS (
      SELECT 1 FROM landlord_questions q
      WHERE q.listing_id = l.id AND q.status IN ('pending','notified')
    )
    ORDER BY pending_count DESC, datetime(l.updated_at) DESC, l.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset).map((row) => ({
    id: row.id,
    publicId: row.public_id,
    title: row.title,
    rentAmount: row.current_rent_amount,
    pendingQuestionCount: row.pending_count
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

function getPendingQuestionDetails(db, questionPublicId) {
  const row = db.prepare(`
    SELECT q.id, q.public_id, q.question_text, q.asked_at, q.status, q.listing_id, l.title AS listing_title, li.display_name_cache AS tenant_name
    FROM landlord_questions q
    JOIN listings l ON l.id = q.listing_id
    JOIN inquiries i ON i.id = q.inquiry_id
    JOIN line_identities li ON li.user_id = i.user_id
    WHERE q.public_id = ? AND q.status IN ('pending', 'notified')
  `).get(questionPublicId);

  if (!row) return null;

  return {
    id: row.id,
    publicId: row.public_id,
    questionText: row.question_text,
    askedAt: row.asked_at,
    status: row.status,
    listingTitle: row.listing_title,
    tenantName: row.tenant_name,
    listingId: row.listing_id
  };
}

function markQuestionAsAnswered(db, questionPublicId) {
  db.prepare(`UPDATE landlord_questions SET status = 'answered', updated_at = CURRENT_TIMESTAMP WHERE public_id = ?`).run(questionPublicId);
}

function updateLandlordAnswer(db, answerPublicId, newAnswerText) {
  db.prepare(`
    UPDATE landlord_answers 
    SET answer_text = ?, answered_at = CURRENT_TIMESTAMP 
    WHERE public_id = ?
  `).run(newAnswerText, answerPublicId);
}

function listPendingQuestions(db, listingPublicId) {
  return db.prepare(`
    SELECT q.public_id, q.question_text, q.asked_at, q.status, li.display_name_cache AS tenant_name, l.title AS listing_title, q.listing_id
    FROM landlord_questions q
    JOIN inquiries i ON i.id = q.inquiry_id
    JOIN line_identities li ON li.user_id = i.user_id
    JOIN listings l ON l.id = q.listing_id
    WHERE l.public_id = ? AND q.status IN ('pending','notified')
    ORDER BY datetime(q.asked_at), q.id
  `).all(listingPublicId).map((row) => ({
    publicId: row.public_id,
    questionText: row.question_text,
    askedAt: row.asked_at,
    status: row.status,
    tenantName: row.tenant_name,
    listingTitle: row.listing_title,
    listingId: row.listing_id
  }));
}

function getListingContactHistory(db, listingPublicId, limit = 10) {
  return db.prepare(`
    SELECT * FROM (
      SELECT
        'tenant' AS role,
        m.sent_at AS time,
        COALESCE(m.text_content, '（圖片/檔案）') AS content,
        li.display_name_cache AS tenant_name,
        (SELECT id FROM landlord_questions WHERE source_message_id = m.id LIMIT 1) AS question_id
      FROM messages m
      JOIN inquiries i ON i.id = m.inquiry_id
      JOIN line_identities li ON li.user_id = i.user_id
      JOIN listings l ON l.id = i.listing_id
      WHERE l.public_id = ? AND m.direction = 'inbound'

      UNION ALL

      SELECT
        'landlord_reply' AS role,
        a.answered_at AS time,
        a.answer_text AS content,
        li.display_name_cache AS tenant_name,
        a.landlord_question_id AS question_id
      FROM landlord_answers a
      JOIN landlord_questions q ON q.id = a.landlord_question_id
      JOIN inquiries i ON i.id = q.inquiry_id
      JOIN line_identities li ON li.user_id = i.user_id
      JOIN listings l ON l.id = i.listing_id
      WHERE l.public_id = ?

      UNION ALL

      SELECT
        'landlord_proactive' AS role,
        m.sent_at AS time,
        COALESCE(m.text_content, '（圖片/檔案）') AS content,
        li.display_name_cache AS tenant_name,
        NULL AS question_id
      FROM messages m
      JOIN inquiries i ON i.id = m.inquiry_id
      JOIN line_identities li ON li.user_id = i.user_id
      JOIN listings l ON l.id = i.listing_id
      WHERE l.public_id = ? AND m.direction = 'outbound'
    )
    ORDER BY time DESC
    LIMIT ?
  `).all(listingPublicId, listingPublicId, listingPublicId, limit);
}

function getTenantContactHistory(db, lineUserId, limit = 10) {
  return db.prepare(`
    SELECT * FROM (
      SELECT
        'tenant' AS role,
        m.sent_at AS time,
        COALESCE(m.text_content, '（圖片/檔案）') AS content,
        l.title AS listing_title,
        (SELECT id FROM landlord_questions WHERE source_message_id = m.id LIMIT 1) AS question_id,
        (SELECT status FROM landlord_questions WHERE source_message_id = m.id LIMIT 1) AS question_status
      FROM messages m
      JOIN inquiries i ON i.id = m.inquiry_id
      JOIN line_identities li ON li.user_id = i.user_id
      JOIN listings l ON l.id = i.listing_id
      WHERE li.line_user_id = ? AND m.direction = 'inbound'

      UNION ALL

      SELECT
        'landlord_reply' AS role,
        a.answered_at AS time,
        a.answer_text AS content,
        l.title AS listing_title,
        a.landlord_question_id AS question_id,
        NULL AS question_status
      FROM landlord_answers a
      JOIN landlord_questions q ON q.id = a.landlord_question_id
      JOIN inquiries i ON i.id = q.inquiry_id
      JOIN line_identities li ON li.user_id = i.user_id
      JOIN listings l ON l.id = i.listing_id
      WHERE li.line_user_id = ?

      UNION ALL

      SELECT
        'landlord_proactive' AS role,
        m.sent_at AS time,
        COALESCE(m.text_content, '（圖片/檔案）') AS content,
        l.title AS listing_title,
        NULL AS question_id,
        NULL AS question_status
      FROM messages m
      JOIN inquiries i ON i.id = m.inquiry_id
      JOIN line_identities li ON li.user_id = i.user_id
      JOIN listings l ON l.id = i.listing_id
      WHERE li.line_user_id = ? AND m.direction = 'outbound'
    )
    ORDER BY time DESC
    LIMIT ?
  `).all(lineUserId, lineUserId, lineUserId, limit);
}

function getTenantContactHistoryByInquiry(db, inquiryId, limit = 10) {
  return db.prepare(`
    SELECT * FROM (
      SELECT
        'tenant' AS role,
        m.sent_at AS time,
        COALESCE(m.text_content, '（圖片/檔案）') AS content,
        l.title AS listing_title,
        (SELECT id FROM landlord_questions WHERE source_message_id = m.id LIMIT 1) AS question_id,
        (SELECT status FROM landlord_questions WHERE source_message_id = m.id LIMIT 1) AS question_status
      FROM messages m
      JOIN inquiries i ON i.id = m.inquiry_id
      JOIN listings l ON l.id = i.listing_id
      WHERE i.id = ? AND m.direction = 'inbound'

      UNION ALL

      SELECT
        'landlord_reply' AS role,
        a.answered_at AS time,
        a.answer_text AS content,
        l.title AS listing_title,
        a.landlord_question_id AS question_id,
        NULL AS question_status
      FROM landlord_answers a
      JOIN landlord_questions q ON q.id = a.landlord_question_id
      JOIN inquiries i ON i.id = q.inquiry_id
      JOIN listings l ON l.id = i.listing_id
      WHERE q.inquiry_id = ?

      UNION ALL

      SELECT
        'landlord_proactive' AS role,
        m.sent_at AS time,
        COALESCE(m.text_content, '（圖片/檔案）') AS content,
        l.title AS listing_title,
        NULL AS question_id,
        NULL AS question_status
      FROM messages m
      JOIN inquiries i ON i.id = m.inquiry_id
      JOIN listings l ON l.id = i.listing_id
      WHERE i.id = ? AND m.direction = 'outbound'
    )
    ORDER BY time DESC
    LIMIT ?
  `).all(inquiryId, inquiryId, inquiryId, limit);
}

module.exports = {
  listLandlordListings,
  listDemoListings,
  listLandlordListingsWithPendingQuestions,
  listDemoListingsWithPendingQuestions,
  listTenantsForListing,
  getPendingQuestionDetails,
  markQuestionAsAnswered,
  updateLandlordAnswer,
  listPendingQuestions,
  getListingContactHistory,
  getTenantContactHistory,
  getTenantContactHistoryByInquiry
};
