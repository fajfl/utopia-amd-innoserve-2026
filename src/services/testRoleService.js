const userTestRoles = new Map();

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
  findTestLandlordLineUserId
};
