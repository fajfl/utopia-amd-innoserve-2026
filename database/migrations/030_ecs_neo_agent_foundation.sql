-- ECS NEO 簽約前協調 Agent:P0 持久化地基(SQLite 方言)。
--
-- **主檔是 database/migrations-tidb/030_ecs_neo_agent_foundation.sql。**
-- TiDB/MySQL 是 production 的 system of record 與架構權威;這一份是**可丟棄的本機
-- 測試 adapter**,唯一任務是讓不變量能用 SQLite 跑快速回歸,將來可能整個移除。
-- 設計理由、欄位選擇、冪等模型與「刻意留給 016 的事」全部寫在主檔裡,
-- 改動一律先改主檔,再把這裡調整成等價形式 —— 不要反過來。
--
-- 這一號只做 additive:新表 + 既有表的 nullable 欄位 + 索引。
-- 不 backfill、不收緊 NOT NULL、不改任何既有 CHECK、不動任何既有欄位或資料。
--
-- 兩邊刻意保持一致的地方:
--   表名、欄位名與順序、所有唯一約束的欄位組合、status/分類的封閉集合 CHECK、
--   ready 與 blocking_issue_count 的一致性 CHECK、外鍵的指向與 ON DELETE 行為、
--   日期欄位一律存 'YYYY-MM-DD' 字串(不用 DATE/DATETIME,見主檔說明)。
--
-- 兩邊必然不同的地方:
--   BIGINT AUTO_INCREMENT        ↔ INTEGER PRIMARY KEY AUTOINCREMENT
--   VARCHAR(n) / LONGTEXT        ↔ TEXT(SQLite 無長度概念)
--   DATETIME DEFAULT CURRENT_...  ↔ TEXT DEFAULT CURRENT_TIMESTAMP
--   具名 CONSTRAINT ... FOREIGN KEY ↔ 欄位層 REFERENCES(SQLite 的 FK 名稱沒有用途)
--   UNIQUE KEY / KEY 寫在表內      ↔ 表外的 CREATE [UNIQUE] INDEX
--   CHECK (finished_at >= started_at)
--     ↔ CHECK (finished_at IS NULL OR finished_at >= started_at)
--     TiDB 那邊照 migrations-tidb/README.md 拿掉 NULL 前綴;SQLite 這邊沿用專案既有
--     寫法(見 004 的 calendar_events 與 014),兩者語意相同:NULL 一律放行。
--
-- SQLite 的 ALTER TABLE 沒有 ADD COLUMN IF NOT EXISTS。這裡不需要:runner 用
-- schema_migrations 判斷版本,而且整個檔案包在 BEGIN IMMEDIATE 裡,失敗整批回捲,
-- 不會留下半套 schema。主檔那邊 DDL 會自動 commit,所以每句都寫了 IF NOT EXISTS。

-- ---------------------------------------------------------------------------
-- 1. 具版本的契約範本
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contract_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  template_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  issuing_authority TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contract_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  contract_template_id INTEGER NOT NULL REFERENCES contract_templates(id),
  version_label TEXT NOT NULL,           -- 官方公告版本標示,例如 '113-07-08'
  source_reference TEXT,
  source_url TEXT,
  source_checksum TEXT NOT NULL,
  published_notice_ref TEXT,
  effective_from TEXT NOT NULL,          -- 'YYYY-MM-DD'
  manifest_json TEXT NOT NULL,
  manifest_checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  approved_by_user_id INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 與既有 knowledge_versions 同一種寫法:核准人與核准時間同進同出。
  CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL)),
  UNIQUE (contract_template_id, version_label)
);

CREATE INDEX IF NOT EXISTS ix_contract_template_versions_status
  ON contract_template_versions(status, effective_from);

-- ---------------------------------------------------------------------------
-- 2. 具版本的法規 rule pack
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS legal_rule_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  pack_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  issuing_authority TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS legal_rule_pack_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  legal_rule_pack_id INTEGER NOT NULL REFERENCES legal_rule_packs(id),
  version_label TEXT NOT NULL,           -- 官方公告版本,例如 '114-04-18'
  source_url TEXT,
  source_checksum TEXT NOT NULL,
  published_notice_ref TEXT,
  effective_from TEXT NOT NULL,          -- 'YYYY-MM-DD'
  rules_json TEXT NOT NULL,
  rules_checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  approved_by_user_id INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL)),
  UNIQUE (legal_rule_pack_id, version_label)
);

CREATE INDEX IF NOT EXISTS ix_legal_rule_pack_versions_status
  ON legal_rule_pack_versions(status, effective_from);

-- ---------------------------------------------------------------------------
-- 3. Agent 執行與 tool-call trace
--
-- channel_event_id NOT NULL:每個 agent turn 都要能追回一筆已持久化的 inbound
-- provider event,沿用既有 channel_events,不新增第二張事件表。
-- inquiry_id 可為 NULL:房源不明、還在選 context 的那個 turn 沒有綁定 inquiry。
-- model_* / prompt_version 可為 NULL:deterministic fake coordinator 沒有模型。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  channel_event_id INTEGER NOT NULL REFERENCES channel_events(id),
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  inquiry_id INTEGER REFERENCES inquiries(id),
  runtime_version TEXT NOT NULL,
  model_id TEXT,
  model_version TEXT,
  prompt_version TEXT,
  context_version TEXT,
  proposed_action_type TEXT CHECK (proposed_action_type IN (
    'answer', 'ask_clarification', 'escalate_to_landlord', 'show_condition_summary',
    'propose_tenant_confirmation', 'propose_landlord_decision',
    'explain_status_or_change', 'no_action'
  )),
  decision_classification TEXT CHECK (decision_classification IN (
    'grounded_and_authorized', 'needs_clarification', 'needs_landlord', 'system_failure'
  )),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'rejected', 'failed')),
  -- Error Taxonomy。model_timeout 不得被寫成 knowledge_insufficient。
  error_category TEXT CHECK (error_category IN (
    'knowledge_insufficient', 'clarification_required', 'model_timeout',
    'model_provider_error', 'invalid_model_output', 'stale_version',
    'authorization_denied', 'unit_claim_conflict', 'notification_failed',
    'draft_review_required', 'invalid_prepared_draft', 'invalid_input',
    'internal_invariant_violation'
  )),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS ix_agent_executions_channel_event
  ON agent_executions(channel_event_id);

CREATE INDEX IF NOT EXISTS ix_agent_executions_inquiry_started
  ON agent_executions(inquiry_id, started_at);

CREATE INDEX IF NOT EXISTS ix_agent_executions_status
  ON agent_executions(status, started_at);

-- tool_kind 讓 model-facing tool 與 deterministic domain command 共用一張表。
-- 刻意沒有 arguments 欄位,只有 arguments_hash:V1 不保存任意 raw/redacted args。
CREATE TABLE IF NOT EXISTS agent_tool_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  agent_execution_id INTEGER NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  tool_kind TEXT NOT NULL CHECK (tool_kind IN ('model_tool', 'domain_command')),
  tool_name TEXT NOT NULL,
  arguments_hash TEXT,
  result_summary TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'rejected')),
  error_category TEXT CHECK (error_category IN (
    'knowledge_insufficient', 'clarification_required', 'model_timeout',
    'model_provider_error', 'invalid_model_output', 'stale_version',
    'authorization_denied', 'unit_claim_conflict', 'notification_failed',
    'draft_review_required', 'invalid_prepared_draft', 'invalid_input',
    'internal_invariant_violation'
  )),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  UNIQUE (agent_execution_id, sequence_number)
);

-- 唯讀 tool 沒有 idempotency key,所以可為 NULL;NULL 不參與唯一性,
-- 兩個方言都是這個語意。有 key 的 domain command 重送則直接撞唯一約束。
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_tool_executions_idempotency_key
  ON agent_tool_executions(idempotency_key);

CREATE INDEX IF NOT EXISTS ix_agent_tool_executions_tool
  ON agent_tool_executions(tool_name, status);

-- ---------------------------------------------------------------------------
-- 4. 不可變的 prepared contract draft artifact
--
-- 綁定 exact intention_version_id,不是「最新版」。
-- 冪等來自 UNIQUE(intention_version_id, payload_checksum);checksum 的唯一定義與
-- 唯一實作在 src/services/ecsNeoContractAcceptanceServiceAsync.js 的
-- preparedDraftChecksum(),固定十個成員的 canonical JSON SHA-256。詳見主檔。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS prepared_contract_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  rental_intention_id INTEGER NOT NULL REFERENCES rental_intentions(id),
  intention_version_id INTEGER NOT NULL REFERENCES intention_versions(id),
  contract_template_version_id INTEGER NOT NULL REFERENCES contract_template_versions(id),
  legal_rule_pack_version_id INTEGER NOT NULL REFERENCES legal_rule_pack_versions(id),
  agent_execution_id INTEGER REFERENCES agent_executions(id),
  model_id TEXT,
  model_version TEXT,
  prompt_version TEXT,
  clause_snapshot_json TEXT NOT NULL,
  responsibility_matrix_json TEXT NOT NULL,
  issues_json TEXT NOT NULL,
  source_map_json TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft_review_required'
    CHECK (status IN ('draft_review_required', 'ready')),
  blocking_issue_count INTEGER NOT NULL DEFAULT 0 CHECK (blocking_issue_count >= 0),
  validated_at TEXT,
  materialized_contract_version_id INTEGER REFERENCES contract_versions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 「ready 就一定零 blocking issue」寫成約束,不只寫在程式裡。
  -- 這是「不得只顯示警告後繼續」的 schema 形式。
  -- 刻意是單向蘊含,不是等價式:零 blocking issue 不代表就該是 ready,
  -- 非 blocking 的缺漏也可以讓 artifact 留在 draft_review_required 等人看。詳見主檔。
  CHECK (status <> 'ready' OR blocking_issue_count = 0),
  UNIQUE (intention_version_id, payload_checksum)
);

-- 一個 contract version 最多由一份 artifact 固化而來。NULL 不參與唯一性。
CREATE UNIQUE INDEX IF NOT EXISTS uq_prepared_contract_drafts_materialized
  ON prepared_contract_drafts(materialized_contract_version_id);

CREATE INDEX IF NOT EXISTS ix_prepared_contract_drafts_intention_status
  ON prepared_contract_drafts(rental_intention_id, status);

CREATE INDEX IF NOT EXISTS ix_prepared_contract_drafts_version_status
  ON prepared_contract_drafts(intention_version_id, status);

-- ---------------------------------------------------------------------------
-- 5. 成交鎖:一個 rental unit 只有一條 contracting 路徑
--
-- rental_unit_id 的**全域** UNIQUE 是 V1 唯一成交鎖 —— 不是 partial index、
-- 不看 status。partial index 是 SQLite 專屬,TiDB 沒有,spec invariant 10 禁止
-- 用 SQLite-only 防線當唯一依據,所以兩邊用完全一樣的原語。
-- V1 不實作 release;contract_id 在同一交易內回填。詳見主檔。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rental_unit_contracting_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  rental_unit_id INTEGER NOT NULL REFERENCES rental_units(id),
  rental_intention_id INTEGER NOT NULL REFERENCES rental_intentions(id),
  intention_version_id INTEGER NOT NULL REFERENCES intention_versions(id),
  contract_id INTEGER REFERENCES contracts(id),
  claimed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- **這一行就是 V1 的成交鎖。**
CREATE UNIQUE INDEX IF NOT EXISTS uq_rental_unit_contracting_claims_unit
  ON rental_unit_contracting_claims(rental_unit_id);

-- 一筆 intention 只能 claim 一次。
CREATE UNIQUE INDEX IF NOT EXISTS uq_rental_unit_contracting_claims_intention
  ON rental_unit_contracting_claims(rental_intention_id);

-- 一份合約只對應一個 claim。NULL 不參與唯一性。
CREATE UNIQUE INDEX IF NOT EXISTS uq_rental_unit_contracting_claims_contract
  ON rental_unit_contracting_claims(contract_id);

CREATE INDEX IF NOT EXISTS ix_rental_unit_contracting_claims_version
  ON rental_unit_contracting_claims(intention_version_id);

-- ---------------------------------------------------------------------------
-- 6. 既有表的 additive 冪等欄位
--
-- 全部 nullable。既有列維持 NULL,舊程式不受影響。NOT NULL 要等 016 backfill。
-- 唯一索引現在就加:NULL 在兩個方言都不參與唯一性,所以「舊列全是 NULL」與
-- 「新列必須唯一」可以並存。
-- ---------------------------------------------------------------------------

ALTER TABLE landlord_questions ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_landlord_questions_idempotency_key
  ON landlord_questions(idempotency_key);

-- intention_decisions 建表時沒有 public_id(它原本只是內部關聯列)。
-- 房東決策現在要能被 LINE payload 與 API 精確指名,所以補上。
ALTER TABLE intention_decisions ADD COLUMN public_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_intention_decisions_public_id
  ON intention_decisions(public_id);

ALTER TABLE intention_decisions ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_intention_decisions_idempotency_key
  ON intention_decisions(idempotency_key);

-- 房客確認的**精確**版本。接受只能對這個指標指到的版本進行。
-- 這裡刻意不寫 REFERENCES intention_versions(id):主檔那邊為了保持全檔可重跑
-- 沒有加外鍵,兩邊必須是同一種強度,否則 SQLite 會擋、雲端不會擋,
-- 測試全過而 production 放行。外鍵留到 016。
ALTER TABLE rental_intentions ADD COLUMN confirmed_intention_version_id INTEGER;

CREATE INDEX IF NOT EXISTS ix_rental_intentions_confirmed_version
  ON rental_intentions(confirmed_intention_version_id);

-- 房東對這一版**條件**的確認(對應主檔同名欄位)。屋況附件的確認在
-- pre_inspection_sessions,是另一道關卡;兩道都過了房客才送得出簽署。
-- 綁在版本上,新版本天生 NULL,必須重新確認。
ALTER TABLE contract_versions ADD COLUMN landlord_terms_confirmed_at TEXT;

ALTER TABLE contract_versions ADD COLUMN landlord_terms_confirmed_by_user_id INTEGER;

-- 原本這裡有 (intention_version_id, decision) 的複合索引,已移除:
-- 雲端 intention_decisions.decision 的實際型別是 LONGTEXT,MySQL/TiDB 對
-- BLOB/TEXT 建索引未指定前綴長度會 ER1170。SQLite 不會報錯,所以只會在雲端炸開。
-- 這個索引不屬於任何不變量,直接拿掉。詳見主檔。

-- ---------------------------------------------------------------------------
-- 7. Agent 主線用得到的既有表索引(對應主檔第 7 節)
--
-- outbox dispatcher 的掃描、channel_events 的未處理查詢、Agent 對話視窗的
-- messages 查詢。全部 additive、可重跑。
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS ix_notification_deliveries_dispatch
  ON notification_deliveries(channel, status, id);

CREATE INDEX IF NOT EXISTS ix_channel_events_provider_status
  ON channel_events(provider, processing_status, id);

CREATE INDEX IF NOT EXISTS ix_messages_inquiry_sent
  ON messages(inquiry_id, sent_at, id);
