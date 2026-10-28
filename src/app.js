require('dotenv').config();

const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');


for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  if (process.env[key] && process.env[key].includes('127.0.0.1:9')) {
    delete process.env[key];
  }
}

const { config } = require('./lineClient');
require('./db');

const { handleWebhook } = require('./handlers/cleanWebhookHandler');
const adminRoutes = require('./routes/adminRoutes');
const healthRoutes = require('./routes/healthRoutes');
const partner591Routes = require('./routes/partner591Routes');
const legacyPartnerListingRoutes = require('./routes/legacyPartnerListingRoutes');
const webRoutes = require('./routes/webRoutes');
const guidedPreInspectionRoutes = require('./routes/guidedPreInspectionRoutes');
const preInspectionWebRoutes = require('./routes/preInspectionWebRoutes');
const repairWebRoutes = require('./routes/repairWebRoutes');
const { createTenantInquiryRoutes } = require('./routes/tenantInquiryRoutes');
const { createLandlordManageRoutes } = require('./routes/landlordManageRoutes');
const { createV2ContractRoutes } = require('./routes/v2ContractRoutes');
const { startReminderWorker } = require('./services/reminderWorkerService');
const { assertSharedStorageConfigured } = require('./services/fileStorage');

const app = express();
// ngrok / cloud ingress terminates HTTPS before forwarding to Express. Trust exactly
// that first proxy hop so req.secure is true and LIFF session cookies keep Secure.
app.set('trust proxy', 1);
const port = Number(process.env.PORT) || 3000;
const hasLineCredentials = Boolean(config.channelAccessToken && config.channelSecret);

// 合約簽章證據的存放位置在 mysql 模式下必須明確設定。原本要等到房客填完表單、
// 錄完影、按下送出的那一刻才會發現漏設定,整份輸入全部白做。這裡在啟動時就擋下來。
// 同理:共用資料庫配上本機檔案,要等到別人打不開照片才會發現,所以一起擋。
let v2ContractRouter;
try {
  assertSharedStorageConfigured();
  v2ContractRouter = createV2ContractRoutes();
} catch (error) {
  console.error(`\n[啟動中止] ${error.message}\n`);
  process.exit(1);
}

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// LINE signature validation must run before any mounted web route can parse
// the request body. Otherwise the raw body is consumed and every valid LINE
// webhook incorrectly fails signature verification.
if (hasLineCredentials) {
  app.post('/webhook', line.middleware(config), handleWebhook);
  app.post('/', line.middleware(config), handleWebhook);
} else {
  const webhookDisabledHandler = (req, res) => {
    res.status(503).json({
      ok: false,
      error: 'LINE webhook is disabled because channel credentials are not configured'
    });
  };

  app.post('/webhook', webhookDisabledHandler);
  app.post('/', webhookDisabledHandler);
}

app.use(healthRoutes);
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.use(partner591Routes);
app.use(legacyPartnerListingRoutes);
app.use(adminRoutes);
app.use(v2ContractRouter);
app.use(webRoutes);
// Must precede the legacy :publicId detail route so /capture stays an editable tenant flow.
app.use(guidedPreInspectionRoutes);
app.use(preInspectionWebRoutes);
app.use(repairWebRoutes);
app.use(createTenantInquiryRoutes());
app.use(createLandlordManageRoutes());

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(err.statusCode || 500).json({
    ok: false,
    error: err.message || 'Internal Server Error'
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`LINE contract proof MVP listening on port ${port}`);
  });
  startReminderWorker();
}

module.exports = app;
