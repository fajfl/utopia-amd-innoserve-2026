-- 房東可看房時段 + 房東規則排序。**這一份是主檔**,SQLite 版是它的鏡像。
--
-- Production 的真相在 TiDB Cloud,所以資料型別、約束與交易語意都先照這裡定,
-- database/migrations/014_*.sql 再跟著調整成 SQLite 能跑的等價形式。
--
-- 下面每一個決定都是照 `node scripts/inspect-tidb-schema.js` 讀回來的**實際**雲端
-- schema 定的,不是照本機 SQLite 檔推論的。2026-08-24 讀到的重點:
--
--   @@tidb_enable_check_constraint = 1     → CHECK 是真的會擋的,不是裝飾
--   @@tidb_txn_mode = pessimistic          → UPDATE 會鎖列,條件式占用可靠
--   @@sql_mode 含 STRICT_TRANS_TABLES      → 超長字串會報錯而不是截斷
--   showing_appointments.id                → bigint AUTO_INCREMENT,FK 接得上
--   listings.id / users.id                 → 同樣是 bigint,FK 接得上
--   showing_appointments.starts_at         → longtext,存 'YYYY-MM-DDTHH:MM' 牆上時間
--   既有資料表**都有** FOREIGN KEY 與 CHECK  → 新表沿用同樣的強度,不降級
--
-- 兩個刻意的選擇:
--
-- 1. starts_at 用 VARCHAR(32) 而不是 DATETIME。
--    既有的 showing_appointments.starts_at 是 longtext,存的是瀏覽器 datetime-local
--    給的**牆上時間字串**(沒有時區)。改用 DATETIME 會讓 mysql2 在 dateStrings 之下
--    回 '2026-07-20 14:00:00'(空格分隔),跟全專案的 'T' 分隔字串比較與顯示全部對不上。
--    VARCHAR 保留同一個格式,而且比 longtext 好:longtext 不能建索引,VARCHAR(32) 可以,
--    這張表正需要 (listing_id, starts_at) 的唯一索引。字典序等於時間序,兩個方言都成立。
--
-- 2. 併發控制放在 showing_slots 這一列上,不放在 showing_appointments。
--    一列只能有一個 held_appointment_id,「同一個時段同時被兩位房客拿走」在資料庫層
--    就不可能發生,不需要 SELECT ... FOR UPDATE(SQLite 沒有)。占用一律用條件式
--    UPDATE(WHERE status='open' AND held_appointment_id IS NULL)並檢查 affectedRows;
--    TiDB 的悲觀交易會讓後到的那一筆卡在列鎖上,解鎖後重讀條件、比對到 0 列,回 409。
--
-- 兩個方向的關聯都要:
--   showing_slots.held_appointment_id  目前占用者,釋出後回 NULL
--   showing_appointments.slot_id       這筆預約當初選的時段,永久保留不清空(稽核用)
--
-- 重跑安全性:TiDB 的 DDL 每句自動 commit,檔案跑到一半失敗,前面的語句會留著。
-- 除了 ADD CONSTRAINT 之外都用了 IF NOT EXISTS。ADD CONSTRAINT 沒有 IF NOT EXISTS,
-- 所以重跑前若上一輪已經建到那一行,要先
--   ALTER TABLE showing_appointments DROP FOREIGN KEY fk_showing_appointments_slot_id;
-- 再重跑。務必先 `npm run db:tidb:migrate -- --dry-run`。

CREATE TABLE IF NOT EXISTS showing_slots (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  listing_id BIGINT NOT NULL,
  created_by_user_id BIGINT NOT NULL,
  starts_at VARCHAR(32) NOT NULL,
  ends_at VARCHAR(32) DEFAULT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'open',
  held_appointment_id BIGINT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_showing_slots_public_id (public_id),
  -- 同一房源同一開始時間只會有一個時段,房東重複建立直接撞唯一約束。
  UNIQUE KEY uq_showing_slots_listing_starts (listing_id, starts_at),
  -- 一筆預約最多只能占著一個時段。NULL 不參與唯一性,釋出後的時段不受限。
  UNIQUE KEY uq_showing_slots_held_appointment (held_appointment_id),
  KEY ix_showing_slots_listing_status (listing_id, status, starts_at),
  KEY fk_showing_slots_created_by_user_id (created_by_user_id),
  CONSTRAINT fk_showing_slots_listing_id FOREIGN KEY (listing_id) REFERENCES listings (id),
  CONSTRAINT fk_showing_slots_created_by_user_id FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_showing_slots_held_appointment_id FOREIGN KEY (held_appointment_id) REFERENCES showing_appointments (id),
  CONSTRAINT chk_showing_slots_status CHECK (status IN ('open', 'booked', 'closed')),
  -- 依 migrations-tidb/README.md:不寫 `ends_at IS NULL OR ...` 這個前綴。
  -- CHECK 本來就只在運算式為 FALSE 時拒絕,NULL 一律放行。
  CONSTRAINT chk_showing_slots_range CHECK (ends_at >= starts_at),
  -- 「booked 就一定有人占著、不是 booked 就一定沒人占著」寫成約束,不只寫在程式裡。
  -- 兩側都是 0/1,沒有 NULL 誤判問題;既有的 chk_knowledge_versions_tbl_2 是同一種寫法。
  CONSTRAINT chk_showing_slots_held CHECK ((status = 'booked') = (held_appointment_id IS NOT NULL))
);

ALTER TABLE showing_appointments ADD COLUMN IF NOT EXISTS slot_id BIGINT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS ix_showing_appointments_slot ON showing_appointments (slot_id);

ALTER TABLE showing_appointments
  ADD CONSTRAINT fk_showing_appointments_slot_id FOREIGN KEY (slot_id) REFERENCES showing_slots (id);

-- 房東規則排序。舊資料的預設順序必須是確定的:先把 sort_order 補成 id,
-- 排序鍵 (sort_order, created_at, id) 套上去之後與改版前的隱含順序完全一致。
-- 新規則一律取同一個 rental_unit 目前的 MAX(sort_order) + 10,不會落回 0,
-- 所以 WHERE sort_order = 0 重跑時不會再動到任何一列。
ALTER TABLE landlord_rules ADD COLUMN IF NOT EXISTS sort_order BIGINT NOT NULL DEFAULT 0;

UPDATE landlord_rules SET sort_order = id WHERE sort_order = 0;

CREATE INDEX IF NOT EXISTS ix_landlord_rules_unit_order
  ON landlord_rules (rental_unit_id, status(32), sort_order, id);
