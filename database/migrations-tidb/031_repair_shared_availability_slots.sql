-- 修繕預約共用房東可用時段。SQLite 對應檔在 database/migrations/031_*.sql。
--
-- 不改寫 showing_slots.held_appointment_id：它是既有看房預約的 FK。
-- 另建 reservation 關聯表，讓一個時段或一個修繕 calendar event 至多出現一次。

CREATE TABLE IF NOT EXISTS repair_slot_reservations (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  showing_slot_id BIGINT NOT NULL,
  calendar_event_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_repair_slot_reservations_public_id (public_id),
  UNIQUE KEY uq_repair_slot_reservations_slot (showing_slot_id),
  UNIQUE KEY uq_repair_slot_reservations_event (calendar_event_id),
  CONSTRAINT fk_repair_slot_reservations_slot
    FOREIGN KEY (showing_slot_id) REFERENCES showing_slots (id),
  CONSTRAINT fk_repair_slot_reservations_event
    FOREIGN KEY (calendar_event_id) REFERENCES calendar_events (id)
);

CREATE INDEX IF NOT EXISTS ix_repair_slot_reservations_slot
  ON repair_slot_reservations (showing_slot_id);

CREATE INDEX IF NOT EXISTS ix_repair_slot_reservations_event
  ON repair_slot_reservations (calendar_event_id);
