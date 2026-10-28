const { withV2Driver } = require('../database/v2Driver');
const { findOrCreateLineUser } = require('../repositories/v2InquiryRepositoryAsync');
const { client } = require('../lineClient');

const BOOTSTRAP_EVENT_TYPES = new Set(['follow', 'message', 'postback']);

// Only called when we create a row or fill a missing cached name, so a blocked
// or unknown profile never costs an API call for every message.
async function fetchDisplayName(lineUserId) {
  if (typeof client.getProfile !== 'function') return null;
  try {
    const profile = await client.getProfile(lineUserId);
    return (profile && profile.displayName) || null;
  } catch (error) {
    console.error('[v2IdentityBootstrap] profile lookup failed:', error.message);
    return null;
  }
}

// Every V2 feature resolves the caller through line_identities. Users who added
// the bot before this existed — or who only ever registered in the legacy
// database — have no row, so they hit "no identity" on every entry point.
// Doing this on any user-sourced event (not just follow) is what backfills them.
//
// 走 withV2Driver,所以 V2_DB_DRIVER=mysql 時身分會建在 TiDB Cloud。這一點很
//重要:合約、房東知識庫、屋況點交切到雲端之後都在雲端查 line_identities,
// 身分若還留在本機 sqlite,那些功能會把使用者當陌生人,或在兩個庫各生一份。
async function ensureV2Identity(event, options = {}) {
  const lineUserId = event && event.source && event.source.userId;
  if (!lineUserId || !BOOTSTRAP_EVENT_TYPES.has(event.type)) return null;

  const withDriver = options.withDriver || withV2Driver;

  const existing = await withDriver((db) => db.get(
    'SELECT id, user_id, display_name_cache FROM line_identities WHERE line_user_id = ?',
    [lineUserId]
  ));
  if (existing && existing.display_name_cache) {
    return { userId: existing.user_id, lineIdentityId: existing.id, created: false };
  }

  // 刻意在取得連線**之前**打 LINE API。getProfile 是外部呼叫,握著連線池的
  // 連線等網路回應,在尖峰時會把連線池吃光。舊身分若沒有名稱,也在這裡補齊。
  const displayName = await (options.fetchDisplayName || fetchDisplayName)(lineUserId);

  const identity = await withDriver((db) => findOrCreateLineUser(db, { lineUserId, displayName }));
  if (identity.created) {
    console.log('[v2IdentityBootstrap] created V2 identity for a LINE user (identity id %s)', identity.lineIdentityId);
  }
  return identity;
}

module.exports = { ensureV2Identity };
