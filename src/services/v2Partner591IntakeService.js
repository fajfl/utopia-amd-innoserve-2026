const { sqliteDriver } = require('../database/sqlDriver');
const { withV2Driver } = require('../database/v2Driver');
const { findOrCreateEntryToken } = require('../repositories/v2ListingEntryTokenRepositoryAsync');
const { mirror591IntakeToV2 } = require('./v2Partner591Service');
const { normalize591Listing } = require('./partner591Normalizer');

const KNOWN_591_AMENITIES = [
  '冰箱', '洗衣機', '電視', '冷氣', '熱水器', '床', '衣櫃', '第四台', '網路',
  '天然瓦斯', '沙發', '桌椅', '陽台', '電梯', '車位', '微波爐', '飲水機',
  '洗碗機', '烘衣機', '瓦斯爐', '抽油煙機'
];
const TAIWAN_CITIES = [
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市', '基隆市', '新竹市', '嘉義市',
  '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
  '台東縣', '澎湖縣', '金門縣', '連江縣'
];

function formatBasicId(basicId) {
  if (!basicId) return null;
  const trimmed = String(basicId).trim();
  if (!trimmed) return null;
  const withAt = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  return encodeURIComponent(withAt);
}

function lineUrl(entryCode, basicId) {
  const encodedId = formatBasicId(basicId);
  if (!encodedId) return null;
  const message = `591租屋詢問 ${entryCode}`;
  return `https://line.me/R/oaMessage/${encodedId}/?${encodeURIComponent(message)}`;
}

function injectedDriver(db) {
  return typeof db.get === 'function' ? db : sqliteDriver(db);
}

function parse591SsrAmenities(html) {
  const itemPattern = `(?:${KNOWN_591_AMENITIES.join('|')})`;
  const sequence = new RegExp(`${itemPattern}(?:\\s*[,，]\\s*${itemPattern}){2,}`, 'g');
  const source = String(html || '');
  let best = [];
  let match;
  while ((match = sequence.exec(source)) !== null) {
    const values = match[0]
      .split(/\s*[,，]\s*/)
      .filter((value) => KNOWN_591_AMENITIES.includes(value));
    if (values.length > best.length) best = [...new Set(values)];
  }
  return best;
}

function plain591Text(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function primary591Text(html) {
  return plain591Text(html).split(/附近房屋|熱門社區推薦|同縣市推薦/)[0];
}

function parse591SsrDetails(html) {
  const source = primary591Text(html);
  const rentMatch = source.match(/(?:^|\s)([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{3,5})\s*元\s*\/\s*月/);
  const price = rentMatch ? Number(rentMatch[1].replace(/,/g, '')) : null;

  const addressMatch = source.match(/地\s*址\s*[:：]\s*([^\n\r]{3,80}?)(?=\s*(?:所屬社區|交通|生活|教育|租住與設備|房屋詳情|$))/);
  let address = addressMatch ? addressMatch[1].replace(/\s+/g, ' ').trim() : null;
  if (address && !TAIWAN_CITIES.some((city) => address.startsWith(city))) {
    const city = TAIWAN_CITIES.find((candidate) => source.includes(candidate));
    if (city) address = `${city}${address}`;
  }

  const normalizedAddress = address
    ? normalize591Listing({
      url: 'https://rent.591.com.tw/0',
      listingId: '0',
      address
    }).address
    : null;

  return {
    price: Number.isFinite(price) && price >= 1000 && price <= 1000000 ? price : null,
    address: normalizedAddress
  };
}

async function enrichMissingListingFieldsFrom591(payload, options = {}) {
  const listing = payload?.listing || {};
  const normalized = normalize591Listing(listing);
  const needsAmenities = !normalized.amenities;
  const needsPrice = !Number.isFinite(normalized.price);
  const needsAddress = !normalized.address;
  if (!needsAmenities && !needsPrice && !needsAddress) return payload;

  const fetchImpl = options.fetch591Page || global.fetch;
  if (typeof fetchImpl !== 'function') return payload;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.listingFetchTimeoutMs || options.amenityFetchTimeoutMs || 4000));
  try {
    // The numeric ID is normalized by normalize591Listing; never fetch a URL
    // supplied directly by the extension for this fallback.
    const response = await fetchImpl(`https://rent.591.com.tw/${normalized.listingId}`, {
      signal: controller.signal,
      headers: { accept: 'text/html' }
    });
    if (!response || !response.ok) return payload;
    const html = await response.text();
    const amenities = needsAmenities ? parse591SsrAmenities(html) : null;
    const details = (needsPrice || needsAddress) ? parse591SsrDetails(html) : null;
    const patch = {};
    if (amenities && amenities.length >= 3) patch.amenities = amenities;
    if (needsPrice && details?.price != null) {
      patch.price = details.price;
      patch.priceSource = 'ssr_primary';
    }
    if (needsAddress && details?.address) patch.address = details.address;
    if (needsAddress && details?.address) patch.addressSource = 'ssr_primary';
    if (!Object.keys(patch).length) return payload;
    return {
      ...payload,
      listing: {
        ...listing,
        ...patch
      }
    };
  } catch {
    // Public-page enrichment is optional. A network failure must not block the
    // normal Extension intake flow.
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function create591V2Intake(payload, options = {}) {
  const enrichedPayload = await enrichMissingListingFieldsFrom591(payload, options);
  const withDriver = options.db
    ? (fn) => fn(injectedDriver(options.db))
    : (options.withDriver || withV2Driver);
  return withDriver(async (db) => {
    return db.transaction(async (tx) => {
      const listing = await mirror591IntakeToV2({ db: tx, payload: enrichedPayload });
      const entryCode = await findOrCreateEntryToken(tx, listing.listingId);
      const basicId = options.lineBasicId || process.env.LINE_OA_BASIC_ID || process.env.LINE_OFFICIAL_ACCOUNT_ID || process.env.LINE_BASIC_ID;
      const lineChatUrl = lineUrl(entryCode, basicId);
      if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
        const normalized = normalize591Listing(enrichedPayload?.listing || {});
        console.log(`[591 intake runtime] serverStartTime=${global.SERVER_START_TIME} requestHost=${options.requestHost || null} driver=${tx.dialect.name} listingId=${listing.sourceListingId || listing.listingId}`);
        console.log(`[591 extension payload] extPrice=${payload?.listing?.price} extPriceSource=${payload?.listing?.priceSource || null}`);
        console.log(`[591 normalizer output] normPrice=${normalized.price} isTrustedRent=${normalized.isTrustedRent} normPriceSource=${payload?.listing?.priceSource || null}`);
      }
      return { ok:true, integrationMode:'v2_only', entryCode, lineChatUrl, lineEntryUrl:lineChatUrl,
        status: listing.snapshotCreated ? 'created' : 'restored', listingPublicId: listing.listingPublicId,
        parseStatus: listing.parseStatus, snapshotCreated: listing.snapshotCreated };
    });
  });
}

module.exports = { create591V2Intake, parse591SsrDetails };
