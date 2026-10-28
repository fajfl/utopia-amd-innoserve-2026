const {
  saveBotCommand,
  saveMessage,
  saveRentalListing
} = require('../services/archiveService');
const { buildCommand, isBotCommand } = require('../services/commandService');
const { handleFileMessage } = require('./fileHandler');
const { RENTAL_URL_REGEX, scrapeRentalUrl } = require('../services/rentalScraperService');
const { bindV2EntryToken, parseEntryCodeText, shouldConsumeEntryCode } = require('../services/v2EntryTokenService');
const { getConfiguredLandlordKnowledgeService } = require('../services/landlordKnowledgeLineRuntime');
const { getConfiguredLandlordContactService } = require('../services/landlordContactLineRuntime');
const { isCalendarCommand, handleCalendarCommand } = require('../services/contractCalendarLineService');
const { getConfiguredDashboardLineService, isDashboardCommand } = require('../services/dashboardLineService');
const {
  handleTenantFeatureText,
  isTenantFeatureCommand,
  handleActivePreInspectionSession,
  handleActiveRenewalConditionInput
} = require('../services/tenantFeatureLineService');
const { handleActiveRepairSession, cancelActiveRepairSessionForLineUser } = require('../services/tenantRepairLineService');
const { askListingQuestion, escalateDemoQuestion } = require('../services/tenantInquiryAiService');
const {
  handleConditionText,
  isConditionCommand
} = require('../services/ecsNeoConditionLineService');
const { handleTenantTurn, recordAgentReply } = require('../services/ecsNeoAgentGatewayServiceAsync');
const { showLoadingAnimation } = require('../lineClient');
const { handleTenantContractDemoText } = require('../services/tenantContractDemoLineService');

const TEXT = {
  recorded: '\u5df2\u8a18\u9304\u9019\u5247\u7fa4\u7d44\u8a0a\u606f\u3002'
};

function normalizeNavigationText(text) {
  return String(text || '').trim().replace(/\s+/g, '');
}

function isLandlordKnowledgeCommand(text) {
  return normalizeNavigationText(text) === 'AI\u77e5\u8b58\u5eab';
}

function shouldRouteBeforeRepairSession(text) {
  return isDashboardCommand(text)
    || isTenantFeatureCommand(text)
    || isLandlordKnowledgeCommand(text)
    || isConditionCommand(text)
    // 只有明確寫出「案件碼 12345678」才插隊。光是八碼數字有歧義,把正在報修的
    // 使用者從流程裡拉出來,代價比讓他多打一次前綴大。
    || Boolean((parseEntryCodeText(text) || {}).explicit);
}

async function handleMessageEvent(event, client, options = {}) {
  const message = event.message;
  if (!message) return;

  if (message.type === 'text') {
    const textTrimmed = message.text.trim();
    if (['我是房客', '切換房客'].includes(textTrimmed)) {
      const { setTestRole } = require('../services/testRoleService');
      setTestRole(event.source.userId, 'tenant');
      if (event.replyToken) {
        await client.replyMessage(event.replyToken, { type: 'text', text: '已切換為房客測試模式。' });
      }
      return;
    }
    if (textTrimmed === '產生測試資料' && process.env.ENABLE_LINE_TEST_COMMANDS === 'true') {
      const { withV2Driver } = require('../database/v2Driver');
      const lineUserId = event.source.userId;

      await withV2Driver(async (db) => {
        let identity = await db.get('SELECT id, user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
        if (!identity) {
          await db.run("INSERT INTO users (public_id) VALUES (?)", ['user-' + Date.now()]);
          const user = await db.get("SELECT id FROM users ORDER BY id DESC LIMIT 1");
          await db.run('INSERT INTO line_identities (public_id, user_id, line_user_id) VALUES (?, ?, ?)', ['li-' + Date.now(), user.id, lineUserId]);
          identity = await db.get('SELECT id, user_id FROM line_identities WHERE line_user_id = ?', [lineUserId]);
        }

        const listing = await db.get('SELECT id FROM listings LIMIT 1');
        if (listing) {
          let inquiry = await db.get('SELECT id FROM inquiries WHERE listing_id = ? AND user_id = ?', [listing.id, identity.user_id]);
          if (!inquiry) {
            await db.run('INSERT INTO inquiries (public_id, user_id, listing_id) VALUES (?, ?, ?)', ['inq-' + Date.now(), identity.user_id, listing.id]);
            inquiry = await db.get('SELECT id FROM inquiries ORDER BY id DESC LIMIT 1');
          }
          await db.run('INSERT INTO active_inquiry_contexts (public_id, line_identity_id, inquiry_id) VALUES (?, ?, ?)', ['ctx-' + Date.now(), identity.id, inquiry.id]);

          if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '測試資料產生完畢，已自動綁定到你的 LINE 帳號。' });
          }
        } else {
          if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '資料庫中沒有任何房源可供測試。' });
          }
        }
      });
      return;
    }
    const localDemoCommandEnabled = process.env.ENABLE_LINE_TEST_COMMANDS === 'true'
      || process.env.NODE_ENV === 'development'
      || !process.env.NODE_ENV;
    if (['綁定報修測試', '綁定租約測試'].includes(textTrimmed) && localDemoCommandEnabled) {
      const db = require('../database/v2Database').openV2Database({ dbPath: process.env.V2_DATABASE_PATH || require('node:path').join(__dirname, '..', '..', 'data', 'ecs-neo-v2.sqlite') });
      const lineUserId = event.source.userId;
      const leaseTenant = db.prepare(`
        SELECT
          lp.user_id,
          le.public_id AS lease_public_id,
          COALESCE(ru.unit_label, l.title, 'Demo 租賃單位') AS unit_label
        FROM leases le
        JOIN lease_parties lp ON lp.lease_id = le.id AND lp.party_role = 'tenant'
        JOIN rental_units ru ON ru.id = le.rental_unit_id
        LEFT JOIN listings l ON l.rental_unit_id = ru.id
        WHERE le.status IN ('active', 'scheduled')
          AND (lp.effective_until IS NULL OR lp.effective_until >= date('now'))
        ORDER BY CASE le.status WHEN 'active' THEN 0 ELSE 1 END, le.start_date DESC, le.id DESC
        LIMIT 1
      `).get();

      if (!leaseTenant) {
        if (event.replyToken) {
          await client.replyMessage(event.replyToken, { type: 'text', text: '目前資料庫沒有可綁定的一筆 active demo 租約。請先跑 V2 seed 或確認 leases/lease_parties。' });
        }
        return;
      }

      const identity = db.prepare('SELECT id, user_id FROM line_identities WHERE line_user_id = ?').get(lineUserId);
      if (identity) {
        db.prepare(`
          UPDATE line_identities
          SET user_id = ?,
              display_name_cache = COALESCE(display_name_cache, 'Demo 報修房客'),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(leaseTenant.user_id, identity.id);
      } else {
        db.prepare(`
          INSERT INTO line_identities (public_id, user_id, line_user_id, display_name_cache, profile_synced_at)
          VALUES (?, ?, ?, 'Demo 報修房客', CURRENT_TIMESTAMP)
        `).run('li-repair-demo-' + Date.now(), leaseTenant.user_id, lineUserId);
      }

      if (event.replyToken) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: `已把目前 LINE 帳號綁定到報修 demo 租約：${leaseTenant.unit_label}。\n現在請再輸入「一鍵報修」。`,
        });
      }
      return;
    }
    if (['我是房東', '切換房東'].includes(textTrimmed)) {
      if (event.replyToken) {
        await client.replyMessage(event.replyToken, { type: 'text', text: '房東權限將依據系統房源權屬（property_owners）與 LINE 帳號關聯自動判定。' });
      }
      return;
    }

    if (['查看待確認屋況', '待確認屋況'].includes(textTrimmed)) {
      const { withV2Driver } = require('../database/v2Driver');
      const preInspectionRepository = require('../repositories/preInspectionRepositoryAsync');

      await withV2Driver(async (db) => {
        const pendingSessions = await preInspectionRepository.getLandlordPendingSessions(db, event.source.userId);

        if (pendingSessions && pendingSessions.length > 0) {
          const { preInspectionLandlordCard } = require('../services/preInspectionLinePresenter');
          const cards = [];
          for (const pendingSession of pendingSessions) {
            const stats = await preInspectionRepository.getSessionStats(db, pendingSession.id);
            const context = await preInspectionRepository.getSessionContext(db, pendingSession.id);
            try {
              if (pendingSession.line_user_id) {
                const profile = await client.getProfile(pendingSession.line_user_id);
                if (profile && profile.displayName) {
                  context.tenantName = profile.displayName;
                }
              }
            } catch (e) {
              if (!context.tenantName) context.tenantName = '房客';
            }
            const supplements = await preInspectionRepository.getSupplementSessions(db, pendingSession.id);
            const landlordCard = preInspectionLandlordCard(pendingSession, stats, supplements.length, {
              ...context,
              landlordLineUserId: event.source.userId
            });
            cards.push(landlordCard);
          }

          if (event.replyToken) {
            if (cards.length === 1) {
              await client.replyMessage(event.replyToken, cards[0]);
            } else {
              const carouselMessage = {
                type: 'flex',
                altText: '【串接】入住前屋況紀錄待確認',
                contents: {
                  type: 'carousel',
                  contents: cards.map(c => c.contents)
                }
              };
              await client.replyMessage(event.replyToken, carouselMessage);
            }
          }
        } else {
          if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有待確認的屋況紀錄。' });
          }
        }
      });
      return;
    }

    if (['查看屋況通知', '屋況通知'].includes(textTrimmed)) {
      const { withV2Driver } = require('../database/v2Driver');
      
      await withV2Driver(async (db) => {
        const confirmedSession = await db.get("SELECT * FROM pre_inspection_sessions WHERE confirmation_status = 'landlord_confirmed' AND line_user_id = ? ORDER BY id DESC LIMIT 1", [event.source.userId]);

        if (confirmedSession) {
          if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '房東已查看並確認此入住前屋況紀錄。\n狀態：房東已確認。' });
          }
        } else {
          if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有新的屋況通知。' });
          }
        }
      });
      return;
    }

    const routeBeforeActiveSessions = shouldRouteBeforeRepairSession(message.text);
    if (routeBeforeActiveSessions) {
      cancelActiveRepairSessionForLineUser(event.source && event.source.userId, 'interrupted_by_navigation');
    } else {
      const repairSessionResult = await handleActiveRepairSession(event, 'text', { text: message.text }, client);
      if (repairSessionResult && repairSessionResult.handled) {
        if (event.replyToken && repairSessionResult.messages && repairSessionResult.messages.length) {
          await client.replyMessage(event.replyToken, repairSessionResult.messages);
        }
        return;
      }

      const sessionResult = await handleActivePreInspectionSession(event, 'text', { text: message.text }, client);
      if (sessionResult && sessionResult.handled) {
        if (event.replyToken && sessionResult.messages && sessionResult.messages.length) {
          await client.replyMessage(event.replyToken, sessionResult.messages);
        }
        return;
      }

      const renewalSessionResult = await handleActiveRenewalConditionInput({
        lineUserId: event.source && event.source.userId,
        text: message.text
      });
      if (renewalSessionResult && renewalSessionResult.handled) {
        if (event.replyToken && renewalSessionResult.messages && renewalSessionResult.messages.length) {
          await client.replyMessage(event.replyToken, renewalSessionResult.messages);
        }
        return;
      }
    }

    if (isDashboardCommand(message.text) || options.dashboardService) {
      const dashboardService = options.dashboardService || getConfiguredDashboardLineService();
      const dashboardResult = await dashboardService.handleText({
        lineUserId: event.source && event.source.userId,
        displayName: event.source && event.source.displayName,
        text: message.text,
      });
      if (dashboardResult && dashboardResult.handled) {
        if (event.replyToken && dashboardResult.messages.length) {
          await client.replyMessage(
            event.replyToken,
            dashboardResult.messages.length === 1 ? dashboardResult.messages[0] : dashboardResult.messages,
          );
        }
        return;
      }
    }
    if (process.env.ENABLE_LINE_TEST_COMMANDS === 'true' && message.text && message.text.trim() === '版本檢查') {
      if (event.replyToken) {
        const text = `ECS NEO runtime check\ntime: ${new Date().toISOString()}\npreInspection: line-bot-main-v3`;
        await client.replyMessage(event.replyToken, [{ type: 'text', text }]).catch(error => {
          console.error('Failed to reply to version check command:', error.message);
        });
      }
      return;
    }

    if (['查看最新房東回覆', '最新房東回覆'].includes(message.text.trim())) {
      const { handleTenantNotificationSingle } = require('../services/tenantNotificationService');
      const card = await handleTenantNotificationSingle(event.source && event.source.userId, 'landlord_answer');
      if (card) {
        if (event.replyToken) {
          await client.replyMessage(event.replyToken, [card]).catch(error => {
            console.error('Failed to reply to LINE notification command:', error.message);
          });
        }
        return;
      }
    }

    if (message.text && message.text.trim() === '查看聯絡紀錄') {
      const { getTenantContactHistory } = require('../repositories/v2LandlordContactRepository');
      const { contactHistoryMessage, contactHistoryTextMessage } = require('../services/landlordContactLinePresenter');
      if (event.source && event.source.userId) {
        const historyRows = getTenantContactHistory(v2Db, event.source.userId, 100);
        if (event.replyToken) {
          try {
            await client.replyMessage(event.replyToken, [contactHistoryMessage(historyRows, null, false)]);
          } catch (error) {
            console.error('Failed to reply to tenant contact history command (Flex):', error.message);
            try {
              await client.replyMessage(event.replyToken, [
                { type: 'text', text: '系統暫時無法顯示卡片，已改用文字版聯絡紀錄。' },
                contactHistoryTextMessage(historyRows, null, false)
              ]);
            } catch (fallbackError) {
              console.error('Failed to reply to tenant contact history command (Fallback):', fallbackError.message);
            }
          }
        }
        return;
      }
    }

    if (isCalendarCommand(message.text)) {
      await handleCalendarCommand(event.source.userId, event.replyToken);
      return;
    }

    if (isTenantFeatureCommand(message.text)) {
      const tenantResult = await (options.handleTenantFeatureText || handleTenantFeatureText)({
        lineUserId: event.source && event.source.userId,
        text: message.text,
        lineClient: client,
      });
      if (tenantResult.handled) {
        if (event.replyToken && tenantResult.messages.length) {
          await client.replyMessage(
            event.replyToken,
            tenantResult.messages.length === 1 ? tenantResult.messages[0] : tenantResult.messages,
          );
        }
        return;
      }
    }

    // 承租條件整理。必須排在房東知識庫與 AI 問答之前:那兩條路徑會把任何文字
    // 當成房客的新問題,「條件整理」就會被當成一個要轉問房東的問題。
    if (isConditionCommand(message.text)) {
      const conditionResult = await (options.handleConditionText || handleConditionText)({
        lineUserId: event.source && event.source.userId,
        text: message.text
      });
      if (conditionResult && conditionResult.handled) {
        if (event.replyToken && conditionResult.messages.length) {
          await client.replyMessage(
            event.replyToken,
            conditionResult.messages.length === 1 ? conditionResult.messages[0] : conditionResult.messages,
          );
        }
        return;
      }
    }

    const landlordKnowledgeEnabled = options.landlordKnowledgeEnabled !== undefined
      ? options.landlordKnowledgeEnabled
      : String(process.env.LANDLORD_KNOWLEDGE_DEMO_ENABLED).toLowerCase() === 'true';
    if (landlordKnowledgeEnabled && event.source && event.source.userId) {
      const contactService = options.landlordContactService || getConfiguredLandlordContactService();
      const contactResult = await contactService.handleText({
        lineUserId: event.source.userId,
        text: message.text,
        displayName: event.source.displayName // Usually display name is not in the text event source directly, handled internally via cache or fallback
      });
      if (contactResult && contactResult.handled) {
        if (event.replyToken && contactResult.messages.length) {
          await client.replyMessage(event.replyToken, contactResult.messages.length === 1 ? contactResult.messages[0] : contactResult.messages);
        }
        return;
      }

      const service = options.landlordKnowledgeService || getConfiguredLandlordKnowledgeService();
      // mysql 模式下 handleText 回 Promise;await 非 Promise 值會直接拿到該值,
      // 所以這個 await 對 sqlite 模式沒有影響。少了它,mysql 模式會靜默失效。
      const result = await service.handleText({
        lineUserId: event.source.userId,
        text: message.text,
      });
      if (result.handled) {
        if (event.replyToken && result.messages.length) {
          await client.replyMessage(event.replyToken, result.messages.length === 1 ? result.messages[0] : result.messages);
        }
        return;
      }
    }


    const entryCode = parseEntryCodeText(message.text);
    if (entryCode) {
      const result = await (options.bindV2EntryToken || bindV2EntryToken)({
        entryCode: entryCode.code,
        lineUserId: event.source && event.source.userId,
        providerEventId: event.webhookEventId || message.id,
        occurredAt: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()
      }, options);
      // 只打八碼數字又查不到房源 = 它不是案件碼,是別的東西(最常見的是日期
      // 20260920)。那就不能回「找不到這組 591 案件碼」然後 return —— 那會把訊息
      // 吃掉,後面的流程與 Agent 永遠收不到。往下走,讓該接的人接。
      if (shouldConsumeEntryCode(entryCode, result)) {
        if (event.replyToken) {
          try {
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: result.replyText
            });
          } catch (error) {
            console.error('Failed to reply to LINE 591 entry code:', error.message);
          }
        }
        return;
      }
    }

    // 一分鐘房客簽約展示。只在明確開啟的測試庫環境接手固定關鍵字；正式流程、
    // Agent 與一般對話完全不受影響。
    const contractDemoResult = await (options.handleTenantContractDemoText || handleTenantContractDemoText)({
      lineUserId: event.source && event.source.userId,
      text: message.text
    });
    if (contractDemoResult && contractDemoResult.handled) {
      if (event.replyToken && contractDemoResult.messages.length) {
        await client.replyMessage(
          event.replyToken,
          contractDemoResult.messages.length === 1 ? contractDemoResult.messages[0] : contractDemoResult.messages
        );
      }
      return;
    }

    if (options.archiveMessage !== false) {
      saveMessage(event, {
        message_type: 'text',
        text_content: message.text
      });
    }

    // Detect rental listing URLs and scrape in background
    const urlMatch = message.text.match(RENTAL_URL_REGEX);
    if (urlMatch) {
      handleRentalUrlInBackground(event, client, urlMatch[1]);
    }


    if (isBotCommand(message.text, { exact: event.source?.type === 'user' })) {
      const command = await buildCommand(event);
      saveBotCommand(event, command);

      if (event.replyToken) {
        try {
          const replies = [{ type: 'text', text: command.aiResponse }];
          if (command.followupMessage) {
            replies.push(command.followupMessage);
          }
          await client.replyMessage(event.replyToken, replies);
        } catch (error) {
          console.error('Failed to reply to LINE bot command:', error.message);
        }
      }
      return;
    }

    // AI Knowledge Q&A: if tenant has active inquiry context in 1-to-1 chat
    const isOneOnOne = event.source && event.source.type === 'user';

    // ECS NEO Negotiation Coordinator。**一定排在這裡**:上面每一條明確指令與
    // 進行中的流程(點交、報修、儀表板、房東知識庫、條件整理、入場碼…)都已經
    // 有機會接手,沒人要的一對一自由對話才交給 Agent。
    //
    // feature flag 預設關,public demo 強制停用,兩者都在 handleTenantTurn 內判斷。
    // 關閉時回 handled=false,下面既有的單次問答路徑照舊。
    if (isOneOnOne && event.source.userId) {
      try {
        // 模型實測熱機約 3–4 秒、冷啟動約 8 秒。這段時間聊天室是完全靜止的,
        // 房客不知道系統有沒有收到,常見反應是再打一次。動畫不是回覆,收到訊息
        // 就自己消失;不 await,不然光是叫它就先多花一個 round trip。
        (options.showLoadingAnimation || showLoadingAnimation)(event.source.userId);

        const agentResult = await (options.handleAgentTurn || handleTenantTurn)({
          lineUserId: event.source.userId,
          text: message.text,
          // webhookEventId 是去重的唯一依據。沒有它 Agent 會直接讓路,
          // 不會跑一個無法冪等的 turn。
          providerEventId: event.webhookEventId || null,
          eventType: 'message'
        });
        if (agentResult && agentResult.handled) {
          if (event.replyToken && agentResult.messages.length) {
            // reply API 會回 sentMessages,裡面是 LINE 自己的 message id。型別宣告
            // 沒寫,但 client 直接把 response body 回出來。留著它稽核時才能從房客
            // 螢幕上看到的那一則,回推到 channel event 與 agent execution。
            const sentResponse = await client.replyMessage(
              event.replyToken,
              agentResult.messages.length === 1 ? agentResult.messages[0] : agentResult.messages,
            );
            // 送出成功之後才留下 Agent 說過的話,下一輪它才看得到自己的上一句。
            // 順序不可以對調:reply token 一分鐘就過期,先寫再送會讓沒送到的話
            // 變成模型以為自己已經回答過的內容。
            await (options.recordAgentReply || recordAgentReply)({
              inquiryId: agentResult.inquiryId,
              channelEventPublicId: agentResult.channelEventPublicId,
              messages: agentResult.messages,
              sentMessages: sentResponse && sentResponse.sentMessages
            }).catch((error) => {
              // 記不下來只是回到原本的行為,不該影響已經送出去的回覆。
              console.error('ECS NEO agent reply persist failed:', error.code || 'unknown', error.message);
            });
          }
          return;
        }
      } catch (agentError) {
        // Agent 這一層壞掉不可以把房客的訊息吃掉。記錄後往下走既有路徑。
        console.error('ECS NEO agent turn failed:', agentError.code || 'unknown', agentError.message);
      }
    }

    if (isOneOnOne && event.source.userId) {
      try {
        const { withV2Driver } = require('../database/v2Driver');
        const { saveInquiryMessage } = require('../repositories/v2InquiryRepositoryAsync');
        const { buildListingContext } = require('../services/tenantInquiryAiService');
        const crypto = require('node:crypto');

        // 資料庫的事一次做完就放掉連線,AI 呼叫留到外面。AI 的 timeout 是 30 秒,
        // 包在連線範圍內等於握著連線池的一條連線等半分鐘,尖峰時會把池吃光。
        const prepared = await withV2Driver(async (v2Db) => {
          const lineIdentity = await v2Db.get(
            'SELECT id, user_id FROM line_identities WHERE line_user_id = ?',
            [event.source.userId]
          );
          if (!lineIdentity) return null;

          let activeCtx = await v2Db.get(`
            SELECT aic.inquiry_id FROM active_inquiry_contexts aic
            WHERE aic.line_identity_id = ? AND aic.cleared_at IS NULL
            ORDER BY aic.id DESC LIMIT 1
          `, [lineIdentity.id]);

          // Auto-bind latest inquiry if no active context
          if (!activeCtx) {
            const latestInquiry = await v2Db.get(`
              SELECT id FROM inquiries WHERE user_id = ? AND ended_at IS NULL
              ORDER BY last_activity_at DESC LIMIT 1
            `, [lineIdentity.user_id]);
            if (latestInquiry) {
              await v2Db.run(`
                INSERT INTO active_inquiry_contexts (public_id, line_identity_id, inquiry_id)
                VALUES (?, ?, ?)
              `, [`aic-auto-${crypto.randomUUID()}`, lineIdentity.id, latestInquiry.id]);
              activeCtx = { inquiry_id: latestInquiry.id };
            }
          }
          if (!activeCtx) return null;

          const inquiry = await v2Db.get('SELECT id, listing_id FROM inquiries WHERE id = ?', [activeCtx.inquiry_id]);
          if (!inquiry) return null;

          const msgId = await saveInquiryMessage(v2Db, {
            inquiryId: inquiry.id,
            senderUserId: lineIdentity.user_id,
            senderLineIdentityId: lineIdentity.id,
            providerMessageId: event.message.id,
            messageType: 'text',
            textContent: message.text
          });

          return { inquiry, msgId, context: await buildListingContext(v2Db, inquiry.listing_id) };
        });

        if (prepared) {
          const demoEscalation = String(process.env.LANDLORD_KNOWLEDGE_DEMO_ENABLED).toLowerCase() === 'true';
          const aiResult = demoEscalation
            ? { insufficient: true }
            : await askListingQuestion({
              listingId: prepared.inquiry.listing_id,
              questionText: message.text,
              context: prepared.context
            });

          if (aiResult.insufficient) {
            await withV2Driver((v2Db) => escalateDemoQuestion({
              db: v2Db,
              lineClient: client,
              inquiryId: prepared.inquiry.id,
              listingId: prepared.inquiry.listing_id,
              questionText: message.text,
              escalationReason: demoEscalation ? 'demo_forced_escalation' : 'ai_insufficient',
              sourceMessageId: prepared.msgId
            }));
            const replyMsg = '這個問題需要房東確認，我已幫你轉交房東。房東回覆後，系統會通知你。';
            if (event.replyToken) {
              await client.replyMessage(event.replyToken, { type: 'text', text: replyMsg });
            }
          } else if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: aiResult.answer });
          }
          return;
        }
      } catch (aiErr) {
        console.error('AI Q&A fallback error:', aiErr.message);
      }
    }

    if (event.replyToken) {
      try {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: TEXT.recorded
        });
      } catch (error) {
        console.error('Failed to reply to LINE text message:', error.message);
      }
    }
    return;
  }

  if (['file', 'image', 'video', 'audio'].includes(message.type)) {
    const repairSessionResult = await handleActiveRepairSession(event, message.type, { fileId: null }, client);
    if (repairSessionResult && repairSessionResult.handled) {
      if (event.replyToken && repairSessionResult.messages && repairSessionResult.messages.length) {
        await client.replyMessage(event.replyToken, repairSessionResult.messages);
      }
      return;
    }

    const sessionResult = await handleActivePreInspectionSession(event, message.type, { fileId: null }, client); // File logic inside will link it later if needed, MVP can just count it
    if (sessionResult && sessionResult.handled) {
      if (event.replyToken && sessionResult.messages && sessionResult.messages.length) {
        await client.replyMessage(event.replyToken, sessionResult.messages);
      }
      // Also proceed to download and save the file properly in V1 DB by calling handleFileMessage
      await handleFileMessage(event, client);
      return;
    }

    // Image fallback: check active inquiry contexts
    if (event.source && event.source.type === 'user' && event.source.userId) {
      const { withV2Driver } = require('../database/v2Driver');
      const { findOrCreateLineUser, saveInquiryMessage } = require('../repositories/v2InquiryRepositoryAsync');
      const { savePendingQuestion } = require('../services/tenantInquiryAiService');
      
      const handled = await withV2Driver(async (v2Db) => {
        const lineIdentity = await findOrCreateLineUser(v2Db, { lineUserId: event.source.userId });
        if (lineIdentity) {
          const activeCtx = await v2Db.get('SELECT inquiry_id FROM active_inquiry_contexts WHERE line_identity_id = ? AND cleared_at IS NULL', [lineIdentity.lineIdentityId]);
          if (activeCtx) {
            const inquiry = await v2Db.get('SELECT id, listing_id FROM inquiries WHERE id = ?', [activeCtx.inquiry_id]);
            if (inquiry) {
              const msgId = await saveInquiryMessage(v2Db, {
                inquiryId: inquiry.id,
                senderUserId: lineIdentity.userId,
                senderLineIdentityId: lineIdentity.lineIdentityId,
                providerMessageId: event.message.id,
                messageType: message.type
              });
              await savePendingQuestion({
                db: v2Db,
                inquiryId: inquiry.id,
                listingId: inquiry.listing_id,
                questionText: '房客上傳了一張檔案/照片，請房東查看並回覆。',
                escalationReason: 'image_attachment',
                sourceMessageId: msgId
              });
              if (event.replyToken) {
                await client.replyMessage(event.replyToken, { type: 'text', text: '這個問題需要房東確認，我已幫你轉交房東。房東回覆後，系統會通知你。' });
              }
              return true;
            }
          }
        }
        return false;
      });

      if (handled) {
        await handleFileMessage(event, client);
        return;
      }
    }

    await handleFileMessage(event, client);
  }

  // 只傳貼圖時使用者會以為機器人當掉;群組裡不回,免得洗版。
  if (message.type === 'sticker' && event.source?.type === 'user' && event.replyToken) {
    await client.replyMessage(event.replyToken, { type: 'text', text: '收到你的貼圖～有房子或合約的問題，直接打字問我就可以。' });
  }
}

async function handleRentalUrlInBackground(event, client, targetUrl) {
  try {
    const data = await scrapeRentalUrl(targetUrl);
    if (!data) return;

    if (data.blocked) {
      const blockedText =
        '\u5075\u6e2c\u5230\u6a02\u5c4b\u7db2\u9023\u7d50\uff0c\u4f46\u8a72\u7db2\u7ad9\u8a2d\u6709 Cloudflare ' +
        '\u5b89\u5168\u9632\u8b77\uff0c\u66ab\u6642\u7121\u6cd5\u81ea\u52d5\u64f7\u53d6\u8a73\u7d30\u8cc7\u8a0a\u3002';
      const targetId = event.source && (event.source.groupId || event.source.roomId);
      if (targetId) {
        await client.pushMessage(targetId, { type: 'text', text: blockedText });
      }
      return;
    }

    // Persist to SQLite
    saveRentalListing(event, {
      source: data.source,
      url: targetUrl,
      price: data.price,
      title: data.title,
      address: data.address,
      rooms: data.rooms,
      type: data.type,
      floor: data.floor,
      amenities: data.amenities,
      description: data.description
    });

    // Parse amenities for display
    let amenitiesDisplay = '\u672a\u63d0\u4f9b';
    if (data.amenities) {
      try {
        const arr = JSON.parse(data.amenities);
        if (arr.length) amenitiesDisplay = arr.join('\u3001');
      } catch {
        amenitiesDisplay = data.amenities;
      }
    }

    // Truncate description for chat display
    let descDisplay = '\u672a\u63d0\u4f9b';
    if (data.description) {
      descDisplay = data.description.length > 100
        ? data.description.slice(0, 100) + '...'
        : data.description;
    }

    // Push formatted listing card
    const lines = [
      '\ud83c\udfe0 \u3010\u5075\u6e2c\u5230\u79df\u5c4b\u9023\u7d50\u3011\u81ea\u52d5\u64f7\u53d6\u8cc7\u8a0a',
      `\ud83d\udd39 \u6a19\u984c\uff1a${data.title || '\u672a\u63d0\u4f9b'}`,
      `\ud83d\udd39 \u79df\u91d1\uff1a${data.price ? data.price.toLocaleString() + ' \u5143/\u6708' : '\u672a\u63d0\u4f9b'}`,
      `\ud83d\udd39 \u5730\u5740\uff1a${data.address || '\u672a\u63d0\u4f9b'}`,
      `\ud83d\udd39 \u683c\u5c40\uff1a${data.rooms || '\u672a\u63d0\u4f9b'}`,
      `\ud83d\udd39 \u985e\u578b\uff1a${data.type || '\u672a\u63d0\u4f9b'}`,
      `\ud83d\udd39 \u6a13\u5c64\uff1a${data.floor || '\u672a\u63d0\u4f9b'}`,
      `\ud83d\udd39 \u8a2d\u5099\uff1a${amenitiesDisplay}`,
      `\ud83d\udd39 \u63cf\u8ff0\uff1a${descDisplay}`,
      `\ud83d\udd17 \u7db2\u5740\uff1a${targetUrl}`,
      '\ud83d\udccc \u5df2\u5c07\u6b64\u623f\u6e90\u8cc7\u8a0a\u81ea\u52d5\u8a18\u9304\u81f3\u5b58\u8b49\u7cfb\u7d71\u3002'
    ];

    const targetId = event.source && (event.source.groupId || event.source.roomId);
    if (targetId) {
      await client.pushMessage(targetId, { type: 'text', text: lines.join('\n') });
    }
  } catch (err) {
    console.error('Rental URL background handler failed:', err.message);
  }
}

module.exports = { handleMessageEvent };
