const { withV2Driver } = require('../database/v2Driver');
const { createLandlordKnowledgeLineServiceAsync } = require('./landlordKnowledgeLineServiceAsync');

// 每次呼叫都經過 withV2Driver 取一條、跑完歸還
function driverBackedService() {
  const call = (method) => (input) => withV2Driver(
    (db) => createLandlordKnowledgeLineServiceAsync({ db })[method](input)
  );
  return { handleText: call('handleText'), handlePostback: call('handlePostback') };
}

function getConfiguredLandlordKnowledgeService() {
  return driverBackedService();
}

function resetLandlordKnowledgeRuntimeForTesting() {}

module.exports = {
  getConfiguredLandlordKnowledgeService,
  resetLandlordKnowledgeRuntimeForTesting
};
