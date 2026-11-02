-- 房客每一次低於刊登價的出價,以及系統怎麼處理。還價只能一次,要靠這張表記住
-- 「這筆詢問已經還過價」;不然房客接受還價時,系統又會再還一次。
CREATE TABLE IF NOT EXISTS rent_negotiations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  source_message_id INTEGER REFERENCES messages(id),
  listed_rent_amount INTEGER NOT NULL CHECK (listed_rent_amount > 0),
  offered_rent_amount INTEGER NOT NULL CHECK (offered_rent_amount > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'countered', 'declined', 'escalated')),
  counter_rent_amount INTEGER CHECK (counter_rent_amount IS NULL OR counter_rent_amount > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((outcome = 'countered') = (counter_rent_amount IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_rent_negotiations_inquiry
  ON rent_negotiations(inquiry_id, outcome);
