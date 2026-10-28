-- 週期性可看房時段(SQLite 方言)。
--
-- **主檔是 database/migrations-tidb/029_showing_slot_recurrences.sql。**
-- 設計理由(為什麼是產生器而不是 rrule 字串、為什麼 until_date 是 NOT NULL、
-- 為什麼展開一次做完不用背景 job)全部寫在主檔,改動時請先改那一份。
--
-- 兩邊刻意保持一致的地方:
--   欄位與順序、兩個唯一約束、weekday / slot_minutes / 時刻範圍 / status 的 CHECK。
-- 兩邊必然不同的地方:
--   BIGINT AUTO_INCREMENT / TINYINT / INT ↔ INTEGER
--   VARCHAR(n)                            ↔ TEXT
--   DATETIME DEFAULT CURRENT_TIMESTAMP    ↔ TEXT DEFAULT CURRENT_TIMESTAMP
--   具名 FOREIGN KEY                       ↔ 欄位層 REFERENCES

CREATE TABLE IF NOT EXISTS showing_slot_recurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  -- 0 = 週日,與 JS 的 Date#getDay 一致(見 services/showingSlotTime.js 的 weekdayOf)。
  weekday INTEGER NOT NULL,
  start_time TEXT NOT NULL,              -- HH:MM 牆上時刻,零補位,字典序 = 時間序
  end_time TEXT NOT NULL,
  slot_minutes INTEGER NOT NULL DEFAULT 60,
  until_date TEXT NOT NULL,              -- YYYY-MM-DD,規則的硬邊界(含當天)
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (weekday BETWEEN 0 AND 6),
  CHECK (slot_minutes BETWEEN 15 AND 480),
  CHECK (end_time > start_time),
  CHECK (status IN ('active', 'inactive'))
);

-- 同一房源同一星期同一開始時刻只會有一條規則,重複送出就是「改這一條」。
CREATE UNIQUE INDEX IF NOT EXISTS uq_showing_slot_recurrences_key
  ON showing_slot_recurrences(listing_id, weekday, start_time);

CREATE INDEX IF NOT EXISTS ix_showing_slot_recurrences_listing
  ON showing_slot_recurrences(listing_id, status, weekday, start_time);

-- NULL = 房東手動建立的單次時段,不受任何規則管。
ALTER TABLE showing_slots ADD COLUMN recurrence_id INTEGER REFERENCES showing_slot_recurrences(id);

CREATE INDEX IF NOT EXISTS ix_showing_slots_recurrence
  ON showing_slots(recurrence_id, starts_at);
