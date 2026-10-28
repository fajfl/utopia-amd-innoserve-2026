// shortcut: 僅解析明確金額、月數與加收；其他自然語句留待確認，草稿仍有法規檢查。
function depositWarning(text, { rentAmount, depositAmount } = {}) {
  const source = String(text).normalize('NFKC').replace(/[,，]/g, '');
  const number = (token) => ({ 半: 0.5, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[token] ?? Number(token));
  const matches = [...source.matchAll(/押金\s*(多收|加收|增加|另收|多加|改為|調整為|為|收|要|是|共)?\s*(?:新臺幣|新台幣|NT\$)?\s*([0-9]+(?:\.[0-9]+)?|[半一二兩三四五六七八九十])\s*(個?月(?:半)?|元|萬)/gi)];
  for (const match of matches) {
    const relative = /多收|加收|增加|另收|多加/.test(match[1] || '');
    const months = match[3].includes('月');
    let value = number(match[2]);
    if (months && match[3].endsWith('半')) value += 0.5;
    const rent = Number(rentAmount);
    const amount = months ? value * rent : value * (match[3] === '萬' ? 10000 : 1);
    if ((!relative && months && value > 2) || (rent > 0 &&
        (relative ? Number(depositAmount) + amount : amount) > 2 * rent)) {
      return '這項押金要求超過兩個月租金。住宅租賃押金不得超過兩個月租金總額，請調整後再回覆；這次尚未送給房客，也未加入知識庫。';
    }
    if (relative && (depositAmount == null || !(rent > 0))) {
      return '目前無法確認加收後的押金總額，請改寫為押金總金額或總月數（最高兩個月），再重新送出。';
    }
  }
  return null;
}

async function warningForLandlord(db, { questionPublicId, listingPublicId, text }) {
  const listing = await db.get(`SELECT l.current_rent_amount,l.current_deposit_amount,
      (SELECT iv.rent_amount FROM intention_versions iv JOIN rental_intentions ri ON ri.id=iv.rental_intention_id
       WHERE ri.inquiry_id=q.inquiry_id ORDER BY iv.id DESC LIMIT 1) AS rent_amount,
      (SELECT iv.deposit_amount FROM intention_versions iv JOIN rental_intentions ri ON ri.id=iv.rental_intention_id
       WHERE ri.inquiry_id=q.inquiry_id ORDER BY iv.id DESC LIMIT 1) AS deposit_amount
    FROM listings l LEFT JOIN landlord_questions q ON q.listing_id=l.id AND q.public_id=?
    WHERE l.public_id=?`, [questionPublicId || '', listingPublicId]);
  return depositWarning(text, {
    rentAmount: listing?.rent_amount ?? listing?.current_rent_amount,
    depositAmount: listing?.deposit_amount ?? listing?.current_deposit_amount
  });
}

module.exports = { depositWarning, warningForLandlord };
