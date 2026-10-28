// 承租條件整理的 LINE 入口:文字指令與 postback。
//
// 這一層只做三件事:把 LINE 事件翻成 domain command、把結果翻成訊息、把錯誤翻成
// 房客看得懂的話。授權、狀態、版本與交易全部在
// ecsNeoIntentionVersionServiceAsync 裡重新驗證,不信任 postback 帶進來的東西
// (postback data 是使用者可改的字串)。
//
// 模型呼叫在 domain service 的交易外進行,所以這裡不需要、也不應該自己開交易。

const {
  confirmIntentionVersion,
  extractAndSaveIntentionVersion,
  loadIntentionVersion
} = require('./ecsNeoIntentionVersionServiceAsync');
const presenter = require('./ecsNeoConditionLinePresenter');
const { withV2Driver } = require('../database/v2Driver');
const {
  ASK_LANDLORD_POSTBACK_ACTION,
  DECLINE_LANDLORD_POSTBACK_ACTION,
  handleAgentEscalationPostback
} = require('./ecsNeoAgentGatewayServiceAsync');
const { projectTrackedFields } = require('./ecsNeoConditionProvenanceService');
const { prepareContractDraft } = require('./ecsNeoPreparedDraftProducerAsync');
const { createDraftNarrativeClient } = require('./ecsNeoDraftNarrativeClient');
const { blockingIssueLabels } = require('./ecsNeoLegalRuleValidator');
const { materializeConfirmedIntentionDraft } = require('./ecsNeoDraftMaterializationServiceAsync');

const TEXT_COMMANDS = new Set(['條件整理', '整理條件', '承租條件', '整理承租條件']);
const POSTBACK_ACTIONS = new Set([
  'ecs_condition_confirm',
  'ecs_condition_sources',
  'ecs_condition_revise',
  // 「幫我問房東」。這一顆沒有 version,帶的是 channel event。
  ASK_LANDLORD_POSTBACK_ACTION,
  // 「先不用」。不寫任何資料,只把那則詢問收掉。
  DECLINE_LANDLORD_POSTBACK_ACTION
]);

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, '');
}

function isConditionCommand(text) {
  return TEXT_COMMANDS.has(normalize(text));
}

function parseAction(data) {
  const params = new URLSearchParams(String(data || ''));
  return {
    action: params.get('action'),
    versionPublicId: params.get('version'),
    channelEventPublicId: params.get('event')
  };
}

function isConditionPostback(data) {
  return POSTBACK_ACTIONS.has(parseAction(data).action || '');
}

function textReply(text) {
  return { handled: true, messages: [{ type: 'text', text }] };
}

// 錯誤翻譯表。authorization_denied 一律回同一句,不揭露目標是否存在。
function messagesForError(error) {
  switch (error && error.code) {
    case 'no_active_inquiry':
      return textReply('目前沒有進行中的房源詢問。請先開啟「找房紀錄」選一筆房源，再回來輸入「條件整理」。');
    case 'intention_frozen':
      return textReply('這筆承租意向已經進入簽約或已結束，條件不再變動。請開啟合約草稿查看目前內容。');
    case 'missing_provenance':
      return textReply('整理出來的條件有欄位追不到原文依據，為了不寫進沒有依據的條款，這次沒有存檔。請把條件在聊天室講清楚後再試一次。');
    case 'invalid_other_agreements':
      return textReply(error.message);
    case 'stale_version':
      return { handled: true, messages: [presenter.staleVersionMessage({ latestVersionNumber: error.latestVersionNumber })] };
    case 'extraction_failed':
      return textReply('條件整理服務暫時無法使用，請稍後再輸入「條件整理」。你的對話紀錄都還在。');
    case 'authorization_denied':
      return textReply('找不到可以操作的承租條件版本。');
    default:
      return textReply('條件整理時發生問題，請稍後再試。');
  }
}

/**
 * 文字指令:重新整理承租條件並產生**新的一版**。
 * 既有版本一律不動 —— 修改是加一版,不是改舊版。
 */
async function handleConditionText({ lineUserId, text, extractor, withDriver = withV2Driver }) {
  if (!isConditionCommand(text)) return { handled: false, messages: [] };
  if (!lineUserId) return textReply('無法確認你的 LINE 身分，請重新從 LINE 開啟。');

  try {
    const result = await withDriver((db) => extractAndSaveIntentionVersion({ db, lineUserId, extractor }));
    return {
      handled: true,
      messages: [presenter.conditionSummaryCard({
        versionPublicId: result.versionPublicId,
        versionNumber: result.versionNumber,
        listingTitle: result.listingTitle,
        fields: result.fields,
        conflicts: result.conflicts,
        missingFields: result.missingFields,
        unsourcedFields: result.unsourcedFields
      })]
    };
  } catch (error) {
    console.error('ECS NEO condition extraction failed:', error.code || 'unknown', error.message);
    return messagesForError(error);
  }
}

async function handleConditionPostback({ lineUserId, data, withDriver = withV2Driver, modelClient }) {
  const { action, versionPublicId, channelEventPublicId } = parseAction(data);
  if (!POSTBACK_ACTIONS.has(action || '')) return { handled: false, messages: [] };
  if (!lineUserId) return textReply('無法確認你的 LINE 身分，請重新從 LINE 開啟。');

  // 「幫我問房東」不是條件版本的操作,它帶的是 channel event,而且要在版本檢查
  // 之前就分出去 —— 否則會被下面那句「缺少版本資訊」擋掉。
  // 「先不用」不碰資料庫,連身分都不需要查:它唯一的作用是讓那句問話有得回答。
  if (action === DECLINE_LANDLORD_POSTBACK_ACTION) {
    return textReply('好，那就先不問房東。想到再跟我說，或直接繼續談條件都可以。');
  }

  if (action === ASK_LANDLORD_POSTBACK_ACTION) {
    if (!channelEventPublicId) return textReply('這張卡片缺少對話資訊，請再說一次你要問的事。');
    try {
      return await withDriver((db) => handleAgentEscalationPostback(db, {
        lineUserId, channelEventPublicId
      }));
    } catch (error) {
      console.error('ECS NEO agent escalation postback failed:', error.code || 'unknown', error.message);
      return textReply('轉問房東時發生問題，請稍後再試一次。');
    }
  }

  if (!versionPublicId) return textReply('這張卡片缺少版本資訊，請輸入「條件整理」重新取得。');

  try {
    if (action === 'ecs_condition_confirm') {
      const result = await withDriver((db) => confirmIntentionVersion({
        db, lineUserId, intentionVersionPublicId: versionPublicId
      }));
      // A confirmation is the tenant's explicit authority to make a reviewable
      // draft. Model narratives are separate from agreed conditions and generated outside transactions.
      const prepared = await withDriver(async (db) => {
        const template = await db.get("SELECT public_id FROM contract_template_versions WHERE status='active' ORDER BY effective_from DESC,id DESC LIMIT 1");
        const rules = await db.get("SELECT public_id FROM legal_rule_pack_versions WHERE status='active' ORDER BY effective_from DESC,id DESC LIMIT 1");
        // 舊資料與既有測試可能還沒有 030 的 active bindings。確認本身仍然有效，
        // 但不能假裝已產生合法草稿；等 seed/migration 補齊後重送會繼續固化。
        if (!template || !rules) return { missingBindings: [!template && '契約範本', !rules && '法規檢查規則'].filter(Boolean) };
        const existing = await db.get(`SELECT public_id AS preparedDraftPublicId,status,blocking_issue_count AS blockingIssueCount,issues_json
          FROM prepared_contract_drafts WHERE intention_version_id=(SELECT id FROM intention_versions WHERE public_id=?)
            AND materialized_contract_version_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [versionPublicId]);
        if (existing) return { ...existing, issues: JSON.parse(existing.issues_json) };
        return prepareContractDraft({ db, intentionVersionPublicId: versionPublicId, templateVersionPublicId: template.public_id, rulePackVersionPublicId: rules.public_id,
          modelClient: modelClient || (withDriver === withV2Driver ? createDraftNarrativeClient() : undefined) });
      });
      if (prepared.missingBindings) {
        return {
          handled: true,
          messages: [result.replayed
            ? presenter.replayedConfirmMessage({ versionNumber: result.versionNumber })
            : presenter.confirmedMessage({ versionNumber: result.versionNumber, listingTitle: result.listingTitle }),
            { type: 'text', text: `條件已確認，但尚未產生合約草稿：系統缺少已啟用的${prepared.missingBindings.join('及')}版本。請聯絡平台管理員補齊；完成後可再按同一張卡片的確認按鈕，接續處理這一版條件。` }]
        };
      }
      if (prepared.status !== 'ready' || prepared.blockingIssueCount) {
        const missing = blockingIssueLabels(prepared.issues);
        if (!missing.length) return textReply('條件已確認，但系統的法規檢查沒有通過，因此尚未建立草稿。這不是你需要補的內容，請聯絡平台協助處理。');
        return textReply(`條件已確認，但合約一定要約定的項目還不完整：${missing.join('、')}。
直接在聊天裡告訴我你和房東對這些項目的安排，我會整理成新版本給你確認。`);
      }
      const materialized = await withDriver((db) => materializeConfirmedIntentionDraft({
        db, lineUserId, intentionVersionPublicId: versionPublicId, preparedDraftPublicId: prepared.preparedDraftPublicId
      }));
      // 沒有可附加的屋況紀錄不擋草稿,但一定要講出來。靜默省略附件一的後果是
      // 房客在簽署頁才發現「現況」沒有任何證據,而那時候已經在簽了。
      const attachmentNote = materialized.conditionRecordAttached
        ? '草稿已自動附上你最新一份屋況點交紀錄作為附件一。'
        : '目前沒有可附加的屋況點交紀錄，這份草稿的附件一是空的。要留下現況證據的話，請先完成點交紀錄再重新確認條件。';
      return {
        handled: true,
        messages: [
          result.replayed && materialized.replayed
            ? presenter.replayedConfirmMessage({ versionNumber: result.versionNumber })
            : presenter.confirmedMessage({
              versionNumber: result.versionNumber,
              listingTitle: result.listingTitle
            }),
          { type: 'text', text: `${attachmentNote}\n\n草稿已建立，請在 Mini App 的「合約草稿」完整閱讀。按下送出簽署後，會先請房東確認條件（租金、押金、租期與責任條款）；房東確認後回到同一頁就能開始簽署。系統不會替你送簽。` }
        ]
      };
    }

    const version = await withDriver((db) => loadIntentionVersion({
      db, lineUserId, intentionVersionPublicId: versionPublicId
    }));

    if (action === 'ecs_condition_revise') {
      return { handled: true, messages: [presenter.reviseGuidanceMessage({ versionNumber: version.versionNumber })] };
    }

    // 逐項依據。欄位標籤與顯示值由同一份 TRACKED_FIELDS 規則算出,
    // 所以卡片與依據列表看到的是同一組欄位,不會有一邊多一項的情況。
    // 來源直接用 intention_version_sources 的既有紀錄,不重新判定 ——
    // 讀取不是重新認定,而且這裡手上沒有原始訊息。
    const fields = projectTrackedFields(version.conditionJson || {}).map((field) => ({
      ...field,
      sources: version.sources
        .filter((row) => row.field_path === field.path)
        .map((row) => ({ sourceType: row.source_type, sourceId: row.source_id }))
    }));

    return {
      handled: true,
      messages: [presenter.conditionSourcesMessage({
        versionNumber: version.versionNumber,
        fields,
        sources: version.sources
      })]
    };
  } catch (error) {
    console.error('ECS NEO condition postback failed:', error.code || 'unknown', error.message);
    return messagesForError(error);
  }
}

module.exports = {
  handleConditionPostback,
  handleConditionText,
  isConditionCommand,
  isConditionPostback
};
