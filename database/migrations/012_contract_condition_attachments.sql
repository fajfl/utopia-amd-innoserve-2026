CREATE TABLE contract_condition_attachments (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  contract_version_id INTEGER NOT NULL REFERENCES contract_versions(id),
  pre_inspection_session_id INTEGER NOT NULL REFERENCES pre_inspection_sessions(id),
  session_public_id TEXT NOT NULL,
  title TEXT,
  sealed_at TEXT,
  match_source TEXT NOT NULL CHECK (match_source IN ('inquiry', 'rental_unit', 'party')),
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  video_count INTEGER NOT NULL DEFAULT 0 CHECK (video_count >= 0),
  text_count INTEGER NOT NULL DEFAULT 0 CHECK (text_count >= 0),
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  attached_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contract_version_id, pre_inspection_session_id)
);

CREATE INDEX idx_contract_condition_attachments_version
ON contract_condition_attachments(contract_version_id, id);

CREATE INDEX idx_contract_condition_attachments_session
ON contract_condition_attachments(pre_inspection_session_id);

-- 已簽署的版本連附件清單都不能再變動，否則簽名涵蓋的文件雜湊會對不上實際附件。
CREATE TRIGGER trg_condition_attachment_immutable_insert
BEFORE INSERT ON contract_condition_attachments
WHEN EXISTS (SELECT 1 FROM signature_records WHERE contract_version_id = NEW.contract_version_id)
BEGIN
  SELECT RAISE(ABORT, 'signed contract version cannot change condition attachments');
END;

CREATE TRIGGER trg_condition_attachment_immutable_update
BEFORE UPDATE ON contract_condition_attachments
WHEN EXISTS (SELECT 1 FROM signature_records WHERE contract_version_id = OLD.contract_version_id)
BEGIN
  SELECT RAISE(ABORT, 'signed contract version cannot change condition attachments');
END;

CREATE TRIGGER trg_condition_attachment_immutable_delete
BEFORE DELETE ON contract_condition_attachments
WHEN EXISTS (SELECT 1 FROM signature_records WHERE contract_version_id = OLD.contract_version_id)
BEGIN
  SELECT RAISE(ABORT, 'signed contract version cannot change condition attachments');
END;
