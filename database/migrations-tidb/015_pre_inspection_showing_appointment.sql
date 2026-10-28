-- 新建立的入住前屋況點交必須對應一筆已核准的看房預約。
-- 舊資料保留 NULL：它們建立時尚無 showing_appointments，仍可依 inquiry 查看與附加。
ALTER TABLE pre_inspection_sessions
  ADD COLUMN IF NOT EXISTS showing_appointment_id BIGINT DEFAULT NULL;

-- MySQL/TiDB 的 UNIQUE 同樣容許多個 NULL，故不影響舊資料與補充紀錄。
CREATE UNIQUE INDEX IF NOT EXISTS uq_pre_inspection_sessions_showing_appointment
  ON pre_inspection_sessions (showing_appointment_id);

ALTER TABLE pre_inspection_sessions
  ADD CONSTRAINT fk_pre_inspection_sessions_showing_appointment
  FOREIGN KEY (showing_appointment_id) REFERENCES showing_appointments (id);
