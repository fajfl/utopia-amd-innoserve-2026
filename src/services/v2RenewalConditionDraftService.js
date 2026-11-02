function numberFrom(text) {
  if (!text) return null;
  const value = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function shiftLeasePeriod(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const durationDays = Math.round((end - start) / 86400000);
  const nextStart = new Date(end);
  nextStart.setUTCDate(nextStart.getUTCDate() + 1);
  const nextEnd = new Date(nextStart);
  nextEnd.setUTCDate(nextEnd.getUTCDate() + durationDays);
  return {
    startDate: nextStart.toISOString().slice(0, 10),
    endDate: nextEnd.toISOString().slice(0, 10)
  };
}

function singleDateIntent(normalized) {
  const datePattern = '20\\d{2}[\\/-]\\d{1,2}[\\/-]\\d{1,2}';
  const endDatePattern = new RegExp(
    `(?:續(?:租)?到|延長到|租期\\s*(?:到|至)|截止(?:至|到)?|到期(?:日)?(?:為|到|至)?|結束(?:日)?(?:為|到|至)?)\\s*[:：]?\\s*${datePattern}`
  );
  if (endDatePattern.test(normalized)) return 'end';
  return 'ambiguous';
}

function parseWithDiagnostics({ text, currentRentAmount, currentDepositAmount, currentStartDate, currentEndDate }) {
  const normalized = String(text || '').trim();
  if (!normalized) return { draft: null, error: '請輸入需要調整的續約條件。' };
  const rentMatch = /(?:月租|租金)\s*(?:調整為|改為|為|[:：])?\s*(?:NT\$?)?\s*([0-9][0-9,]*)/i.exec(normalized);
  const depositAmountMatch = /押金\s*(?:調整為|改為|為|[:：])?\s*(?:NT\$?)?\s*([0-9][0-9,]*)\s*(?:元)?(?!\s*個?月)/i.exec(normalized);
  const depositMonthsMatch = /押金\s*(?:調整為|改為|為|[:：])?\s*([0-9]+)\s*個?月/i.exec(normalized);
  const dates = [...normalized.matchAll(/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})/g)]
    .map((match) => `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`);
  const shifted = shiftLeasePeriod(currentStartDate, currentEndDate);
  const rentAmount = numberFrom(rentMatch && rentMatch[1]) ?? Number(currentRentAmount);
  let depositAmount = numberFrom(depositAmountMatch && depositAmountMatch[1]);
  if (depositAmount === null && depositMonthsMatch) depositAmount = rentAmount * Number(depositMonthsMatch[1]);
  if (depositAmount === null) depositAmount = currentDepositAmount === null ? null : Number(currentDepositAmount);
  let startDate = shifted.startDate;
  let endDate = shifted.endDate;
  let dateInferenceNotice = null;
  if (dates.length >= 2) {
    [startDate, endDate] = dates;
  } else if (dates.length === 1) {
    if (singleDateIntent(normalized) !== 'end') {
      return {
        draft: null,
        error: `我只抓到一個日期 ${dates[0]}，無法確認是起租日或到期日。請輸入完整租期，例如「租期 ${shifted.startDate} 到 ${shifted.endDate}」。`
      };
    }
    endDate = dates[0];
    dateInferenceNotice = `只偵測到到期日，系統已將起租日設為 ${shifted.startDate}。`;
  }
  if (!Number.isFinite(rentAmount) || startDate > endDate) {
    return { draft: null, error: '續約租期或租金無法成立，請確認後重新輸入完整條件。' };
  }
  return { draft: {
    startDate,
    endDate,
    rentAmount,
    depositAmount,
    note: normalized,
    dateInferenceNotice,
    renewalNegotiable: true
  }, error: null };
}

function parse(input) {
  return parseWithDiagnostics(input).draft;
}

module.exports = { parse, parseWithDiagnostics, shiftLeasePeriod };
