// prepared draft 的 AI 說明 client。
//
// 這是模型在草稿產生流程裡的**唯一**入口,而且它只能回兩件事:
//   clauseNarratives   每個已確認條件欄位的自然語言說明
//   suspectedConflicts 疑似矛盾的初步提示
//
// 它不回條件、不回金額、不回日期、不回責任歸屬、不回合法性判斷。
// 產生端(ecsNeoPreparedDraftProducerAsync)還會再過一次白名單,
// 所以就算模型或這個檔案哪天多回了東西,也進不了 artifact。
//
// 呼叫方式與 conditionExtractionService 一致:走供應商的 OpenAI 相容
// /chat/completions,設定只從 aiConfigService 取得,response_format 優先用
// json_schema。溫度固定 0 —— artifact 的 checksum 綁 responsibilityMatrix,
// 說明文字每次都不一樣會讓同一組條件產生無限多份「內容不同」的草稿。
// (即使如此仍不能假設模型輸出可重現,所以冪等的判準是 checksum 相符,
// 不是「同輸入必得同 artifact」。)

const axios = require('axios');

const { aiRequestOptions, resolveAiCredentials, assertAiConfig, getAiConfig, supportsJsonSchema } = require('./aiConfigService');

const DEFAULT_MODEL = 'gemini-3.7-flash';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 120000;

// 提示詞沿用 conditionExtractionService 的保守原則:無證據不得腦補,
// 模糊措辭不得視為同意。這裡再加一條更強的限制 —— 連「條件是什麼」都不准說,
// 因為條件已經由雙方確認,模型只是替人類把它翻成人話。
const SYSTEM_PROMPT = [
  '你是 ECS NEO 的租約草稿說明產生器。',
  '輸入是雙方**已經確認**的承租條件、契約範本的條次清單與版本標示。',
  '你的唯一任務是為每個條件欄位寫一段中立、白話的說明，讓房東與房客看得懂這一條在契約裡代表什麼。',
  '你不是律師，不提供法律意見，不判斷條款是否合法、是否有效、是否屬於不得記載事項。',
  '合法性、應記載事項、不得記載事項與是否可以簽署，全部由系統的 deterministic 規則判斷，與你無關。',
  '嚴格禁止：新增條件、修改金額、修改日期、補上原本沒有的責任歸屬、推測雙方意圖、填寫空白欄位。',
  '嚴格禁止：輸出 clauseNarratives 與 suspectedConflicts 以外的任何頂層欄位。',
  '只能為輸入 clauseSnapshot 裡實際存在的欄位寫說明；不存在的欄位一律不要提及。',
  '若某個欄位的內容不足以說明（例如只寫「另議」），該欄位的說明必須直接寫出「這一項尚未談定，需雙方確認」，不可自行補完。',
  '模糊措辭（可討論、應該可以、再看看、視情況）不得解讀為已同意。',
  'suspectedConflicts 只放你覺得兩個欄位可能互相矛盾的初步觀察，並在 note 說明理由。',
  'suspectedConflicts 是提示，不是結論；不要宣稱某條款違法或無效。',
  '所有輸出使用繁體中文。',
  '不要輸出思考過程、markdown、註解或額外文字，只輸出符合 JSON schema 的單一 JSON object。'
].join('\n');

const NARRATIVE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clauseNarratives', 'suspectedConflicts'],
  properties: {
    clauseNarratives: {
      type: 'object',
      additionalProperties: { type: 'string' }
    },
    suspectedConflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['clauseFields', 'note'],
        properties: {
          clauseFields: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' }
        }
      }
    }
  }
};

function parseJsonContent(content) {
  const text = String(content || '').trim()
    // 有些回應會包在 ```json 圍籬裡。
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(text);
}

function createDraftNarrativeClient({ config } = {}) {
  const resolved = config || getAiConfig({
    defaultModel: DEFAULT_MODEL,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS
  });

  return {
    async generateDraftNarrative(payload) {
      assertAiConfig(resolved, 'prepared contract draft narrative');

      const request = {
        ...aiRequestOptions(resolved),
        model: resolved.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload, null, 2) }
        ],
        max_tokens: resolved.maxTokens || DEFAULT_MAX_TOKENS,
        temperature: 0,
        stream: false
      };

      if (supportsJsonSchema(resolved.baseURL)) {
        request.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'contract_draft_narrative',
            schema: NARRATIVE_JSON_SCHEMA,
            strict: true
          }
        };
      } else {
        request.response_format = { type: 'json_object' };
      }

      const credentials = await resolveAiCredentials(resolved);
      const response = await axios.post(`${resolved.baseURL}/chat/completions`, request, {
        timeout: resolved.timeoutMs || DEFAULT_TIMEOUT_MS,
        proxy: false,
        headers: {
          Authorization: credentials.authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      });

      const choice = response.data
        && response.data.choices
        && response.data.choices[0]
        && response.data.choices[0].message;
      if (!choice || !choice.content) {
        throw new Error('AI response did not include message content.');
      }

      return {
        modelId: resolved.model,
        // 供應商回報的實際版本優先;沒有就退回設定值,不留 null 讓 checksum 少一個綁定。
        modelVersion: typeof response.data.model === 'string' ? response.data.model : resolved.model,
        output: parseJsonContent(choice.content)
      };
    }
  };
}

module.exports = {
  NARRATIVE_JSON_SCHEMA,
  SYSTEM_PROMPT,
  createDraftNarrativeClient
};
