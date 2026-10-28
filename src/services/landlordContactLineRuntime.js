const { withV2Driver } = require('../database/v2Driver');
const { createLandlordContactLineServiceAsync } = require('./landlordContactLineServiceAsync');

// 每次呼叫都經過 withV2Driver 取一條、跑完歸還
function driverBackedService() {
  const call = (method) => (input) => withV2Driver(
    (db) => createLandlordContactLineServiceAsync({ db })[method](input)
  );
  return { handleText: call('handleText'), handlePostback: call('handlePostback') };
}

function getConfiguredLandlordContactService() {
  return driverBackedService();
}

module.exports = { getConfiguredLandlordContactService };
