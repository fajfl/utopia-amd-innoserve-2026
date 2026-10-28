-- 修繕預約也使用房東既有的可用時段。
--
-- showing_slots 原本的 held_appointment_id 專屬看房預約，不能把 calendar_events
-- 硬塞進去。這張關聯表保留兩邊既有稽核資料，並讓同一個 slot 只能由看房或修繕
-- 其中一方占用。程式會在同一交易內先鎖定 showing_slots，再建立此 reservation。

CREATE TABLE repair_slot_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  showing_slot_id INTEGER NOT NULL REFERENCES showing_slots(id),
  calendar_event_id INTEGER NOT NULL REFERENCES calendar_events(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(showing_slot_id),
  UNIQUE(calendar_event_id)
);

CREATE INDEX ix_repair_slot_reservations_slot
  ON repair_slot_reservations(showing_slot_id);

CREATE INDEX ix_repair_slot_reservations_event
  ON repair_slot_reservations(calendar_event_id);
