const crypto = require('crypto');

const db = require('../db');
const { webUrl } = require('./cardMessageService');
const { ensureCaseForLineThread } = require('./caseService');
const { buildLineChatUrl, createEntryCodeForCase } = require('./partnerEntryCodeService');
const { ensureLineIdentity } = require('./profileService');
const { extract591ListingId, normalize591Listing } = require('./partner591Normalizer');

const INTEGRATION_MODE = 'partner_591_line_shared_mock';

function cleanText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}


function parsePrice(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value);
  if (text.includes('面議')) return null;
  const match = text.match(/[\d,]+/);
  if (!match) return null;
  const parsed = parseInt(match[0].replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAmenities(value) {
  if (!value) return null;
  let items = value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      items = Array.isArray(parsed) ? parsed : value.split(/[,\n、]/);
    } catch {
      items = value.split(/[,\n、]/);
    }
  }
  if (!Array.isArray(items)) return null;
  const unique = [];
  for (const item of items) {
    const text = cleanText(item);
    if (text && !unique.includes(text)) unique.push(text);
  }
  return unique.length ? JSON.stringify(unique) : null;
}

function jsonText(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : null;
}

function parseJsonOrNull(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function objectHasKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function arrayHasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function chooseObjectJson(nextValue, existingJson) {
  if (objectHasKeys(nextValue)) return jsonText(nextValue);
  return existingJson || null;
}

function chooseArrayJson(nextValue, existingJson, preferLonger = false) {
  if (!arrayHasItems(nextValue)) return existingJson || null;
  if (!preferLonger) return jsonText(nextValue);
  const existingValue = parseJsonOrNull(existingJson);
  if (Array.isArray(existingValue) && existingValue.length > nextValue.length) {
    return existingJson;
  }
  return jsonText(nextValue);
}

function partnerThreadIdForListing(listing = {}) {
  const normalized = listing.url && /591\.com\.tw/i.test(listing.url)
    ? normalize591Listing(listing)
    : {
      url: cleanText(listing.url),
      listingId: cleanText(listing.listingId)
    };
  const stablePart = normalized.listingId ||
    crypto.createHash('sha256').update(normalized.url || 'unknown-591-listing').digest('hex').slice(0, 12);
  return `partner-591-${stablePart}`;
}

function normalizeIdentity(input = {}, fallback) {
  const lineUserId = cleanText(input.lineUserId || input.line_user_id) || fallback;
  if (!lineUserId) {
    const error = new Error('591 partner intake requires mocked LINE identity data.');
    error.statusCode = 400;
    throw error;
  }

  return {
    lineUserId,
    displayName: cleanText(input.displayName || input.display_name || input.name) || lineUserId,
    pictureUrl: cleanText(input.pictureUrl || input.picture_url)
  };
}

function upsertLineIdentity(identity) {
  const userId = ensureLineIdentity(identity.lineUserId);
  db.prepare(`
    UPDATE line_identities
    SET line_display_name = COALESCE(@displayName, line_display_name),
        line_picture_url = COALESCE(@pictureUrl, line_picture_url),
        updated_at = CURRENT_TIMESTAMP
    WHERE line_user_id = @lineUserId
  `).run({
    lineUserId: identity.lineUserId,
    displayName: identity.displayName,
    pictureUrl: identity.pictureUrl
  });
  return userId;
}

function upsertParticipant({ caseId, role, identity }) {
  const userId = upsertLineIdentity(identity);
  const existing = db.prepare(`
    SELECT id
    FROM case_participants
    WHERE case_id = @caseId
      AND line_user_id = @lineUserId
      AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get({ caseId, lineUserId: identity.lineUserId });

  const params = {
    id: existing && existing.id,
    caseId,
    userId,
    lineUserId: identity.lineUserId,
    role,
    displayName: identity.displayName
  };

  if (existing) {
    db.prepare(`
      UPDATE case_participants
      SET user_id = @userId,
          role = @role,
          display_name_snapshot = @displayName,
          legal_name_snapshot = COALESCE(legal_name_snapshot, @displayName),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run(params);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO case_participants (
      case_id,
      user_id,
      line_user_id,
      role,
      display_name_snapshot,
      legal_name_snapshot,
      signing_required,
      status
    ) VALUES (
      @caseId,
      @userId,
      @lineUserId,
      @role,
      @displayName,
      @displayName,
      1,
      'active'
    )
  `).run(params);

  return result.lastInsertRowid;
}

function upsertRentalListing({ rentalCase, threadId, tenantIdentity, listing, partnerMetadata }) {
  const existing = db.prepare(`
    SELECT
      id,
      raw_listing_json,
      detail_items_json,
      image_urls_json,
      contact_info_json,
      nearby_json
    FROM rental_listings
    WHERE case_id = @caseId
      AND source = @source
    ORDER BY id DESC
    LIMIT 1
  `).get({
    caseId: rentalCase.case_id,
    source: listing.source
  });

  const params = {
    id: existing && existing.id,
    caseId: rentalCase.case_id,
    groupId: threadId,
    userId: tenantIdentity.lineUserId,
    source: listing.source,
    url: listing.url,
    price: listing.price,
    title: listing.title,
    address: listing.address,
    rooms: listing.rooms,
    type: listing.type,
    floor: listing.floor,
    amenities: listing.amenities,
    description: listing.description,
    rawListingJson: existing ? chooseObjectJson(listing.rawListing, existing.raw_listing_json) : jsonText(listing.rawListing),
    detailItemsJson: existing ? chooseObjectJson(listing.detailItems, existing.detail_items_json) : jsonText(listing.detailItems),
    imageUrlsJson: existing ? chooseArrayJson(listing.imageUrls, existing.image_urls_json, true) : jsonText(listing.imageUrls),
    contactInfoJson: existing ? chooseObjectJson(listing.contactInfo, existing.contact_info_json) : jsonText(listing.contactInfo),
    nearbyJson: existing ? chooseArrayJson(listing.nearby, existing.nearby_json) : jsonText(listing.nearby),
    partnerMetadataJson: jsonText(partnerMetadata)
  };

  if (existing) {
    db.prepare(`
      UPDATE rental_listings
      SET group_id = @groupId,
          user_id = @userId,
          source = @source,
          url = @url,
          price = COALESCE(@price, price),
          title = COALESCE(@title, title),
          address = COALESCE(@address, address),
          rooms = COALESCE(@rooms, rooms),
          type = COALESCE(@type, type),
          floor = COALESCE(@floor, floor),
          amenities = COALESCE(@amenities, amenities),
          description = COALESCE(@description, description),
          raw_listing_json = @rawListingJson,
          detail_items_json = @detailItemsJson,
          image_urls_json = @imageUrlsJson,
          contact_info_json = @contactInfoJson,
          nearby_json = @nearbyJson,
          partner_metadata_json = @partnerMetadataJson
      WHERE id = @id
    `).run(params);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO rental_listings (
      message_id,
      case_id,
      source_message_id,
      group_id,
      room_id,
      user_id,
      source,
      url,
      price,
      title,
      address,
      rooms,
      type,
      floor,
      amenities,
      description,
      raw_listing_json,
      detail_items_json,
      image_urls_json,
      contact_info_json,
      nearby_json,
      partner_metadata_json
    ) VALUES (
      NULL,
      @caseId,
      NULL,
      @groupId,
      NULL,
      @userId,
      @source,
      @url,
      @price,
      @title,
      @address,
      @rooms,
      @type,
      @floor,
      @amenities,
      @description,
      @rawListingJson,
      @detailItemsJson,
      @imageUrlsJson,
      @contactInfoJson,
      @nearbyJson,
      @partnerMetadataJson
    )
  `).run(params);

  return result.lastInsertRowid;
}

function lineEntryUrl(caseId) {
  const configured = cleanText(process.env.ECS_NEO_LINE_ENTRY_URL || process.env.LINE_ENTRY_URL);
  if (configured) {
    const url = new URL(configured);
    url.searchParams.set('caseId', caseId);
    url.searchParams.set('entry', '591');
    return url.toString();
  }
  return webUrl(`/contracts?caseId=${encodeURIComponent(caseId)}&entry=591`);
}

function create591PartnerIntake(payload = {}) {
  const listing = normalize591Listing(payload.listing || {});
  const threadId = partnerThreadIdForListing(listing);
  const tenantIdentity = normalizeIdentity(
    payload.tenantIdentity,
    `mock-591-tenant-${listing.listingId || threadId.replace(/^partner-591-/, '')}`
  );
  const landlordIdentity = normalizeIdentity(
    payload.landlordIdentity,
    `mock-591-landlord-${listing.listingId || threadId.replace(/^partner-591-/, '')}`
  );
  const partnerMetadata = Object.assign({
    partner: '591',
    integrationMode: INTEGRATION_MODE,
    liffStatus: 'todo'
  }, payload.partnerMetadata || {});

  return db.transaction(() => {
    const title = [listing.title, listing.address].filter(Boolean).join(' - ') || '591 合作模擬房源';
    const rentalCase = ensureCaseForLineThread(threadId, {
      title,
      sourceListingUrl: listing.url
    });

    db.prepare(`
      UPDATE cases
      SET title = @title,
          source_listing_url = @sourceListingUrl,
          updated_at = CURRENT_TIMESTAMP
      WHERE case_id = @caseId
    `).run({
      caseId: rentalCase.case_id,
      title,
      sourceListingUrl: listing.url
    });

    const listingRowId = upsertRentalListing({
      rentalCase,
      threadId,
      tenantIdentity,
      listing,
      partnerMetadata
    });
    const entry = createEntryCodeForCase({
      caseId: rentalCase.case_id,
      listingRowId,
      partner: '591'
    });

    upsertParticipant({
      caseId: rentalCase.case_id,
      role: 'tenant',
      identity: tenantIdentity
    });
    upsertParticipant({
      caseId: rentalCase.case_id,
      role: 'landlord',
      identity: landlordIdentity
    });

    return {
      ok: true,
      source: '591',
      integrationMode: INTEGRATION_MODE,
      caseId: rentalCase.case_id,
      partnerThreadId: threadId,
      listingRowId,
      entryCode: entry.entryCode,
      lineChatUrl: buildLineChatUrl(entry.entryCode),
      lineEntryUrl: lineEntryUrl(rentalCase.case_id),
      liffStatus: 'todo'
    };
  })();
}

module.exports = {
  INTEGRATION_MODE,
  create591PartnerIntake,
  extract591ListingId,
  normalize591Listing,
  partnerThreadIdForListing
};
