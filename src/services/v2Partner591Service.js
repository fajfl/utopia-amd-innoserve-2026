const { normalize591Listing } = require('./partner591Normalizer');
const { upsert591ListingSnapshot } = require('../repositories/v2ListingRepositoryAsync');

const PHONE_PATTERN = /(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}(?:[,，]\d+)?/g;

function sanitizeText(value) {
  if (value == null) return null;
  const text = String(value)
    .replace(PHONE_PATTERN, '[聯絡資訊已移除]')
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]+/g, '[本機路徑已移除]')
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

function sanitizeNested(value) {
  if (Array.isArray(value)) return value.map(sanitizeNested);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitizeNested(child)])
    );
  }
  return typeof value === 'string' ? sanitizeText(value) : value;
}

function parseAmenities(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(sanitizeText).filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(sanitizeText).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeImageUrls(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((url) => {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }))];
}

function sanitize591ForV2(listing, options = {}) {
  const normalized = normalize591Listing(listing || {});
  if (!normalized.listingId) throw new Error('591 listing id is required for V2 mirror');

  const warnings = [];
  const required = [
    ['title', normalized.title],
    ['price', normalized.price],
    ['address', normalized.address],
    ['rooms', normalized.rooms],
    ['rental type', normalized.type],
    ['floor', normalized.floor]
  ];
  for (const [label, value] of required) {
    if (value == null || value === '') warnings.push(`missing ${label}`);
  }
  const amenities = parseAmenities(normalized.amenities);
  if (amenities.length === 0) warnings.push('missing amenities');

  return {
    sourceListingId: normalized.listingId,
    sourceUrl: normalized.url,
    title: sanitizeText(normalized.title),
    price: normalized.price,
    isTrustedRent: normalized.isTrustedRent,
    priceSource: (listing && listing.priceSource) || normalized.priceSource || null,
    address: sanitizeText(normalized.address),
    addressSource: (listing && listing.addressSource) || normalized.addressSource || null,
    rooms: sanitizeText(normalized.rooms),
    rentalType: sanitizeText(normalized.type),
    floor: sanitizeText(normalized.floor),
    amenities,
    description: sanitizeText(normalized.description),
    imageUrls: safeImageUrls(normalized.imageUrls),
    nearby: sanitizeNested(Array.isArray(normalized.nearby) ? normalized.nearby : []),
    parseStatus: warnings.length === 0 ? 'valid' : 'partial',
    warnings,
    parserVersion: options.parserVersion || 'partner-591-v2-1',
    capturedAt: options.capturedAt || new Date().toISOString()
  };
}

async function mirror591IntakeToV2({ db, payload, capturedAt, parserVersion } = {}) {
  if (!db) throw new Error('V2 database is required');
  const dto = sanitize591ForV2((payload && payload.listing) || {}, {
    capturedAt,
    parserVersion
  });
  return upsert591ListingSnapshot(db, dto);
}

module.exports = {
  mirror591IntakeToV2,
  sanitize591ForV2
};
