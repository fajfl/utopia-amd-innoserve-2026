-- 週期性可看房時段(「每週四 20:00-22:00 都可以」)。**這一份是主檔**,SQLite 版是鏡像。
--
-- 為什麼要一張規則表,而不是只在 showing_slots 上加個 rrule 字串:
--
-- 1. 房客端一列都不改。listAvailableSlotsForInquiry 只認得 showing_slots 的實際列,
--    所以規則的角色是**產生器**:建立時就把區間展開成一般的 showing_slots,
--    每一列該有的 status / held_appointment_id / 唯一約束全部照舊。
--    房東停掉某一天、房客預約某一天、房東拒絕某一天,走的都是既有那三支 SQL。
--
-- 2. 展開必須有硬邊界。until_date 是 NOT NULL,而且路由把它夾在
--    「今天 + 84 天」以內,同一條規則最多產生 60 個時段。沒有邊界的話,
--    「每週四」會是一個無限序列,不是資料。
--
-- 3. 邊界既然有限,展開就一次做完:建立(或更新)規則時把 until_date 之前的時段
--    全部寫進去。因此**不需要背景 job**,也不需要在房客查詢時補展開 ——
--    後者會讓讀路徑變成寫路徑,而房客端這輪明確不改。
--
-- 重跑同一條規則(相同 listing + weekday + start_time)是更新而不是新增:
-- uq_showing_slot_recurrences_key 讓「改」有唯一的落點,路由收到重複的 key 時
-- 先把該規則未被使用的未來時段收掉,再用新參數重新展開。展開時會跳過
-- 已存在的 starts_at,所以重跑不會撞 uq_showing_slots_listing_starts,也不會產生重複列。
--
-- 型別沿用 014:時刻用 VARCHAR 存牆上時間字串(字典序 = 時間序),不用 TIME/DATETIME。
-- mysql2 開了 dateStrings,DATETIME 讀回來是空格分隔,跟全專案的 'T' 字串比不起來。
--
-- 重跑注意:ALTER TABLE ... ADD CONSTRAINT 沒有 IF NOT EXISTS。若上一輪已跑到那一行,
-- 重跑前先:
--   ALTER TABLE showing_slots DROP FOREIGN KEY fk_showing_slots_recurrence_id;

CREATE TABLE IF NOT EXISTS showing_slot_recurrences (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  listing_id BIGINT NOT NULL,
  created_by_user_id BIGINT NOT NULL,
  -- 0 = 週日,與 JS 的 Date#getDay 一致(見 services/showingSlotTime.js 的 weekdayOf)。
  weekday TINYINT NOT NULL,
  start_time VARCHAR(5) NOT NULL,
  end_time VARCHAR(5) NOT NULL,
  slot_minutes INT NOT NULL DEFAULT 60,
  -- 規則的硬邊界,含當天。NOT NULL 是刻意的:沒有邊界的週期規則不允許存在。
  until_date VARCHAR(10) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_showing_slot_recurrences_public_id (public_id),
  -- 同一房源同一星期同一開始時刻只會有一條規則,重複送出就是「改這一條」。
  UNIQUE KEY uq_showing_slot_recurrences_key (listing_id, weekday, start_time),
  KEY ix_showing_slot_recurrences_listing (listing_id, status, weekday, start_time),
  KEY fk_showing_slot_recurrences_created_by (created_by_user_id),
  CONSTRAINT fk_showing_slot_recurrences_listing_id
    FOREIGN KEY (listing_id) REFERENCES listings (id),
  CONSTRAINT fk_showing_slot_recurrences_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_showing_slot_recurrences_weekday CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT chk_showing_slot_recurrences_minutes CHECK (slot_minutes BETWEEN 15 AND 480),
  -- 'HH:MM' 零補位,字串比較等於時間比較。一天之內不跨午夜。
  CONSTRAINT chk_showing_slot_recurrences_range CHECK (end_time > start_time),
  CONSTRAINT chk_showing_slot_recurrences_status CHECK (status IN ('active', 'inactive'))
);

-- 展開出來的時段要認得回自己的規則:停用規則時才知道該收哪些列,
-- 也才能在清單上把「這是每週四那條」跟房東手動加的單次時段分開顯示。
-- NULL = 房東手動建立的單次時段,不受任何規則管。
ALTER TABLE showing_slots ADD COLUMN IF NOT EXISTS recurrence_id BIGINT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS ix_showing_slots_recurrence
  ON showing_slots (recurrence_id, starts_at);

ALTER TABLE showing_slots
  ADD CONSTRAINT fk_showing_slots_recurrence_id
  FOREIGN KEY (recurrence_id) REFERENCES showing_slot_recurrences (id);
