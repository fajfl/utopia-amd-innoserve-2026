const { client } = require('../lineClient');
const {
  recordGroupJoin,
  recordGroupLeave,
  savePostback
} = require('../services/archiveService');
const { handleMessageEvent } = require('./cleanMessageHandler');
const { handlePostbackAction } = require('../services/postbackActionService');
const { getConfiguredLandlordKnowledgeService } = require('../services/landlordKnowledgeLineRuntime');
const { getConfiguredLandlordContactService } = require('../services/landlordContactLineRuntime');
const { handleRichMenuSwitchPostback } = require('../services/richMenuSwitchService');
const { getConfiguredDashboardLineService } = require('../services/dashboardLineService');
const { handleTenantFeaturePostback } = require('../services/tenantFeatureLineService');
const { ensureV2Identity } = require('../services/v2IdentityBootstrapService');
const {
  handleConditionPostback,
  isConditionPostback
} = require('../services/ecsNeoConditionLineService');
const {
  handleTenantContractDemoPostback,
  isTenantContractDemoPostback
} = require('../services/tenantContractDemoLineService');

async function handleLandlordContactPostback(event, lineClient, service) {
  const data = event.postback && event.postback.data;
  const action = new URLSearchParams(String(data || '')).get('action');
  if (!action || !(action.startsWith('tenant_message_') || action.startsWith('landlord_contact_'))) return false;
  try {
    const result = await service.handlePostback({
      lineUserId: event.source && event.source.userId,
      data,
    });
    if (result.handled && event.replyToken && result.messages.length) {
      try {
        await lineClient.replyMessage(
          event.replyToken,
          result.messages.length === 1 ? result.messages[0] : result.messages,
        );
      } catch (replyError) {
        console.error('[handleLandlordContactPostback] action:', data);
        console.error('[handleLandlordContactPostback] reply error:', replyError.message);
        if (replyError.originalError && replyError.originalError.response) {
          console.error('[handleLandlordContactPostback] response data:', JSON.stringify(replyError.originalError.response.data, null, 2));
        }

        if (result.fallbackMessages && result.fallbackMessages.length) {
          try {
            await lineClient.replyMessage(
              event.replyToken,
              result.fallbackMessages.length === 1 ? result.fallbackMessages[0] : result.fallbackMessages
            );
          } catch (fbError) {
            console.error('Fallback reply also failed:', fbError.message);
          }
        }
      }
    }
    return result.handled;
  } catch (error) {
    console.error('[Landlord Contact Error]', error);
    if (event.replyToken) {
      await lineClient.replyMessage(event.replyToken, { type: 'text', text: '系統暫時無法載入房客訊息，請稍後再試。' }).catch(e => console.error(e));
    }
    return true; // We handled the error, prevent fallback
  }
  return result.handled;
}

async function handleLandlordKnowledgePostback(event, lineClient, service) {
  const data = event.postback && event.postback.data;
  const action = new URLSearchParams(String(data || '')).get('action');
  if (!action || !action.startsWith('knowledge_')) return false;
  // 同上:mysql 模式回 Promise,沒有 await 會讓 result.handled 變 undefined。
  const result = await service.handlePostback({
    lineUserId: event.source && event.source.userId,
    data,
  });
  if (result.handled && event.replyToken && result.messages.length) {
    await lineClient.replyMessage(
      event.replyToken,
      result.messages.length === 1 ? result.messages[0] : result.messages,
    );
  }
  return result.handled;
}


async function handleDashboardPostback(event, lineClient, service) {
  const data = event.postback && event.postback.data;
  const result = await service.handlePostback({
    lineUserId: event.source && event.source.userId,
    data,
  });
  if (result && result.handled && event.replyToken && result.messages.length) {
    await lineClient.replyMessage(
      event.replyToken,
      result.messages.length === 1 ? result.messages[0] : result.messages,
    );
  }
  return result.handled;
}

const welcomeText = [
  '我是合約協商存證 Bot。',
  '從現在開始，本群組後續傳送的文字與檔案將可被記錄到測試系統。',
  '請雙方先在群組輸入「我是房東」或「我是房客」。',
  '若要填個人資料，請輸入「個人資料」，或至官方帳號／圖文選單開啟個人資料卡。',
  '身分證與信箱是選填，也可以之後在群組輸入「我的身分證是...」或「我的信箱是...」補充。',
  '若你是後加入群組，看不到前面訊息，請輸入「使用說明」或「個人資料」。',
  '若要建立看房提醒，請輸入「看房時間 2026-06-01 14:00」。'
].join('\n');

const memberJoinedText = [
  '歡迎加入租約協商群組。',
  '如果你看不到前面的訊息，請輸入「使用說明」取得目前支援指令。',
  '請先輸入「我是房東」或「我是房客」設定簽署角色，再輸入「個人資料」開啟資料填寫卡。'
].join('\n');

const followText = [
  '歡迎使用 ECS NEO。',
  '',
  '你的帳號已建立完成，可以直接使用下方圖文選單。',
  '若你是從 591 房源頁過來的，請把該頁提供的 8 位數案件碼傳給我，我會幫你帶入那筆房源。',
  '想看已經談過的房源，輸入「找房紀錄」。'
].join('\n');

async function handleEvent(event) {
  // Must run before dispatch: every V2 feature looks the caller up in
  // line_identities, and users who joined before this hook existed have no row.
  try {
    await ensureV2Identity(event);
  } catch (error) {
    console.error('Failed to bootstrap V2 identity:', error.message);
  }

  if (event.type === 'follow') {
    if (event.replyToken) {
      try {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: followText
        });
      } catch (error) {
        console.error('Failed to reply to LINE follow event:', error.message);
      }
    }
    return;
  }

  if (event.type === 'join') {
    const groupId = event.source && event.source.groupId;
    recordGroupJoin(groupId);

    if (event.replyToken) {
      try {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: welcomeText
        });
      } catch (error) {
        console.error('Failed to reply to LINE join event:', error.message);
      }
    }
    return;
  }

  if (event.type === 'memberJoined') {
    if (event.replyToken) {
      try {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: memberJoinedText
        });
      } catch (error) {
        console.error('Failed to reply to LINE memberJoined event:', error.message);
      }
    }
    return;
  }

  if (event.type === 'leave') {
    const groupId = event.source && event.source.groupId;
    recordGroupLeave(groupId);
    return;
  }

  if (event.type === 'message') {
    await handleMessageEvent(event, client);
    return;
  }

  if (event.type === 'postback') {
    const richMenuResult = await handleRichMenuSwitchPostback(event, client);
    if (richMenuResult.handled) {
      if (event.replyToken && richMenuResult.message) {
        try {
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: richMenuResult.message
          });
        } catch (error) {
          console.error('Failed to reply to LINE rich menu switch event:', error.message);
        }
      }
      return;
    }

    if (isTenantContractDemoPostback(event.postback && event.postback.data)) {
      const demoResult = await handleTenantContractDemoPostback({
        lineUserId: event.source && event.source.userId,
        data: event.postback && event.postback.data
      });
      if (demoResult.handled && event.replyToken && demoResult.messages.length) {
        await client.replyMessage(
          event.replyToken,
          demoResult.messages.length === 1 ? demoResult.messages[0] : demoResult.messages
        );
      }
      return;
    }

    // 承租條件的確認／依據／修改。排在其他 postback handler 之前:
    // 確認 exact version 是有法律意義的動作,不能讓別的 handler 順手吃掉。
    if (isConditionPostback(event.postback && event.postback.data)) {
      const conditionResult = await handleConditionPostback({
        lineUserId: event.source && event.source.userId,
        data: event.postback && event.postback.data
      });
      if (conditionResult && conditionResult.handled) {
        if (event.replyToken && conditionResult.messages.length) {
          try {
            await client.replyMessage(
              event.replyToken,
              conditionResult.messages.length === 1 ? conditionResult.messages[0] : conditionResult.messages,
            );
          } catch (error) {
            console.error('Failed to reply to condition postback:', error.message);
          }
        }
        return;
      }
    }

    const dashboardHandled = await handleDashboardPostback(
      event,
      client,
      getConfiguredDashboardLineService(),
    );
    if (dashboardHandled) return;

    const tenantResult = await handleTenantFeaturePostback(event);
    if (tenantResult && tenantResult.handled) {
      if (event.replyToken && tenantResult.messages && tenantResult.messages.length) {
        try {
          await client.replyMessage(event.replyToken, tenantResult.messages);
        } catch (error) {
          console.error('Failed to reply to tenant feature postback, trying fallback:', error.message);
          if (tenantResult.fallbackText) {
            try {
               await client.replyMessage(event.replyToken, { type: 'text', text: tenantResult.fallbackText });
            } catch (fbErr) {
               console.error('Fallback reply also failed:', fbErr.message);
            }
          }
        }
      }
      return;
    }

    if (String(process.env.LANDLORD_KNOWLEDGE_DEMO_ENABLED).toLowerCase() === 'true') {
      const contactHandled = await handleLandlordContactPostback(
        event,
        client,
        getConfiguredLandlordContactService(),
      );
      if (contactHandled) return;

      const knowledgeHandled = await handleLandlordKnowledgePostback(
        event,
        client,
        getConfiguredLandlordKnowledgeService(),
      );
      if (knowledgeHandled) return;
    }

    const postback = savePostback(event);
    const replyText = handlePostbackAction(postback, event);

    if (event.replyToken) {
      try {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: replyText
        });
      } catch (error) {
        console.error('Failed to reply to LINE postback event:', error.message);
      }
    }
  }
}

async function handleWebhook(req, res, next) {
  try {
    await Promise.all((req.body.events || []).map(async (event) => {
      try {
        await handleEvent(event);
      } catch (error) {
        console.error('Failed to handle LINE event:', error.message);
        if (error.response && error.response.data) {
          console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        }
        if (error.originalError && error.originalError.response && error.originalError.response.data) {
          console.error('LINE original error response:', JSON.stringify(error.originalError.response.data, null, 2));
        }
      }
    }));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleDashboardPostback,
  handleLandlordKnowledgePostback,
  handleWebhook
};
