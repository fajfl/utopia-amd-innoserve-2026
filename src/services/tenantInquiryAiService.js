const OpenAI = require('openai');
const { sqliteDriver } = require('../database/sqlDriver');
const { aiRequestOptions, getAiConfig, assertAiConfig, resolveAiCredentials } = require('./aiConfigService');
const { findTestLandlordLineUserId } = require('./testRoleService');

// 原本這裡有一個 getDb() 單例,自己開 data/ecs-neo-v2.sqlite。房客的身分與詢問
// 已經建在 TiDB Cloud,再從本機檔案找房源與房東規則,結果就是「AI 讀到的房源
// 跟房客實際詢問的不是同一筆」,而且不會報錯。所以連線一律由呼叫端傳進來。
//
// 傳 better-sqlite3 的原始連線也可以——既有測試就是這樣呼叫的——會自動包成 driver。
function asDriver(db) {
  if (!db) throw new Error('database is required');
  return typeof db.get === 'function' ? db : sqliteDriver(db);
}

const INSUFFICIENT_MARKER = '##INSUFFICIENT##';

/**
 * Build RAG context for a given listing.
 */
async function buildListingContext(db, listingId) {
  const listing = await db.get(`
    SELECT l.title, l.current_rent_amount, l.current_deposit_amount,
           ls.normalized_address, ls.pet_policy_text, ls.amenity_json, ls.rent_amount, ls.deposit_amount, ls.management_fee_amount
    FROM listings l
    LEFT JOIN listing_snapshots ls ON ls.id = l.latest_valid_snapshot_id
    WHERE l.id = ?
  `, [listingId]);

  if (!listing) return null;

  // Landlord rules
  //
  // visibility = 'public' 是必要條件。knowledge_items 的類型裡有
  // landlord_internal_rule —— 那是房東記給自己看的,不能餵給回答房客的 AI。
  //
  // 順序也是語意的一部分:房東把「不可議價」排在「租金可談」前面,是希望 AI 先看到
  // 前者。原本這條 SQL 沒有 ORDER BY,兩個 driver 的預設順序都不保證,同一份規則在
  // SQLite 與 TiDB 可能餵出不同順序的 prompt。排序鍵固定 (sort_order, created_at, id),
  // 與房東管理介面看到的順序完全一致。
  const rules = await db.all(`
    SELECT lr.rule_type, lr.rule_value_json
    FROM landlord_rules lr
    JOIN knowledge_items ki ON ki.id = lr.knowledge_item_id
    JOIN listings l ON l.rental_unit_id = lr.rental_unit_id
    WHERE l.id = ? AND lr.status = 'active' AND ki.status = 'active'
      AND lr.visibility = 'public'
    ORDER BY lr.sort_order ASC, lr.created_at ASC, lr.id ASC
  `, [listingId]);

  // Answered Q&A
  //
  // reuse_approved = 1 是必要條件,這就是「潛規則」的實作:房東這次答應，不代表
  // 下一個房客問同樣的問題也算數。沒勾核准的答案不能進 AI 的參考資料,
  // 否則 AI 會拿「本次可以，但其他房客仍需個別確認」去回答下一個人。
  //
  // integrityRules.js 有一道防線擋住未核准的回答變成知識庫來源,但 AI 問答
  // 是直接讀 landlord_answers 原始表,繞過了那道防線,所以這裡必須自己擋。
  const qas = await db.all(`
    SELECT lq.question_text, la.answer_text
    FROM landlord_questions lq
    JOIN landlord_answers la ON la.landlord_question_id = lq.id
    WHERE lq.listing_id = ? AND lq.status = 'answered'
      AND la.reuse_approved = 1 AND la.visibility = 'public'
    ORDER BY lq.id DESC LIMIT 20
  `, [listingId]);

  let context = `【房源資訊】\n`;
  context += `名稱：${listing.title || '未提供'}\n`;
  context += `月租金：${listing.current_rent_amount || listing.rent_amount || '未提供'} 元\n`;
  if (listing.current_deposit_amount || listing.deposit_amount) {
    context += `押金：${listing.current_deposit_amount || listing.deposit_amount} 元\n`;
  }
  if (listing.management_fee_amount) {
    context += `管理費：${listing.management_fee_amount} 元\n`;
  }
  if (listing.normalized_address) {
    context += `地址：${listing.normalized_address}\n`;
  }
  if (listing.pet_policy_text) {
    context += `寵物政策：${listing.pet_policy_text}\n`;
  }
  if (listing.amenity_json) {
    try {
      const amenities = JSON.parse(listing.amenity_json);
      if (Array.isArray(amenities) && amenities.length > 0) {
        context += `設備：${amenities.join('、')}\n`;
      }
    } catch {}
  }

  if (rules.length > 0) {
    context += `\n【房東補充規則】\n`;
    rules.forEach(r => {
      try {
        const val = JSON.parse(r.rule_value_json);
        // confirmedText 是房東確認過的那句話,也是 saveConfirmedRule 實際寫進去的欄位。
        // 少了它就會落到 JSON.stringify(val),把 originalText 與 adapter 名稱一起塞進
        // prompt —— 房東看到的是自己那句話,AI 看到的卻是一坨 JSON。
        context += `[${r.rule_type}] ${val.confirmedText || val.label || val.description || JSON.stringify(val)}\n`;
      } catch {
        context += `[${r.rule_type}] ${r.rule_value_json}\n`;
      }
    });
  }

  if (qas.length > 0) {
    context += `\n【歷史 Q&A】\n`;
    qas.forEach(qa => {
      context += `問：${qa.question_text}\n答：${qa.answer_text}\n\n`;
    });
  }

  return context;
}

const SYSTEM_PROMPT = [
  '你是一位親切的租屋小助手，專門協助房客了解特定房源的資訊。',
  '你的回答必須完全基於以下提供的房源 Context（房源資訊、房東規則、歷史 Q&A）。',
  '如果 Context 中的資訊足以回答房客問題，請直接友善地回答。',
  '如果 Context 中沒有相關資訊，或資訊不足以回答，你必須在回答的最開頭輸出 ' + INSUFFICIENT_MARKER + '，然後簡短說明你無法回答的原因。',
  '不要編造不存在於 Context 中的資訊。',
  '回答要簡潔、實用，使用繁體中文。'
].join('\n');

/**
 * Ask AI a question about a listing.
 * Returns { answer, insufficient }
 */
// aiClient 只給測試注入。不注入時行為與原本完全相同,照 config 自己建一個。
//
// context 可以由呼叫端先建好傳進來。這很重要:AI 呼叫的 timeout 是 30 秒,
// 在連線池模式下,如果整段都包在 withV2Driver 裡,等於握著一條連線等 AI 回應
// 半分鐘,尖峰時會把池吃光。呼叫端應該在連線範圍內先 buildListingContext,
// 歸還連線之後才呼叫這支。
async function askListingQuestion({ db, listingId, questionText, aiClient = null, context: preparedContext }) {
  const context = preparedContext !== undefined
    ? preparedContext
    : await buildListingContext(asDriver(db), listingId);

  if (!context) {
    return { answer: '找不到此房源的相關資料。', insufficient: true };
  }

  const config = getAiConfig({
    defaultMaxTokens: 500,
    defaultTimeoutMs: 30000
  });

  let credentials = null;
  if (!aiClient) {
    try {
      assertAiConfig(config, 'tenant AI Q&A');
      // Vertex 的認證是會過期的 OAuth 權杖,所以每次呼叫前重新解析,不能在建立
      // client 時綁死一個常數。拿不到權杖跟沒設定 AI 是同一種結果:回覆房客
      // 「暫時無法回答」,不要把錯誤往上丟到 LINE 訊息處理器。
      credentials = await resolveAiCredentials(config);
    } catch {
      return { answer: 'AI 服務目前未設定，無法回答您的問題。', insufficient: true };
    }
  }

  const client = aiClient || new OpenAI({
    // 真正生效的是 defaultHeaders 帶進去的 Authorization;Vertex 沒有靜態金鑰,
    // 但 SDK 要求 apiKey 非空,所以放一個明顯是佔位的值。
    apiKey: config.apiKey || 'vertex-oauth',
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
    defaultHeaders: { Authorization: credentials.authorization },
  });

  try {
    const completion = await client.chat.completions.create({
      ...aiRequestOptions(config),
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `【房源 Context】\n${context}\n\n【房客問題】\n${questionText}` }
      ],
    });

    const aiAnswer = completion.choices?.[0]?.message?.content?.trim() || '';

    if (aiAnswer.includes(INSUFFICIENT_MARKER)) {
      const cleanAnswer = aiAnswer.replace(INSUFFICIENT_MARKER, '').trim();
      return { answer: cleanAnswer, insufficient: true };
    }

    return { answer: aiAnswer, insufficient: false };
  } catch (err) {
    console.error('AI Q&A error:', err.message);
    return { answer: 'AI 回答時發生錯誤，請稍後再試。', insufficient: true };
  }
}

/**
 * Save a pending question for the landlord to answer.
 */
async function savePendingQuestion({ db, inquiryId, listingId, questionText,
  escalationReason = 'ai_insufficient', sourceMessageId = null }) {
  const crypto = require('node:crypto');
  const publicId = `lq-${crypto.randomUUID()}`;

  await asDriver(db).run(`
    INSERT INTO landlord_questions (public_id, inquiry_id, listing_id, question_text, escalation_reason, status, source_message_id)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `, [publicId, inquiryId, listingId, questionText, escalationReason, sourceMessageId]);

  return publicId;
}

async function findLandlordLineUserId(db, listingId) {
  const testLandlord = findTestLandlordLineUserId();
  if (testLandlord) return testLandlord;
  const row = await db.get(`
    SELECT li.line_user_id
    FROM listings l
    JOIN rental_units ru ON ru.id = l.rental_unit_id
    JOIN property_owners po ON po.rental_unit_id = ru.id OR
      (po.rental_unit_id IS NULL AND po.property_id = ru.property_id)
    JOIN line_identities li ON li.user_id = po.owner_user_id
    WHERE l.id = ? AND po.effective_until IS NULL
    ORDER BY po.id DESC, li.id DESC LIMIT 1
  `, [listingId]);
  return (row && row.line_user_id) || null;
}

async function escalateDemoQuestion({ db, lineClient, inquiryId, listingId, questionText,
  escalationReason = 'demo_forced_escalation', sourceMessageId = null }) {
  const driver = asDriver(db);
  const publicId = await savePendingQuestion({
    db: driver, inquiryId, listingId, questionText,
    escalationReason, sourceMessageId
  });
  // 推播是外部呼叫,刻意排在所有寫入之後,而且不在交易裡。
  const landlordLineUserId = await findLandlordLineUserId(driver, listingId);
  let notificationPending = !landlordLineUserId || !lineClient?.pushMessage;
  if (!notificationPending) {
    try {
      await lineClient.pushMessage(landlordLineUserId, {
        type: 'text',
        text: `房客提出新問題：「${questionText}」\n請開啟「AI知識庫」查看並回答。`
      });
    } catch (error) {
      console.error('Landlord question push failed:', error.message);
      notificationPending = true;
    }
  }
  return { publicId, landlordLineUserId, notificationPending };
}

module.exports = {
  askListingQuestion,
  escalateDemoQuestion,
  savePendingQuestion,
  buildListingContext,
  INSUFFICIENT_MARKER
};
