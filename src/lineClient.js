const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

function createUnavailableClient() {
  const error = new Error('LINE channel access token is not configured');

  return {
    replyMessage() {
      return Promise.reject(error);
    },
    pushMessage() {
      return Promise.reject(error);
    },
    linkRichMenuToUser() {
      return Promise.reject(error);
    }
  };
}

const client = config.channelAccessToken && config.channelSecret
  ? new line.Client(config)
  : createUnavailableClient();

// 舊的 line.Client(相容 v7 介面)沒有 loading animation,只有 v9 的
// MessagingApiClient 有。為了一個呼叫不值得把整包 client 換掉,所以只在這裡
// 多開一個 instance —— 兩者共用同一組 credential,沒有額外設定。
const messagingApiClient = config.channelAccessToken
  ? new line.messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken })
  : null;

/**
 * 在一對一聊天室顯示「輸入中」的動畫。
 *
 * 只在真的要等模型的時候用。它不是回覆,收到任何訊息就會自動消失,所以不需要
 * (也沒有辦法)手動關掉。
 *
 * **刻意不 await、也不讓它的失敗往外拋**:這是純粹的體感修飾,多等一個
 * round trip 才開始跑模型是本末倒置,而動畫沒顯示出來也不該讓房客的訊息掉。
 *
 * @param {string} lineUserId 一對一聊天室的對象;群組與聊天室不支援
 * @param {number} [seconds]  5..60,必須是 5 的倍數
 */
function showLoadingAnimation(lineUserId, seconds = 20) {
  if (!messagingApiClient || !lineUserId) return;
  messagingApiClient
    .showLoadingAnimation({ chatId: lineUserId, loadingSeconds: seconds })
    .catch((error) => {
      console.error('LINE loading animation failed:', error && error.message);
    });
}

module.exports = { client, config, showLoadingAnimation };
