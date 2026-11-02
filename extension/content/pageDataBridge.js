(function installEcsNeo591PageDataBridge() {
  var REQUEST_TYPE = 'ECS_NEO_591_NUXT_REQUEST';
  var RESPONSE_TYPE = 'ECS_NEO_591_NUXT_RESPONSE';
  var ALLOWED_KEYS = [
    'id',
    'title',
    'price',
    'deposit',
    'info',
    'costData',
    'linkInfo',
    'positionRound',
    'service',
    'tags',
    'preference',
    'navData',
    'remark',
    'gtm_detail_data',
    'shareInfo'
  ];

  function nuxtContext() {
    try {
      if (!window.__NUXT__) return null;
      var n = window.__NUXT__;

      // Try exact path first (historical)
      if (n.pinia && n.pinia['rent-detail-info'] && n.pinia['rent-detail-info'].ctx) {
        return n.pinia['rent-detail-info'].ctx;
      }

      // Fallback: deep search for a context object
      var found = null;
      var visited = new Set();

      function search(obj) {
        if (found || !obj || typeof obj !== 'object') return;
        if (visited.has(obj)) return;
        visited.add(obj);

        if (obj.info && obj.service && (obj.costData || obj.positionRound || obj.facility)) {
          found = obj;
          return;
        }

        for (var key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            search(obj[key]);
            if (found) return;
          }
        }
      }

      search(n);
      return found;
    } catch (e) {
      return null;
    }
  }

  function safeWhitelistedContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    var selected = {};
    ALLOWED_KEYS.forEach(function copy(key) {
      if (Object.prototype.hasOwnProperty.call(ctx, key)) selected[key] = ctx[key];
    });
    try {
      return JSON.parse(JSON.stringify(selected));
    } catch {
      return null;
    }
  }

  window.addEventListener('message', function onMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== REQUEST_TYPE || !event.data.requestId) return;
    window.postMessage({
      type: RESPONSE_TYPE,
      requestId: event.data.requestId,
      context: safeWhitelistedContext(nuxtContext())
    }, window.location.origin);
  });
})();
