const { withV2Driver } = require('../database/v2Driver');
const { createLandlordReportLineServiceAsync } = require('./landlordReportLineServiceAsync');

// 每次呼叫都經過 withV2Driver 取一條、跑完歸還
function driverBackedService() {
  const call = (method) => (input) => withV2Driver(
    (db) => createLandlordReportLineServiceAsync({ db })[method](input)
  );
  return { handleText: call('handleText'), handlePostback: call('handlePostback') };
}

function getConfiguredLandlordReportService() {
  return driverBackedService();
}

module.exports = { getConfiguredLandlordReportService };