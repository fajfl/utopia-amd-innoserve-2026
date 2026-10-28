// 比對兩個資料庫 id 是否為同一筆。
//
// tidbPool 設了 supportBigNumbers,mysql2 在 id 超過 Number.MAX_SAFE_INTEGER 時
// 回傳字串而不是數字。此時 '9007199254740993' !== 9007199254740993 恆為真,
// 用 === / !== 直接比會把同一筆判成不同筆。
// 路由參數帶進來的 id 也是字串,同樣會踩到。
//
// null / undefined 一律視為不相等 —— 「查不到」不等於「是同一筆」。

function idEquals(left, right) {
  if (left === null || left === undefined) return false;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

module.exports = { idEquals };
