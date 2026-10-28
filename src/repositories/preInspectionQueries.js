// 合約附件一需要讀屋況紀錄,但屋況點交功能本身還跑在同步的 better-sqlite3 上。
// 把這三句共用的 SQL 抽出來寫一次,同步與 driver 兩條路徑各自薄薄地執行,
// 避免為了遷移合約而在兩個地方各留一份查詢。
//
// preInspectionRepository 的公開 API 與其 4 個同步呼叫端都不受影響。

const SESSION_ENTRIES = `
  SELECT e.*, i.item_name AS inspection_item_name, i.note AS inspection_item_note,
         i.status AS inspection_item_status
  FROM pre_inspection_entries e
  LEFT JOIN pre_inspection_items i ON i.id = e.inspection_item_id
  WHERE e.session_id = ?
  ORDER BY e.created_at ASC
  LIMIT ?
`;

const SUPPLEMENT_SESSIONS = `
  SELECT * FROM pre_inspection_sessions
  WHERE parent_session_id = ? AND status = 'sealed' AND record_type = 'supplement'
  ORDER BY id ASC
`;

const SESSION_BY_PUBLIC_ID = `
  SELECT * FROM pre_inspection_sessions WHERE public_id = ?
`;

module.exports = {
  SESSION_BY_PUBLIC_ID,
  SESSION_ENTRIES,
  SUPPLEMENT_SESSIONS,

  // driver 版本:合約遷移期間由 v2ContractConditionRepositoryAsync 使用。
  async getSessionEntries(driver, sessionId, limit = 10) {
    return driver.all(SESSION_ENTRIES, [sessionId, limit]);
  },
  async getSupplementSessions(driver, parentSessionId) {
    return driver.all(SUPPLEMENT_SESSIONS, [parentSessionId]);
  },
  async getSessionByPublicId(driver, publicId) {
    return driver.get(SESSION_BY_PUBLIC_ID, [publicId]);
  }
};
