const userTestRoles = new Map();
// shortcut: 單機測試角色只存記憶體；改成多程序部署前需共用儲存。
const activeSelections = new Map();
const { AsyncLocalStorage } = require('node:async_hooks');
const requestRole = new AsyncLocalStorage();

function singlePhoneEnabled(env = process.env) {
  return env.SINGLE_PHONE_TEST_MODE === 'true' && ['development', 'test'].includes(env.NODE_ENV);
}

function getActiveRole(lineUserId) {
  if (!singlePhoneEnabled()) return null;
  const scope = requestRole.getStore();
  return (scope?.lineUserId === lineUserId ? scope.role : activeSelections.get(lineUserId)?.role) || null;
}

function selectRole(lineUserId, role, timestamp = Date.now()) {
  if (!singlePhoneEnabled() || !lineUserId || !['tenant', 'landlord'].includes(role)) return null;
  const time = Number.isFinite(timestamp) ? timestamp : Date.now();
  if (time >= (activeSelections.get(lineUserId)?.time || 0)) {
    const previousRole = activeSelections.get(lineUserId)?.role || null;
    activeSelections.set(lineUserId, { role, time });
    const scope = requestRole.getStore();
    if (scope?.lineUserId === lineUserId) scope.role = role;
    const diagnostics = require('./localDiagnosticsService');
    diagnostics.record('role.selected', { actor: diagnostics.actorRef(lineUserId), previousRole, role });
  }
  return activeSelections.get(lineUserId)?.role;
}

function withActiveRole(lineUserId, work) {
  return requestRole.run({ lineUserId, role: singlePhoneEnabled() ? activeSelections.get(lineUserId)?.role || null : null }, work);
}

function roleForMenu(target) {
  if (['landlord', 'owner', 'menu_A'].includes(target)) return 'landlord';
  if (['tenant', 'menu_B'].includes(target)) return 'tenant';
  return null;
}

function roleMiddleware(req, res, next) {
  if (!singlePhoneEnabled()) return next();
  const lineUserId = require('./liffSessionService').readSession(req);
  if (!lineUserId) return next();
  if (req.method === 'GET') {
    if (['/landlordManage', '/landlord/tasks', '/liff/repair-entry/landlord'].includes(req.path)) selectRole(lineUserId, 'landlord');
    if (['/findHouses', '/rentalNotification', '/preInspectionList', '/liff/repair-entry/tenant'].includes(req.path) || /^\/tenant\/repairs(?:\/|$)/.test(req.path)) selectRole(lineUserId, 'tenant');
  }
  return withActiveRole(lineUserId, () => {
    const role = getActiveRole(lineUserId);
    if (role) {
      res.setHeader('X-Test-Role', role);
      res.setHeader('Cache-Control', 'private, no-store');
      const pathRole = /^\/v2\/api\/(tenant|landlord)\//.exec(req.path)?.[1];
      if (pathRole && pathRole !== role) return res.status(409).json({ error: '測試角色已切換，請回目前角色的頁面繼續操作。' });
    }
    next();
  });
}

function handleRoleSelection(req, res) {
  if (!singlePhoneEnabled()) return res.sendStatus(404);
  const lineUserId = require('./liffSessionService').readSession(req);
  if (!lineUserId) return res.sendStatus(401);
  if (!['tenant', 'landlord'].includes(req.body?.role)) return res.status(400).json({ error: '請選擇房客或房東' });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ role: selectRole(lineUserId, req.body.role) });
}

function setTestRole(lineUserId, role) {
  userTestRoles.set(lineUserId, role);
}

function getTestRole(lineUserId) {
  return userTestRoles.get(lineUserId);
}

function findTestLandlordLineUserId() {
  for (const [userId, role] of userTestRoles.entries()) {
    if (role === 'landlord') {
      return userId;
    }
  }
  return null;
}

module.exports = {
  setTestRole,
  getTestRole,
  findTestLandlordLineUserId,
  singlePhoneEnabled, getActiveRole, selectRole, withActiveRole, roleForMenu, roleMiddleware, handleRoleSelection
};
