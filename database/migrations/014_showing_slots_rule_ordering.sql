-- 房東可看房時段 + 房東規則排序(SQLite 方言)。
--
-- **主檔是 database/migrations-tidb/014_showing_slots_rule_ordering.sql。**
-- Production 的真相在 TiDB Cloud;這一份是讓本機與測試跑得起來的等價鏡像,
-- 設計理由、型別選擇與併發模型全部寫在主檔裡,改動時請先改那一份。
--
-- 兩邊刻意保持一致的地方:
--   欄位與順序、三個唯一約束、狀態與範圍的 CHECK、held/status 的一致性 CHECK。
-- 兩邊必然不同的地方:
--   BIGINT AUTO_INCREMENT ↔ INTEGER PRIMARY KEY AUTOINCREMENT
--   VARCHAR(n)            ↔ TEXT(SQLite 無長度概念,showing_appointments 也是 TEXT)
--   DATETIME              ↔ TEXT DEFAULT CURRENT_TIMESTAMP
--   具名 FOREIGN KEY       ↔ 欄位層 REFERENCES(SQLite 的 FK 名稱沒有用途)
--   ends_at >= starts_at  ↔ ends_at IS NULL OR ends_at >= starts_at
--     TiDB 那邊照 migrations-tidb/README.md 拿掉 NULL 前綴;SQLite 這邊沿用專案既有
--     寫法(見 004 的 calendar_events),兩者語意相同:NULL 一律放行。
--
-- SQLite 的 ALTER TABLE 沒有 ADD COLUMN IF NOT EXISTS。這裡不需要:SQLite runner 用
-- schema_migrations 判斷版本,而且整個檔案包在 BEGIN IMMEDIATE 裡,失敗整批回捲,
-- 不會留下半套 schema。TiDB 那邊 DDL 會自動 commit,所以主檔用了 IF NOT EXISTS。

CREATE TABLE IF NOT EXISTS showing_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,               -- 與 showing_appointments.starts_at 同格式:YYYY-MM-DDTHH:MM
  ends_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'closed')),
  held_appointment_id INTEGER REFERENCES showing_appointments(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CHECK ((status = 'booked') = (held_appointment_id IS NOT NULL))
);

-- 同一房源同一開始時間只會有一個時段,房東重複建立會直接撞唯一約束。
CREATE UNIQUE INDEX IF NOT EXISTS uq_showing_slots_listing_starts
  ON showing_slots(listing_id, starts_at);

-- 一筆預約最多只能占著一個時段。NULL 不參與唯一性,所以釋出後的時段不受限。
CREATE UNIQUE INDEX IF NOT EXISTS uq_showing_slots_held_appointment
  ON showing_slots(held_appointment_id);

CREATE INDEX IF NOT EXISTS ix_showing_slots_listing_status
  ON showing_slots(listing_id, status, starts_at);

ALTER TABLE showing_appointments ADD COLUMN slot_id INTEGER REFERENCES showing_slots(id);

CREATE INDEX IF NOT EXISTS ix_showing_appointments_slot
  ON showing_appointments(slot_id);

-- 房東規則排序。舊資料的預設順序必須是確定的:先把 sort_order 補成 id,
-- 排序鍵 (sort_order, created_at, id) 套上去之後與改版前的隱含順序完全一致。
-- 新規則一律取同一個 rental_unit 目前的 MAX(sort_order) + 10,不會落回 0,
-- 所以 WHERE sort_order = 0 重跑時不會再動到任何一列。
ALTER TABLE landlord_rules ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE landlord_rules SET sort_order = id WHERE sort_order = 0;

CREATE INDEX IF NOT EXISTS ix_landlord_rules_unit_order
  ON landlord_rules(rental_unit_id, status, sort_order, id);
