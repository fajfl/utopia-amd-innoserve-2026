function normalize(text) {
  return String(text || '').trim();
}

function inferRepairRisk(description) {
  const text = normalize(description);
  // 只有明確安全危險才走緊急通道；一般家電「漏水」不應自動當成緊急。
  if (/(瓦斯味|聞到.{0,8}瓦斯|瓦斯.{0,8}(?:洩|漏)|漏氣|冒煙|火花|觸電|焦味|(?:電線|插座).{0,12}(?:焦|煙|火花)|嚴重漏水|大量漏水|水管爆|淹水|積水.{0,12}(?:插座|電器)|無法關門|門鎖.{0,8}(?:壞|故障)|斷電.{0,8}(?:全屋|整戶))/.test(text)) {
    return {
      priority: 'urgent',
      label: '高風險',
      reason: '描述包含安全、用電、瓦斯、漏水或出入安全風險，需優先處理。',
    };
  }
  if (/(不能用|壞掉|故障|破|裂|掉了|卡住|堵塞|不冷|不熱|異音|鬆脫|接觸不良)/.test(text)) {
    return {
      priority: 'normal',
      label: '一般報修',
      reason: '描述像是一般設備或家具故障，需依租約與照片判斷責任。',
    };
  }
  return {
    priority: 'normal',
    label: '待補資料',
    reason: '目前描述較少，建議補充損壞時間、使用情境與照片。',
  };
}

function inferRepairDamageType(description) {
  const text = normalize(description);
  if (/(我弄壞|不小心|摔(?:落|壞)?|撞(?:擊|壞)?|踩|打破|剪破|刷破|自己(?:拆|裝)|拆裝不當|人為|寵物|小孩|弄破|弄斷|搬動(?:或移動)?後|移動後|搬動[／/]拆裝後|外力[、，／/]?(?:小孩|寵物)|(?:外力|寵物|小孩).{0,10}(?:造成|破壞|撞|咬|抓)|跳床)/.test(text)) {
    return 'tenant_fault';
  }
  if (/(故意|惡意|破壞)/.test(text)) {
    return 'malicious_damage';
  }
  // 「正常使用中突然異常」與「設備自然老化」在規則庫中是兩種可分別
  // 對應的原因。前者應優先命中 normal_use / normal_failure 規則，不能
  // 因為過去把兩者混在一起而退回 unknown 的保守規則。
  if (/(正常使用|突然壞|沒有碰|自己壞|正常使用中突然異常|使用一段時間後發現)/.test(text)) {
    return 'normal_use';
  }
  if (/(老舊|自然|用久|磨損|年久|耗材|入住時已存在|入住時已有痕跡)/.test(text)) {
    return 'natural_wear';
  }
  if (/(不能用|故障|壞掉|破|裂|漏水|堵塞|不冷|不熱|接觸不良)/.test(text)) {
    return 'unknown';
  }
  return 'unknown';
}

function toCauseClassification(damageType) {
  return {
    natural_wear: 'natural_wear',
    normal_use: 'normal_failure',
    tenant_fault: 'tenant_negligence',
    malicious_damage: 'intentional_damage',
    unknown: 'unknown',
  }[damageType] || 'unknown';
}

function toLegacyDamageType(causeClassification) {
  return {
    natural_wear: 'natural_wear',
    normal_failure: 'normal_use',
    tenant_negligence: 'tenant_fault',
    intentional_damage: 'malicious_damage',
    external_cause: 'unknown',
    unknown: 'unknown',
  }[causeClassification] || 'unknown';
}

function labelParty(value) {
  return {
    none: '無可歸責方',
    landlord: '房東',
    tenant: '房客',
    shared: '雙方分攤',
    vendor: '師傅／廠商',
    building_management: '管委會',
    third_party: '第三方',
    pending: '待確認',
    review_required: '待確認',
    insufficient_info: '資訊不足',
  }[value] || '待確認';
}

function labelCause(value) {
  return {
    natural_wear: '自然耗損',
    normal_failure: '正常使用故障',
    tenant_negligence: '房客過失／不當使用',
    intentional_damage: '故意破壞',
    external_cause: '外部因素',
    unknown: '原因待確認',
  }[value] || '原因待確認';
}

function buildMissingInfo({ description, photoCount, asset, damageType }) {
  const missing = [];
  const text = normalize(description);
  if (!normalize(description)) missing.push('損壞描述');
  if (!Number(photoCount)) missing.push('損壞照片');
  if (!asset) missing.push('對應家具／設備');
  if (damageType === 'unknown') {
    // Tenant supplements are deliberately stored with a 「補件」 prefix so
    // the audit trail remains readable.  Treat those structured fields as the
    // same evidence as the original-report fields during reassessment.
    const hasUsageContext = /(?:補件)?使用情境：/.test(text) && !/(?:補件)?使用情境：不確定/.test(text);
    const hasDamageTiming = /(?:(?:補件)?損壞時間|(?:補件)?發生時間)：/.test(text)
      && !/(?:(?:補件)?損壞時間|(?:補件)?發生時間)：不確定/.test(text);
    if (!hasUsageContext || !hasDamageTiming) {
      missing.push('使用情境與損壞時間');
    } else {
      // 入住點交資料能協助比對既有損傷，但不該是每一件一般故障
      // 都必須具備的門檻。資訊完整但原因仍未知時，交由專業判斷即可。
      missing.push('維修人員判斷或更清楚的故障現象');
    }
  }
  return missing;
}

function isConcreteContractAsset(asset) {
  const name = normalize(asset && asset.asset_name);
  // 「其他」是報修表單的暫存分類，並不是租約已列出的設備。
  // 在使用者補上真正品項前，絕不能拿它去套用任一設備的預設責任。
  return Boolean(name) && !/^(其他|其他項目|其他家具(?:／設備)?|未分類|未知設備)$/.test(name);
}

function ruleSource(rule) {
  const pathValue = String(rule?.source_clause_path || '');
  if (pathValue.startsWith('system:')) return 'legal_default';
  if (pathValue.startsWith('unit-default:')) return 'unit_default';
  return 'contract_rule';
}

function buildResponsibilityFromRule(rule, damageType, asset = null) {
  const causeClassification = toCauseClassification(damageType);
  // 「其他」或尚未對應到點交設備時，不能偷偷套用任一設備的自然耗損預設。
  // 這時系統只知道有一件報修，不知道它究竟是哪一項租約設備。
  if (!isConcreteContractAsset(asset)) {
    return {
      source: 'no_rule',
      policy: 'review_required',
      label: '尚未對應到租約家具／設備',
      causeClassification,
      liabilityParty: 'review_required',
      dispatchParty: 'review_required',
      payerParty: 'review_required',
      confidence: 0.2,
      contractBasis: '本案尚未對應到租約或點交清單中的家具／設備，因此不能套用任何一方應負擔的設備規則。請先確認項目，必要時建立本案例外處理。',
    };
  }
  if (!rule) {
    if (damageType === 'tenant_fault' || damageType === 'malicious_damage') {
      return {
        source: 'legal_default',
        policy: 'tenant_fault_possible',
        label: '可能需釐清房客責任',
        causeClassification,
        liabilityParty: 'tenant',
        dispatchParty: 'review_required',
        payerParty: 'tenant',
        confidence: 0.58,
        contractBasis: '未找到可直接套用的租約條款；依一般原則，房客故意、過失或不當使用造成的損壞，可能需由房客負擔，仍需照片與使用情境佐證。',
      };
    }
    if (damageType === 'natural_wear' || damageType === 'normal_use') {
      return {
        source: 'legal_default',
        policy: 'landlord_default',
        label: '可能屬房東修繕／負擔',
        causeClassification,
        liabilityParty: 'none',
        dispatchParty: 'landlord',
        payerParty: 'landlord',
        confidence: 0.58,
        contractBasis: '未找到可直接套用的租約條款；依一般原則，自然損壞或正常使用造成的故障，通常由房東修繕與負擔。這是修繕義務，不代表房東造成損壞。',
      };
    }
    return {
      source: 'no_rule',
      policy: 'review_required',
      label: '無對應租約規則',
      causeClassification,
      liabilityParty: 'review_required',
      dispatchParty: 'review_required',
      payerParty: 'review_required',
      confidence: damageType === 'unknown' ? 0.35 : 0.5,
      contractBasis: '目前沒有找到可直接套用的修繕責任規則；需建立本次例外處理紀錄，或回頭補齊該房源／設備的租約規則。',
    };
  }

  const ruleCause = rule.cause_classification || toCauseClassification(rule.damage_type);
  // 設備規則可能是「若經確認為房客不當使用才適用」的條件式規則。
  // 在原因尚未確認時，不能把條件本身誤顯示成「房客已可歸責」。
  const conditionalCause = ['tenant_negligence', 'intentional_damage'].includes(ruleCause);
  const inferredTenantCause = ['tenant_fault', 'malicious_damage'].includes(damageType);
  const inferredNaturalCause = ['natural_wear', 'normal_use'].includes(damageType);
  const ruleHasConcreteLiability = rule.liability_party
    && !['review_required', 'pending', 'insufficient_info'].includes(rule.liability_party);
  // 有些房源先只有「設備存在」或通用法規 baseline，尚未把每一種正常故障
  // 寫成獨立規則。房客已明確回報正常使用中突然故障時，不能因此一直被導到
  // 補件／例外處理；此時套用出租人修繕義務的預設方向，後續若有相反證據再重判。
  if (inferredNaturalCause && !conditionalCause && !ruleHasConcreteLiability) {
    return {
      source: ruleSource(rule),
      policy: 'rule_matched',
      label: '依一般修繕規則：正常使用故障，房東修繕／房東負擔',
      causeClassification,
      liabilityParty: 'none',
      dispatchParty: 'landlord',
      payerParty: 'landlord',
      confidence: 0.62,
      contractBasis: `${rule.source_text || '已找到對應設備規則。'} 本次回報為正常使用中發生的故障，且目前沒有房客不當使用的事證；先依出租人修繕義務安排處理。`,
      ruleId: rule.id,
      rulePublicId: rule.public_id,
    };
  }
  // 「房客不當使用時由房客負擔」是例外規則，而不是把所有故障都先算給房客。
  // 當房客回報的是正常使用／自然耗損，仍可先依出租人修繕義務安排處理；
  // 此處的 liabilityParty=none 表示沒有任何一方被認定為造成損壞，並非房東有過失。
  if (conditionalCause && inferredNaturalCause) {
    return {
      source: ruleSource(rule),
      policy: 'rule_matched',
      label: '依規則初判：正常使用故障，房東修繕／房東負擔',
      causeClassification,
      liabilityParty: 'none',
      dispatchParty: 'landlord',
      payerParty: 'landlord',
      confidence: 0.62,
      contractBasis: `${rule.source_text || '已找到對應修繕規則。'} 目前回報為正常使用或自然耗損，尚未出現房客不當使用的事證；可先由房東安排修繕，若後續有相反證據再重新判斷。`,
      ruleId: rule.id,
      rulePublicId: rule.public_id,
    };
  }
  if (conditionalCause && !inferredTenantCause) {
    return {
      source: ruleSource(rule),
      policy: 'review_required',
      label: '已找到條件式規則，待確認損壞原因',
      causeClassification: inferredNaturalCause ? causeClassification : 'unknown',
      liabilityParty: 'review_required',
      dispatchParty: 'review_required',
      payerParty: 'review_required',
      confidence: 0.42,
      contractBasis: `${rule.source_text || '已找到對應修繕規則。'} 此規則僅在損壞原因符合條件時適用，目前尚未確認原因，不能直接判定任何一方負擔。`,
      ruleId: rule.id,
      rulePublicId: rule.public_id,
    };
  }

  // 即使設備的預設規則是「正常故障由房東修繕」，房客已明確回報搬動、
  // 寵物、外力或不當使用時，也不應再把案件退回成「原因未知」。這裡只是
  // 產生可供房客接受／異議的初判，並不直接認定最終賠償金額。
  if (inferredTenantCause) {
    return {
      source: String(rule.source_clause_path || '').startsWith('system:') ? 'legal_default' : 'contract_rule',
      policy: 'tenant_fault_possible',
      label: '依目前回報：房客可能可歸責，待確認處理方案',
      causeClassification,
      liabilityParty: 'tenant',
      dispatchParty: 'review_required',
      payerParty: 'tenant',
      confidence: 0.66,
      contractBasis: `${rule.source_text || '已找到對應設備規則。'} 本次回報包含搬動、外力、寵物或不當使用等情境；系統先提出房客可能可歸責的處理方案，房客仍可補充資料或提出異議。`,
      ruleId: rule.id,
      rulePublicId: rule.public_id,
    };
  }

  const liabilityParty = rule.liability_party || (
    rule.damage_type === 'natural_wear' || rule.damage_type === 'normal_use'
      ? 'none'
      : rule.responsible_party
  ) || 'review_required';
  const dispatchParty = rule.dispatch_party || rule.repair_executor || 'review_required';
  const payerParty = rule.payer_party || 'review_required';
  const ruleMatched = liabilityParty !== 'review_required';
  const label = ruleMatched
    ? liabilityParty === 'none'
      ? `依規則初判：${labelCause(ruleCause)}，${labelParty(dispatchParty)}修繕／${labelParty(payerParty)}負擔`
      : `依規則初判：${labelParty(liabilityParty)}可歸責，${labelParty(dispatchParty)}修繕／${labelParty(payerParty)}負擔`
    : '規則保守處理：待房東／維修確認';

  return {
    source: ruleSource(rule),
    policy: ruleMatched ? 'rule_matched' : 'review_required',
    label,
    causeClassification: ruleCause,
    liabilityParty,
    dispatchParty,
    payerParty,
    confidence: ruleMatched ? 0.78 : 0.45,
    contractBasis: rule.source_text || '已找到對應修繕規則。',
    ruleId: rule.id,
    rulePublicId: rule.public_id,
  };
}

function buildRecommendedAction({ responsibility, missing, risk }) {
  if (risk.priority === 'urgent') {
    return '偵測到明確安全風險，請先停止使用、聯絡房東或專業人員；危險解除後再補照片與處理紀錄。';
  }
  if (responsibility.source === 'no_rule' && missing.length) {
    return `目前同時有兩件事：租約／房源規則沒有對應條款，且證據不足（${missing.join('、')}）；請先補資料並建立本次例外處理紀錄。`;
  }
  if (responsibility.source === 'no_rule') {
    return '租約／房源規則沒有對應條款，請建立本次例外處理紀錄；若確認為常見情境，之後可補進該房源規則。';
  }
  if (missing.length) {
    return `目前證據不足，請補充：${missing.join('、')}；這不代表規則沒寫，而是還不能可靠套用規則。`;
  }
  if (responsibility.liabilityParty === 'none' && responsibility.payerParty === 'landlord') {
    return '此案較像修繕義務：可由房東派修或依合約允許房客代修，費用原則由房東負擔。';
  }
  if (responsibility.liabilityParty === 'tenant') {
    return '需通知房客確認責任與費用條件；房客可接受、拒絕或補充說明。';
  }
  return '目前不直接判定，請建立本次例外處理紀錄，並保留雙方確認內容。';
}

function buildRepairAssistantAnalysis({
  description,
  photoCount = 0,
  unitLabel,
  asset = null,
  rule = null,
  tenantPreference = 'no_preference',
  moveInEvidence = null,
} = {}) {
  const cleanDescription = normalize(description);
  const risk = inferRepairRisk(cleanDescription);
  const damageType = inferRepairDamageType(cleanDescription);
  const causeClassification = toCauseClassification(damageType);
  const responsibility = buildResponsibilityFromRule(rule, damageType, asset);
  const missing = buildMissingInfo({ description: cleanDescription, photoCount, asset, damageType, moveInEvidence });
  const recommendedAction = buildRecommendedAction({ responsibility, missing, risk });
  const tenantPreferenceLabel = {
    tenant_self_repair: '房客傾向自修',
    landlord_repair: '房客希望房東處理',
    no_preference: '房客尚未表達修繕方式',
  }[tenantPreference] || '房客尚未表達修繕方式';

  const legalBasis = '台灣現行原則：自然損壞、正常使用造成的故障通常由房東修繕與負擔；房客故意、過失或不當使用造成則可能由房客負擔。租約特別約定必須在不違反強制／禁止規定及住宅租賃定型化契約規範前提下才適用。';
  const contractBasis = responsibility.contractBasis;
  const ruleRefs = responsibility.rulePublicId ? [responsibility.rulePublicId] : [];
  const evidenceStatus = missing.length ? 'insufficient' : 'sufficient';
  const ruleMatchStatus = responsibility.source === 'no_rule'
    ? 'missing'
    : responsibility.policy === 'review_required'
      ? 'needs_review'
      : 'matched';
  const legacyResponsibilityGuess = responsibility.liabilityParty === 'none'
    ? 'review_required'
    : responsibility.liabilityParty === 'review_required'
      ? 'review_required'
      : responsibility.liabilityParty || 'insufficient_info';

  return {
    risk,
    damageType,
    causeClassification: responsibility.causeClassification || causeClassification,
    responsibility,
    missing,
    recommendedAction,
    tenantPreference,
    legalBasis,
    contractBasis,
    ruleRefs,
    moveInEvidence: moveInEvidence || { status: 'unavailable', label: '尚無已完成點交照片可比對' },
    assessment: {
      riskLevel: risk.priority,
      ruleMatchStatus,
      evidenceStatus,
      causeClassification: responsibility.causeClassification || causeClassification,
      liabilityParty: responsibility.liabilityParty,
      recommendedDispatchParty: responsibility.dispatchParty,
      recommendedPayerParty: responsibility.payerParty,
      responsibilityGuess: legacyResponsibilityGuess,
      recommendedExecutor: responsibility.dispatchParty,
      recommendedPayer: responsibility.payerParty,
      confidence: responsibility.confidence,
      missingInfo: missing,
    },
    summaryLines: [
      `AI 初判：${risk.label}｜${responsibility.label}`,
      `報修設備：${asset?.asset_name || '尚未對應到設備'}`,
      `房客意願：${tenantPreferenceLabel}`,
      `建議：${recommendedAction}`,
    ],
    recordText: [
      `AI 協商摘要：${unitLabel || '未指定房源'}`,
      `報修內容：${cleanDescription || '尚未填寫'}`,
      `損壞照片：${Number(photoCount) || 0} 張`,
      `對應設備：${asset?.asset_name || '待補資料'}`,
      `房客意願：${tenantPreferenceLabel}`,
      `初判：${risk.label}；${responsibility.label}`,
      `建議：${recommendedAction}`,
      `依據：${contractBasis || legalBasis}`,
      missing.length ? `待補：${missing.join('、')}` : '待補：無',
    ].join('\n'),
  };
}

module.exports = {
  buildRepairAssistantAnalysis,
  inferRepairRisk,
  inferRepairDamageType,
  toCauseClassification,
  toLegacyDamageType,
};
