(function init(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EcsNeo591Adapter = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function factory() {
  var INTEGRATION_MODE = 'partner_591_line_shared_mock';

  function cleanText(value) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    return text || null;
  }

  function listingIdFromUrl(url) {
    var detail = String(url || '').match(/rent-detail-(\d+)/i);
    if (detail) return detail[1];
    var pathId = String(url || '').match(/591\.com\.tw\/(?:home\/)?(\d+)(?:[/?#]|$)/i);
    return pathId ? pathId[1] : null;
  }

  function compareListingIdentity(pageUrl, ctx) {
    var pageListingId = listingIdFromUrl(pageUrl);
    var contextListingId = cleanText(ctx && ctx.id);
    var status = 'incomplete';
    if (pageListingId && contextListingId) {
      status = pageListingId === contextListingId ? 'match' : 'mismatch';
    }
    return {
      status: status,
      pageListingId: pageListingId,
      contextListingId: contextListingId
    };
  }

  async function waitForMatching591Context(options) {
    options = options || {};
    var readContext = options.readContext;
    var delay = options.delay || function wait(ms) {
      return new Promise(function resolveAfter(resolve) { setTimeout(resolve, ms); });
    };
    var now = options.now || Date.now;
    var timeoutMs = Number(options.timeoutMs || 3000);
    var intervalMs = Number(options.intervalMs || 150);
    var startedAt = now();
    var attempts = 0;
    var lastMismatch = null;

    while (true) {
      attempts += 1;
      var context = await readContext();
      var identity = compareListingIdentity(options.pageUrl, context);
      if (identity.status === 'match') {
        return { status: 'match', context: context, identity: identity, attempts: attempts };
      }
      if (identity.status === 'mismatch') {
        lastMismatch = { context: context, identity: identity };
      }

      var elapsed = now() - startedAt;
      if (elapsed >= timeoutMs) {
        if (lastMismatch) {
          return {
            status: 'mismatch',
            context: lastMismatch.context,
            identity: lastMismatch.identity,
            attempts: attempts
          };
        }
        return { status: 'unavailable', context: null, identity: identity, attempts: attempts };
      }
      await delay(Math.min(intervalMs, timeoutMs - elapsed));
    }
  }

  function parsePrice(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    var text = String(value || '');
    if (text.indexOf('面議') !== -1) return null;
    var match = text.match(/[\d,]+/);
    if (!match) return null;
    var parsed = parseInt(match[0].replace(/,/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeAmenities(values) {
    var unique = [];
    (Array.isArray(values) ? values : []).forEach(function each(item) {
      var text = cleanText(item);
      if (text && unique.indexOf(text) === -1) unique.push(text);
    });
    return unique;
  }

  function isFacilityActive(item) {
    if (!item) return false;
    if (typeof item === 'string') return Boolean(cleanText(item));
    if (typeof item !== 'object') return false;
    var name = cleanText(item.name || item.label || item.title);
    if (!name) return false;

    if (item.active === 0 || item.active === '0' || item.active === false) return false;
    if (item.is_active === 0 || item.is_active === '0' || item.is_active === false) return false;
    if (item.status === 0 || item.status === '0' || item.status === false) return false;
    if (item.checked === 0 || item.checked === '0' || item.checked === false) return false;
    if (item.provided === 0 || item.provided === '0' || item.provided === false) return false;
    if (item.has === 0 || item.has === '0' || item.has === false) return false;
    if (item.active === -1 || item.active === '-1') return false;

    if (item.active === 1 || item.active === '1' || item.active === true) return true;
    if (item.is_active === 1 || item.is_active === '1' || item.is_active === true) return true;
    if (item.isActive === 1 || item.isActive === '1' || item.isActive === true) return true;
    if (item.status === 1 || item.status === '1' || item.status === true) return true;
    if (item.checked === 1 || item.checked === '1' || item.checked === true) return true;
    if (item.provided === 1 || item.provided === '1' || item.provided === true) return true;
    if (item.value === 1 || item.value === '1' || item.value === true) return true;
    if (item.has === 1 || item.has === '1' || item.has === true) return true;
    return true;
  }

  function stripHtml(value) {
    return cleanText(String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'));
  }

  function keyValueObject(items, keyName, valueName) {
    var result = {};
    (Array.isArray(items) ? items : []).forEach(function each(item) {
      if (!item) return;
      var key = cleanText(item[keyName]) || cleanText(item.name) || cleanText(item.label);
      var value = cleanText(item[valueName]) || cleanText(item.value);
      if (key && value) result[key] = value;
    });
    return result;
  }

  function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') return null;
    var clean = String(url).trim();
    if (!/^https?:\/\//i.test(clean)) return null;
    if (/recommend|suggest|avatar|icon|logo|default|placeholder|no[-_]?photo|video|cover|watermark|banner|ad[-_]|data:image/i.test(clean)) return null;
    var pathWithoutTransform = clean.split('?')[0].replace(/![^/]*$/i, '');
    if (!/\.(?:jpg|jpeg|png|webp)$/i.test(pathWithoutTransform)) return null;
    return clean;
  }

  function imageUrlIdentity(url) {
    var valid = normalizeImageUrl(url);
    if (!valid) return null;
    try {
      var parsed = new URL(valid);
      var hostname = /^img\d+\.591\.com\.tw$/i.test(parsed.hostname)
        ? 'img.591.com.tw'
        : parsed.hostname.toLowerCase();
      return parsed.protocol + '//' + hostname + parsed.pathname.replace(/![^/]*$/i, '');
    } catch (error) {
      return null;
    }
  }

  function collectImageUrls(value, output) {
    if (!value) return output;
    if (typeof value === 'string') {
      var norm = normalizeImageUrl(value);
      if (norm && output.indexOf(norm) === -1) {
        output.push(norm);
      }
      return output;
    }
    if (Array.isArray(value)) {
      value.forEach(function each(item) { collectImageUrls(item, output); });
      return output;
    }
    if (typeof value === 'object') {
      Object.keys(value).forEach(function each(key) {
        if (/recommend|shareInfo|gtm/i.test(key)) return;
        collectImageUrls(value[key], output);
      });
    }
    return output;
  }

  function isHouseImage(url) {
    return /\/\/img\d*\.591\.com\.tw\/house\//i.test(String(url || ''));
  }

  function uniqueUrls(values) {
    var unique = [];
    var seen = {};
    (Array.isArray(values) ? values : []).forEach(function each(value) {
      var norm = normalizeImageUrl(value);
      var identity = imageUrlIdentity(norm);
      if (norm && identity && !seen[identity]) {
        seen[identity] = true;
        unique.push(norm);
      }
    });
    return unique;
  }

  function mergeImageUrls(listing, imageUrls) {
    var merged = uniqueUrls([].concat(listing.imageUrls || [], imageUrls || []));
    merged.sort(function compare(a, b) {
      if (isHouseImage(a) === isHouseImage(b)) return 0;
      return isHouseImage(a) ? -1 : 1;
    });
    listing.imageUrls = merged;
    return listing;
  }

  function hasDisabledClassToken(htmlSnippet) {
    if (!htmlSnippet) return false;
    if (/<(?:del|s|strike)\b/i.test(htmlSnippet)) return true;
    var disabledTokens = ['no', 'del', 'disabled', 'grey', 'gray', 'off', 'is-disabled', 'line-through', 'is-off', 'not-provided'];
    var classMatches = htmlSnippet.match(/class=["']([^"']+)["']/gi) || [];
    for (var i = 0; i < classMatches.length; i++) {
      var attrMatch = classMatches[i].match(/class=["']([^"']+)["']/i);
      if (!attrMatch) continue;
      var tokens = attrMatch[1].split(/\s+/);
      for (var j = 0; j < tokens.length; j++) {
        var tok = tokens[j].toLowerCase().trim();
        if (disabledTokens.indexOf(tok) !== -1) return true;
      }
    }
    return false;
  }

  function extractDelimitedAmenities(value) {
    var text = String(value || '');
    var knownEquipment = ['冰箱', '洗衣機', '電視', '冷氣', '熱水器', '床', '衣櫃', '第四台', '網路', '天然瓦斯', '沙發', '桌椅', '陽台', '電梯', '車位', '微波爐', '飲水機', '洗碗機', '烘衣機', '瓦斯爐', '抽油煙機'];
    var itemPattern = '(?:' + knownEquipment.join('|') + ')';
    var sequence = new RegExp(itemPattern + '(?:\\s*[,，]\\s*' + itemPattern + '){2,}', 'g');
    var best = [];
    var match;
    while ((match = sequence.exec(text)) !== null) {
      var items = match[0].split(/\s*[,，]\s*/).filter(function(item) {
        return knownEquipment.indexOf(item) !== -1;
      });
      if (items.length > best.length) best = normalizeAmenities(items);
    }
    return best;
  }

  function extractActiveAmenitiesFromHtml(htmlString) {
    // The current 591 SSR payload serializes the enabled devices as a compact
    // comma-separated string instead of facility nodes. Read that authoritative
    // list before falling back to rendered-item parsing.
    var serializedAmenities = extractDelimitedAmenities(htmlString);
    if (serializedAmenities.length >= 3) return serializedAmenities;

    var html = String(htmlString || '').replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
    if (!html) return [];

    var knownEquipment = ['冰箱', '洗衣機', '電視', '冷氣', '熱水器', '床', '衣櫃', '第四台', '網路', '天然瓦斯', '沙發', '桌椅', '陽台', '電梯', '車位', '微波爐', '飲水機', '洗碗機', '烘衣機', '瓦斯爐', '抽油煙機'];
    var active = [];

    knownEquipment.forEach(function check(name) {
      var pos = 0;
      while ((pos = html.indexOf(name, pos)) !== -1) {
        // Use the closest semantic item container. The old 200-character window
        // mixed neighbouring facilities, so an unrelated `no`/`del` class could
        // incorrectly hide a valid item.
        var before = html.slice(0, pos);
        var opener = /<(dl|li|div)\b[^>]*>/gi;
        var match;
        var lastMatch = null;
        while ((match = opener.exec(before)) !== null) lastMatch = match;

        var targetSnippet = '';
        if (lastMatch) {
          var tag = lastMatch[1];
          var closeIndex = html.indexOf('</' + tag + '>', pos + name.length);
          targetSnippet = html.slice(lastMatch.index, closeIndex === -1 ? pos + name.length : closeIndex + tag.length + 3);
        }

        var isDisabled = hasDisabledClassToken(targetSnippet || html.slice(Math.max(0, pos - 80), pos + name.length + 80));
        if (!isDisabled) {
          if (active.indexOf(name) === -1) active.push(name);
          break;
        }
        pos += name.length;
      }
    });

    return active;
  }

  function normalizeListingFrom591NuxtContext(ctx, pageUrl) {
    ctx = ctx || {};
    var info = keyValueObject(ctx.info, 'key', 'value');
    var infoByName = keyValueObject(ctx.info, 'name', 'value');
    var costs = keyValueObject(ctx.costData && ctx.costData.data, 'key', 'value');
    var service = keyValueObject(ctx.service && ctx.service.descData, 'label', 'value');

    var facilityRaw = (ctx.service && ctx.service.facility) || ctx.facility || ctx.facilities || [];
    var activeAmenities = normalizeAmenities(facilityRaw
      .filter(isFacilityActive)
      .map(function name(item) { return item.name || item.label || item.title; }));

    if (!activeAmenities.length) {
      activeAmenities = extractActiveAmenitiesFromHtml(ctx.remark && ctx.remark.content);
    }

    var mainPhotos = [];
    var gallery = ctx.photoList || ctx.photos || ctx.mediaData || ctx.media;
    if (Array.isArray(gallery)) {
      gallery.forEach(function each(item) {
        if (typeof item === 'string') collectImageUrls(item, mainPhotos);
        else if (item && typeof item === 'object') collectImageUrls(item.url || item.src || item.photo || item, mainPhotos);
      });
    }

    var collectedImages = mainPhotos.length ? mainPhotos : collectImageUrls(ctx, []);

    var tags = (Array.isArray(ctx.tags) ? ctx.tags : [])
      .map(function tag(item) { return cleanText(item && (item.value || item.name)); })
      .filter(Boolean);
    var preferences = (ctx.preference && Array.isArray(ctx.preference.data) ? ctx.preference.data : [])
      .map(function pref(item) {
        return {
          name: cleanText(item.name),
          text: cleanText(item.text),
          icon: cleanText(item.icon)
        };
      });
    var contact = ctx.linkInfo || {};
    var gtm = ctx.gtm_detail_data || {};
    var detailItems = Object.assign({}, info, costs, service, {
      deposit: cleanText((ctx.deposit || costs.deposit)),
      tags: tags.join('、') || null,
      preferences: preferences
        .filter(function present(item) { return item.name || item.text; })
        .map(function join(item) { return [item.name, item.text].filter(Boolean).join('：'); })
        .join('；') || null
    });
    Object.keys(detailItems).forEach(function prune(key) {
      if (detailItems[key] == null || detailItems[key] === '') delete detailItems[key];
    });

    return {
      source: '591',
      url: cleanText(pageUrl || (ctx.shareInfo && ctx.shareInfo.url)) || null,
      listingId: cleanText(ctx.id) || listingIdFromUrl(pageUrl),
      title: cleanText(ctx.title),
      price: parsePrice(ctx.price || (ctx.costData && ctx.costData.data && ctx.costData.data[0] && ctx.costData.data[0].value)),
      address: cleanText(ctx.positionRound && ctx.positionRound.address),
      rooms: cleanText(info.layout || infoByName['格局']),
      type: cleanText(gtm.kind_name || info.shape || infoByName['型態']),
      floor: cleanText(info.floor || infoByName['樓層']),
      amenities: activeAmenities,
      description: stripHtml(ctx.remark && ctx.remark.content),
      detailItems: detailItems,
      contactInfo: {
        name: cleanText(contact.name),
        roleName: cleanText(contact.roleName),
        roleText: cleanText(contact.roleTxt),
        mobile: cleanText(contact.mobile),
        phone: cleanText(contact.phone),
        imName: cleanText(contact.imName),
        uid: cleanText(contact.uid),
        serviceFee: cleanText(contact.isrecmoney),
        labels: Array.isArray(contact.labelInfo) ? contact.labelInfo.map(cleanText).filter(Boolean) : []
      },
      nearby: Array.isArray(ctx.positionRound && ctx.positionRound.data) ? ctx.positionRound.data : [],
      imageUrls: uniqueUrls(collectedImages),
      rawListing: ctx
    };
  }

  function normalizePageSnapshot(raw) {
    if (!raw) return null;
    var snapshot = {
      pageTitle: cleanText(raw.pageTitle),
      metaDescription: cleanText(raw.metaDescription),
      bodyText: cleanText(raw.bodyText),
      metaTags: Array.isArray(raw.metaTags) ? raw.metaTags : null,
      structuredData: Array.isArray(raw.structuredData) ? raw.structuredData : null
    };
    Object.keys(snapshot).forEach(function prune(key) {
      if (snapshot[key] == null || snapshot[key] === '') delete snapshot[key];
    });
    return Object.keys(snapshot).length ? snapshot : null;
  }

  function attachPageSnapshot(listing, raw) {
    var snapshot = normalizePageSnapshot(raw);
    if (!snapshot) return listing;
    listing.rawListing = Object.assign({}, listing.rawListing || {}, { pageSnapshot: snapshot });
    listing.detailItems = Object.assign({}, listing.detailItems || {});
    if (snapshot.bodyText && !listing.detailItems.fullPageText) {
      listing.detailItems.fullPageText = snapshot.bodyText;
    }
    if (!listing.description && snapshot.bodyText) {
      listing.description = snapshot.bodyText.slice(0, 4000);
    }
    return listing;
  }
  function normalizeListingFromPage(raw) {
    var url = cleanText(raw && raw.url);
    var listingId = cleanText(raw && raw.listingId) || listingIdFromUrl(url);
    var rawPrice = raw && raw.price != null ? raw.price : (raw && raw.priceText);
    var listing = {
      source: '591',
      url: url,
      listingId: listingId,
      title: cleanText(raw && (raw.title || raw.titleText || raw.pageTitle)),
      price: parsePrice(rawPrice),
      address: cleanText(raw && (raw.address || raw.addressText)),
      rooms: cleanText(raw && (raw.rooms || raw.roomsText)),
      type: cleanText(raw && (raw.type || raw.typeText)),
      floor: cleanText(raw && (raw.floor || raw.floorText)),
      amenities: normalizeAmenities(raw && (raw.amenities || raw.amenityTexts)),
      description: cleanText(raw && (raw.description || raw.descriptionText))
    };
    if (raw && raw.detailItems) listing.detailItems = raw.detailItems;
    if (raw && raw.contactInfo) listing.contactInfo = raw.contactInfo;
    if (raw && raw.nearby) listing.nearby = raw.nearby;
    if (raw && raw.imageUrls) listing.imageUrls = raw.imageUrls;
    if (raw && raw.rawListing) listing.rawListing = raw.rawListing;
    return attachPageSnapshot(listing, raw);
  }

  function fallbackId(prefix, listing) {
    return prefix + (listing.listingId || 'current-page');
  }

  function buildIntakePayload(options) {
    var listing = options.listing;
    var tenantDisplayName = cleanText(options.tenantDisplayName) || '591 LINE 租客(模擬)';
    var landlordDisplayName = cleanText(options.landlordDisplayName) || '591 屋主(模擬)';
    return {
      listing: listing,
      tenantIdentity: {
        lineUserId: fallbackId('mock-591-tenant-', listing),
        displayName: tenantDisplayName
      },
      landlordIdentity: {
        lineUserId: fallbackId('mock-591-landlord-', listing),
        displayName: landlordDisplayName
      },
      partnerMetadata: {
        partner: '591',
        integrationMode: INTEGRATION_MODE,
        source: 'chrome_extension',
        capturedAt: new Date().toISOString(),
        liffStatus: 'todo'
      }
    };
  }

  function sanitizeCleanAddress(value) {
    if (!value || typeof value !== 'string') return null;
    var text = stripHtml(value).replace(/^地址[:：\s]*/, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 3 || text.length > 80) return null;

    var forbidden = ['出租', '租金', '面積', '?', '？', '位於', '套房', '雅房', '整層', '辦公', '店面', '車位', '說明', '介紹', '推薦'];
    for (var i = 0; i < forbidden.length; i++) {
      if (text.indexOf(forbidden[i]) !== -1) return null;
    }

    var twRegionRegex = /(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/;
    if (!twRegionRegex.test(text)) return null;

    var addrRegex = /(?:(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)[^\n,()<>{}"'\s]{1,30}(?:市|區|鎮|鄉|村|里|路|街|段|巷|弄|號)?)/;
    var match = text.match(addrRegex);
    if (match) {
      var candidate = match[0].trim();
      for (var j = 0; j < forbidden.length; j++) {
        if (candidate.indexOf(forbidden[j]) !== -1) return null;
      }
      return candidate;
    }
    return null;
  }

  function extractListingFrom591Html(htmlString, pageUrl) {
    var cleanHtml = String(htmlString || '');
    var listingId = listingIdFromUrl(pageUrl);

    var priceMatch = cleanHtml.match(/class=["'][^"']*info-price-num[^"']*["'][^>]*>\s*([\d,]+)\s*</i) ||
                     cleanHtml.match(/class=["'][^"']*info-price[^"']*["'][^>]*>[\s\S]{0,300}?class=["'][^"']*(?:price-num|price)[^"']*["'][^>]*>\s*([\d,]+)\s*</i) ||
                     cleanHtml.match(/class=["'][^"']*(?:price-num|rental-price)[^"']*["'][^>]*>\s*([\d,]+)\s*</i) ||
                     cleanHtml.match(/(?:月租|租金)[:：\s]*([\d,]+)\s*元?/i) ||
                     cleanHtml.match(/([\d,]+)\s*元\s*\/\s*月/i);
    var parsedPrice = priceMatch ? parsePrice(priceMatch[1]) : null;

    var addrMatch = cleanHtml.match(/class=["'][^"']*(?:address|info-addr-content|info-addr|load-map)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|a)>/i) ||
                    cleanHtml.match(/(?:name|property)=["'](?:og:street-address|location)["']\s+content=["']([^"']+)["']/i);

    var rawAddress = addrMatch ? sanitizeCleanAddress(addrMatch[1]) : null;
    if (!rawAddress) {
      var descMatch = cleanHtml.match(/(?:name|property)=["']description["']\s+content=["']([^"']+)["']/i);
      if (descMatch) rawAddress = sanitizeCleanAddress(descMatch[1]);
    }
    if (!rawAddress) {
      var twAddrMatch = cleanHtml.match(/(?:(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|屏東縣)[^\n,()<>{}"'\s]{1,30}(?:市|區|鎮|鄉|村|里|路|街|段|巷|弄|號)?)/);
      if (twAddrMatch) rawAddress = sanitizeCleanAddress(twAddrMatch[0]);
    }

    var titleMatch = cleanHtml.match(/<title>([^<]+)<\/title>/i);
    var title = titleMatch ? cleanText(titleMatch[1].replace(/-?\s*591.*/i, '')) : null;

    var extractedAmenities = extractActiveAmenitiesFromHtml(cleanHtml);

    var imgUrls = [];
    var imgMatches = cleanHtml.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
    imgMatches.forEach(function(tag) {
      var srcMatch = tag.match(/src=["']([^"']+)["']/i);
      if (srcMatch && srcMatch[1]) {
        var norm = normalizeImageUrl(srcMatch[1]);
        if (norm && imgUrls.indexOf(norm) === -1) imgUrls.push(norm);
      }
    });

    return normalizeListingFromPage({
      url: pageUrl,
      listingId: listingId,
      title: title,
      price: parsedPrice,
      address: rawAddress,
      amenities: extractedAmenities,
      imageUrls: imgUrls,
      bodyText: cleanHtml
    });
  }

  return {
    INTEGRATION_MODE: INTEGRATION_MODE,
    buildIntakePayload: buildIntakePayload,
    compareListingIdentity: compareListingIdentity,
    extractActiveAmenitiesFromHtml: extractActiveAmenitiesFromHtml,
    extractListingFrom591Html: extractListingFrom591Html,
    listingIdFromUrl: listingIdFromUrl,
    mergeImageUrls: mergeImageUrls,
    normalizeListingFrom591NuxtContext: normalizeListingFrom591NuxtContext,
    normalizeListingFromPage: normalizeListingFromPage,
    parsePrice: parsePrice,
    waitForMatching591Context: waitForMatching591Context
  };
});
