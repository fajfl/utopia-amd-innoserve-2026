const crypto = require('node:crypto');
const { imageUrlIdentity, normalizeImageUrl } = require('../services/partner591Normalizer');

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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function publicPayload(dto) {
  return stableValue({
    sourceListingId: String(dto.sourceListingId),
    title: dto.title || null,
    price: Number.isFinite(dto.price) ? dto.price : null,
    address: dto.address || null,
    rentalType: dto.rentalType || null,
    floor: dto.floor || null,
    rooms: dto.rooms || null,
    amenities: Array.isArray(dto.amenities) ? dto.amenities : [],
    description: dto.description || null,
    imageUrls: Array.isArray(dto.imageUrls) ? dto.imageUrls : [],
    nearby: Array.isArray(dto.nearby) ? dto.nearby : []
  });
}

const hashPayload = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const publicId = (kind, sourceListingId) => `591-${kind}-${String(sourceListingId)}`;

function uniqueImageUrls(values) {
  const seen = new Set();
  const unique = [];
  for (const value of Array.isArray(values) ? values : []) {
    const url = normalizeImageUrl(value);
    const identity = imageUrlIdentity(url);
    if (url && identity && !seen.has(identity)) {
      seen.add(identity);
      unique.push({ identity, url });
    }
  }
  return unique;
}

async function syncListingMedia(db, { listingId, snapshotId, imageUrls, capturedAt }) {
  const incoming = uniqueImageUrls(imageUrls);
  // An incomplete scrape must never erase the last usable media set or its file_id
  // associations. New media is merged by the original image identity instead.
  if (!incoming.length) return;

  const existing = await db.all(`
    SELECT id, source_url
    FROM listing_media
    WHERE listing_id = ? AND media_type = 'image'
    ORDER BY id ASC
  `, [listingId]);
  const byIdentity = new Map();
  for (const row of existing) {
    const identity = imageUrlIdentity(row.source_url);
    if (identity && !byIdentity.has(identity)) byIdentity.set(identity, row);
  }

  for (const [sortOrder, item] of incoming.entries()) {
    const current = byIdentity.get(item.identity);
    if (current) {
      await db.run(`UPDATE listing_media
        SET listing_snapshot_id = ?, source_url = ?, sort_order = ?
        WHERE id = ?`, [snapshotId, item.url, sortOrder, current.id]);
    } else {
      await db.run(`INSERT INTO listing_media
        (listing_id, listing_snapshot_id, media_type, source_url, sort_order, created_at)
        VALUES (?, ?, 'image', ?, ?, ?)`, [listingId, snapshotId, item.url, sortOrder, capturedAt]);
    }
  }
}

async function upsertCore(db, dto) {
  const sourceListingId = String(dto.sourceListingId || dto.listingId || '');
  const sourceUrl = String(dto.sourceUrl || dto.url || '');
  if (!sourceListingId) throw new Error('sourceListingId is required');
  if (!sourceUrl) throw new Error('sourceUrl is required');
  if (!['valid', 'partial', 'invalid', 'error'].includes(dto.parseStatus)) throw new Error('parseStatus is invalid');

  let listing = await db.get(`SELECT id, rental_unit_id, latest_valid_snapshot_id FROM listings
    WHERE source = '591' AND source_listing_id = ?`, [sourceListingId]);
  let propertyId;
  let rentalUnitId;

  if (!listing) {
    await db.run(`INSERT INTO properties
      (public_id,address_text,normalized_address,status,created_at,updated_at)
      VALUES (?,?,?,'active',?,?)`, [publicId('property', sourceListingId), dto.address || `未擷取完整地址（591 房源 ${sourceListingId}）`, dto.address || null, dto.capturedAt, dto.capturedAt]);
    propertyId = (await db.get('SELECT id FROM properties WHERE public_id=?', [publicId('property', sourceListingId)])).id;
    await db.run(`INSERT INTO rental_units
      (public_id,property_id,unit_label,rental_type,floor_label,room_count,status,created_at,updated_at)
      VALUES (?,?,'591 刊登單位',?,?,?,'marketing',?,?)`, [publicId('unit', sourceListingId), propertyId, rentalType(dto.rentalType), dto.floor || null, roomCount(dto.rooms), dto.capturedAt, dto.capturedAt]);
    rentalUnitId = (await db.get('SELECT id FROM rental_units WHERE public_id=?', [publicId('unit', sourceListingId)])).id;
    await db.run(`INSERT INTO listings
      (public_id,rental_unit_id,source,source_listing_id,source_url,title,current_rent_amount,status,published_at,created_at,updated_at)
      VALUES (?,?,'591',?,?,?,?, 'published',?,?,?)`, [publicId('listing', sourceListingId), rentalUnitId, sourceListingId, dto.sourceUrl, dto.title || null, Number.isFinite(dto.price) ? dto.price : null, dto.capturedAt, dto.capturedAt, dto.capturedAt]);
    listing = await db.get(`SELECT id,rental_unit_id,latest_valid_snapshot_id FROM listings
      WHERE source='591' AND source_listing_id=?`, [sourceListingId]);
  } else {
    rentalUnitId = listing.rental_unit_id;
    propertyId = (await db.get('SELECT property_id FROM rental_units WHERE id=?', [rentalUnitId])).property_id;
  }

  const payload = publicPayload(dto);
  const rawPayloadJson = JSON.stringify(payload);
  const rawHash = hashPayload(payload);
  const isTrustedRent = Number.isFinite(dto.price) &&
                        dto.isTrustedRent !== false &&
                        dto.priceSource !== 'recommendation' &&
                        dto.priceSource !== 'deposit';

  const existingSnapshot = await db.get('SELECT id FROM listing_snapshots WHERE listing_id=? AND raw_hash=?', [listing.id, rawHash]);
  if (existingSnapshot) {
    const currentListing = await db.get(`SELECT current_rent_amount FROM listings WHERE id=?`, [listing.id]);
    const shouldFillRent = isTrustedRent &&
      (dto.priceSource !== 'ssr_primary' || currentListing?.current_rent_amount == null);
    if (shouldFillRent) {
      await db.run(`UPDATE listings SET current_rent_amount=?, updated_at=? WHERE id=?`, [dto.price, dto.capturedAt, listing.id]);
    }
    if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
      console.log(`[591 intake db] driver=${db.dialect.name} persistedRent=${currentListing?.current_rent_amount ?? null}`);
    }
    return { propertyId, rentalUnitId, listingId: listing.id, listingPublicId: publicId('listing', sourceListingId), snapshotId: existingSnapshot.id, snapshotCreated: false, parseStatus: dto.parseStatus };
  }

  const previous = await db.get(`SELECT id FROM listing_snapshots WHERE listing_id=?
    ORDER BY captured_at DESC,id DESC LIMIT 1`, [listing.id]);
  await db.run(`INSERT INTO listing_snapshots
    (public_id,listing_id,previous_snapshot_id,source,source_listing_id,source_url,captured_at,parser_version,parse_status,raw_payload_json,raw_hash,warning_json,normalized_title,normalized_address,rent_amount,amenity_json,is_latest_valid,created_at)
    VALUES (?,?,?,'591',?,?,?,?,?,?,?,?,?,?,?,?,0,?)`, [
    `591-snapshot-${sourceListingId}-${rawHash.slice(0, 16)}`, listing.id, previous?.id || null,
    sourceListingId, dto.sourceUrl, dto.capturedAt, dto.parserVersion || 'unknown', dto.parseStatus,
    rawPayloadJson, rawHash, JSON.stringify(dto.warnings || []), dto.title || null, dto.address || null,
    Number.isFinite(dto.price) ? dto.price : null,
    typeof dto.amenities === 'string' ? dto.amenities : JSON.stringify(dto.amenities || []),
    dto.capturedAt
  ]);
  const snapshotId = (await db.get('SELECT id FROM listing_snapshots WHERE listing_id=? AND raw_hash=?', [listing.id, rawHash])).id;

  const existingListing = await db.get(`SELECT title, current_rent_amount FROM listings WHERE id=?`, [listing.id]);
  const existingProp = await db.get(`SELECT address_text, normalized_address FROM properties WHERE id=?`, [propertyId]);

  const isFallbackAddress = (addr) => !addr || String(addr).startsWith('未擷取完整地址');
  const shouldUseFallbackRent = isTrustedRent &&
    (dto.priceSource !== 'ssr_primary' || existingListing?.current_rent_amount == null);
  const shouldUseFallbackAddress = !isFallbackAddress(dto.address) &&
    (dto.addressSource !== 'ssr_primary' || isFallbackAddress(existingProp?.address_text));

  const targetTitle = dto.title || existingListing?.title || null;
  const targetRent = shouldUseFallbackRent ? dto.price : (existingListing?.current_rent_amount ?? null);
  let targetAddress = shouldUseFallbackAddress ? dto.address : existingProp?.address_text;
  if (isFallbackAddress(targetAddress) && existingProp && !isFallbackAddress(existingProp.address_text)) {
    targetAddress = existingProp.address_text;
  }

  const shouldUpdate = shouldUseFallbackRent ||
                       dto.parseStatus === 'valid' ||
                       (targetRent != null && existingListing?.current_rent_amount == null) ||
                       shouldUseFallbackAddress;

  if (shouldUpdate) {
    if (dto.parseStatus === 'valid' || shouldUseFallbackRent) {
      await db.run('UPDATE listing_snapshots SET is_latest_valid=0 WHERE listing_id=? AND id<>? AND is_latest_valid=1', [listing.id, snapshotId]);
      await db.run('UPDATE listing_snapshots SET is_latest_valid=1 WHERE id=?', [snapshotId]);
    }
    const latestValidId = (dto.parseStatus === 'valid' || shouldUseFallbackRent) ? snapshotId : (listing.latest_valid_snapshot_id || null);
    await db.run(`UPDATE listings SET source_url=?,title=?,current_rent_amount=?,latest_valid_snapshot_id=?,updated_at=? WHERE id=?`, [dto.sourceUrl, targetTitle, targetRent, latestValidId, dto.capturedAt, listing.id]);
    await db.run('UPDATE properties SET address_text=?,normalized_address=?,updated_at=? WHERE id=?', [targetAddress || `未擷取完整地址（591 房源 ${sourceListingId}）`, targetAddress || null, dto.capturedAt, propertyId]);
    await db.run('UPDATE rental_units SET rental_type=?,floor_label=?,room_count=?,updated_at=? WHERE id=?', [rentalType(dto.rentalType), dto.floor || null, roomCount(dto.rooms), dto.capturedAt, rentalUnitId]);
  }

  const currentListing = await db.get(`SELECT current_rent_amount FROM listings WHERE id=?`, [listing.id]);
  if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
    console.log(`[591 intake db] driver=${db.dialect.name} persistedRent=${currentListing?.current_rent_amount ?? null}`);
  }

  await syncListingMedia(db, {
    listingId: listing.id,
    snapshotId,
    imageUrls: dto.imageUrls,
    capturedAt: dto.capturedAt
  });

  return { propertyId, rentalUnitId, listingId: listing.id, listingPublicId: publicId('listing', sourceListingId), snapshotId, snapshotCreated: true, parseStatus: dto.parseStatus };
}

function upsert591ListingSnapshot(db, dto) {
  return db.transaction((tx) => upsertCore(tx, dto));
}

module.exports = { upsert591ListingSnapshot };
