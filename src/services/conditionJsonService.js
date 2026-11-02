const CONDITION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    parties: {
      type: 'object',
      additionalProperties: false,
      properties: {
        landlord: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: ['string', 'null'] },
            id_number: { type: ['string', 'null'] },
            address: { type: ['string', 'null'] },
            phone: { type: ['string', 'null'] }
          },
          required: ['name', 'id_number', 'address', 'phone']
        },
        tenant: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: ['string', 'null'] },
            id_number: { type: ['string', 'null'] },
            address: { type: ['string', 'null'] },
            phone: { type: ['string', 'null'] }
          },
          required: ['name', 'id_number', 'address', 'phone']
        }
      },
      required: ['landlord', 'tenant']
    },
    property: {
      type: 'object',
      additionalProperties: false,
      properties: {
        address_text: { type: ['string', 'null'] },
        rental_type_text: { type: ['string', 'null'] },
        layout_text: { type: ['string', 'null'] },
        area_ping: { type: ['number', 'null'] },
        floor_text: { type: ['string', 'null'] },
        parking: {
          type: 'object',
          additionalProperties: false,
          properties: {
            included: { type: ['boolean', 'null'] },
            description: { type: ['string', 'null'] }
          },
          required: ['included', 'description']
        }
      },
      required: ['address_text', 'rental_type_text', 'layout_text', 'area_ping', 'floor_text', 'parking']
    },
    lease_term: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start_date_roc: { type: ['string', 'null'] },
        end_date_roc: { type: ['string', 'null'] },
        term_months: { type: ['number', 'null'] }
      },
      required: ['start_date_roc', 'end_date_roc', 'term_months']
    },
    rent: {
      type: 'object',
      additionalProperties: false,
      properties: {
        monthly_rent_ntd: { type: ['number', 'null'] },
        payment_due_day: { type: ['number', 'null'] },
        payment_method: { type: ['string', 'null'] },
        bank_account: { type: ['string', 'null'] }
      },
      required: ['monthly_rent_ntd', 'payment_due_day', 'payment_method', 'bank_account']
    },
    deposit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deposit_months: { type: ['number', 'null'] },
        deposit_amount_ntd: { type: ['number', 'null'] }
      },
      required: ['deposit_months', 'deposit_amount_ntd']
    },
    fees: {
      type: 'object',
      additionalProperties: false,
      properties: {
        management_fee: feeSchema(true),
        parking_management_fee: feeSchema(true),
        water_fee: feeSchema(false),
        electricity_fee: feeSchema(false),
        gas_fee: feeSchema(false),
        internet_fee: feeSchema(false)
      },
      required: [
        'management_fee',
        'parking_management_fee',
        'water_fee',
        'electricity_fee',
        'gas_fee',
        'internet_fee'
      ]
    },
    use_restrictions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sublease_allowed: { type: ['boolean', 'null'] },
        pet_allowed: { type: ['boolean', 'null'] },
        cooking_allowed: { type: ['boolean', 'null'] },
        subsidy_application_allowed: { type: ['boolean', 'null'] },
        tax_filing_allowed: { type: ['boolean', 'null'] },
        household_registration_allowed: { type: ['boolean', 'null'] }
      },
      required: [
        'sublease_allowed',
        'pet_allowed',
        'cooking_allowed',
        'subsidy_application_allowed',
        'tax_filing_allowed',
        'household_registration_allowed'
      ]
    },
    repairs: {
      type: 'object',
      additionalProperties: false,
      properties: {
        landlord_responsibility: { type: 'array', items: { type: 'string' } },
        tenant_responsibility: { type: 'array', items: { type: 'string' } }
      },
      required: ['landlord_responsibility', 'tenant_responsibility']
    },
    termination: {
      type: 'object',
      additionalProperties: false,
      properties: {
        early_termination_allowed: { type: ['boolean', 'null'] },
        notice_days: { type: ['number', 'null'] },
        penalty_months_max: { type: ['number', 'null'] }
      },
      required: ['early_termination_allowed', 'notice_days', 'penalty_months_max']
    },
    attachments: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachment_1_property_condition: attachmentWithItemsSchema(),
        attachment_2_sublease_consent: attachmentRequiredOnlySchema(),
        attachment_3_tenant_repair_scope: attachmentWithItemsSchema()
      },
      required: [
        'attachment_1_property_condition',
        'attachment_2_sublease_consent',
        'attachment_3_tenant_repair_scope'
      ]
    },
    special_terms: { type: 'array', items: { type: 'string' } },
    review_period_days_min: { type: ['number', 'null'] },
    compliance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        is_valid: { type: ['boolean', 'null'] },
        errors: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
        missing_fields: { type: 'array', items: { type: 'string' } }
      },
      required: ['is_valid', 'errors', 'warnings', 'missing_fields']
    }
  },
  required: [
    'parties',
    'property',
    'lease_term',
    'rent',
    'deposit',
    'fees',
    'use_restrictions',
    'repairs',
    'termination',
    'attachments',
    'special_terms',
    'review_period_days_min',
    'compliance'
  ]
};

function feeSchema(withAmount) {
  const properties = {
    payer: { type: ['string', 'null'] },
    rule: { type: ['string', 'null'] }
  };
  const required = ['payer', 'rule'];
  if (withAmount) {
    properties.amount_ntd = { type: ['number', 'null'] };
    required.splice(1, 0, 'amount_ntd');
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required
  };
}

function attachmentWithItemsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      required: { type: ['boolean', 'null'] },
      items: { type: 'array', items: { type: 'string' } }
    },
    required: ['required', 'items']
  };
}

function attachmentRequiredOnlySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      required: { type: ['boolean', 'null'] }
    },
    required: ['required']
  };
}

function createEmptyConditionJson() {
  return {
    parties: {
      landlord: { name: null, id_number: null, address: null, phone: null },
      tenant: { name: null, id_number: null, address: null, phone: null }
    },
    property: {
      address_text: null,
      rental_type_text: null,
      layout_text: null,
      area_ping: null,
      floor_text: null,
      parking: { included: null, description: null }
    },
    lease_term: { start_date_roc: null, end_date_roc: null, term_months: null },
    move_in: { date_roc: null },
    rent: {
      monthly_rent_ntd: null,
      payment_due_day: null,
      payment_method: null,
      bank_account: null
    },
    deposit: { deposit_months: null, deposit_amount_ntd: null },
    fees: {
      management_fee: { payer: null, amount_ntd: null, rule: null },
      parking_management_fee: { payer: null, amount_ntd: null, rule: null },
      water_fee: { payer: null, rule: null },
      electricity_fee: { payer: null, rule: null },
      gas_fee: { payer: null, rule: null },
      internet_fee: { payer: null, rule: null }
    },
    use_restrictions: {
      sublease_allowed: null,
      pet_allowed: null,
      cooking_allowed: null,
      subsidy_application_allowed: null,
      tax_filing_allowed: null,
      household_registration_allowed: null
    },
    repairs: {
      landlord_responsibility: [],
      tenant_responsibility: []
    },
    termination: {
      early_termination_allowed: null,
      notice_days: null,
      penalty_months_max: null
    },
    attachments: {
      attachment_1_property_condition: { required: true, items: [] },
      attachment_2_sublease_consent: { required: false },
      attachment_3_tenant_repair_scope: { required: false, items: [] }
    },
    special_terms: [],
    review_period_days_min: 3,
    compliance: {
      is_valid: null,
      errors: [],
      warnings: [],
      missing_fields: []
    }
  };
}

const MISSING_FIELD_LABELS = [
  ['parties.landlord.name', '出租人姓名'],
  ['parties.tenant.name', '承租人姓名'],
  ['property.address_text', '租賃住宅地址'],
  ['property.rental_type_text', '租賃型態'],
  ['lease_term.start_date_roc', '租期起日'],
  ['lease_term.end_date_roc', '租期迄日'],
  ['rent.monthly_rent_ntd', '每月租金'],
  ['rent.payment_due_day', '每月繳租日'],
  ['rent.payment_method', '租金付款方式'],
  ['deposit.deposit_months', '押金月數'],
  ['deposit.deposit_amount_ntd', '押金金額'],
  ['fees.management_fee.payer', '管理費負擔方式'],
  ['fees.water_fee.rule', '水費約定'],
  ['fees.electricity_fee.rule', '電費約定'],
  ['use_restrictions.sublease_allowed', '是否可轉租'],
  ['use_restrictions.subsidy_application_allowed', '是否可申請租金補貼'],
  ['use_restrictions.tax_filing_allowed', '是否可報稅'],
  ['use_restrictions.household_registration_allowed', '是否可遷入戶籍'],
  ['repairs.landlord_responsibility', '房東修繕責任'],
  ['termination.early_termination_allowed', '是否可提前終止租約'],
  ['termination.notice_days', '提前終止通知日數'],
  ['termination.penalty_months_max', '提前終止違約金上限']
];

function parseJsonContent(content) {
  if (typeof content !== 'string') return content;
  const trimmed = content.trim();
  if (trimmed.startsWith('```')) {
    return JSON.parse(trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim());
  }
  return JSON.parse(trimmed);
}

function normalizeConditionJson(rawValue) {
  const warnings = [];
  const value = repairKnownAliases(rawValue && rawValue.condition_json ? rawValue.condition_json : rawValue);
  const base = createEmptyConditionJson();
  mergeKnownShape(base, value || {}, warnings);
  inferDerivedFields(base);
  base.compliance.warnings = [
    ...new Set([...base.compliance.warnings, ...warnings].filter(Boolean).map(String))
  ];
  base.compliance.errors = toStringArray(base.compliance.errors);
  base.special_terms = toStringArray(base.special_terms);
  base.compliance.missing_fields = collectMissingFields(base);
  base.compliance.is_valid = base.compliance.errors.length === 0;
  return base;
}

function repairKnownAliases(value) {
  if (!value || typeof value !== 'object') return value;
  const repaired = JSON.parse(JSON.stringify(value));
  unwrapKnownArrays(repaired);

  if (!repaired.fees && (repaired.management_fee || repaired.parking_management_fee)) {
    repaired.fees = {};
  }
  if (typeof repaired.rent === 'number' || typeof repaired.rent === 'string') {
    repaired.rent = { monthly_rent_ntd: repaired.rent };
  }
  if (typeof repaired.deposit === 'number' || typeof repaired.deposit === 'string') {
    repaired.deposit = { deposit_amount_ntd: repaired.deposit };
  }
  if (repaired.fees && repaired.fees.payment_day != null) {
    repaired.rent = repaired.rent && typeof repaired.rent === 'object' && !Array.isArray(repaired.rent)
      ? repaired.rent
      : {};
    if (repaired.rent.payment_due_day == null) {
      repaired.rent.payment_due_day = repaired.fees.payment_day;
    }
  }
  if (repaired.fees && repaired.fees.parking_management_fee) {
    const parkingFee = repaired.fees.parking_management_fee;
    if (parkingFee.amount_ndt != null && parkingFee.amount_ntd == null) {
      parkingFee.amount_ntd = parkingFee.amount_ndt;
      delete parkingFee.amount_ndt;
    }
  }
  if (repaired.attachments && repaired.attachments.attachment_3_tenant_repair_scopes) {
    if (!repaired.attachments.attachment_3_tenant_repair_scope) {
      repaired.attachments.attachment_3_tenant_repair_scope =
        repaired.attachments.attachment_3_tenant_repair_scopes;
    }
    delete repaired.attachments.attachment_3_tenant_repair_scopes;
  }
  if (!repaired.property && hasAny(repaired, [
    'address_text',
    'rental_type_text',
    'layout_text',
    'area_ping',
    'floor_text',
    'parking'
  ])) {
    repaired.property = {
      address_text: repaired.address_text,
      rental_type_text: repaired.rental_type_text,
      layout_text: repaired.layout_text,
      area_ping: repaired.area_ping,
      floor_text: repaired.floor_text,
      parking: repaired.parking
    };
  }

  normalizeQwenLeaseAliases(repaired);

  return repaired;
}

function normalizeQwenLeaseAliases(value) {
  if (!value || typeof value !== 'object') return;

  if (value.rent && typeof value.rent === 'object' && !Array.isArray(value.rent)) {
    if (value.rent.amount != null && value.rent.monthly_rent_ntd == null) {
      value.rent.monthly_rent_ntd = value.rent.amount;
    }
    if (value.rent.payment_due != null && value.rent.payment_due_day == null) {
      value.rent.payment_due_day = value.rent.payment_due;
    }
    if (value.rent.method != null && value.rent.payment_method == null) {
      value.rent.payment_method = value.rent.method;
    }
  }

  if (value.deposit && typeof value.deposit === 'object' && !Array.isArray(value.deposit)) {
    if (value.deposit.amount != null) {
      const amountText = String(value.deposit.amount);
      if (/月/.test(amountText) && value.deposit.deposit_months == null) {
        value.deposit.deposit_months = value.deposit.amount;
      } else if (value.deposit.deposit_amount_ntd == null) {
        value.deposit.deposit_amount_ntd = value.deposit.amount;
      }
    }
  }

  if (value.use_restrictions && typeof value.use_restrictions === 'object' && !Array.isArray(value.use_restrictions)) {
    const restrictions = value.use_restrictions;
    if (restrictions.pets_allowed != null && restrictions.pet_allowed == null) {
      restrictions.pet_allowed = restrictions.pets_allowed;
    }
    if (restrictions.allow_pet != null && restrictions.pet_allowed == null) {
      restrictions.pet_allowed = restrictions.allow_pet;
    }
    if (restrictions.pets != null && restrictions.pet_allowed == null) {
      restrictions.pet_allowed = restrictions.pets;
    }
    if (restrictions.subletting_allowed != null && restrictions.sublease_allowed == null) {
      restrictions.sublease_allowed = restrictions.subletting_allowed;
    }
    if (restrictions.allow_subletting != null && restrictions.sublease_allowed == null) {
      restrictions.sublease_allowed = restrictions.allow_subletting;
    }
    if (restrictions.subletting != null && restrictions.sublease_allowed == null) {
      restrictions.sublease_allowed = restrictions.subletting;
    }
    if (restrictions.allow_cooking != null && restrictions.cooking_allowed == null) {
      restrictions.cooking_allowed = restrictions.allow_cooking;
    }
    if (restrictions.purpose != null && restrictions.cooking_allowed == null) {
      const purpose = String(restrictions.purpose);
      if (/不可開伙|不得開伙|不可以開伙|禁.*開伙/.test(purpose)) {
        restrictions.cooking_allowed = false;
      } else if (/可開伙|可以開伙|允許開伙/.test(purpose)) {
        restrictions.cooking_allowed = true;
      }
    }
  }

  if (value.repairs && typeof value.repairs === 'object' && !Array.isArray(value.repairs)) {
    if (value.repairs.landlord_obligations != null && value.repairs.landlord_responsibility == null) {
      value.repairs.landlord_responsibility = value.repairs.landlord_obligations;
    }
    if (value.repairs.tenant_obligations != null && value.repairs.tenant_responsibility == null) {
      value.repairs.tenant_responsibility = value.repairs.tenant_obligations;
    }
  }

  if (value.termination && typeof value.termination === 'object' && !Array.isArray(value.termination)) {
    if (value.termination.notice_period != null && value.termination.notice_days == null) {
      value.termination.notice_days = value.termination.notice_period;
    }
    if (value.termination.early_termination != null && value.termination.early_termination_allowed == null) {
      value.termination.early_termination_allowed = value.termination.early_termination;
    }
  }

  if (value.attachments && typeof value.attachments === 'object' && !Array.isArray(value.attachments)) {
    const attachment = value.attachments;
    if (attachment.inventory != null && !attachment.attachment_1_property_condition) {
      attachment.attachment_1_property_condition = {
        required: true,
        items: toStringArray(attachment.inventory)
      };
    }
    if (attachment.handover_list != null && !attachment.attachment_1_property_condition) {
      attachment.attachment_1_property_condition = {
        required: true,
        items: toStringArray(attachment.handover_list)
      };
    }
  }
}

function unwrapKnownArrays(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (Array.isArray(value[key]) && value[key].length === 1 && value[key][0] && typeof value[key][0] === 'object') {
      value[key] = value[key][0];
    }
    if (value[key] && typeof value[key] === 'object') {
      unwrapKnownArrays(value[key]);
    }
  }
}

function hasAny(value, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function mergeKnownShape(target, source, warnings, path = '') {
  if (!source || typeof source !== 'object') return;

  for (const key of Object.keys(target)) {
    const sourceKey = Object.prototype.hasOwnProperty.call(source, key)
      ? key
      : findAliasKey(source, key);
    if (!sourceKey) continue;
    const currentPath = path ? `${path}.${key}` : key;
    const sourceValue = source[sourceKey];

    if (Array.isArray(target[key])) {
      target[key] = toStringArray(sourceValue);
    } else if (target[key] && typeof target[key] === 'object') {
      if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
        mergeKnownShape(target[key], sourceValue, warnings, currentPath);
      } else {
        warnings.push(`${currentPath} 型態不符，已保留預設值`);
      }
    } else if (typeof target[key] === 'number' || typeof target[key] === 'boolean' || target[key] === null) {
      target[key] = normalizeScalar(sourceValue, currentPath);
    } else {
      target[key] = sourceValue == null ? null : String(sourceValue);
    }
  }
}

function findAliasKey(source, key) {
  const aliases = {
    address_text: ['address', 'property_address', '地址'],
    rental_type_text: ['rental_type', 'type', '租賃型態', '房屋型態'],
    layout_text: ['layout', 'rooms', '格局'],
    area_ping: ['area', '坪數'],
    floor_text: ['floor', '樓層'],
    monthly_rent_ntd: ['amount', 'monthly_rent', 'rent', 'rent_ntd', '租金', '月租'],
    payment_due_day: ['payment_due', 'due_day', 'payment_day', '繳租日'],
    payment_method: ['method', '付款方式'],
    deposit_months: ['months', '押金月數'],
    deposit_amount_ntd: ['amount', 'deposit_amount', '押金金額'],
    sublease_allowed: ['allow_subletting', 'subletting_allowed', 'subletting', 'sublease', '轉租'],
    pet_allowed: ['allow_pet', 'pets_allowed', 'pets', 'pet', '寵物'],
    cooking_allowed: ['allow_cooking', 'purpose', 'cooking', '開伙'],
    subsidy_application_allowed: ['subsidy_application', 'subsidy_allowed', 'allow_subsidy', 'subsidy', 'rent_subsidy', '租補', '租金補貼'],
    tax_filing_allowed: ['tax_allowed', 'tax', 'tax_filing', '報稅'],
    household_registration_allowed: ['household_registration', '戶籍'],
    landlord_responsibility: ['landlord_obligations'],
    tenant_responsibility: ['tenant_obligations'],
    early_termination_allowed: ['early_termination', '提前解約'],
    notice_days: ['notice_period', 'notice', '通知天數'],
    penalty_months_max: ['penalty', '違約金']
  };
  return (aliases[key] || []).find((alias) => Object.prototype.hasOwnProperty.call(source, alias));
}

function inferDerivedFields(conditionJson) {
  const rent = conditionJson.rent.monthly_rent_ntd;
  const dueDay = conditionJson.rent.payment_due_day;
  const method = conditionJson.rent.payment_method;
  const depositMonths = conditionJson.deposit.deposit_months;
  const depositAmount = conditionJson.deposit.deposit_amount_ntd;

  if (dueDay == null && method) {
    conditionJson.rent.payment_due_day = toNumberOrNull(method);
  }
  if (method && /匯款/.test(method)) {
    conditionJson.rent.payment_method = '匯款';
  }
  if (rent && depositAmount && depositMonths == null && depositAmount % rent === 0) {
    conditionJson.deposit.deposit_months = depositAmount / rent;
  }
  if (rent && depositMonths && depositAmount == null) {
    conditionJson.deposit.deposit_amount_ntd = rent * depositMonths;
  }
  if (conditionJson.review_period_days_min == null) {
    conditionJson.review_period_days_min = 3;
  }
}

function normalizeScalar(value, path) {
  if (value == null || value === '') return null;
  if (path.endsWith('_allowed') || path.endsWith('.required') || path.endsWith('.included')) {
    return toBooleanOrNull(value);
  }
  if (
    path.endsWith('_ntd') ||
    path.endsWith('_months') ||
    path.endsWith('_day') ||
    path.endsWith('_days') ||
    path.endsWith('_days_min') ||
    path.endsWith('_max') ||
    path.endsWith('_ping')
  ) {
    return toNumberOrNull(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return flatten(value).join(' ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toBooleanOrNull(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^(false|no|n|0)$/i.test(trimmed)) return false;
    if (/不可|不得|不可以|不允許|不同意|禁止|否|無|沒有/.test(trimmed)) return false;
    if (/^(true|yes|y|1)$/i.test(trimmed)) return true;
    if (/可以|可|允許|同意|是|有/.test(trimmed)) return true;
  }
  return null;
}

function toNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/,/g, '');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (match) return Number(match[0]);
  return chineseNumberToNumber(normalized);
}

function chineseNumberToNumber(value) {
  const text = String(value || '').replace(/[個个月月前後號日天]/g, '');
  const map = {
    零: 0,
    一: 1,
    二: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  if (Object.prototype.hasOwnProperty.call(map, text)) return map[text];
  if (text === '十') return 10;
  const tens = text.match(/^([一二兩三四五六七八九])?十([一二兩三四五六七八九])?$/);
  if (tens) {
    const high = tens[1] ? map[tens[1]] : 1;
    const low = tens[2] ? map[tens[2]] : 0;
    return high * 10 + low;
  }
  return null;
}

function toStringArray(value) {
  return flatten(value).map(valueToText).filter(Boolean);
}

function flatten(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return [value];
  return value.flatMap(flatten);
}

function valueToText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return toStringArray(value).join('、');
  if (typeof value === 'object') {
    const preferredKeys = [
      'text',
      'value',
      'description',
      'rule',
      'responsibility',
      'scope',
      'item',
      'equipment',
      'payer'
    ];
    const preferred = preferredKeys
      .map((key) => value[key])
      .filter((item) => item != null && item !== '')
      .map(valueToText)
      .filter(Boolean);
    if (preferred.length) return preferred.join('，');

    return Object.entries(value)
      .filter(([, item]) => item != null && item !== '')
      .map(([key, item]) => `${labelForObjectKey(key)}:${valueToText(item)}`)
      .filter(Boolean)
      .join('，');
  }
  return String(value).trim();
}

function labelForObjectKey(key) {
  const labels = {
    air_conditioner: '冷氣',
    ac: '冷氣',
    water_heater: '熱水器',
    refrigerator: '冰箱',
    fridge: '冰箱',
    washing_machine: '洗衣機',
    tv: '電視',
    gas_stove: '瓦斯爐',
    induction_cooker: '電磁爐',
    range_hood: '抽油煙機',
    daily_consumables: '日常耗材',
    consumables: '耗材',
    landlord: '房東',
    tenant: '房客',
    repair: '修繕',
    repairs: '修繕',
    responsibility: '責任',
    description: '描述'
  };
  return labels[key] || key;
}

function collectMissingFields(conditionJson) {
  return MISSING_FIELD_LABELS
    .filter(([path]) => isMissing(getByPath(conditionJson, path)))
    .map(([, label]) => label);
}

function getByPath(value, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), value);
}

function isMissing(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

module.exports = {
  CONDITION_JSON_SCHEMA,
  // 逐欄來源判定會清空沒有依據的欄位,清空後必須重算缺漏清單。
  // 不能改用 normalizeConditionJson:它會用「租金 × 月數」把剛清掉的押金金額
  // 再推算回來,等於繞過來源判定。所以這裡把缺漏計算單獨開放出去。
  collectMissingFields,
  createEmptyConditionJson,
  normalizeConditionJson,
  parseJsonContent
};
