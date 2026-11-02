function normalizeRuleInput(value) {
  const originalText = String(value || '').replace(/\s+/g, ' ').trim();
  if (!originalText) throw new Error('請輸入要補充的房源規則。');
  if (originalText.length > 1000) throw new Error('輸入內容過長，請縮短後再試。');
  return {
    adapter: 'deterministic-demo',
    originalText,
    candidates: [{ topic: '房東補充', content: originalText, ruleType: 'other' }]
  };
}
module.exports = { normalizeRuleInput };
