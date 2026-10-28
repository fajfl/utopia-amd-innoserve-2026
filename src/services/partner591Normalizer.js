function cleanText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function extract591ListingId(url) {
  const value = String(url || '');
  const detail = value.match(/rent-detail-(\d+)/i);
  if (detail) return detail[1];
  const pathId = value.match(/591\.com\.tw\/(?:home\/)?(\d+)(?:[/?#]|$)/i);
  return pathId ? pathId[1] : null;
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
    } catch { items = value.split(/[,\n、]/); }
  }
  if (!Array.isArray(items)) return null;
  const unique = [];
  for (const item of items) {
    const itemText = cleanText(item);
    if (itemText && !unique.includes(itemText)) unique.push(itemText);
  }
  return unique.length ? JSON.stringify(unique) : null;
}

function plainObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function arrayValue(value) { return Array.isArray(value) ? value : null; }

function extractPriceInfo(input) {
  if (input.isTrustedRent === false || input.priceSource === 'recommendation' || input.priceSource === 'deposit') {
    const price = parsePrice(input.price || input.priceText);
    return { price, isTrusted: false };
  }

  if (input.rawListing) {
    const raw = input.rawListing;
    if (raw.price != null) {
      const p = parsePrice(raw.price);
      if (p != null) return { price: p, isTrusted: true };
    }
    if (raw.infoData && raw.infoData.price != null) {
      const p = parsePrice(raw.infoData.price);
      if (p != null) return { price: p, isTrusted: true };
    }
  }

  let price = parsePrice(input.price);
  if (price != null) return { price, isTrusted: true };
  price = parsePrice(input.priceText);
  if (price != null) return { price, isTrusted: true };

  if (input.detailItems) {
    price = parsePrice(input.detailItems.price || input.detailItems.priceText);
    if (price != null) return { price, isTrusted: true };
  }

  if (input.rawListing && input.rawListing.pageSnapshot) {
    const snap = input.rawListing.pageSnapshot;
    const body = String(snap.metaDescription || snap.pageTitle || snap.bodyText || '');
    const m = body.match(/(?:月租|租金)[:：\s]*([\d,]+)\s*元?/i) ||
              body.match(/([\d,]+)\s*元\s*\/\s*月/i);
    if (m) {
      price = parsePrice(m[1]);
      if (price != null) return { price, isTrusted: false };
    }
  }
  return { price: null, isTrusted: false };
}

function extractPrice(input) {
  return extractPriceInfo(input).price;
}

function sanitizeCleanAddress(value) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value.replace(/^地址[:：\s]*/, '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 3 || cleaned.length > 80) return null;

  const forbidden = ['出租', '租金', '面積', '?', '？', '位於', '套房', '雅房', '整層', '辦公', '店面', '車位', '說明', '介紹', '推薦'];
  for (const kw of forbidden) {
    if (cleaned.includes(kw)) return null;
  }

  const twRegionRegex = /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/;
  if (!twRegionRegex.test(cleaned)) return null;

  const addrRegex = /(?:(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^\n,()<>{}"'\s]{1,30}(?:市|區|鎮|鄉|村|里|路|街|段|巷|弄|號)?)/;
  const match = cleaned.match(addrRegex);
  if (match) {
    const candidate = match[0].trim();
    for (const kw of forbidden) {
      if (candidate.includes(kw)) return null;
    }
    return candidate;
  }
  return null;
}

function extractAddress(input) {
  // Priority 1: High quality structured field from Nuxt Context
  if (input.rawListing && input.rawListing.positionRound && input.rawListing.positionRound.address) {
    const ctxAddr = sanitizeCleanAddress(input.rawListing.positionRound.address);
    if (ctxAddr) return ctxAddr;
  }
  // Priority 2: Structured detailItems address
  if (input.detailItems && input.detailItems.address) {
    const detailAddr = sanitizeCleanAddress(input.detailItems.address);
    if (detailAddr) return detailAddr;
  }
  // Priority 3: Provided address / addressText
  const directAddr = sanitizeCleanAddress(input.address || input.addressText);
  if (directAddr) return directAddr;

  // Priority 4: Page snapshot meta / text fallback
  if (input.rawListing && input.rawListing.pageSnapshot) {
    const snap = input.rawListing.pageSnapshot;
    const textSources = [snap.metaDescription, snap.pageTitle, snap.bodyText];
    for (const src of textSources) {
      const snapAddr = sanitizeCleanAddress(src);
      if (snapAddr) return snapAddr;
    }
  }
  return null;
}

function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) return null;
  if (/recommend|suggest|avatar|icon|logo|default|placeholder|no[-_]?photo|video|cover|watermark|banner|ad[-_]|data:image/i.test(clean)) return null;
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    return null;
  }
  const pathname = parsed.pathname.replace(/![^/]*$/i, '');
  if (!/\.(?:jpg|jpeg|png|webp)$/i.test(pathname)) return null;
  // The suffix/query can be required by the 591 CDN. Validate the URL, but never
  // rewrite the value that the browser originally loaded.
  return clean;
}

function imageUrlIdentity(url) {
  const valid = normalizeImageUrl(url);
  if (!valid) return null;
  const parsed = new URL(valid);
  // 591 serves identical house assets from img1/img2 mirror hosts. The host is
  // transport detail, not image identity, so collapse it before deduplication.
  const hostname = /^img\d+\.591\.com\.tw$/i.test(parsed.hostname)
    ? 'img.591.com.tw'
    : parsed.hostname.toLowerCase();
  return `${parsed.protocol}//${hostname}${parsed.pathname.replace(/![^/]*$/i, '')}`;
}

function uniqueUrls(values) {
  if (!Array.isArray(values)) return null;
  const unique = [];
  const seen = new Set();
  for (const val of values) {
    const norm = normalizeImageUrl(val);
    const identity = imageUrlIdentity(norm);
    if (norm && identity && !seen.has(identity)) {
      seen.add(identity);
      unique.push(norm);
    }
  }
  return unique.length ? unique : null;
}

function normalize591Listing(input = {}) {
  const rawUrl = cleanText(input.url);
  if (!rawUrl) {
    const error = new Error('591 partner intake requires a 591 listing URL.');
    error.statusCode = 400;
    throw error;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    const error = new Error('591 partner intake requires a valid URL.');
    error.statusCode = 400;
    throw error;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const allowedHosts = new Set(['591.com.tw', 'www.591.com.tw', 'rent.591.com.tw']);
  if (!allowedHosts.has(hostname)) {
    const error = new Error('591 partner intake URL hostname must be 591.com.tw, www.591.com.tw, or rent.591.com.tw.');
    error.statusCode = 400;
    throw error;
  }

  const urlListingId = extract591ListingId(rawUrl);
  if (!urlListingId) {
    const error = new Error('Unable to extract listing ID from 591 URL.');
    error.statusCode = 400;
    throw error;
  }

  const providedListingId = cleanText(input.listingId);
  if (providedListingId && providedListingId !== urlListingId) {
    const error = new Error(`Provided listing ID (${providedListingId}) does not match URL listing ID (${urlListingId}).`);
    error.statusCode = 400;
    throw error;
  }

  const priceInfo = extractPriceInfo(input);

  return { source:'591', url:rawUrl, listingId:urlListingId,
    price:priceInfo.price, isTrustedRent:priceInfo.isTrusted, title:cleanText(input.title), address:extractAddress(input),
    priceSource:cleanText(input.priceSource), addressSource:cleanText(input.addressSource),
    rooms:cleanText(input.rooms), type:cleanText(input.type), floor:cleanText(input.floor),
    amenities:normalizeAmenities(input.amenities), description:cleanText(input.description),
    rawListing:plainObject(input.rawListing), detailItems:plainObject(input.detailItems),
    imageUrls:uniqueUrls(arrayValue(input.imageUrls)), contactInfo:plainObject(input.contactInfo), nearby:arrayValue(input.nearby),
    parseStatus: 'valid' };
}

module.exports = { cleanText, extract591ListingId, imageUrlIdentity, normalizeImageUrl, normalize591Listing };
