// 房客端「詢問進度」要用的那一支查詢，driver 版本。
//
// 刻意**只搬這一支**。v2LandlordContactRepository.js 另外 11 支都是房東端
// （聯絡房客、待回覆問題、房東的房源清單）在用，那一塊還沒上雲端，貓貓要搬的
// 時候再一起處理。兩份共存期間，同步版是唯一真相，這裡有任何行為調整都要同步回去。
//
// 房東端那 11 支裡有 5 處 `datetime(...)`，TiDB 沒有這個純量函式。搬的人第一時間
// 就會撞到，詳見 docs/project/open-findings.md。

// 原本的 SQL 有一個只在 TiDB 才會爆的問題：`SELECT * FROM ( ... ) ORDER BY`
// 的子查詢**沒有別名**。SQLite 完全接受，TiDB 直接回
// "Every derived table must have its own alias"。這裡補上 `timeline`。
const HISTORY_BY_INQUIRY = `
  SELECT * FROM (
    SELECT
      'tenant' AS role,
      m.sent_at AS time,
      COALESCE(m.text_content, '（圖片/檔案）') AS content,
      l.title AS listing_title,
      (SELECT id FROM landlord_questions WHERE source_message_id = m.id LIMIT 1) AS question_id,
      (SELECT status FROM landlord_questions WHERE source_message_id = m.id LIMIT 1) AS question_status
    FROM messages m
    JOIN inquiries i ON i.id = m.inquiry_id
    JOIN listings l ON l.id = i.listing_id
    WHERE i.id = ? AND m.direction = 'inbound'

    UNION ALL

    SELECT
      'landlord_reply' AS role,
      a.answered_at AS time,
      a.answer_text AS content,
      l.title AS listing_title,
      a.landlord_question_id AS question_id,
      NULL AS question_status
    FROM landlord_answers a
    JOIN landlord_questions q ON q.id = a.landlord_question_id
    JOIN inquiries i ON i.id = q.inquiry_id
    JOIN listings l ON l.id = i.listing_id
    WHERE q.inquiry_id = ?

    UNION ALL

    SELECT
      'landlord_proactive' AS role,
      m.sent_at AS time,
      COALESCE(m.text_content, '（圖片/檔案）') AS content,
      l.title AS listing_title,
      NULL AS question_id,
      NULL AS question_status
    FROM messages m
    JOIN inquiries i ON i.id = m.inquiry_id
    JOIN listings l ON l.id = i.listing_id
    WHERE i.id = ? AND m.direction = 'outbound'
  ) timeline
  ORDER BY time DESC
  LIMIT ?
`;

function getTenantContactHistoryByInquiry(db, inquiryId, limit = 10) {
  return db.all(HISTORY_BY_INQUIRY, [inquiryId, inquiryId, inquiryId, limit]);
}

module.exports = { getTenantContactHistoryByInquiry };
