const { sha256 } = require('./hashService');

const UNKNOWN = '尚未確認';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function valueText(value) {
  if (value == null) return UNKNOWN;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.join('、') : UNKNOWN;
  const text = String(value).trim();
  return text || UNKNOWN;
}

function money(value) {
  if (typeof value !== 'number') return UNKNOWN;
  return `${value.toLocaleString('zh-TW')} 元`;
}

function boolAllowed(value, yesText = '同意', noText = '不同意') {
  if (value == null) return UNKNOWN;
  return value ? yesText : noText;
}

function feeText(fee, withAmount = false) {
  if (!fee) return UNKNOWN;
  const parts = [];
  if (fee.payer) parts.push(`由${fee.payer}負擔`);
  if (withAmount && typeof fee.amount_ntd === 'number') {
    parts.push(`金額 ${money(fee.amount_ntd)}`);
  }
  if (fee.rule) parts.push(valueText(fee.rule));
  return parts.length ? parts.join('，') : UNKNOWN;
}

function renderDraftHtml(conditionJson) {
  const c = conditionJson;
  const missing = c.compliance && Array.isArray(c.compliance.missing_fields)
    ? c.compliance.missing_fields
    : [];

  const html = `
    <article class="contract-draft">
      <header>
        <p class="eyebrow">ECS NEO AI 候選整理結果</p>
        <h1>住宅租賃契約書草稿</h1>
        <p class="notice">本草稿依 LINE 群組協商紀錄、房源資料與案件檔案紀錄整理產生，尚待房東與房客逐條確認，不能視為最終租約條款。</p>
      </header>

      ${section('立契約書人', `
        <p>出租人：${escapeHtml(valueText(c.parties.landlord.name))}，身分證字號或統一編號：${escapeHtml(valueText(c.parties.landlord.id_number))}，聯絡電話：${escapeHtml(valueText(c.parties.landlord.phone))}，地址：${escapeHtml(valueText(c.parties.landlord.address))}。</p>
        <p>承租人：${escapeHtml(valueText(c.parties.tenant.name))}，身分證字號或統一編號：${escapeHtml(valueText(c.parties.tenant.id_number))}，聯絡電話：${escapeHtml(valueText(c.parties.tenant.phone))}，地址：${escapeHtml(valueText(c.parties.tenant.address))}。</p>
      `)}

      ${section('第一條 租賃住宅標示', `
        <p>租賃住宅地址：${escapeHtml(valueText(c.property.address_text))}。</p>
        <p>租賃型態：${escapeHtml(valueText(c.property.rental_type_text))}；格局：${escapeHtml(valueText(c.property.layout_text))}；坪數：${escapeHtml(valueText(c.property.area_ping))} 坪；樓層：${escapeHtml(valueText(c.property.floor_text))}。</p>
        <p>停車位：${escapeHtml(boolAllowed(c.property.parking.included, '包含', '不包含'))}。${escapeHtml(valueText(c.property.parking.description))}</p>
      `)}

      ${section('第二條 租賃期間', `
        <p>租賃期間自民國 ${escapeHtml(valueText(c.lease_term.start_date_roc))} 起至民國 ${escapeHtml(valueText(c.lease_term.end_date_roc))} 止，共 ${escapeHtml(valueText(c.lease_term.term_months))} 個月。</p>
      `)}

      ${section('第三條 租金與押金', `
        <p>每月租金為新臺幣 ${escapeHtml(money(c.rent.monthly_rent_ntd))}，承租人應於每月 ${escapeHtml(valueText(c.rent.payment_due_day))} 日前給付。</p>
        <p>付款方式：${escapeHtml(valueText(c.rent.payment_method))}；帳戶資訊：${escapeHtml(valueText(c.rent.bank_account))}。</p>
        <p>押金為 ${escapeHtml(valueText(c.deposit.deposit_months))} 個月租金，金額為新臺幣 ${escapeHtml(money(c.deposit.deposit_amount_ntd))}。</p>
      `)}

      ${section('第四條 費用負擔', `
        <p>管理費：${escapeHtml(feeText(c.fees.management_fee, true))}。</p>
        <p>停車管理費：${escapeHtml(feeText(c.fees.parking_management_fee, true))}。</p>
        <p>水費：${escapeHtml(feeText(c.fees.water_fee))}。</p>
        <p>電費：${escapeHtml(feeText(c.fees.electricity_fee))}。</p>
        <p>瓦斯費：${escapeHtml(feeText(c.fees.gas_fee))}。</p>
        <p>網路費：${escapeHtml(feeText(c.fees.internet_fee))}。</p>
      `)}

      ${section('第五條 使用限制與申請事項', `
        <p>轉租：${escapeHtml(boolAllowed(c.use_restrictions.sublease_allowed, '可轉租', '不得轉租'))}；寵物：${escapeHtml(boolAllowed(c.use_restrictions.pet_allowed, '可飼養', '不得飼養'))}；開伙：${escapeHtml(boolAllowed(c.use_restrictions.cooking_allowed, '可開伙', '不得開伙'))}。</p>
        <p>租金補貼：${escapeHtml(boolAllowed(c.use_restrictions.subsidy_application_allowed, '可申請', '不可申請'))}；報稅：${escapeHtml(boolAllowed(c.use_restrictions.tax_filing_allowed, '可報稅', '不可報稅'))}；戶籍遷入：${escapeHtml(boolAllowed(c.use_restrictions.household_registration_allowed, '可遷入', '不可遷入'))}。</p>
      `)}

      ${section('第六條 修繕責任', `
        <p>出租人負責：${escapeHtml(valueText(c.repairs.landlord_responsibility))}。</p>
        <p>承租人負責：${escapeHtml(valueText(c.repairs.tenant_responsibility))}。</p>
      `)}

      ${section('第七條 提前終止租約', `
        <p>是否得提前終止：${escapeHtml(boolAllowed(c.termination.early_termination_allowed, '得提前終止', '不得提前終止'))}。</p>
        <p>通知期間：${escapeHtml(valueText(c.termination.notice_days))} 日；違約金上限：${escapeHtml(valueText(c.termination.penalty_months_max))} 個月租金。</p>
      `)}

      ${section('第八條 附件與特約事項', `
        <p>房屋現況附件：${escapeHtml(boolAllowed(c.attachments.attachment_1_property_condition.required, '需要', '不需要'))}；項目：${escapeHtml(valueText(c.attachments.attachment_1_property_condition.items))}。</p>
        <p>轉租同意附件：${escapeHtml(boolAllowed(c.attachments.attachment_2_sublease_consent.required, '需要', '不需要'))}。</p>
        <p>承租人修繕範圍附件：${escapeHtml(boolAllowed(c.attachments.attachment_3_tenant_repair_scope.required, '需要', '不需要'))}；項目：${escapeHtml(valueText(c.attachments.attachment_3_tenant_repair_scope.items))}。</p>
        <p>其他特約：${escapeHtml(valueText(c.special_terms))}。</p>
      `)}

      ${section('第九條 契約審閱與確認', `
        <p>建議契約審閱期至少 ${escapeHtml(valueText(c.review_period_days_min))} 日。</p>
        <p>本頁為 AI 候選整理結果，正式簽署前仍需由雙方確認條款內容。</p>
      `)}

      ${missing.length ? section('尚未確認事項', `
        <ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      `) : ''}
    </article>
  `;

  return {
    html,
    hash: sha256(html)
  };
}

function section(title, content) {
  return `
    <section class="contract-section">
      <h2>${escapeHtml(title)}</h2>
      ${content}
    </section>
  `;
}

module.exports = { renderDraftHtml };
