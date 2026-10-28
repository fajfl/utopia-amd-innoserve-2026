(function injectEcsNeoEntry() {
  if (window.__ecsNeo591Injected) return;
  if (!/rent\.591\.com\.tw/i.test(window.location.hostname)) return;

  window.__ecsNeo591Injected = true;

  var adapter = window.EcsNeo591Adapter;
  var API_BASE_KEY = 'ecsNeoPartnerApiBase';
  var DEFAULT_API_BASE = 'http://localhost:3000';
  var NUXT_REQUEST_TYPE = 'ECS_NEO_591_NUXT_REQUEST';
  var NUXT_RESPONSE_TYPE = 'ECS_NEO_591_NUXT_RESPONSE';

  function cleanText(value) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    return text || null;
  }

  function clippedText(value, maxLength) {
    var textValue = cleanText(value);
    if (!textValue) return null;
    return textValue.length > maxLength ? textValue.slice(0, maxLength) + ' ...[truncated]' : textValue;
  }

  function metaTags() {
    return Array.from(document.querySelectorAll('meta'))
      .map(function map(node) {
        return {
          name: cleanText(node.getAttribute('name') || node.getAttribute('property')),
          content: cleanText(node.getAttribute('content'))
        };
      })
      .filter(function filter(item) { return item.name && item.content; })
      .slice(0, 80);
  }

  function metaContent(key) {
    var metas = metaTags();
    var found = metas.find(function find(item) {
      return item.name === key || item.name === 'og:' + key;
    });
    return found ? found.content : null;
  }

  function structuredData() {
    var values = [];
    Array.from(document.querySelectorAll('script[type="application/ld+json"]')).forEach(function each(script) {
      try {
        values.push(JSON.parse(script.textContent || 'null'));
      } catch {
        // Ignore malformed third-party structured data.
      }
    });
    return values.slice(0, 20);
  }

  function collectImageUrls() {
    var urls = Array.from(document.images || [])
      .map(function map(image) {
        var url = image.getAttribute('data-src') || image.dataset.src || image.currentSrc || image.src;
        if (url && String(url).indexOf('data:') === 0) return null;
        return url;
      })
      .filter(Boolean);
    structuredData().forEach(function inspect(data) {
      var items = Array.isArray(data) ? data : [data];
      items.forEach(function each(item) {
        if (!item) return;
        if (Array.isArray(item.image)) urls = urls.concat(item.image);
        else if (item.image) urls.push(item.image);
      });
    });
    return urls.filter(function unique(url, index) { return urls.indexOf(url) === index; }).slice(0, 80);
  }

  function listingHintsFromStructuredData() {
    var hint = {};
    structuredData().some(function inspect(data) {
      var items = Array.isArray(data) ? data : [data];
      return items.some(function each(item) {
        if (!item || typeof item !== 'object') return false;
        if (item['@type'] !== 'Product' && item['@type'] !== 'House' && item['@type'] !== 'Apartment') return false;
        hint.titleText = cleanText(item.name);
        hint.descriptionText = cleanText(item.description);
        if (item.offers && typeof item.offers === 'object') {
          hint.priceText = cleanText(item.offers.price || item.offers.lowPrice || item.offers.priceSpecification && item.offers.priceSpecification.price);
        }
        return true;
      });
    });
    return hint;
  }

  function isInsideRecommendedContainer(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest('[class*="recommend"], [class*="suggest"], [class*="similar"], [class*="other"], [class*="relate"], [class*="history"], .recommend-list, .other-house'));
  }

  function extractPriceFromDomAndMeta() {
    var primarySelectors = ['.info-price-num', '.info-price .price-num', '.house-price .price-num', '.main-price .price-num', '.info-price'];
    for (var i = 0; i < primarySelectors.length; i++) {
      var primaryNodes = document.querySelectorAll(primarySelectors[i]);
      for (var j = 0; j < primaryNodes.length; j++) {
        if (isInsideRecommendedContainer(primaryNodes[j])) continue;
        var primaryText = cleanText(primaryNodes[j].innerText || primaryNodes[j].textContent);
        if (primaryText && /[\d,]+/.test(primaryText) && primaryText.indexOf('面議') === -1 && primaryText.indexOf('押金') === -1) {
          var matchPrimary = primaryText.match(/[\d,]+/);
          if (matchPrimary) return matchPrimary[0];
        }
      }
    }

    var fallbackSelectors = ['.price-num', '.rental-price'];
    for (var k = 0; k < fallbackSelectors.length; k++) {
      var fallbackNodes = document.querySelectorAll(fallbackSelectors[k]);
      for (var l = 0; l < fallbackNodes.length; l++) {
        if (isInsideRecommendedContainer(fallbackNodes[l])) continue;
        var fallbackText = cleanText(fallbackNodes[l].innerText || fallbackNodes[l].textContent);
        if (fallbackText && /[\d,]+/.test(fallbackText) && fallbackText.indexOf('面議') === -1 && fallbackText.indexOf('押金') === -1) {
          var matchFallback = fallbackText.match(/[\d,]+/);
          if (matchFallback) return matchFallback[0];
        }
      }
    }

    var textSources = [metaContent('description'), document.title];
    for (var m = 0; m < textSources.length; m++) {
      var src = String(textSources[m] || '');
      var matchRent = src.match(/(?:月租|租金)[:：\s]*([\d,]+)\s*元?/i) ||
                      src.match(/([\d,]+)\s*元\s*\/\s*月/i);
      if (matchRent) return matchRent[1];
    }
    return null;
  }

  function sanitizeCleanAddress(value) {
    if (!value || typeof value !== 'string') return null;
    var text = value.replace(/^地址[:：\s]*/, '').replace(/\s+/g, ' ').trim();
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

  function extractAddressFromDomAndMeta() {
    var selectors = ['.address', '.load-map', '.info-addr-content', '.info-addr', '[class*="address"]', '[class*="addr"]'];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var text = cleanText(nodes[j].innerText || nodes[j].textContent);
        var cleaned = sanitizeCleanAddress(text);
        if (cleaned) return cleaned;
      }
    }
    var textSources = [metaContent('og:street-address'), metaContent('location'), metaContent('description'), document.title, document.body ? document.body.innerText : ''];
    for (var k = 0; k < textSources.length; k++) {
      var cleanedMeta = sanitizeCleanAddress(textSources[k]);
      if (cleanedMeta) return cleanedMeta;
    }
    return null;
  }

  function extractActiveAmenitiesFromDomOrHtml(fullHtml) {
    // 591's current SSR payload contains the complete supplied-equipment list,
    // while the hydrated DOM can expose only the first visible item. Prefer the
    // serialized result before treating DOM nodes as a fallback.
    var serializedAmenities = (adapter && typeof adapter.extractActiveAmenitiesFromHtml === 'function')
      ? adapter.extractActiveAmenitiesFromHtml(fullHtml)
      : [];
    if (serializedAmenities.length >= 3) {
      return serializedAmenities;
    }

    if (typeof document !== 'undefined' && document.body) {
      var activeFromDom = [];
      var knownEquipment = ['冰箱', '洗衣機', '電視', '冷氣', '熱水器', '床', '衣櫃', '第四台', '網路', '天然瓦斯', '沙發', '桌椅', '陽台', '電梯', '車位', '微波爐', '飲水機', '洗碗機', '烘衣機', '瓦斯爐', '抽油煙機'];
      var disabledTokens = ['no', 'del', 'disabled', 'grey', 'gray', 'off', 'is-disabled', 'line-through', 'is-off', 'not-provided'];

      var itemNodes = document.querySelectorAll('.service-facility .facility-item, .facility-item, .service-item, [class*="facility-item"], [class*="service-item"], .facility dl');
      if (itemNodes && itemNodes.length > 0) {
        itemNodes.forEach(function(node) {
          var text = cleanText(node.innerText || node.textContent || '');
          knownEquipment.forEach(function(name) {
            if (text.indexOf(name) !== -1) {
              var isDel = Boolean(node.querySelector('del, s, strike') || (node.closest && node.closest('del, s, strike')));
              var classList = Array.from(node.classList || []);
              if (node.parentElement && node.parentElement.classList) {
                classList = classList.concat(Array.from(node.parentElement.classList));
              }
              var isDisabled = isDel || classList.some(function(c) {
                return disabledTokens.indexOf(String(c).toLowerCase().trim()) !== -1;
              });
              if (!isDisabled && activeFromDom.indexOf(name) === -1) {
                activeFromDom.push(name);
              }
            }
          });
        });
      }

      if (activeFromDom.length > 0) {
        return activeFromDom;
      }

      // Fallback: search through script tags for embedded JSON state (bypasses lazy DOM hydration)
      var scripts = document.querySelectorAll('script');
      var jsonText = '';
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent || '';
        if (text.indexOf('window.__NUXT__') !== -1 || text.indexOf('"facility"') !== -1 || text.indexOf('"service"') !== -1) {
          jsonText += ' ' + text;
        }
      }

      if (jsonText) {
        var activeFromJson = [];
        knownEquipment.forEach(function(name) {
          var nameRegex = new RegExp('\\{[^}]*"name"\\s*:\\s*"' + name + '"[^}]*\\}', 'g');
          var matches = jsonText.match(nameRegex);
          if (matches) {
            matches.forEach(function(m) {
              if (m.indexOf('"active":1') !== -1 || m.indexOf('"active":"1"') !== -1 || m.indexOf('"active":true') !== -1 || m.indexOf('"is_active":1') !== -1 || m.indexOf('"isActive":1') !== -1) {
                if (activeFromJson.indexOf(name) === -1) activeFromJson.push(name);
              }
            });
          }
        });

        if (activeFromJson.length > 0) {
          return activeFromJson;
        }
      }
    }

    return serializedAmenities;
  }

  function collectGenericPageSnapshot() {
    var bodyText = clippedText(document.body ? document.body.innerText : '', 60000);
    var structuredHint = listingHintsFromStructuredData();
    var domPrice = extractPriceFromDomAndMeta();
    var domAddress = extractAddressFromDomAndMeta();
    var fullHtml = document.documentElement ? document.documentElement.outerHTML : '';
    var domAmenities = extractActiveAmenitiesFromDomOrHtml(fullHtml);
    return Object.assign({
      url: window.location.href,
      pageTitle: cleanText(document.title),
      titleText: structuredHint.titleText || cleanText(document.title),
      metaDescription: metaContent('description'),
      descriptionText: structuredHint.descriptionText || (bodyText ? bodyText.slice(0, 4000) : null),
      priceText: structuredHint.priceText || domPrice,
      addressText: domAddress,
      address: domAddress,
      amenities: domAmenities,
      bodyText: bodyText,
      metaTags: metaTags(),
      structuredData: structuredData(),
      imageUrls: collectImageUrls()
    }, structuredHint);
  }

  function requestNuxtListingContext() {
    return new Promise(function request(resolve) {
      var requestId = 'ecs-neo-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var settled = false;
      var timer = window.setTimeout(function onTimeout() {
        finish(null);
      }, 350);

      function finish(value) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(value || null);
      }

      function onMessage(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (!event.data || event.data.type !== NUXT_RESPONSE_TYPE) return;
        if (event.data.requestId !== requestId) return;
        finish(event.data.context);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({ type: NUXT_REQUEST_TYPE, requestId: requestId }, window.location.origin);
    });
  }

  async function collectListing() {
    var pageUrl = window.location.href;
    var nuxtResult = await adapter.waitForMatching591Context({
      pageUrl: pageUrl,
      timeoutMs: 3000,
      intervalMs: 150,
      readContext: requestNuxtListingContext
    });
    if (nuxtResult.status === 'mismatch') {
      throw new Error('591 房源頁仍在切換，請稍後再試。');
    }
    if (window.location.href !== pageUrl) {
      throw new Error('591 房源頁已切換，請在新房源載入後再試。');
    }

    var snapshot = collectGenericPageSnapshot();
    console.log('[ECS-NEO DIAG] snapshot.amenities:', JSON.stringify(snapshot.amenities));

    var ctx = nuxtResult.status === 'match' ? nuxtResult.context : null;
    if (ctx) {
      var facilityRaw = (ctx.service && ctx.service.facility) || ctx.facility || ctx.facilities || [];
      console.log('[ECS-NEO DIAG] nuxt status:', nuxtResult.status, 'ctx.service exists:', !!ctx.service, 'facility count:', facilityRaw.length);
      if (facilityRaw.length > 0) {
        console.log('[ECS-NEO DIAG] facility[0]:', JSON.stringify(facilityRaw[0]));
        console.log('[ECS-NEO DIAG] facility active flags:', facilityRaw.map(function(f) { return f.name + ':' + f.active; }).join(', '));
      }
    } else {
      console.log('[ECS-NEO DIAG] nuxt status:', nuxtResult.status, 'no context');
    }

    var listing = ctx
      ? adapter.normalizeListingFrom591NuxtContext(ctx, window.location.href)
      : adapter.normalizeListingFromPage(snapshot);
    console.log('[ECS-NEO DIAG] listing.amenities after normalize:', JSON.stringify(listing.amenities));

    listing = adapter.mergeImageUrls(listing, snapshot.imageUrls);

    var combined = Object.assign({}, snapshot, listing);
    console.log('[ECS-NEO DIAG] combined.amenities after Object.assign:', JSON.stringify(combined.amenities));

    if (Array.isArray(snapshot.amenities) && snapshot.amenities.length > 0) {
      combined.amenities = snapshot.amenities;
      console.log('[ECS-NEO DIAG] restored snapshot.amenities:', JSON.stringify(combined.amenities));
    }

    // The hydrated 591 DOM can contain a partial facility list. Always verify
    // amenities against the same-page SSR response before submitting intake.
    // Images still use this fetch only as a fallback to avoid unnecessary work.
    var shouldFetchSsr = true;
    if (shouldFetchSsr) {
      try {
        console.log('[ECS-NEO DIAG] Verifying amenities against SSR HTML');
        var res = await fetch(window.location.href, {
          cache: 'no-store',
          credentials: 'same-origin'
        });
        var text = await res.text();

        var fetchedAmenities = adapter.extractActiveAmenitiesFromHtml(text);
        if (fetchedAmenities.length >= 3 || !combined.amenities || combined.amenities.length === 0) {
          combined.amenities = fetchedAmenities;
          console.log('[ECS-NEO DIAG] SSR verified amenities:', JSON.stringify(combined.amenities));
        }

        if (!combined.imageUrls || combined.imageUrls.length === 0) {
          var imgRegex = /<img[^>]+data-src="([^"]+)"/g;
          var match;
          var fetchedImages = [];
          while ((match = imgRegex.exec(text)) !== null) {
            fetchedImages.push(match[1]);
          }
          if (fetchedImages.length > 0) {
            combined.imageUrls = adapter.mergeImageUrls(listing, fetchedImages);
            console.log('[ECS-NEO DIAG] SSR fetched images count:', fetchedImages.length);
          }
        }

        var parser = new DOMParser();
        var ssrDoc = parser.parseFromString(text, 'text/html');

        if (combined.price == null) {
          var ssrPrice = adapter.parsePrice(cleanText(ssrDoc.querySelector('.price, .rent-price, .info-price-text, [class*="price"], .c-price')));
          if (ssrPrice) {
            combined.price = ssrPrice;
            console.log('[ECS-NEO DIAG] SSR fetched price:', combined.price);
          }
        }
        if (!combined.address) {
          var ssrAddr = cleanText(ssrDoc.querySelector('.address, .location, .info-addr-content, [class*="address"]'));
          if (ssrAddr) combined.address = ssrAddr;
        }
        if (!combined.rooms) {
          var ssrRooms = cleanText(ssrDoc.querySelector('.room-info, .info-rooms, [class*="room"]'));
          if (ssrRooms) combined.rooms = ssrRooms;
        }
        if (!combined.floor) {
          var ssrFloor = cleanText(ssrDoc.querySelector('.floor-info, .info-floor, [class*="floor"]'));
          if (ssrFloor) combined.floor = ssrFloor;
        }
      } catch(e) {
        console.log('[ECS-NEO DIAG] SSR fetch failed:', e.message);
      }
    }

    if (!listing.price && snapshot.priceText && !combined.price) {
      combined.price = adapter.parsePrice(snapshot.priceText);
    }
    if (!listing.address && snapshot.addressText && !combined.address) {
      combined.address = snapshot.addressText;
    }

    // Force default values for non-critical fields to prevent backend validation from rejecting the payload
    if (!combined.address) combined.address = '未提供地址';
    if (!combined.rooms) combined.rooms = '未提供房型';
    if (!combined.floor) combined.floor = '未提供樓層';
    if (!combined.rentalType) combined.rentalType = '未提供類型';

    var final = adapter.normalizeListingFromPage(combined);
    console.log('[ECS-NEO DIAG] final.amenities:', JSON.stringify(final.amenities));
    return final;
  }

  function apiBase() {
    return (window.localStorage.getItem(API_BASE_KEY) || DEFAULT_API_BASE).replace(/\/$/, '');
  }

  function setStatus(node, message, isError) {
    node.textContent = message;
    node.className = isError ? 'ecs-neo-591-status error' : 'ecs-neo-591-status';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function qrCodeUrl(value) {
    return 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(value);
  }

  function renderLineEntry(status, result, lineUrl, listing) {
    status.className = 'ecs-neo-591-status ready';
    status.innerHTML = [
      '<div>案件已建立，請用手機掃 QR Code，並在 LINE 送出預填訊息完成綁定。</div>',
      '<div class="ecs-neo-591-hint">本次擷取：設備 ' + escapeHtml((listing.amenities || []).length) + ' 項，照片 ' + escapeHtml((listing.imageUrls || []).length) + ' 張。</div>',
      result.entryCode ? '<div class="ecs-neo-591-code">案件碼 ' + escapeHtml(result.entryCode) + '</div>' : '',
      lineUrl ? '<img class="ecs-neo-591-qr" alt="手機掃描開啟 LINE" src="' + escapeHtml(qrCodeUrl(lineUrl)) + '">' : '',
      lineUrl ? '<div class="ecs-neo-591-hint">手機掃描後會帶入同一筆房源的 LINE 預填訊息。</div>' : ''
    ].join('');
  }

  async function handleClick(button, status) {
    button.disabled = true;
    setStatus(status, '正在建立 ECS NEO 案件...', false);

    try {
      var listing = await collectListing();
      var payload = adapter.buildIntakePayload({
        listing: listing,
        tenantDisplayName: '591 LINE 租客(模擬)',
        landlordDisplayName: listing.contactInfo && listing.contactInfo.name || '591 頁面屋主(模擬)'
      });
      var response = await fetch(apiBase() + '/api/partner/591/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || '建立案件失敗');
      }
      var lineUrl = result.lineChatUrl;
      renderLineEntry(status, result, lineUrl, listing);
    } catch (error) {
      setStatus(status, error.message || '無法建立 ECS NEO 案件', true);
      button.disabled = false;
    }
  }

  function mount() {
    if (!adapter || document.getElementById('ecs-neo-591-entry')) return;
    var container = document.createElement('aside');
    container.id = 'ecs-neo-591-entry';
    container.innerHTML = [
      '<div class="ecs-neo-591-label">ECS NEO x 591 合作模擬</div>',
      '<button type="button">建立 LINE 房源案件碼</button>',
      '<div class="ecs-neo-591-status">擷取目前房源資料，建立案件碼後顯示手機 QR Code。</div>'
    ].join('');
    document.documentElement.appendChild(container);

    var button = container.querySelector('button');
    var status = container.querySelector('.ecs-neo-591-status');
    button.addEventListener('click', function onClick() {
      handleClick(button, status);
    });
  }

  mount();
})();
