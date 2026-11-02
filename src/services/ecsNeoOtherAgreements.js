const MAX_AGREEMENTS = 10;
const MAX_AGREEMENT_LENGTH = 200;

function otherAgreements(value) {
  const items = typeof value === 'string' ? value.split(/\r?\n/).filter((text) => text.trim()) : value;
  if (!Array.isArray(items) || items.length > MAX_AGREEMENTS || items.some((item) =>
    typeof item !== 'string' || !item.trim() || [...item.trim()].length > MAX_AGREEMENT_LENGTH)) {
    const error = new Error('其他約定最多 10 條，每條須為 1 至 200 字；請分行列出並修改後再送出。');
    error.code = 'invalid_other_agreements';
    error.statusCode = 400;
    throw error;
  }
  return [...new Set(items.map((item) => item.trim()))];
}

module.exports = { otherAgreements, MAX_AGREEMENTS, MAX_AGREEMENT_LENGTH };
