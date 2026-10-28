/**
 * Rental listing scraper service for LINE Bot.
 *
 * Detects and parses single-listing detail pages from:
 *   - 591 租屋網 (rent.591.com.tw)
 *   - 方齊物業 (fcrent.tw)
 *   - 樂屋網 (rakuya.com.tw)
 *
 * Uses lightweight HTTP + vm/JSON parsing — no browser needed.
 */

const axios = require('axios');
const vm = require('vm');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
};

const REQUEST_TIMEOUT = 8000;

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/**
 * Regex to match rental listing URLs from the three supported platforms.
 * Exported so that the message handler can use it for detection.
 */
const RENTAL_URL_REGEX =
  /(https?:\/\/(?:[a-zA-Z0-9-]+\.)*(?:591\.com\.tw|rakuya\.com\.tw|fcrent\.tw)\S*)/i;

/**
 * Determine which platform a URL belongs to.
 * Returns '591' | 'fcrent' | 'rakuya' | null.
 */
function detectSource(url) {
  if (/591\.com\.tw/i.test(url)) return '591';
  if (/fcrent\.tw/i.test(url)) return 'fcrent';
  if (/rakuya\.com\.tw/i.test(url)) return 'rakuya';
  return null;
}

// ---------------------------------------------------------------------------
// 591 parser
// ---------------------------------------------------------------------------

/**
 * Normalise a 591 list-page URL (e.g. rent.591.com.tw/list?…) into a detail
 * page URL if possible.  If the URL already points to a detail page it is
 * returned unchanged.
 */
function normalise591Url(url) {
  // Detail page patterns:
  //   https://rent.591.com.tw/rent-detail-<id>.html
  //   https://rent.591.com.tw/<id>
  if (/rent-detail-\d+/i.test(url) || /591\.com\.tw\/\d+\/?$/i.test(url)) {
    return url;
  }
  return url;
}

async function scrape591(url) {
  url = normalise591Url(url);

  // Extract listing id from the URL
  let listingId = null;
  const detailMatch = url.match(/rent-detail-(\d+)/);
  if (detailMatch) {
    listingId = detailMatch[1];
  } else {
    const idMatch = url.match(/591\.com\.tw\/(\d+)/);
    if (idMatch) {
      listingId = idMatch[1];
    }
  }

  // If we got a listing ID, ensure we hit the detail page
  const detailUrl = listingId
    ? `https://rent.591.com.tw/rent-detail-${listingId}.html`
    : url;

  const { data: html } = await axios.get(detailUrl, {
    headers: HEADERS,
    timeout: REQUEST_TIMEOUT
  });

  // Extract window.__NUXT__ assignment
  const scriptMatch = html.match(
    /<script>(window\.__NUXT__\s*=[\s\S]*?)<\/script>/
  );
  if (!scriptMatch) return null;

  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(scriptMatch[1], sandbox);

  const nuxt = sandbox.window.__NUXT__;
  if (!nuxt || !nuxt.pinia) return null;

  const store = nuxt.pinia['rent-detail-info'];
  if (!store) return null;

  // ctx holds the full detail data
  const ctx = store.ctx || {};

  const title = ctx.title || null;

  // Address lives in positionRound
  const position = ctx.positionRound || {};
  const address = position.address || null;

  // Breadcrumb gives us city / district / kind
  const crumbs = ctx.breadcrumb || [];
  const kindCrumb = crumbs.find((c) => c.query === 'kind');
  const typeName = kindCrumb ? kindCrumb.name : null;

  // info is an array of {name, value, key}
  const info = ctx.info || [];
  const infoMap = {};
  for (const item of info) {
    if (item.key) infoMap[item.key] = item.value;
  }

  const rooms = infoMap.layout || null;
  const floor = infoMap.floor || null;
  const type = typeName || infoMap.shape || null;

  // Amenities from service.facility
  const service = ctx.service || {};
  const facility = service.facility || [];
  const amenities = facility
    .filter((f) => f.active && f.key !== 'gas' && f.name)
    .map((f) => f.name);

  // Description from remark.content (strip HTML tags)
  const remark = ctx.remark || {};
  const rawDesc = remark.content || null;
  const description = rawDesc
    ? rawDesc.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim() || null
    : null;

  // Price from ctx.price (e.g. "130,000 元/月")
  let price = null;
  const priceStr = String(ctx.price || '');
  if (priceStr && !priceStr.includes('面議')) {
    const priceNums = priceStr.match(/[\d,]+/);
    if (priceNums) price = parseInt(priceNums[0].replace(/,/g, ''), 10) || null;
  }

  return {
    source: '591', title, address, rooms, type, floor, price,
    amenities: amenities.length ? JSON.stringify(amenities) : null,
    description
  };
}

// ---------------------------------------------------------------------------
// fcrent parser
// ---------------------------------------------------------------------------

async function scrapeFcrent(url) {
  const { data: html } = await axios.get(url, {
    headers: HEADERS,
    timeout: REQUEST_TIMEOUT
  });

  const match = html.match(
    /<script\s+id="__NEXT_DATA__"\s+type="application\/json">\s*(.*?)\s*<\/script>/s
  );
  if (!match) return null;

  let nextData;
  try {
    nextData = JSON.parse(match[1]);
  } catch {
    return null;
  }

  const pageProps = (nextData.props || {}).pageProps || {};
  const obj = pageProps.object;
  if (!obj) return null;

  // Build id → name lookups
  const lookup = (items) => {
    if (!items) return {};
    return items.reduce((acc, item) => {
      acc[item.id] = (item.name && item.name.zhTW) || '';
      return acc;
    }, {});
  };

  const cityLookup = lookup(pageProps.city);
  const districtLookup = lookup(pageProps.district);
  const typeLookup = lookup(pageProps.type);
  const layoutLookup = lookup(pageProps.layout);

  const cityName = cityLookup[obj.city] || '';
  const districtName = districtLookup[obj.district] || '';
  const address =
    cityName && districtName ? `${cityName}${districtName}` : null;

  const listingType = layoutLookup[obj.layout] || typeLookup[obj.type] || null;

  // Price
  let price = null;
  const rentStr = obj.rent || '';
  if (rentStr) {
    const parsed = parseInt(String(rentStr).replace(/,/g, ''), 10);
    if (!isNaN(parsed)) price = parsed;
  }

  // Amenities from facility IDs
  const facilityLookup = lookup(pageProps.facilities);
  const amenities = (obj.facility || [])
    .map((fid) => facilityLookup[fid] || fid)
    .filter(Boolean);

  // Description from rich-text contents blocks
  let description = null;
  const contents = (obj.contents && obj.contents.zhTW) || [];
  if (Array.isArray(contents)) {
    const parts = contents
      .filter((b) => b && b.data && b.data.html)
      .map((b) => b.data.html.replace(/<[^>]+>/g, ''));
    if (parts.length) description = parts.join('\n');
  }

  return {
    source: 'fcrent',
    title: (obj.name && obj.name.zhTW) || null,
    address,
    rooms: obj.pattern || null,
    type: listingType,
    floor: obj.floor || null,
    price,
    amenities: amenities.length ? JSON.stringify(amenities) : null,
    description
  };
}

// ---------------------------------------------------------------------------
// Rakuya parser
// ---------------------------------------------------------------------------

async function scrapeRakuya(url) {
  let html;
  try {
    const response = await axios.get(url, {
      headers: HEADERS,
      timeout: REQUEST_TIMEOUT
    });
    html = response.data;
  } catch (err) {
    if (err.response && err.response.status === 403) {
      return {
        source: 'rakuya',
        title: null,
        address: null,
        rooms: null,
        type: null,
        floor: null,
        blocked: true
      };
    }
    throw err;
  }

  // Check for Cloudflare challenge page
  if (
    html.includes('challenge-form') ||
    html.includes('Just a moment...')
  ) {
    return {
      source: 'rakuya',
      title: null,
      address: null,
      rooms: null,
      type: null,
      floor: null,
      blocked: true
    };
  }

  // Parse detail page HTML using regex (same approach as tw-rent-radar)
  let title = null;
  const titleMatch = html.match(
    /class="block__title"[^>]*>\s*<h2[^>]*>(.*?)<\/h2>/s
  );
  if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();

  let address = null;
  const addrMatch = html.match(
    /<h1[^>]*class="txt__address"[^>]*>(.*?)<\/h1>/s
  );
  if (addrMatch) address = addrMatch[1].replace(/<[^>]+>/g, '').trim();

  // Info table label/content pairs
  const infoPairs = [
    ...html.matchAll(
      /class="list__label"[^>]*>(.*?)<\/span>\s*<span[^>]*class="list__content"[^>]*>(.*?)<\/span>/gs
    )
  ];

  let rooms = null;
  let floor = null;
  let type = null;

  for (const [, rawLabel, rawContent] of infoPairs) {
    const label = rawLabel.replace(/<[^>]+>/g, '').trim();
    const content = rawContent.replace(/<[^>]+>/g, '').trim();
    if (label.includes('格局')) rooms = content;
    else if (label.includes('樓層')) floor = content;
    else if (label.includes('類型')) type = content;
  }

  // Amenities from 設備/傢俱 label pairs
  const amenities = [];
  for (const [, rawLabel, rawContent] of infoPairs) {
    const label = rawLabel.replace(/<[^>]+>/g, '').trim();
    if (label.includes('設備') || label.includes('傢俱')) {
      const items = rawContent.replace(/<[^>]+>/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      amenities.push(...items);
    }
  }

  // Description from block__describe
  let description = null;
  const descMatch = html.match(/class="block__describe"[^>]*>([\s\S]*?)<\/div>/s);
  if (descMatch) description = descMatch[1].replace(/<[^>]+>/g, '').trim() || null;

  // Price from txt__price-total
  let price = null;
  const priceMatch = html.match(/class="txt__price-total"[^>]*>(.*?)<\/span>/s);
  if (priceMatch) {
    const priceNums = priceMatch[1].replace(/<[^>]+>/g, '').match(/[\d,]+/);
    if (priceNums) price = parseInt(priceNums[0].replace(/,/g, ''), 10) || null;
  }

  return {
    source: 'rakuya', title, address, rooms, type, floor, price,
    amenities: amenities.length ? JSON.stringify(amenities) : null,
    description
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape a rental listing URL and return structured data.
 *
 * @param {string} url - Full URL to a rental listing detail page.
 * @returns {Promise<object|null>} Parsed listing or null on failure.
 *   Shape: { source, title, address, rooms, type, floor, blocked? }
 */
async function scrapeRentalUrl(url) {
  const source = detectSource(url);
  if (!source) return null;

  try {
    switch (source) {
      case '591':
        return await scrape591(url);
      case 'fcrent':
        return await scrapeFcrent(url);
      case 'rakuya':
        return await scrapeRakuya(url);
      default:
        return null;
    }
  } catch (err) {
    console.error(`Rental scraper [${source}] failed for ${url}:`, err.message);
    return null;
  }
}

module.exports = { RENTAL_URL_REGEX, scrapeRentalUrl };
