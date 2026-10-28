const crypto = require('node:crypto');

const SEED_MARKER_ID = 'demo-seed-v1';
const CONTRACT_SEED_MARKER_ID = 'demo-contract-seed-v1';

function iso(value) {
  return new Date(value).toISOString();
}

function addMinutes(value, minutes) {
  return iso(new Date(value).getTime() + minutes * 60 * 1000);
}

function dateOnly(value) {
  return iso(value).slice(0, 10);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rentalType(value) {
  const text = String(value || '');
  if (/整層|整戶/.test(text)) return 'whole_home';
  if (/整樓|整層辦公/.test(text)) return 'whole_floor';
  if (/套房/.test(text)) return 'suite';
  if (/雅房|房間/.test(text)) return 'room';
  return 'other';
}

function roomCount(value) {
  const match = String(value || '').match(/(\d+)房/);
  return match ? Number(match[1]) : null;
}

function insertUser(db, user) {
  db.prepare(`
    INSERT INTO users (public_id, status, created_at, updated_at)
    VALUES (?, 'active', ?, ?)
  `).run(user.publicId, user.createdAt, user.createdAt);
  const userId = db.prepare(`SELECT id FROM users WHERE public_id = ?`).get(user.publicId).id;
  db.prepare(`
    INSERT INTO user_profiles (
      user_id, display_name, legal_name, phone, email, contact_address,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    user.displayName,
    user.legalName,
    user.phone,
    user.email,
    user.address,
    user.createdAt,
    user.createdAt
  );
  db.prepare(`
    INSERT INTO line_identities (
      public_id, user_id, line_user_id, display_name_cache,
      profile_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `demo-line-${user.key}`,
    userId,
    `U-DEMO-${user.key.toUpperCase()}`,
    user.displayName,
    user.createdAt,
    user.createdAt,
    user.createdAt
  );
  const lineIdentityId = db.prepare(`
    SELECT id FROM line_identities WHERE public_id = ?
  `).get(`demo-line-${user.key}`).id;
  return { userId, lineIdentityId };
}

function insertUsersAndOrganization(db, now) {
  const createdAt = iso(now);
  const definitions = [
    ['landlord', 'Demo 房東甲', '示範房東甲', '0000-000-101', 'landlord@example.test'],
    ['tenant-1', 'Demo 房客甲', '示範房客甲', '0000-000-201', 'tenant1@example.test'],
    ['tenant-2', 'Demo 房客乙', '示範房客乙', '0000-000-202', 'tenant2@example.test'],
    ['tenant-3', 'Demo 房客丙', '示範房客丙', '0000-000-203', 'tenant3@example.test'],
    ['agent', 'Demo 管理專員', '示範管理專員', '0000-000-301', 'agent@example.test']
  ];
  const users = {};
  for (const [key, displayName, legalName, phone, email] of definitions) {
    users[key] = insertUser(db, {
      key,
      publicId: `demo-user-${key}`,
      displayName,
      legalName,
      phone,
      email,
      address: '臺北市示範區 Demo 路 1 號',
      createdAt
    });
  }

  db.prepare(`
    INSERT INTO organizations (
      public_id, name, organization_type, status, created_by_user_id,
      created_at, updated_at
    ) VALUES ('demo-organization-1', 'ECS NEO Demo 租賃管理',
      'property_management', 'active', ?, ?, ?)
  `).run(users.landlord.userId, createdAt, createdAt);
  const organizationId = db.prepare(`
    SELECT id FROM organizations WHERE public_id = 'demo-organization-1'
  `).get().id;
  db.prepare(`
    INSERT INTO organization_memberships (
      organization_id, user_id, role_code, status, starts_at, created_at
    ) VALUES (?, ?, 'agent', 'active', ?, ?)
  `).run(organizationId, users.agent.userId, createdAt, createdAt);
  const membershipId = db.prepare(`
    SELECT id FROM organization_memberships
    WHERE organization_id = ? AND user_id = ?
  `).get(organizationId, users.agent.userId).id;
  for (const permission of ['property.read', 'inquiry.read', 'contract.read']) {
    db.prepare(`
      INSERT INTO role_permissions (
        organization_id, role_code, permission_code, allowed, created_at
      ) VALUES (?, 'agent', ?, 1, ?)
    `).run(organizationId, permission, createdAt);
  }
  return { users, organizationId, membershipId };
}

function insertListings(db, fixture, identities, now) {
  const listings = new Map();
  const valid = fixture.filter((row) => row.quality.status === 'valid');
  for (const row of fixture) {
    const sourceId = row.sourceListingId;
    const propertyPublicId = `demo-591-property-${sourceId}`;
    const unitPublicId = `demo-591-unit-${sourceId}`;
    const listingPublicId = `demo-591-listing-${sourceId}`;
    const snapshotPublicId = `demo-591-snapshot-${sourceId}`;
    const addressText = row.address || `未擷取完整地址（591 房源 ${sourceId}）`;
    db.prepare(`
      INSERT INTO properties (
        public_id, organization_id, address_text, normalized_address,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(
      propertyPublicId,
      identities.organizationId,
      addressText,
      row.address,
      row.capturedAt,
      row.capturedAt
    );
    const propertyId = db.prepare(`SELECT id FROM properties WHERE public_id = ?`).get(propertyPublicId).id;
    db.prepare(`
      INSERT INTO rental_units (
        public_id, property_id, unit_label, rental_type, floor_label,
        room_count, status, created_at, updated_at
      ) VALUES (?, ?, '591 刊登單位', ?, ?, ?, 'marketing', ?, ?)
    `).run(
      unitPublicId,
      propertyId,
      rentalType(row.rentalType),
      row.floor,
      roomCount(row.rooms),
      row.capturedAt,
      row.capturedAt
    );
    const unitId = db.prepare(`SELECT id FROM rental_units WHERE public_id = ?`).get(unitPublicId).id;
    db.prepare(`
      INSERT INTO property_owners (
        property_id, rental_unit_id, owner_user_id, ownership_role,
        effective_from, created_at
      ) VALUES (?, ?, ?, 'owner', ?, ?)
    `).run(
      propertyId,
      unitId,
      identities.users.landlord.userId,
      dateOnly(row.capturedAt),
      row.capturedAt
    );
    db.prepare(`
      INSERT INTO property_assignments (
        organization_membership_id, rental_unit_id, assigned_at
      ) VALUES (?, ?, ?)
    `).run(identities.membershipId, unitId, row.capturedAt);
    for (const amenity of row.amenities) {
      const amenityCode = sha256(amenity).slice(0, 12);
      db.prepare(`
        INSERT INTO unit_amenities (
          rental_unit_id, amenity_code, label, source, is_available, updated_at
        ) VALUES (?, ?, ?, 'landlord', 1, ?)
      `).run(unitId, amenityCode, amenity, row.capturedAt);
    }
    db.prepare(`
      INSERT INTO listings (
        public_id, rental_unit_id, source, source_listing_id, source_url,
        title, current_rent_amount, status, published_at, created_at, updated_at
      ) VALUES (?, ?, '591', ?, ?, ?, ?, 'published', ?, ?, ?)
    `).run(
      listingPublicId,
      unitId,
      sourceId,
      row.sourceUrl,
      row.title,
      row.price,
      row.capturedAt,
      row.capturedAt,
      row.capturedAt
    );
    const listingId = db.prepare(`SELECT id FROM listings WHERE public_id = ?`).get(listingPublicId).id;
    const payload = JSON.stringify({
      sourceListingId: row.sourceListingId,
      sourceUrl: row.sourceUrl,
      title: row.title,
      price: row.price,
      address: row.address,
      rooms: row.rooms,
      rentalType: row.rentalType,
      floor: row.floor,
      amenities: row.amenities,
      description: row.description,
      imageUrls: row.imageUrls,
      nearby: row.nearby,
      quality: row.quality
    });
    const isValid = row.quality.status === 'valid';
    db.prepare(`
      INSERT INTO listing_snapshots (
        public_id, listing_id, source, source_listing_id, source_url,
        captured_at, parser_version, parse_status, raw_payload_json,
        raw_hash, warning_json, normalized_title, normalized_address,
        rent_amount, amenity_json, is_latest_valid, created_at
      ) VALUES (?, ?, '591', ?, ?, ?, 'demo-seed-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotPublicId,
      listingId,
      sourceId,
      row.sourceUrl,
      row.capturedAt,
      row.quality.status,
      payload,
      sha256(payload),
      row.quality.missingFields.length ? JSON.stringify({ missingFields: row.quality.missingFields }) : null,
      row.title,
      row.address,
      row.price,
      JSON.stringify(row.amenities),
      isValid ? 1 : 0,
      row.capturedAt
    );
    const snapshotId = db.prepare(`SELECT id FROM listing_snapshots WHERE public_id = ?`).get(snapshotPublicId).id;
    if (isValid) {
      db.prepare(`
        UPDATE listings SET latest_valid_snapshot_id = ? WHERE id = ?
      `).run(snapshotId, listingId);
    }
    row.imageUrls.forEach((imageUrl, index) => {
      db.prepare(`
        INSERT INTO listing_media (
          listing_id, listing_snapshot_id, media_type, source_url,
          sort_order, created_at
        ) VALUES (?, ?, 'image', ?, ?, ?)
      `).run(listingId, snapshotId, imageUrl, index, row.capturedAt);
    });
    listings.set(sourceId, { propertyId, unitId, listingId, snapshotId, row });
  }
  return {
    listings,
    primary: listings.get(valid[0].sourceListingId),
    leasedCandidate: listings.get(valid[1].sourceListingId)
  };
}

function insertInquiry(db, data) {
  db.prepare(`
    INSERT INTO inquiries (
      public_id, user_id, listing_id, status, started_at,
      last_activity_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.publicId,
    data.userId,
    data.listingId,
    data.status,
    data.startedAt,
    data.lastActivityAt,
    data.startedAt,
    data.lastActivityAt
  );
  const inquiryId = db.prepare(`SELECT id FROM inquiries WHERE public_id = ?`).get(data.publicId).id;
  db.prepare(`
    INSERT INTO active_inquiry_contexts (
      public_id, line_identity_id, inquiry_id, activated_at
    ) VALUES (?, ?, ?, ?)
  `).run(`${data.publicId}-context`, data.lineIdentityId, inquiryId, data.lastActivityAt);
  db.prepare(`
    INSERT INTO inquiry_activity_sessions (
      public_id, inquiry_id, listing_id, started_at,
      last_activity_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `${data.publicId}-session`,
    inquiryId,
    data.listingId,
    data.startedAt,
    data.lastActivityAt,
    addMinutes(data.lastActivityAt, 15)
  );
  return inquiryId;
}

function insertInquiryAndKnowledge(db, listingSet, identities, now) {
  const startedAt = addMinutes(now, -20);
  const lastActivityAt = addMinutes(now, -2);
  const inquiry1 = insertInquiry(db, {
    publicId: 'demo-inquiry-primary-1',
    userId: identities.users['tenant-1'].userId,
    lineIdentityId: identities.users['tenant-1'].lineIdentityId,
    listingId: listingSet.primary.listingId,
    status: 'intention_confirming',
    startedAt,
    lastActivityAt
  });
  const inquiry2 = insertInquiry(db, {
    publicId: 'demo-inquiry-primary-2',
    userId: identities.users['tenant-2'].userId,
    lineIdentityId: identities.users['tenant-2'].lineIdentityId,
    listingId: listingSet.primary.listingId,
    status: 'waiting_landlord',
    startedAt: addMinutes(now, -12),
    lastActivityAt: addMinutes(now, -1)
  });
  const inquiry3 = insertInquiry(db, {
    publicId: 'demo-inquiry-lease-1',
    userId: identities.users['tenant-3'].userId,
    lineIdentityId: identities.users['tenant-3'].lineIdentityId,
    listingId: listingSet.leasedCandidate.listingId,
    status: 'contracting',
    startedAt: addMinutes(now, -60),
    lastActivityAt: addMinutes(now, -5)
  });

  db.prepare(`
    INSERT INTO messages (
      public_id, inquiry_id, provider, provider_message_id,
      sender_user_id, direction, message_type, text_content, sent_at, created_at
    ) VALUES
      ('demo-message-equipment', ?, 'line', 'DEMO-MESSAGE-EQUIPMENT', ?, 'inbound', 'text',
       '可以使用焊接設備嗎？', ?, ?),
      ('demo-message-pet', ?, 'line', 'DEMO-MESSAGE-PET', ?, 'inbound', 'text',
       '可以養兩棲類嗎？', ?, ?)
  `).run(
    inquiry1,
    identities.users['tenant-1'].userId,
    startedAt,
    startedAt,
    inquiry2,
    identities.users['tenant-2'].userId,
    startedAt,
    startedAt
  );
  const equipmentMessageId = db.prepare(`SELECT id FROM messages WHERE public_id = 'demo-message-equipment'`).get().id;
  const petMessageId = db.prepare(`SELECT id FROM messages WHERE public_id = 'demo-message-pet'`).get().id;
  db.prepare(`
    INSERT INTO landlord_questions (
      public_id, inquiry_id, listing_id, source_message_id,
      question_text, escalation_reason, status, asked_at, answered_at, created_at
    ) VALUES
      ('demo-question-equipment', ?, ?, ?, '可以使用焊接設備嗎？',
       'knowledge_missing', 'answered', ?, ?, ?),
      ('demo-question-pet', ?, ?, ?, '可以養兩棲類嗎？',
       'knowledge_missing', 'answered', ?, ?, ?)
  `).run(
    inquiry1,
    listingSet.primary.listingId,
    equipmentMessageId,
    startedAt,
    lastActivityAt,
    startedAt,
    inquiry2,
    listingSet.primary.listingId,
    petMessageId,
    startedAt,
    lastActivityAt,
    startedAt
  );
  db.prepare(`
    INSERT INTO landlord_questions (
      public_id, inquiry_id, listing_id, question_text,
      escalation_reason, status, asked_at, created_at
    ) VALUES (
      'demo-question-pending-soldering', ?, ?, '房客可以在屋內使用焊錫設備嗎？',
      'knowledge_missing', 'pending', ?, ?
    )
  `).run(inquiry1, listingSet.primary.listingId, lastActivityAt, lastActivityAt);
  const equipmentQuestionId = db.prepare(`SELECT id FROM landlord_questions WHERE public_id = 'demo-question-equipment'`).get().id;
  const petQuestionId = db.prepare(`SELECT id FROM landlord_questions WHERE public_id = 'demo-question-pet'`).get().id;
  db.prepare(`
    INSERT INTO landlord_answers (
      public_id, landlord_question_id, landlord_user_id, answer_text,
      reuse_approved, visibility, answered_at, created_at
    ) VALUES
      ('demo-answer-equipment', ?, ?, '本次可以，但其他房客仍需個別確認。', 0, 'public', ?, ?),
      ('demo-answer-pet', ?, ?, '可接受兩棲類與小型寵物，但不接受貓狗。', 1, 'public', ?, ?)
  `).run(
    equipmentQuestionId,
    identities.users.landlord.userId,
    lastActivityAt,
    lastActivityAt,
    petQuestionId,
    identities.users.landlord.userId,
    lastActivityAt,
    lastActivityAt
  );
  const reusableAnswerId = db.prepare(`SELECT id FROM landlord_answers WHERE public_id = 'demo-answer-pet'`).get().id;
  db.prepare(`
    INSERT INTO knowledge_items (public_id, knowledge_type, status, created_at, updated_at)
    VALUES ('demo-knowledge-pet', 'approved_qa', 'active', ?, ?)
  `).run(lastActivityAt, lastActivityAt);
  const itemId = db.prepare(`SELECT id FROM knowledge_items WHERE public_id = 'demo-knowledge-pet'`).get().id;
  db.prepare(`
    INSERT INTO knowledge_versions (
      public_id, knowledge_item_id, version_number, normalized_question,
      topic_text, content_text, visibility, use_policy, effective_from,
      approved_by_user_id, approved_at, created_at
    ) VALUES ('demo-knowledge-pet-v1', ?, 1, '是否可以養兩棲類或小型寵物',
      '寵物規則', '可接受兩棲類與小型寵物，但不接受貓狗。',
      'public', 'answer_directly', ?, ?, ?, ?)
  `).run(
    itemId,
    lastActivityAt,
    identities.users.landlord.userId,
    lastActivityAt,
    lastActivityAt
  );
  const versionId = db.prepare(`SELECT id FROM knowledge_versions WHERE public_id = 'demo-knowledge-pet-v1'`).get().id;
  db.prepare(`
    INSERT INTO knowledge_sources (
      knowledge_version_id, source_type, source_id, created_at
    ) VALUES (?, 'landlord_answer', ?, ?)
  `).run(versionId, reusableAnswerId, lastActivityAt);
  db.prepare(`
    INSERT INTO knowledge_scope_links (
      knowledge_version_id, rental_unit_id, priority, created_at
    ) VALUES (?, ?, 100, ?)
  `).run(versionId, listingSet.primary.unitId, lastActivityAt);

  db.prepare(`
    INSERT INTO rental_intentions (
      public_id, inquiry_id, listing_id, tenant_user_id,
      status, submitted_at, created_at, updated_at
    ) VALUES ('demo-intention-primary', ?, ?, ?, 'submitted', ?, ?, ?)
  `).run(
    inquiry1,
    listingSet.primary.listingId,
    identities.users['tenant-1'].userId,
    lastActivityAt,
    lastActivityAt,
    lastActivityAt
  );
  const intentionId = db.prepare(`SELECT id FROM rental_intentions WHERE public_id = 'demo-intention-primary'`).get().id;
  db.prepare(`
    INSERT INTO intention_versions (
      public_id, rental_intention_id, version_number, rent_amount,
      deposit_amount, move_in_date, special_request_text,
      created_by_user_id, created_at
    ) VALUES ('demo-intention-primary-v1', ?, 1, ?, ?, ?,
      '希望可使用小型焊接設備，並依房東個別確認結果辦理。', ?, ?)
  `).run(
    intentionId,
    listingSet.primary.row.price,
    listingSet.primary.row.price * 2,
    dateOnly(new Date(now).getTime() + 30 * 86400000),
    identities.users['tenant-1'].userId,
    lastActivityAt
  );
  db.prepare(`
    INSERT INTO listing_demand_events (
      public_id, listing_id, inquiry_id, rental_intention_id,
      event_type, occurred_at, created_at
    ) VALUES
      ('demo-demand-inquiry-1', ?, ?, NULL, 'inquiry_active', ?, ?),
      ('demo-demand-inquiry-2', ?, ?, NULL, 'inquiry_active', ?, ?),
      ('demo-demand-intention-1', ?, ?, ?, 'intention_submitted', ?, ?)
  `).run(
    listingSet.primary.listingId,
    inquiry1,
    lastActivityAt,
    lastActivityAt,
    listingSet.primary.listingId,
    inquiry2,
    lastActivityAt,
    lastActivityAt,
    listingSet.primary.listingId,
    inquiry1,
    intentionId,
    lastActivityAt,
    lastActivityAt
  );
  return { inquiry1, inquiry2, inquiry3, intentionId };
}

function insertLeaseAndOperations(db, listingSet, identities, inquirySet, now) {
  const createdAt = iso(now);
  const leaseStart = dateOnly(new Date(now).getTime() - 340 * 86400000);
  const leaseEnd = dateOnly(new Date(now).getTime() + 25 * 86400000);
  const billingMonthStart = `${createdAt.slice(0, 7)}-01`;
  const billingMonthEnd = dateOnly(new Date(Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth() + 1,
    0
  )));
  const billingDueDate = `${createdAt.slice(0, 7)}-05`;

  db.prepare(`
    INSERT INTO rental_intentions (
      public_id, inquiry_id, listing_id, tenant_user_id, status,
      submitted_at, created_at, updated_at
    ) VALUES ('demo-intention-lease', ?, ?, ?, 'accepted', ?, ?, ?)
  `).run(
    inquirySet.inquiry3,
    listingSet.leasedCandidate.listingId,
    identities.users['tenant-3'].userId,
    addMinutes(now, -50),
    addMinutes(now, -50),
    addMinutes(now, -45)
  );
  const intentionId = db.prepare(`
    SELECT id FROM rental_intentions WHERE public_id = 'demo-intention-lease'
  `).get().id;
  db.prepare(`
    INSERT INTO intention_versions (
      public_id, rental_intention_id, version_number, rent_amount,
      deposit_amount, lease_start_date, lease_end_date, move_in_date,
      created_by_user_id, created_at
    ) VALUES ('demo-intention-lease-v1', ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    intentionId,
    listingSet.leasedCandidate.row.price,
    listingSet.leasedCandidate.row.price * 2,
    leaseStart,
    leaseEnd,
    leaseStart,
    identities.users['tenant-3'].userId,
    addMinutes(now, -45)
  );
  const intentionVersionId = db.prepare(`
    SELECT id FROM intention_versions WHERE public_id = 'demo-intention-lease-v1'
  `).get().id;
  db.prepare(`
    INSERT INTO intention_decisions (
      rental_intention_id, intention_version_id, decision,
      decided_by_user_id, reason, decided_at
    ) VALUES (?, ?, 'accepted', ?, 'Demo：房東接受承租意向', ?)
  `).run(
    intentionId,
    intentionVersionId,
    identities.users.landlord.userId,
    addMinutes(now, -40)
  );

  db.prepare(`
    INSERT INTO contracts (
      public_id, rental_unit_id, selected_intention_id, source_inquiry_id,
      status, executed_at, created_at, updated_at
    ) VALUES ('demo-contract-lease', ?, ?, ?, 'executed', ?, ?, ?)
  `).run(
    listingSet.leasedCandidate.unitId,
    intentionId,
    inquirySet.inquiry3,
    addMinutes(now, -30),
    addMinutes(now, -40),
    addMinutes(now, -30)
  );
  const contractId = db.prepare(`
    SELECT id FROM contracts WHERE public_id = 'demo-contract-lease'
  `).get().id;
  db.prepare(`
    INSERT INTO contract_versions (
      public_id, contract_id, version_number, condition_snapshot_json,
      document_hash, status, created_by_user_id, created_at
    ) VALUES ('demo-contract-lease-v1', ?, 1, ?,
      'demo-contract-document-hash-v1', 'executed', ?, ?)
  `).run(
    contractId,
    JSON.stringify({
      rentAmount: listingSet.leasedCandidate.row.price,
      depositAmount: listingSet.leasedCandidate.row.price * 2,
      leaseStart,
      leaseEnd,
      demo: true
    }),
    identities.users.landlord.userId,
    addMinutes(now, -40)
  );
  const versionId = db.prepare(`
    SELECT id FROM contract_versions WHERE public_id = 'demo-contract-lease-v1'
  `).get().id;
  db.prepare(`
    INSERT INTO contract_version_sources (
      contract_version_id, field_path, source_type, source_id, created_at
    ) VALUES (?, '$.rentAmount', 'intention_version', ?, ?)
  `).run(versionId, intentionVersionId, addMinutes(now, -40));

  const partyDefinitions = [
    ['landlord', identities.users.landlord.userId, 'landlord', 1],
    ['tenant', identities.users['tenant-3'].userId, 'tenant', 1]
  ];
  const parties = {};
  for (const [key, userId, role, order] of partyDefinitions) {
    db.prepare(`
      INSERT INTO contract_parties (
        public_id, contract_id, user_id, party_role, required_signer,
        signing_order, status, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, 'active', ?)
    `).run(`demo-contract-party-${key}`, contractId, userId, role, order, addMinutes(now, -40));
    const partyId = db.prepare(`SELECT id FROM contract_parties WHERE public_id = ?`)
      .get(`demo-contract-party-${key}`).id;
    parties[key] = partyId;
    const profile = db.prepare(`SELECT * FROM user_profiles WHERE user_id = ?`).get(userId);
    db.prepare(`
      INSERT INTO contract_party_snapshots (
        contract_party_id, contract_version_id, legal_name, display_name,
        phone, email, contact_address, masked_identifier, party_role,
        snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DEMO-****', ?, ?, ?)
    `).run(
      partyId,
      versionId,
      profile.legal_name,
      profile.display_name,
      profile.phone,
      profile.email,
      profile.contact_address,
      role,
      JSON.stringify({ demo: true }),
      addMinutes(now, -40)
    );
    db.prepare(`
      INSERT INTO signature_requests (
        public_id, contract_version_id, contract_party_id, status,
        verification_required, sent_at, completed_at, created_at
      ) VALUES (?, ?, ?, 'signed', 1, ?, ?, ?)
    `).run(
      `demo-signature-request-${key}`,
      versionId,
      partyId,
      addMinutes(now, -38),
      addMinutes(now, -32 + order),
      addMinutes(now, -38)
    );
    const requestId = db.prepare(`SELECT id FROM signature_requests WHERE public_id = ?`)
      .get(`demo-signature-request-${key}`).id;
    db.prepare(`
      INSERT INTO signature_records (
        public_id, signature_request_id, contract_version_id, contract_party_id,
        document_hash, signature_hash, signed_at, ip_address, user_agent, created_at
      ) VALUES (?, ?, ?, ?, 'demo-contract-document-hash-v1', ?, ?,
        '192.0.2.1', 'ECS-NEO-Demo-Agent', ?)
    `).run(
      `demo-signature-record-${key}`,
      requestId,
      versionId,
      partyId,
      `demo-signature-hash-${key}`,
      addMinutes(now, -32 + order),
      addMinutes(now, -32 + order)
    );
  }

  db.prepare(`
    INSERT INTO leases (
      public_id, contract_id, rental_unit_id, start_date, end_date,
      rent_due_day, status, created_at, updated_at
    ) VALUES ('demo-lease-active', ?, ?, ?, ?, 5, 'active', ?, ?)
  `).run(
    contractId,
    listingSet.leasedCandidate.unitId,
    leaseStart,
    leaseEnd,
    addMinutes(now, -30),
    createdAt
  );
  const leaseId = db.prepare(`SELECT id FROM leases WHERE public_id = 'demo-lease-active'`).get().id;
  for (const [key, userId, role] of partyDefinitions) {
    db.prepare(`
      INSERT INTO lease_parties (
        lease_id, contract_party_id, user_id, party_role,
        effective_from, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(leaseId, parties[key], userId, role, leaseStart, addMinutes(now, -30));
  }
  db.prepare(`UPDATE rental_units SET status = 'leased', updated_at = ? WHERE id = ?`)
    .run(createdAt, listingSet.leasedCandidate.unitId);
  db.prepare(`UPDATE listings SET status = 'leased', updated_at = ? WHERE id = ?`)
    .run(createdAt, listingSet.leasedCandidate.listingId);

  db.prepare(`
    INSERT INTO billing_charges (
      public_id, lease_id, charge_type, billing_period_start,
      billing_period_end, due_date, amount, status, description,
      created_at, updated_at
    ) VALUES ('demo-charge-current-rent', ?, 'rent', ?, ?, ?, ?,
      'partially_paid', 'Demo 當月租金', ?, ?)
  `).run(
    leaseId,
    billingMonthStart,
    billingMonthEnd,
    billingDueDate,
    listingSet.leasedCandidate.row.price,
    createdAt,
    createdAt
  );
  const chargeId = db.prepare(`
    SELECT id FROM billing_charges WHERE public_id = 'demo-charge-current-rent'
  `).get().id;
  db.prepare(`
    INSERT INTO payment_records (
      public_id, billing_charge_id, amount, paid_at, method_label,
      reference, recorded_by_user_id, status, created_at
    ) VALUES ('demo-payment-partial', ?, 15000, ?, 'bank_transfer',
      'DEMO-TRANSFER-001', ?, 'confirmed', ?)
  `).run(chargeId, addMinutes(now, -1440), identities.users.landlord.userId, createdAt);
  const paymentId = db.prepare(`
    SELECT id FROM payment_records WHERE public_id = 'demo-payment-partial'
  `).get().id;
  db.prepare(`
    INSERT INTO receipts (
      public_id, payment_record_id, receipt_number, issued_at,
      issued_by_user_id, note, created_at
    ) VALUES ('demo-receipt-partial', ?, 'DEMO-RECEIPT-001', ?, ?,
      'Demo 部分繳款收據', ?)
  `).run(paymentId, addMinutes(now, -1430), identities.users.landlord.userId, createdAt);

  db.prepare(`
    INSERT INTO repair_tickets (
      public_id, lease_id, rental_unit_id, category, description, priority,
      status, reported_by_user_id, assigned_owner_user_id, reported_at,
      completed_at, closed_at, created_at, updated_at
    ) VALUES
      ('demo-repair-completed', ?, ?, 'plumbing', '浴室水龍頭漏水', 'normal',
       'tenant_confirmed', ?, ?, ?, ?, ?, ?, ?),
      ('demo-repair-in-progress', ?, ?, 'electrical', '客廳插座接觸不良', 'high',
       'in_progress', ?, ?, ?, NULL, NULL, ?, ?)
  `).run(
    leaseId,
    listingSet.leasedCandidate.unitId,
    identities.users['tenant-3'].userId,
    identities.users.landlord.userId,
    addMinutes(now, -14400),
    addMinutes(now, -12240),
    addMinutes(now, -12180),
    addMinutes(now, -14400),
    addMinutes(now, -12180),
    leaseId,
    listingSet.leasedCandidate.unitId,
    identities.users['tenant-3'].userId,
    identities.users.landlord.userId,
    addMinutes(now, -2880),
    addMinutes(now, -2880),
    createdAt
  );
  const completedRepairId = db.prepare(`
    SELECT id FROM repair_tickets WHERE public_id = 'demo-repair-completed'
  `).get().id;
  db.prepare(`
    INSERT INTO repair_confirmations (
      repair_ticket_id, confirmed_by_user_id, result, note, confirmed_at
    ) VALUES (?, ?, 'resolved', 'Demo 房客確認已修復', ?)
  `).run(completedRepairId, identities.users['tenant-3'].userId, addMinutes(now, -12180));

  db.prepare(`
    INSERT INTO files (
      public_id, storage_key, storage_provider, original_name, mime_type,
      size_bytes, sha256_hash, security_classification, status,
      created_by_user_id, created_at
    ) VALUES ('demo-file-inspection-photo', 'demo/inspection/photo-001', 'local',
      'demo-room.jpg', 'image/jpeg', 1024, 'demo-inspection-photo-hash',
      'private', 'active', ?, ?)
  `).run(identities.users.agent.userId, createdAt);
  const inspectionFileId = db.prepare(`
    SELECT id FROM files WHERE public_id = 'demo-file-inspection-photo'
  `).get().id;
  db.prepare(`
    INSERT INTO inspection_checklists (
      public_id, lease_id, checklist_type, scheduled_at, performed_at,
      status, created_by_user_id, created_at, updated_at
    ) VALUES ('demo-inspection-move-in', ?, 'move_in', ?, ?, 'confirmed', ?, ?, ?)
  `).run(
    leaseId,
    `${leaseStart}T02:00:00.000Z`,
    `${leaseStart}T02:30:00.000Z`,
    identities.users.agent.userId,
    `${leaseStart}T02:00:00.000Z`,
    `${leaseStart}T03:00:00.000Z`
  );
  const checklistId = db.prepare(`
    SELECT id FROM inspection_checklists WHERE public_id = 'demo-inspection-move-in'
  `).get().id;
  db.prepare(`
    INSERT INTO inspection_items (
      inspection_checklist_id, area_label, item_label, condition_code,
      note, sort_order, created_at
    ) VALUES (?, '客廳', '牆面與地板', 'good', 'Demo：無明顯損傷', 1, ?)
  `).run(checklistId, `${leaseStart}T02:30:00.000Z`);
  const inspectionItemId = db.prepare(`
    SELECT id FROM inspection_items WHERE inspection_checklist_id = ?
  `).get(checklistId).id;
  db.prepare(`
    INSERT INTO inspection_evidence (
      inspection_item_id, file_id, evidence_type, captured_at, note, created_at
    ) VALUES (?, ?, 'photo', ?, 'Demo 點交照片 metadata', ?)
  `).run(
    inspectionItemId,
    inspectionFileId,
    `${leaseStart}T02:35:00.000Z`,
    `${leaseStart}T02:35:00.000Z`
  );
  for (const key of ['landlord', 'tenant']) {
    db.prepare(`
      INSERT INTO inspection_confirmations (
        inspection_checklist_id, contract_party_id, result, note, confirmed_at
      ) VALUES (?, ?, 'confirmed', 'Demo 雙方確認', ?)
    `).run(checklistId, parties[key], `${leaseStart}T03:00:00.000Z`);
  }

  db.prepare(`
    INSERT INTO contract_action_requests (
      public_id, contract_id, lease_id, request_type,
      requested_by_contract_party_id, proposed_effective_date,
      reason, status, created_at, updated_at
    ) VALUES ('demo-action-renewal', ?, ?, 'renewal', ?, ?,
      '系統於到期前 30 天提醒可開始續約', 'pending', ?, ?)
  `).run(contractId, leaseId, parties.tenant, leaseEnd, createdAt, createdAt);
  const actionId = db.prepare(`
    SELECT id FROM contract_action_requests WHERE public_id = 'demo-action-renewal'
  `).get().id;
  db.prepare(`
    INSERT INTO renewal_requests (
      public_id, contract_action_request_id, lease_id, initiated_by,
      reminded_at, created_at
    ) VALUES ('demo-renewal-request', ?, ?, 'system_reminder', ?, ?)
  `).run(actionId, leaseId, createdAt, createdAt);
  db.prepare(`
    INSERT INTO calendar_events (
      public_id, event_type, title, starts_at, contract_id,
      lease_id, status, created_at
    ) VALUES ('demo-calendar-renewal', 'renewal_reminder',
      'Demo：租約到期前可開始續約', ?, ?, ?, 'scheduled', ?)
  `).run(createdAt, contractId, leaseId, createdAt);

  db.prepare(`
    INSERT INTO notifications (
      public_id, event_type, entity_type, entity_id,
      template_code, payload_json, created_at
    ) VALUES ('demo-notification-renewal', 'renewal_reminder', 'lease', ?,
      'renewal_30_days', ?, ?)
  `).run(String(leaseId), JSON.stringify({ demo: true, leaseEnd }), createdAt);
  const notificationId = db.prepare(`
    SELECT id FROM notifications WHERE public_id = 'demo-notification-renewal'
  `).get().id;
  db.prepare(`
    INSERT INTO notification_deliveries (
      public_id, notification_id, recipient_user_id, channel,
      idempotency_key, status, scheduled_at, sent_at, created_at
    ) VALUES ('demo-delivery-renewal-landlord', ?, ?, 'line', ?,
      'sent', ?, ?, ?)
  `).run(
    notificationId,
    identities.users.landlord.userId,
    `renewal_reminder:lease-${leaseId}:demo-user-landlord:line`,
    createdAt,
    createdAt,
    createdAt
  );
  const deliveryId = db.prepare(`
    SELECT id FROM notification_deliveries WHERE public_id = 'demo-delivery-renewal-landlord'
  `).get().id;
  db.prepare(`
    INSERT INTO notification_delivery_attempts (
      notification_delivery_id, attempt_number, status,
      provider_response_json, attempted_at
    ) VALUES (?, 1, 'succeeded', '{"demo":true}', ?)
  `).run(deliveryId, createdAt);

  return { contractId, versionId, leaseId, chargeId };
}

function requiredSeedCounts(db) {
  return {
    users: db.prepare(`SELECT COUNT(*) count FROM users WHERE public_id LIKE 'demo-user-%'`).get().count,
    listings: db.prepare(`SELECT COUNT(*) count FROM listings WHERE public_id LIKE 'demo-591-listing-%'`).get().count,
    snapshots: db.prepare(`SELECT COUNT(*) count FROM listing_snapshots WHERE public_id LIKE 'demo-591-snapshot-%'`).get().count,
    contracts: db.prepare(`SELECT COUNT(*) count FROM contracts WHERE public_id = 'demo-contract-lease'`).get().count,
    leases: db.prepare(`SELECT COUNT(*) count FROM leases WHERE public_id = 'demo-lease-active'`).get().count,
    receipts: db.prepare(`SELECT COUNT(*) count FROM receipts WHERE public_id = 'demo-receipt-partial'`).get().count
  };
}

function assertCompleteSeed(db) {
  const actual = requiredSeedCounts(db);
  const expected = {
    users: 5,
    listings: 7,
    snapshots: 7,
    contracts: 1,
    leases: 1,
    receipts: 1
  };
  for (const [name, count] of Object.entries(expected)) {
    if (actual[name] !== count) {
      throw new Error(`demo seed marker exists but required data is incomplete: ${name}`);
    }
  }
  return actual;
}

function hasPartialDemoRows(db) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE public_id LIKE 'demo-%') +
      (SELECT COUNT(*) FROM properties WHERE public_id LIKE 'demo-%') +
      (SELECT COUNT(*) FROM listings WHERE public_id LIKE 'demo-%') +
      (SELECT COUNT(*) FROM contracts WHERE public_id LIKE 'demo-%') +
      (SELECT COUNT(*) FROM leases WHERE public_id LIKE 'demo-%') AS count
  `).get();
  return row.count > 0;
}

function insertContractParty(db, { contractId, versionId, userId, role, publicSuffix, requestStatus, now }) {
  db.prepare(`INSERT INTO contract_parties (public_id,contract_id,user_id,party_role,required_signer,signing_order,status,created_at) VALUES (?,?,?,?,1,?,'active',?)`)
    .run(`demo-contract-party-${publicSuffix}-${role}`, contractId, userId, role, role === 'tenant' ? 1 : 2, now);
  const partyId = db.prepare('SELECT id FROM contract_parties WHERE public_id=?').get(`demo-contract-party-${publicSuffix}-${role}`).id;
  const profile = db.prepare('SELECT * FROM user_profiles WHERE user_id=?').get(userId);
  db.prepare(`INSERT INTO contract_party_snapshots (contract_party_id,contract_version_id,legal_name,display_name,phone,email,contact_address,masked_identifier,party_role,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,'DEMO-****',?,'{"demo":true}',?)`)
    .run(partyId, versionId, profile.legal_name, profile.display_name, profile.phone, profile.email, profile.contact_address, role, now);
  db.prepare(`INSERT INTO signature_requests (public_id,contract_version_id,contract_party_id,status,verification_required,sent_at,completed_at,created_at) VALUES (?,?,?,?,1,?,?,?)`)
    .run(`demo-signature-request-${publicSuffix}-${role}`, versionId, partyId, requestStatus, now, requestStatus === 'signed' ? now : null, now);
  return {
    partyId,
    requestId: db.prepare('SELECT id FROM signature_requests WHERE public_id=?').get(`demo-signature-request-${publicSuffix}-${role}`).id
  };
}

function applyContractDemoSeed(db, now = new Date()) {
  if (db.prepare('SELECT 1 FROM audit_logs WHERE public_id=?').get(CONTRACT_SEED_MARKER_ID)) return { status: 'skipped' };
  if (db.prepare("SELECT 1 FROM contracts WHERE public_id IN ('demo-contract-tenant-pending','demo-contract-landlord-pending')").get()) {
    throw new Error('damaged partial contract demo seed detected');
  }
  const createdAt = iso(now);
  db.transaction(() => {
    const landlordId = db.prepare("SELECT id FROM users WHERE public_id='demo-user-landlord'").get().id;
    const tenant1Id = db.prepare("SELECT id FROM users WHERE public_id='demo-user-tenant-1'").get().id;
    const tenant2Id = db.prepare("SELECT id FROM users WHERE public_id='demo-user-tenant-2'").get().id;
    const primaryIntention = db.prepare("SELECT * FROM rental_intentions WHERE public_id='demo-intention-primary'").get();
    const primaryInquiry = db.prepare('SELECT * FROM inquiries WHERE id=?').get(primaryIntention.inquiry_id);
    const primaryUnitId = db.prepare('SELECT rental_unit_id FROM listings WHERE id=?').get(primaryIntention.listing_id).rental_unit_id;

    db.prepare(`INSERT INTO contracts (public_id,rental_unit_id,selected_intention_id,source_inquiry_id,status,created_at,updated_at) VALUES ('demo-contract-tenant-pending',?,?,?,'signing',?,?)`)
      .run(primaryUnitId, primaryIntention.id, primaryInquiry.id, createdAt, createdAt);
    const tenantPendingContractId = db.prepare("SELECT id FROM contracts WHERE public_id='demo-contract-tenant-pending'").get().id;
    const tenantConditions = { monthlyRent: 18000, depositAmount: 36000, pets: 'one_cat', moveInDate: dateOnly(new Date(now).getTime() + 30 * 86400000), demo: true };
    db.prepare(`INSERT INTO contract_versions (public_id,contract_id,version_number,condition_snapshot_json,status,created_by_user_id,created_at) VALUES ('demo-contract-tenant-pending-v1',?,1,?,'superseded',?,?),('demo-contract-tenant-pending-v2',?,2,?,'issued',?,?)`)
      .run(tenantPendingContractId, JSON.stringify({ ...tenantConditions, monthlyRent: 19000 }), tenant1Id, addMinutes(now, -10), tenantPendingContractId, JSON.stringify(tenantConditions), tenant1Id, createdAt);
    const tenantPendingVersionId = db.prepare("SELECT id FROM contract_versions WHERE public_id='demo-contract-tenant-pending-v2'").get().id;
    insertContractParty(db, { contractId: tenantPendingContractId, versionId: tenantPendingVersionId, userId: tenant1Id, role: 'tenant', publicSuffix: 'tenant-pending', requestStatus: 'pending', now: createdAt });
    insertContractParty(db, { contractId: tenantPendingContractId, versionId: tenantPendingVersionId, userId: landlordId, role: 'landlord', publicSuffix: 'tenant-pending', requestStatus: 'pending', now: createdAt });

    const alternate = db.prepare(`SELECT l.id listing_id,l.rental_unit_id FROM listings l WHERE l.rental_unit_id NOT IN (?,(SELECT rental_unit_id FROM contracts WHERE public_id='demo-contract-lease')) ORDER BY l.id LIMIT 1`).get(primaryUnitId);
    db.prepare(`INSERT INTO inquiries (public_id,user_id,listing_id,status,started_at,last_activity_at,created_at,updated_at) VALUES ('demo-inquiry-contract-tenant-2',?,?,'contracting',?,?,?,?)`)
      .run(tenant2Id, alternate.listing_id, createdAt, createdAt, createdAt, createdAt);
    const landlordPendingInquiryId = db.prepare("SELECT id FROM inquiries WHERE public_id='demo-inquiry-contract-tenant-2'").get().id;
    db.prepare(`INSERT INTO rental_intentions (public_id,inquiry_id,listing_id,tenant_user_id,status,submitted_at,created_at,updated_at) VALUES ('demo-intention-landlord-pending',?,?,?,'contracting',?,?,?)`)
      .run(landlordPendingInquiryId, alternate.listing_id, tenant2Id, createdAt, createdAt, createdAt);
    const landlordPendingIntentionId = db.prepare("SELECT id FROM rental_intentions WHERE public_id='demo-intention-landlord-pending'").get().id;
    db.prepare(`INSERT INTO intention_versions (public_id,rental_intention_id,version_number,rent_amount,deposit_amount,condition_json,created_by_user_id,created_at) VALUES ('demo-intention-landlord-pending-v1',?,1,17500,35000,'{"pets":"none","demo":true}',?,?)`)
      .run(landlordPendingIntentionId, tenant2Id, createdAt);
    db.prepare(`INSERT INTO contracts (public_id,rental_unit_id,selected_intention_id,source_inquiry_id,status,created_at,updated_at) VALUES ('demo-contract-landlord-pending',?,?,?,'signing',?,?)`)
      .run(alternate.rental_unit_id, landlordPendingIntentionId, landlordPendingInquiryId, createdAt, createdAt);
    const landlordPendingContractId = db.prepare("SELECT id FROM contracts WHERE public_id='demo-contract-landlord-pending'").get().id;
    const documentHash = sha256('demo-landlord-pending-contract-v1');
    db.prepare(`INSERT INTO contract_versions (public_id,contract_id,version_number,condition_snapshot_json,document_hash,status,created_by_user_id,created_at) VALUES ('demo-contract-landlord-pending-v1',?,1,?,?,'issued',?,?)`)
      .run(landlordPendingContractId, JSON.stringify({ monthlyRent: 17500, depositAmount: 35000, pets: 'none', demo: true }), documentHash, tenant2Id, createdAt);
    const landlordPendingVersionId = db.prepare("SELECT id FROM contract_versions WHERE public_id='demo-contract-landlord-pending-v1'").get().id;
    const tenantParty = insertContractParty(db, { contractId: landlordPendingContractId, versionId: landlordPendingVersionId, userId: tenant2Id, role: 'tenant', publicSuffix: 'landlord-pending', requestStatus: 'signed', now: createdAt });
    insertContractParty(db, { contractId: landlordPendingContractId, versionId: landlordPendingVersionId, userId: landlordId, role: 'landlord', publicSuffix: 'landlord-pending', requestStatus: 'pending', now: createdAt });
    db.prepare(`INSERT INTO signature_records (public_id,signature_request_id,contract_version_id,contract_party_id,document_hash,signature_hash,signed_at,ip_address,user_agent,created_at) VALUES ('demo-signature-record-landlord-pending-tenant',?,?,?,?,?,?,'192.0.2.2','ECS-NEO-Demo-Agent',?)`)
      .run(tenantParty.requestId, landlordPendingVersionId, tenantParty.partyId, documentHash, sha256('demo-tenant-signature'), createdAt, createdAt);
    db.prepare(`INSERT INTO audit_logs (public_id,actor_type,action,entity_type,entity_id,change_json,created_at) VALUES (?,'system','demo_contract_seed_applied','demo_seed','contract-v1','{"contracts":2}',?)`)
      .run(CONTRACT_SEED_MARKER_ID, createdAt);
  }).immediate();
  return { status: 'applied' };
}

function cleanupContractDemoSeed(db) {
  db.transaction(() => {
    const contractIds = db.prepare("SELECT id FROM contracts WHERE public_id IN ('demo-contract-tenant-pending','demo-contract-landlord-pending')").all().map((row) => row.id);
    for (const contractId of contractIds) {
      const versionIds = db.prepare('SELECT id FROM contract_versions WHERE contract_id=?').all(contractId).map((row) => row.id);
      for (const versionId of versionIds) {
        db.prepare('DELETE FROM contract_reading_sessions WHERE contract_version_id=?').run(versionId);
        db.prepare('DELETE FROM signature_records WHERE contract_version_id=?').run(versionId);
        db.prepare('DELETE FROM signature_requests WHERE contract_version_id=?').run(versionId);
        db.prepare('DELETE FROM contract_party_snapshots WHERE contract_version_id=?').run(versionId);
        db.prepare("DELETE FROM file_links WHERE entity_type='contract_version' AND entity_id=?").run(versionId);
        db.prepare('DELETE FROM contract_version_sources WHERE contract_version_id=?').run(versionId);
      }
      db.prepare('DELETE FROM contract_parties WHERE contract_id=?').run(contractId);
      db.prepare('DELETE FROM contract_versions WHERE contract_id=?').run(contractId);
      db.prepare('DELETE FROM contract_status_history WHERE contract_id=?').run(contractId);
      db.prepare('DELETE FROM contracts WHERE id=?').run(contractId);
    }
    const intention = db.prepare("SELECT id,inquiry_id FROM rental_intentions WHERE public_id='demo-intention-landlord-pending'").get();
    if (intention) {
      db.prepare('DELETE FROM intention_versions WHERE rental_intention_id=?').run(intention.id);
      db.prepare('DELETE FROM rental_intentions WHERE id=?').run(intention.id);
      db.prepare('DELETE FROM inquiries WHERE id=?').run(intention.inquiry_id);
    }
    db.prepare('DELETE FROM audit_logs WHERE public_id=?').run(CONTRACT_SEED_MARKER_ID);
  }).immediate();
}

function applyDemoSeed(db, fixture, options = {}) {
  const now = options.now || new Date();
  if (!Array.isArray(fixture) || fixture.length !== 7) {
    throw new Error('demo seed requires exactly seven sanitized 591 listings');
  }
  const marker = db.prepare(`SELECT id FROM audit_logs WHERE public_id = ?`).get(SEED_MARKER_ID);
  if (marker) {
    const counts = assertCompleteSeed(db);
    const contracts = applyContractDemoSeed(db, now);
    return { status: 'skipped', counts, contracts };
  }
  if (hasPartialDemoRows(db)) {
    throw new Error('damaged partial demo seed detected: demo rows exist without demo-seed-v1 marker');
  }

  const apply = db.transaction(() => {
    const identities = insertUsersAndOrganization(db, now);
    const listingSet = insertListings(db, fixture, identities, now);
    const inquirySet = insertInquiryAndKnowledge(db, listingSet, identities, now);
    const leaseSet = insertLeaseAndOperations(db, listingSet, identities, inquirySet, now);
    db.prepare(`
      INSERT INTO audit_logs (
        public_id, actor_type, action, entity_type, entity_id,
        change_json, created_at
      ) VALUES (?, 'system', 'demo_seed_v1_applied', 'demo_seed', 'v1', ?, ?)
    `).run(
      SEED_MARKER_ID,
      JSON.stringify({ listings: 7, valid: 2, partial: 5 }),
      iso(now)
    );
    return { identities, listingSet, inquirySet, leaseSet };
  });
  apply.immediate();
  const contracts = applyContractDemoSeed(db, now);
  return {
    status: 'applied',
    contracts,
    counts: {
      listings: 7,
      validSnapshots: 2,
      partialSnapshots: 5,
      users: 5
    }
  };
}

module.exports = {
  CONTRACT_SEED_MARKER_ID,
  SEED_MARKER_ID,
  applyDemoSeed,
  cleanupContractDemoSeed
};
