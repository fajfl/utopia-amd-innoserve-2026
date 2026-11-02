const axios = require('axios');
const {
  CONDITION_JSON_SCHEMA,
  normalizeConditionJson,
  parseJsonContent
} = require('./conditionJsonService');
const {
  aiRequestOptions,
  assertAiConfig,
  getAiConfig,
  resolveAiCredentials,
  supportsJsonSchema
} = require('./aiConfigService');

const DEFAULT_MODEL = 'gemini-3.7-flash';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_TOKENS = 2048;
const MAX_REPAIR_ATTEMPTS = 1;

const SYSTEM_PROMPT = [
  '你是 ECS NEO 的本地 LLM 租屋條件抽取器。',
  '你的任務是根據台灣租屋房源資料、LINE 群組協商對話與案件檔案紀錄，整理 AI 候選租屋條件，輸出完整 condition_json。',
  '你不是律師，不提供法律意見，不產生正式租約，不替雙方決定條款。',
  '這是「AI 候選整理結果」，不是最終租約條款；未經房東與房客確認，不得視為正式契約內容。',
  '最外層 key 必須直接是 parties, property, lease_term, rent, deposit, fees, use_restrictions, repairs, termination, attachments, special_terms, review_period_days_min, compliance。',
  '禁止輸出 case_id、group_id、condition_json 外層包裝。',
  '所有 schema 定義為 object 的欄位都必須輸出 object，不可輸出 array 或字串。',
  'rent、deposit、fees、repairs、termination、attachments 即使沒有資料也必須輸出完整 object，不可只輸出數字或 null。',
  '資料優先順序：LINE 對話優先於房源資料；LINE 對話與房源資料衝突時，以 LINE 對話為準；檔案紀錄是案件紀錄的一部分，若檔案已提供 extracted_text，應納入判斷。',
  '若目前檔案只有檔名、類型、hash、時間等 metadata，這些 metadata 只能作為附件存在證明，不可推測檔案內容。',
  '只能抽取原文或檔案文字中有明確依據的資訊；沒有明確證據的欄位請填 null，不要用租屋常識補完。',
  '對寵物、轉租、開伙，若對話明確說可以或不可以，才填入對應 boolean；「可討論」、「應該可以」、「再看看」不可解讀為已同意。',
  'subsidy_application_allowed、tax_filing_allowed、household_registration_allowed 不得輸出 false。若原文出現不能租補、不能報稅、不能遷戶籍等限制，請填 null，並在 compliance.warnings 記錄「原文出現疑似限制承租人權益的約定，需人工確認」。只有原文明確表示可以，才填 true。',
  '付款日請放在 rent.payment_due_day，付款方式請放在 rent.payment_method，押金月數請放在 deposit.deposit_months。',
  '租期起日請放在 lease_term.start_date_roc，租期迄日請放在 lease_term.end_date_roc。若對話寫「租期從民國115年7月1日到116年6月30日」，必須抽成 start_date_roc="115年7月1日", end_date_roc="116年6月30日"。',
  'fees 內的 payer、rule、amount 只能根據原文填入。若原文未提水費、電費、瓦斯費或網路費，對應欄位的 payer 與 rule 必須為 null。不得自行補「依帳單」、「依台電」、「房客負擔」。',
  'repairs.landlord_responsibility 與 repairs.tenant_responsibility 只能放原文明確提到的設備或責任。若只提到冷氣、熱水器房東修，不得擴張成所有家電或冰箱、洗衣機也由房東修。',
  '所有金額請用新臺幣數字，不要包含逗號或「元」。',
  '日期若有民國格式請保留為民國格式字串，例如「114年7月1日」。',
  'repair、special_terms 等陣列請只放明確文字。',
  'review_period_days_min 若未提及，依住宅租賃契約審閱期 demo 規則填 3。',
  'compliance.missing_fields 可先留空，後端會重新計算。',
  '不要輸出思考過程，不要把 reasoning 或分析內容放進回應。',
  '請只輸出符合 JSON schema 的單一 JSON object，不要輸出 markdown、解釋、註解或額外文字。'
].join('\n');

const REPAIR_SYSTEM_PROMPT = [
  SYSTEM_PROMPT,
  '',
  '你現在只負責修正上一輪輸出的 JSON 結構問題。',
  '只修 JSON 格式、schema 欄位、型別、陣列/object/string 錯誤、多包 condition_json 外層等問題。',
  '不得新增原文沒有提到的租屋條件。',
  '不得把 validator warning 洗掉或改寫成已確認條款。',
  '缺乏證據、敏感權利限制、費用未提及、修繕責任擴張等問題，應保留 null、空陣列或 warnings，不能自行補值。',
  '只輸出修正後的單一 JSON object。'
].join('\n');

async function extractConditionJson(context) {
  const config = getAiConfig({
    defaultModel: DEFAULT_MODEL,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS
  });
  assertAiConfig(config, 'draft condition extraction');

  // 先要求模型直接照 schema 產出;端點不支援或當次被拒時,退一階到
  // json_object,再退一階到純文字解析。每退一階都會留下 warning,讓後面
  // 的人工審閱知道這份結果的把握程度比平常低。
  const useSchema = supportsJsonSchema(config.baseURL);

  try {
    return await requestConditionJson({
      ...config,
      context,
      jsonSchema: useSchema,
      responseFormat: true
    });
  } catch (schemaError) {
    if (schemaError.isConditionJsonContentError) {
      throw schemaError;
    }
    if (!useSchema) {
      console.warn('json_object extraction failed, retrying without response_format:', schemaError.message);
      const plain = await requestConditionJson({
        ...config,
        context,
        jsonSchema: false,
        responseFormat: false
      });
      plain.warnings.push(`json_object failed: ${schemaError.message}`);
      return plain;
    }

    console.warn('json_schema extraction failed, retrying with json_object:', schemaError.message);
    const fallback = await requestConditionJson({
      ...config,
      context,
      jsonSchema: false,
      responseFormat: true
    });
    fallback.warnings.push(`json_schema failed: ${schemaError.message}`);
    return fallback;
  }
}

async function requestConditionJson({ apiKey, provider, baseURL, model, maxTokens, timeoutMs, context, jsonSchema, responseFormat }) {
  const content = await requestConditionJsonContent({
    apiKey,
    provider,
    baseURL,
    model,
    maxTokens,
    timeoutMs,
    context,
    jsonSchema,
    responseFormat
  });
  const firstResult = processConditionJsonContent({
    content,
    context,
    model,
    jsonSchema,
    repairAttempts: 0,
    repairWarnings: []
  });

  if (!needsRepair(firstResult)) {
    if (firstResult.ok) return firstResult.result;
    firstResult.error.isConditionJsonContentError = true;
    throw firstResult.error;
  }

  const repairWarnings = repairFeedback(firstResult);
  let attemptedRepair = false;
  let repairedResult = null;
  try {
    attemptedRepair = true;
    const repairedContent = await requestConditionJsonContent({
      apiKey,
      provider,
      baseURL,
      model,
      maxTokens,
      timeoutMs,
      context,
      jsonSchema: false,
      responseFormat,
      messages: repairMessages({
        context,
        previousContent: content,
        feedback: repairWarnings
      })
    });
    repairedResult = processConditionJsonContent({
      content: repairedContent,
      context,
      model,
      jsonSchema: false,
      repairAttempts: 1,
      repairWarnings
    });
  } catch (repairError) {
    repairWarnings.push(`self_repair_failed: ${repairError.message}`);
  }

  if (repairedResult && repairedResult.ok) {
    return repairedResult.result;
  }

  if (firstResult.ok) {
    firstResult.result.repairAttempts = attemptedRepair ? 1 : 0;
    firstResult.result.repairWarnings = repairWarnings;
    return firstResult.result;
  }

  if (repairedResult && repairedResult.error) {
    repairWarnings.push(`self_repair_failed: ${repairedResult.error.message}`);
  }
  firstResult.error.message = `${firstResult.error.message}; self repair failed: ${repairWarnings.join('; ')}`;
  firstResult.error.isConditionJsonContentError = true;
  throw firstResult.error;
}

async function requestConditionJsonContent({
  apiKey,
  provider,
  baseURL,
  model,
  maxTokens,
  timeoutMs,
  context,
  jsonSchema,
  responseFormat,
  messages
}) {
  const payload = {
    ...aiRequestOptions({ provider }),
    model,
    messages: messages || [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(context, null, 2) }
    ],
    max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
    temperature: 0,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    stream: false
  };

  if (jsonSchema) {
    payload.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'condition_json',
        schema: CONDITION_JSON_SCHEMA,
        strict: true
      }
    };
  } else if (responseFormat) {
    payload.response_format = { type: 'json_object' };
  }

  // Vertex 的認證是會過期的 OAuth 權杖,所以在每次送出前才解析,不是啟動時取一次。
  const credentials = await resolveAiCredentials({ provider, apiKey });

  const response = await axios.post(`${baseURL}/chat/completions`, payload, {
    timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
    proxy: false,
    headers: {
      Authorization: credentials.authorization,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });

  const content = response.data &&
    response.data.choices &&
    response.data.choices[0] &&
    response.data.choices[0].message &&
    response.data.choices[0].message.content;

  if (!content) {
    throw new Error('AI response did not include message content.');
  }

  return content;
}

function processConditionJsonContent({ content, context, model, jsonSchema, repairAttempts, repairWarnings }) {
  let rawJson;
  try {
    rawJson = parseJsonContent(content);
  } catch (error) {
    return {
      ok: false,
      error,
      parseError: true,
      content,
      repairWarnings,
      repairAttempts
    };
  }

  const conditionJson = normalizeConditionJson(rawJson);
  applyContextHeuristics(conditionJson, context);
  applyEvidenceValidation(conditionJson, context);
  const normalizedConditionJson = normalizeConditionJson(conditionJson);

  return {
    ok: true,
    result: {
      rawJson,
      conditionJson: normalizedConditionJson,
      model,
      usedJsonSchema: Boolean(jsonSchema),
      warnings: [],
      repairAttempts,
      repairWarnings
    }
  };
}

function needsRepair(result) {
  if (MAX_REPAIR_ATTEMPTS < 1) return false;
  if (!result.ok) return Boolean(result.parseError);
  return repairableWarnings(result.result.conditionJson).length > 0;
}

function repairFeedback(result) {
  if (!result.ok) {
    return [`invalid_json: ${result.error.message}`];
  }
  return repairableWarnings(result.result.conditionJson);
}

function repairableWarnings(conditionJson) {
  const warnings = conditionJson &&
    conditionJson.compliance &&
    Array.isArray(conditionJson.compliance.warnings)
    ? conditionJson.compliance.warnings
    : [];

  return warnings.filter((warning) => {
    const value = String(warning || '');
    if (/型態不符/.test(value)) return true;
    if (/schema_|invalid_json|wrong_type|extra_wrapper/.test(value)) return true;
    if (/\\[object Object\\]/.test(value)) return true;
    return false;
  });
}

function repairMessages({ context, previousContent, feedback }) {
  return [
    { role: 'system', content: REPAIR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${JSON.stringify({
        task: 'repair_condition_json_shape_only',
        validator_feedback: feedback,
        previous_output: previousContent,
        original_context: context
      }, null, 2)}`
    }
  ];
}

function applyContextHeuristics(conditionJson, context) {
  const text = collectContextText(context);
  if (!text) return;

  fillLeaseTermDates(conditionJson, text);
  fillDemoProperty(conditionJson, text);
  fillDemoRentAndDeposit(conditionJson, text);
  fillDemoRepairsAndTermination(conditionJson, text);
  fillBoolean(
    conditionJson.use_restrictions,
    'subsidy_application_allowed',
    text,
    /(不可以|不能|不可|不得|不允許|不同意|拒絕).{0,8}(租補|租金補貼)|(租補|租金補貼).{0,8}(不可以|不能|不可|不得|不行|拒絕)/,
    /(租補|租金補貼).{0,12}(可以|可|同意|允許|沒問題)|可以.{0,8}(申請)?(租補|租金補貼)/
  );
  fillBoolean(
    conditionJson.use_restrictions,
    'tax_filing_allowed',
    text,
    /(不可以|不能|不可|不得|不允許|不同意|拒絕).{0,8}(報稅|申報)|(報稅|申報).{0,8}(不可以|不能|不可|不得|不行|拒絕)/,
    /(報稅|申報).{0,12}(可以|可|同意|允許|沒問題)|可以.{0,8}(報稅|申報)/
  );
  fillBoolean(
    conditionJson.use_restrictions,
    'pet_allowed',
    text,
    /(不可以|不能|不可|不得|禁止|不允許).{0,8}(養)?(寵物|貓|狗)|(寵物|貓|狗).{0,8}(不可以|不能|不可|不得|不行|禁止)/,
    /(可以|可|允許|同意).{0,8}(養)?(寵物|貓|狗)|(寵物|貓|狗).{0,8}(可以|可|允許|同意)/
  );
  fillBoolean(
    conditionJson.use_restrictions,
    'sublease_allowed',
    text,
    /(不可以|不能|不可|不得|禁止|不允許).{0,8}(轉租|分租)|(轉租|分租).{0,8}(不可以|不能|不可|不得|不行|禁止)/,
    /(可以|可|允許|同意).{0,8}(轉租|分租)|(轉租|分租).{0,8}(可以|可|允許|同意)/
  );
  fillBoolean(
    conditionJson.use_restrictions,
    'cooking_allowed',
    text,
    /(不可以|不能|不可|不得|禁止|不允許).{0,8}開伙|開伙.{0,8}(不可以|不能|不可|不得|不行|禁止)/,
    /(可以|可|允許|同意).{0,8}開伙|開伙.{0,8}(可以|可|允許|同意)/
  );
  fillBoolean(
    conditionJson.use_restrictions,
    'household_registration_allowed',
    text,
    /(不可以|不能|不可|不得|禁止|不允許).{0,8}(戶籍|遷戶籍|入籍)|(戶籍|遷戶籍|入籍).{0,8}(不可以|不能|不可|不得|不行|禁止)/,
    /(可以|可|允許|同意).{0,8}(戶籍|遷戶籍|入籍)|(戶籍|遷戶籍|入籍).{0,8}(可以|可|允許|同意)/
  );
}

function applyEvidenceValidation(conditionJson, context) {
  if (!conditionJson || !conditionJson.compliance) return;
  const warnings = new Set(conditionJson.compliance.warnings || []);
  const text = collectContextText(context);

  enforceSensitiveRestriction(conditionJson, warnings);
  validateFeeEvidence(conditionJson, text, warnings);
  validateRepairEvidence(conditionJson, text, warnings);
  if (conditionJson.review_period_days_min == null) {
    conditionJson.review_period_days_min = 3;
  }

  warnings.add('needs_human_confirmation: AI 候選整理結果需雙方確認');
  conditionJson.compliance.warnings = [...warnings];
}

function enforceSensitiveRestriction(conditionJson, warnings) {
  const restrictions = conditionJson.use_restrictions || {};
  const sensitiveKeys = [
    'subsidy_application_allowed',
    'tax_filing_allowed',
    'household_registration_allowed'
  ];

  for (const key of sensitiveKeys) {
    if (restrictions[key] === false) {
      restrictions[key] = null;
      warnings.add(`sensitive_rights_restricted: ${key} 不得由 AI 直接判定為 false，需人工確認`);
    }
  }
}

function validateFeeEvidence(conditionJson, text, warnings) {
  const fees = conditionJson.fees || {};
  const rules = [
    ['water_fee', /(水費|水電|自來水|台水)/],
    ['electricity_fee', /(電費|水電|台電|度電|一度)/],
    ['gas_fee', /(瓦斯|天然氣|桶裝瓦斯)/],
    ['internet_fee', /(網路|寬頻|第四台|wifi|wi-fi)/i]
  ];

  for (const [key, evidencePattern] of rules) {
    const fee = fees[key];
    if (!fee) continue;
    const hasValue = Boolean(fee.payer || fee.rule);
    if (!hasValue) continue;
    if (!evidencePattern.test(text)) {
      fee.payer = null;
      fee.rule = null;
      warnings.add(`fee_hallucination: ${key} 原文未提及，已清空疑似自行補值`);
    }
  }
}

function validateRepairEvidence(conditionJson, text, warnings) {
  const repairs = conditionJson.repairs || {};
  repairs.landlord_responsibility = filterRepairItems(
    repairs.landlord_responsibility,
    text,
    warnings,
    'repairs.landlord_responsibility'
  );
  repairs.tenant_responsibility = filterRepairItems(
    repairs.tenant_responsibility,
    text,
    warnings,
    'repairs.tenant_responsibility'
  );
}

function filterRepairItems(items, text, warnings, path) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    const value = String(item || '').trim();
    if (!value) return false;
    if (isOverbroadRepairItem(value, text)) {
      warnings.add(`repair_scope_expanded: ${path}「${value}」疑似擴張修繕責任，已移除`);
      return false;
    }

    const mentionedEquipment = equipmentTerms(value).filter((term) => !text.includes(term));
    if (mentionedEquipment.length) {
      warnings.add(`repair_scope_expanded: ${path}「${value}」包含原文未提及設備「${mentionedEquipment.join('、')}」，已移除`);
      return false;
    }
    return true;
  });
}

function isOverbroadRepairItem(value, text) {
  if (!/(修|修繕|維修|負責|損壞|壞掉)/.test(value)) return false;
  if (/(所有|全部|一切|各項|全屋).{0,6}(設備|家電|修繕|維修)/.test(value)) {
    return !/(所有|全部|一切|各項|全屋).{0,6}(設備|家電|修繕|維修)/.test(text);
  }
  if (/(設備|家電).{0,6}(房東|出租人|房客|承租人).{0,6}(負責|修)/.test(value)) {
    return !/(設備|家電).{0,6}(房東|出租人|房客|承租人).{0,6}(負責|修)/.test(text);
  }
  return false;
}

function equipmentTerms(value) {
  const terms = [
    '冷氣',
    '熱水器',
    '冰箱',
    '洗衣機',
    '電視',
    '瓦斯爐',
    '電磁爐',
    '抽油煙機',
    '床',
    '衣櫃',
    '沙發',
    '桌',
    '椅',
    '馬桶',
    '水龍頭'
  ];
  return terms.filter((term) => value.includes(term));
}

function fillDemoProperty(conditionJson, text) {
  if (!conditionJson || !conditionJson.property) return;
  const property = conditionJson.property;
  const addressMatch = String(text).match(/房屋地址(?:是|為|：|:)?\s*([^。\n，,]+(?:路|街|巷|弄|號)[^。\n，,]*)/);
  if (!property.address_text && addressMatch) property.address_text = addressMatch[1].trim();

  if (!property.rental_type_text) {
    const typeMatch = String(text).match(/(整層住家|獨立套房|分租套房|雅房|透天|公寓|電梯大樓)/);
    if (typeMatch) property.rental_type_text = typeMatch[1];
  }

  if (!property.layout_text) {
    const layoutMatch = String(text).match(/(\d+\s*房\s*\d+\s*廳(?:\s*\d+\s*衛)?)/);
    if (layoutMatch) property.layout_text = layoutMatch[1].replace(/\s+/g, '');
  }

  if (!property.area_ping) {
    const areaMatch = String(text).match(/約?\s*(\d+(?:\.\d+)?)\s*坪/);
    if (areaMatch) property.area_ping = Number(areaMatch[1]);
  }

  if (!property.floor_text) {
    const floorMatch = String(text).match(/(?:位於|在|，|,|\s)(\d+\s*樓)(?:，|,|。|\s|$)/);
    if (floorMatch) property.floor_text = floorMatch[1].replace(/\s+/g, '');
  }
}

function fillDemoRentAndDeposit(conditionJson, text) {
  if (!conditionJson || !conditionJson.rent || !conditionJson.deposit) return;
  const rentMatch = String(text).match(/(?:月租|租金|房租)\s*(?:新臺幣|台幣|NT\$?)?\s*(\d[\d,]*)\s*元?/i);
  if (!conditionJson.rent.monthly_rent_ntd && rentMatch) {
    conditionJson.rent.monthly_rent_ntd = Number(rentMatch[1].replace(/,/g, ''));
  }

  const dueMatch = String(text).match(/每月\s*(\d{1,2})\s*(?:號|日).{0,8}(?:繳租|付款|給付|支付)/);
  if (!conditionJson.rent.payment_due_day && dueMatch) {
    const day = Number(dueMatch[1]);
    if (day >= 1 && day <= 31) conditionJson.rent.payment_due_day = day;
  }

  if (!conditionJson.rent.payment_method && /匯款|轉帳/.test(text)) {
    conditionJson.rent.payment_method = /轉帳/.test(text) ? '轉帳' : '匯款';
  }

  const depositMonthsMatch = String(text).match(/(?:押金|保證金).{0,6}?([一二兩三四五六七八九十\d]+)\s*(?:個)?月/);
  if (!conditionJson.deposit.deposit_months && depositMonthsMatch) {
    const months = numberTextToNumber(depositMonthsMatch[1]);
    if (months) conditionJson.deposit.deposit_months = months;
  }

  if (
    conditionJson.rent.monthly_rent_ntd &&
    conditionJson.deposit.deposit_months &&
    !conditionJson.deposit.deposit_amount_ntd
  ) {
    conditionJson.deposit.deposit_amount_ntd = conditionJson.rent.monthly_rent_ntd * conditionJson.deposit.deposit_months;
  }
}

function fillDemoRepairsAndTermination(conditionJson, text) {
  if (!conditionJson) return;
  const repairs = conditionJson.repairs || {};
  if (Array.isArray(repairs.landlord_responsibility) && !repairs.landlord_responsibility.length && /修繕大項.{0,8}房東負責|房東.{0,8}修繕大項/.test(text)) {
    repairs.landlord_responsibility.push('修繕大項由房東負責');
  }
  if (Array.isArray(repairs.tenant_responsibility) && !repairs.tenant_responsibility.length && /日常耗材.{0,8}房客負責|房客.{0,8}日常耗材/.test(text)) {
    repairs.tenant_responsibility.push('日常耗材由房客負責');
  }

  const termination = conditionJson.termination || {};
  const noticeMatch = String(text).match(/提前(?:終止|解約).{0,12}?提前\s*(\d{1,3})\s*日通知/);
  if (noticeMatch) {
    termination.early_termination_allowed = true;
    termination.notice_days = Number(noticeMatch[1]);
  }
  const penaltyMatch = String(text).match(/(?:違約金|賠償).{0,12}?(?:最高|上限|最多)\s*(\d+(?:\.\d+)?)\s*(?:個)?月/);
  if (penaltyMatch && termination.penalty_months_max == null) {
    termination.penalty_months_max = Number(penaltyMatch[1]);
  }
}

function fillLeaseTermDates(conditionJson, text) {
  if (!conditionJson || !conditionJson.lease_term) return;
  if (conditionJson.lease_term.start_date_roc && conditionJson.lease_term.end_date_roc) return;

  const normalized = String(text || '').replace(/\s+/g, ' ');
  const patterns = [
    /租期.{0,12}?(?:從|自|起)?\s*(?:民國)?(\d{2,4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?\s*(?:到|至|到民國|至民國|~|～|-|－|—)\s*(?:民國)?(\d{2,4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/,
    /(?:民國)?(\d{2,4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?\s*(?:到|至|~|～|-|－|—)\s*(?:民國)?(\d{2,4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?.{0,12}?租期/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const start = toRocDate(match[1], match[2], match[3]);
    const end = toRocDate(match[4], match[5], match[6]);
    if (!start || !end) continue;
    if (!conditionJson.lease_term.start_date_roc) conditionJson.lease_term.start_date_roc = start;
    if (!conditionJson.lease_term.end_date_roc) conditionJson.lease_term.end_date_roc = end;
    return;
  }
}

function toRocDate(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const rocYear = year >= 1912 ? year - 1911 : year;
  if (rocYear < 1 || rocYear > 999) return null;
  return `${rocYear}年${month}月${day}日`;
}

function numberTextToNumber(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const map = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (Object.prototype.hasOwnProperty.call(map, text)) return map[text];
  if (text === '十') return 10;
  const tens = text.match(/^([一二兩三四五六七八九])?十([一二兩三四五六七八九])?$/);
  if (!tens) return null;
  const high = tens[1] ? map[tens[1]] : 1;
  const low = tens[2] ? map[tens[2]] : 0;
  return high * 10 + low;
}

function fillBoolean(target, key, text, negativePattern, positivePattern) {
  if (!target || target[key] != null) return;
  if (negativePattern.test(text)) {
    target[key] = false;
    return;
  }
  if (positivePattern.test(text)) {
    target[key] = true;
  }
}

function collectContextText(context) {
  const chunks = [];
  const messageGroups = [
    context && context.line_messages,
    context && context.messages
  ];
  for (const messages of messageGroups) {
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (typeof message === 'string') {
        chunks.push(message);
      } else if (message && typeof message.text === 'string') {
        chunks.push(message.text);
      } else if (message && typeof message.content === 'string') {
        chunks.push(message.content);
      }
    }
  }
  const records = [
    context && context.rental_listings,
    context && context.file_records,
    context && context.files
  ];
  for (const items of records) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item) continue;
      chunks.push(JSON.stringify(item));
    }
  }
  return chunks.join('\n');
}

module.exports = { extractConditionJson };
