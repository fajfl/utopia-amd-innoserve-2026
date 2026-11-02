-- 預約看房紀錄表
CREATE TABLE IF NOT EXISTS showing_appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT UNIQUE NOT NULL,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  tenant_user_id INTEGER NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL, -- 預約看房時間 (YYYY-MM-DD HH:MM)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_showing_appointments_tenant ON showing_appointments(tenant_user_id, status);
CREATE INDEX IF NOT EXISTS idx_showing_appointments_inquiry ON showing_appointments(inquiry_id);
