const TARGET_ENV = {
  menu_A: 'LINE_RICH_MENU_A_ID',
  menu_B: 'LINE_RICH_MENU_B_ID',
  menu_C: 'LINE_RICH_MENU_C_ID',
  landlord: 'LINE_RICH_MENU_LANDLORD_ID',
  owner: 'LINE_RICH_MENU_LANDLORD_ID',
  tenant: 'LINE_RICH_MENU_TENANT_ID',
  contract: 'LINE_RICH_MENU_CONTRACT_ID',
  contracts: 'LINE_RICH_MENU_CONTRACT_ID',
};

const TARGET_FALLBACK = {
  landlord: 'menu_A',
  owner: 'menu_A',
  tenant: 'menu_B',
  contract: 'menu_C',
  contracts: 'menu_C',
};

const TARGET_LABEL = {
  menu_A: '房東功能',
  menu_B: '房客功能',
  menu_C: '合約功能',
  landlord: '房東選單',
  owner: '房東選單',
  tenant: '房客選單',
  contract: '合約選單',
  contracts: '合約選單',
};

function postbackParams(event) {
  return new URLSearchParams(String(event && event.postback && event.postback.data || ''));
}

function postbackData(event) {
  return String(event && event.postback && event.postback.data || '');
}

function richMenuIdForTarget(target) {
  if (!target) return null;
  if (String(target).startsWith('richmenu-')) return String(target);
  const envName = TARGET_ENV[target] || `LINE_RICH_MENU_${String(target).toUpperCase()}_ID`;
  const fallbackEnvName = TARGET_ENV[TARGET_FALLBACK[target]];
  return process.env[envName] || (fallbackEnvName && process.env[fallbackEnvName]) || null;
}

async function resolveRichMenuIdForTarget(target, lineClient) {
  const configuredValue = richMenuIdForTarget(target);
  if (!configuredValue) return null;
  if (String(configuredValue).startsWith('richmenu-')) return configuredValue;

  if (!lineClient || typeof lineClient.getRichMenuAlias !== 'function') {
    const error = new Error(`Rich menu alias ${configuredValue} cannot be resolved by this LINE client.`);
    error.code = 'RICH_MENU_ALIAS_UNSUPPORTED';
    error.aliasId = configuredValue;
    throw error;
  }

  const alias = await lineClient.getRichMenuAlias(configuredValue);
  if (!alias || !alias.richMenuId) {
    const error = new Error(`Rich menu alias ${configuredValue} did not return a richMenuId.`);
    error.code = 'RICH_MENU_ALIAS_EMPTY';
    error.aliasId = configuredValue;
    throw error;
  }
  return alias.richMenuId;
}

function targetLabel(target) {
  return TARGET_LABEL[target] || target || '指定選單';
}

async function handleRichMenuSwitchPostback(event, lineClient) {
  const rawData = postbackData(event);
  const params = postbackParams(event);
  if (params.get('action') !== 'switch_menu' && rawData !== 'switch_menu') {
    return { handled: false, message: null };
  }

  const target = params.get('target') || params.get('menu') || params.get('to');
  const userId = event && event.source && event.source.userId;
  if (!target) {
    return {
      handled: true,
      message: '這個選單切換按鈕缺少 target，請把 postback data 設成 action=switch_menu&target=menu_A。',
    };
  }
  if (!userId) {
    return {
      handled: true,
      message: 'LINE 沒有帶入使用者 ID，暫時無法切換你的個人選單。',
    };
  }

  let richMenuId;
  try {
    richMenuId = await resolveRichMenuIdForTarget(target, lineClient);
  } catch (error) {
    console.error('Failed to resolve rich menu alias:', error && error.message ? error.message : error);
    return {
      handled: true,
      message: `無法解析 ${targetLabel(target)} 的 rich menu alias（${error.aliasId || richMenuIdForTarget(target)}）。請確認 LINE 後台已建立 alias，或把 .env 改成 richmenu- 開頭的 ID。`,
    };
  }
  if (!richMenuId) {
    return {
      handled: true,
      message: `尚未設定 ${targetLabel(target)} 的 rich menu ID 或 alias，請在 .env 加上對應的 LINE_RICH_MENU_*_ID。`,
    };
  }

  if (!lineClient || typeof lineClient.linkRichMenuToUser !== 'function') {
    return {
      handled: true,
      message: '目前的 LINE client 不支援 rich menu 切換，請確認 @line/bot-sdk 版本與 token 設定。',
    };
  }

  // 這裡原本是裸的 await。LINE 回 404 richmenu not found(.env 的 ID 被刪掉、
  // 或指到別的 channel)時例外會一路往上丟,cleanWebhookHandler 只印
  // 「Failed to handle LINE event」就結束——連回覆都不會送出,使用者按什麼都沒反應,
  // 而且看不出是選單的問題。2026-08-25 實測就是這樣,每一則訊息都中斷。
  //
  // 選單切換是附帶效果,不該有權力終止整個事件。失敗就照實說,流程繼續。
  try {
    await lineClient.linkRichMenuToUser(userId, richMenuId);
  } catch (error) {
    const status = error?.statusCode || error?.originalError?.response?.status;
    console.error('[richMenuSwitch] 切換失敗', { target, richMenuId, status, message: error?.message });
    return {
      handled: true,
      message: status === 404
        ? `切換${targetLabel(target)}失敗:這個圖文選單在 LINE 上已經不存在。請用 GET /v2/bot/richmenu/list 查現有的 ID,更新 .env 的 LINE_RICH_MENU_*_ID。`
        : `切換${targetLabel(target)}時發生錯誤,請稍後再試。`,
    };
  }

  return {
    handled: true,
    message: `已切換到${targetLabel(target)}。`,
  };
}

module.exports = {
  handleRichMenuSwitchPostback,
  richMenuIdForTarget,
  resolveRichMenuIdForTarget,
};
