-- ECS NEO 簽約前協調 Agent:P0 持久化地基。**這一份是主檔。**
--
-- TiDB/MySQL 是 production 的 system of record 與架構權威。型別、約束、交易語意與
-- DDL 行為一律先照這裡定。database/migrations/030_ecs_neo_agent_foundation.sql 是
-- **可丟棄的本機測試 adapter**,只為了讓不變量能用 SQLite 快速回歸,將來可能整個移除;
-- 兩邊衝突時以這一份為準,不要為了遷就 SQLite 弱化這裡的約束。
--
-- 這一號**只做 additive**:新表 + 既有表的 nullable 欄位 + 索引。
-- 不 backfill、不收緊 NOT NULL、不改任何既有 CHECK、不動任何既有欄位或資料。
-- 舊程式完全不知道這些表存在也照樣跑;回滾等於「不使用這些表」。
--
-- 重跑安全性(與 014 不同,這一號是全檔可重跑的):
--   全部語句都是 CREATE TABLE / CREATE [UNIQUE] INDEX / ADD COLUMN 的
--   IF NOT EXISTS 形式。TiDB stable 文件確認 `CREATE [UNIQUE] INDEX IF NOT EXISTS`
--   與 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 都支援(後者 014 已對實機驗證過)。
--   **沒有任何 ALTER TABLE ... ADD CONSTRAINT**,所以不需要像 014 那樣先手動
--   DROP FOREIGN KEY 才能重跑。新表對既有表的外鍵都寫在 CREATE TABLE 裡面。
--   TiDB 的 DDL 每句自動 commit,檔案跑到一半失敗時前面的語句會留著,但因為每句都
--   idempotent,修正後直接重跑即可。務必先 `npm run db:tidb:migrate -- --dry-run`。
--
-- 型別選擇的兩個共同決定:
--
-- 1. 日期用 VARCHAR(32) 存 'YYYY-MM-DD',不用 DATE/DATETIME。
--    見 migrations-tidb/README.md 的「時間欄位混型別的坑」:雲端既有表一半 DATETIME
--    一半 longtext,mysql2 在 dateStrings 下把 DATETIME 讀成 '2026-08-24 23:00:00'
--    (空格分隔),程式寫進 longtext 的是 ISO 'T' 分隔,直接比字串會判反。
--    新表凡是會被拿來比較或顯示的日期一律用固定格式字串,字典序等於時間序,
--    兩個方言完全一致。純粹的稽核時戳(created_at / started_at)才用 DATETIME。
--
-- 2. JSON payload 用 LONGTEXT,不用 TEXT。
--    MySQL/TiDB 的 TEXT 上限是 64KB,而完整住宅租賃契約範本 manifest 與 23 項應記載
--    事項 rule pack 很容易超過。@@sql_mode 含 STRICT_TRANS_TABLES,超長會**報錯**
--    而不是截斷 —— 這比靜默截斷好,但仍然是可避免的故障。SQLite 的 TEXT 無長度概念。
--
-- 刻意**不**在這一號做,留給 016(需要 backfill、收緊或 JS guard 配對):
--   a. landlord_questions.idempotency_key 與 intention_decisions.public_id /
--      idempotency_key 的 NOT NULL:既有列現在是 NULL,必須先 backfill。
--   b. contracts.selected_intention_id 的 UNIQUE:spec 要求「先查重再收緊」,
--      查重是資料檢查不是 schema 變更,不能在 additive 這一號盲目加。
--   c. intention_version_sources.source_type 加 'landlord_answer':那是修改既有
--      CHECK,SQLite 無法 ALTER CHECK,得走整表重建,不屬於 additive。
--   d. intention_versions 的不可變性 guard:SQLite 要 trigger、TiDB 要
--      src/database/integrityGuardsAsync.js,兩者必須同批進以免單邊生效。
--   e. prepared_contract_drafts 內容欄位的 mutation-rejection guard:同上,
--      本號只用 payload_checksum 與 UNIQUE 讓改寫「可被偵測」,還沒讓它「被拒絕」。
--   f. rental_unit_contracting_claims.intention_version_id 必須屬於同一筆
--      rental_intention_id:跨欄不變量,兩個方言都無法用 FK 表達,走 guard。
--   g. 同一 exact version 只能有一筆有效決策的競爭限制:需要先決定 decision 的
--      有效/失效模型,不是單純加索引。

-- ---------------------------------------------------------------------------
-- 1. 具版本的契約範本(spec P0-E 第 1 點)
--
-- DOCX/PDF 只是來源,不在每次 request 臨時解析。manifest_json 是固化後的完整主文、
-- 附件、slot、required/optional;manifest_checksum 才是 prepared draft 綁定的東西。
-- source_checksum 綁原始公文件,manifest_checksum 綁我們的解讀 —— 兩個都要,
-- 因為「範本沒變但我們的解讀改了」跟「範本改版了」是不同事件。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contract_templates (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  template_code VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  issuing_authority VARCHAR(128) DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_templates_public_id (public_id),
  UNIQUE KEY uq_contract_templates_code (template_code),
  CONSTRAINT chk_contract_templates_status CHECK (status IN ('active', 'retired'))
);

CREATE TABLE IF NOT EXISTS contract_template_versions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  contract_template_id BIGINT NOT NULL,
  -- 官方公告的版本標示,例如 '113-07-08'。不是我們自己編的序號。
  version_label VARCHAR(64) NOT NULL,
  source_reference VARCHAR(512) DEFAULT NULL,
  source_url VARCHAR(512) DEFAULT NULL,
  source_checksum VARCHAR(64) NOT NULL,
  published_notice_ref VARCHAR(255) DEFAULT NULL,
  effective_from VARCHAR(32) NOT NULL,
  manifest_json LONGTEXT NOT NULL,
  manifest_checksum VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  approved_by_user_id BIGINT DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contract_template_versions_public_id (public_id),
  UNIQUE KEY uq_contract_template_versions_label (contract_template_id, version_label),
  KEY ix_contract_template_versions_status (status, effective_from),
  KEY fk_contract_template_versions_approved_by_user_id (approved_by_user_id),
  CONSTRAINT fk_contract_template_versions_template_id
    FOREIGN KEY (contract_template_id) REFERENCES contract_templates (id),
  CONSTRAINT fk_contract_template_versions_approved_by_user_id
    FOREIGN KEY (approved_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_contract_template_versions_status
    CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  -- 與既有 knowledge_versions 同一種寫法:核准人與核准時間同進同出。
  CONSTRAINT chk_contract_template_versions_approval
    CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL))
);

-- ---------------------------------------------------------------------------
-- 2. 具版本的法規 rule pack(spec P0-E 第 2 點)
--
-- 應記載 23 項與不得記載 10 項的 deterministic checks 定義放在 rules_json。
-- 每次升版都要重抓官方來源、人工審閱差異、產生新 checksum;舊 prepared draft
-- 保留原本綁定的版本,不就地改寫(所以這裡沒有 updated_at 之外的可變狀態)。
-- 不另建 rule item 表:逐項覆蓋率由讀 rules_json 的 deterministic test 斷言,
-- 拆表在還沒有查詢需求前只是多一層無用 join。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS legal_rule_packs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  pack_code VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  issuing_authority VARCHAR(128) DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_legal_rule_packs_public_id (public_id),
  UNIQUE KEY uq_legal_rule_packs_code (pack_code),
  CONSTRAINT chk_legal_rule_packs_status CHECK (status IN ('active', 'retired'))
);

CREATE TABLE IF NOT EXISTS legal_rule_pack_versions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  legal_rule_pack_id BIGINT NOT NULL,
  -- 官方公告版本,例如 '114-04-18'(現行應記載及不得記載事項)。
  version_label VARCHAR(64) NOT NULL,
  source_url VARCHAR(512) DEFAULT NULL,
  source_checksum VARCHAR(64) NOT NULL,
  published_notice_ref VARCHAR(255) DEFAULT NULL,
  effective_from VARCHAR(32) NOT NULL,
  rules_json LONGTEXT NOT NULL,
  rules_checksum VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  approved_by_user_id BIGINT DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_legal_rule_pack_versions_public_id (public_id),
  UNIQUE KEY uq_legal_rule_pack_versions_label (legal_rule_pack_id, version_label),
  KEY ix_legal_rule_pack_versions_status (status, effective_from),
  KEY fk_legal_rule_pack_versions_approved_by_user_id (approved_by_user_id),
  CONSTRAINT fk_legal_rule_pack_versions_pack_id
    FOREIGN KEY (legal_rule_pack_id) REFERENCES legal_rule_packs (id),
  CONSTRAINT fk_legal_rule_pack_versions_approved_by_user_id
    FOREIGN KEY (approved_by_user_id) REFERENCES users (id),
  CONSTRAINT chk_legal_rule_pack_versions_status
    CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  CONSTRAINT chk_legal_rule_pack_versions_approval
    CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL))
);

-- ---------------------------------------------------------------------------
-- 3. Agent 執行與 tool-call trace(spec P0-D)
--
-- channel_event_id 是 NOT NULL:每個 agent turn 都要能追回一筆已持久化的 inbound
-- provider event。spec 明講 actor「一律取自已持久化的 channel_events／
-- agent_executions,不信任 sidecar 回傳的身分」,這條 FK 就是那句話的 schema 形式。
-- 不新增第二張事件表,沿用既有 channel_events(它已有 UNIQUE(provider, provider_event_id))。
--
-- inquiry_id 可為 NULL:房源不明、房客還在選 context 的那一個 turn 沒有綁定 inquiry。
-- spec Case L 要求「房源不明時先選擇,不猜」,所以這裡不能逼出一個假的 inquiry。
--
-- model_* 與 prompt_version 可為 NULL:Phase 1 的 deterministic fake coordinator
-- 沒有模型。runtime_version 一律要有(fake runtime 也有版本字串)。
--
-- idempotency_key 是 NOT NULL UNIQUE:新表沒有既有列,不需要 backfill 就能直接收緊。
-- 同一個 event 重試沿用同一把 key,也就沿用同一筆 execution。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_executions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  channel_event_id BIGINT NOT NULL,
  actor_user_id BIGINT NOT NULL,
  inquiry_id BIGINT DEFAULT NULL,
  runtime_version VARCHAR(64) NOT NULL,
  model_id VARCHAR(128) DEFAULT NULL,
  model_version VARCHAR(128) DEFAULT NULL,
  prompt_version VARCHAR(64) DEFAULT NULL,
  context_version VARCHAR(64) DEFAULT NULL,
  proposed_action_type VARCHAR(64) DEFAULT NULL,
  decision_classification VARCHAR(32) DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  error_category VARCHAR(64) DEFAULT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_executions_public_id (public_id),
  UNIQUE KEY uq_agent_executions_idempotency_key (idempotency_key),
  KEY ix_agent_executions_channel_event (channel_event_id),
  KEY ix_agent_executions_inquiry_started (inquiry_id, started_at),
  KEY ix_agent_executions_status (status, started_at),
  KEY fk_agent_executions_actor_user_id (actor_user_id),
  CONSTRAINT fk_agent_executions_channel_event_id
    FOREIGN KEY (channel_event_id) REFERENCES channel_events (id),
  CONSTRAINT fk_agent_executions_actor_user_id
    FOREIGN KEY (actor_user_id) REFERENCES users (id),
  CONSTRAINT fk_agent_executions_inquiry_id
    FOREIGN KEY (inquiry_id) REFERENCES inquiries (id),
  CONSTRAINT chk_agent_executions_status
    CHECK (status IN ('running', 'completed', 'rejected', 'failed')),
  -- proposed_action.type 的封閉集合。模型送來集合外的值由 Gateway 拒絕,
  -- 這裡再擋一層,避免任何路徑把未知 action 寫成既成事實。
  CONSTRAINT chk_agent_executions_proposed_action_type
    CHECK (proposed_action_type IN (
      'answer', 'ask_clarification', 'escalate_to_landlord', 'show_condition_summary',
      'propose_tenant_confirmation', 'propose_landlord_decision',
      'explain_status_or_change', 'no_action'
    )),
  CONSTRAINT chk_agent_executions_decision_classification
    CHECK (decision_classification IN (
      'grounded_and_authorized', 'needs_clarification', 'needs_landlord', 'system_failure'
    )),
  -- Error Taxonomy。model_timeout 不得被寫成 knowledge_insufficient,
  -- 集合固定下來才能用 SQL 稽核這件事。
  CONSTRAINT chk_agent_executions_error_category
    CHECK (error_category IN (
      'knowledge_insufficient', 'clarification_required', 'model_timeout',
      'model_provider_error', 'invalid_model_output', 'stale_version',
      'authorization_denied', 'unit_claim_conflict', 'notification_failed',
      'draft_review_required', 'invalid_prepared_draft', 'invalid_input',
      'internal_invariant_violation'
    )),
  -- 依 migrations-tidb/README.md:不寫 `finished_at IS NULL OR ...` 前綴,
  -- CHECK 只在運算式為 FALSE 時拒絕,NULL 一律放行。
  CONSTRAINT chk_agent_executions_finished CHECK (finished_at >= started_at)
);

-- tool_kind 讓 model-facing read/proposal tool 與 deterministic domain command 共用
-- 一張表:兩者的欄位需求完全相同(名稱、參數 hash、結果摘要、狀態、時間),
-- 拆成兩張表只會讓「這個 turn 到底做了哪些事」需要 UNION 才讀得出來。
--
-- 刻意**沒有** arguments 欄位,只有 arguments_hash。spec P0-D:「V1 不保存任意
-- raw/redacted args,等欄位白名單核准後再加」。result_summary 是有長度上限的摘要,
-- 不是原始輸出,不放 secrets、完整 internal rule、身分證或原始敏感合約內容。
CREATE TABLE IF NOT EXISTS agent_tool_executions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  agent_execution_id BIGINT NOT NULL,
  sequence_number BIGINT NOT NULL,
  tool_kind VARCHAR(32) NOT NULL,
  tool_name VARCHAR(128) NOT NULL,
  arguments_hash VARCHAR(64) DEFAULT NULL,
  result_summary VARCHAR(512) DEFAULT NULL,
  idempotency_key VARCHAR(255) DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  error_category VARCHAR(64) DEFAULT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_tool_executions_public_id (public_id),
  UNIQUE KEY uq_agent_tool_executions_sequence (agent_execution_id, sequence_number),
  -- 唯讀 tool 沒有 idempotency key,所以可為 NULL;NULL 不參與唯一性,
  -- 兩個方言都是這個語意。有 key 的 domain command 重送則直接撞唯一約束。
  UNIQUE KEY uq_agent_tool_executions_idempotency_key (idempotency_key),
  KEY ix_agent_tool_executions_tool (tool_name, status),
  CONSTRAINT fk_agent_tool_executions_execution_id
    FOREIGN KEY (agent_execution_id) REFERENCES agent_executions (id) ON DELETE CASCADE,
  CONSTRAINT chk_agent_tool_executions_kind
    CHECK (tool_kind IN ('model_tool', 'domain_command')),
  CONSTRAINT chk_agent_tool_executions_status
    CHECK (status IN ('running', 'succeeded', 'failed', 'rejected')),
  CONSTRAINT chk_agent_tool_executions_sequence CHECK (sequence_number > 0),
  CONSTRAINT chk_agent_tool_executions_error_category
    CHECK (error_category IN (
      'knowledge_insufficient', 'clarification_required', 'model_timeout',
      'model_provider_error', 'invalid_model_output', 'stale_version',
      'authorization_denied', 'unit_claim_conflict', 'notification_failed',
      'draft_review_required', 'invalid_prepared_draft', 'invalid_input',
      'internal_invariant_violation'
    )),
  CONSTRAINT chk_agent_tool_executions_finished CHECK (finished_at >= started_at)
);

-- ---------------------------------------------------------------------------
-- 4. 不可變的 prepared contract draft artifact(spec P0-E 第 3 點)
--
-- 為什麼要有這張表:LLM 不能在房東接受的那個交易裡即時生成契約。所以流程是
--   (交易外) 產生 artifact -> deterministic validation -> status='ready'
--   (交易內) 只把 checksum 相符的 artifact 固化成 contract_versions.status='draft'
-- 這樣既不把模型呼叫放進 DB transaction,也不會留下 accepted-without-draft。
--
-- 綁定的是 **exact** intention_version_id,不是 rental_intention_id + 「最新版」。
-- spec 明確禁止用 ORDER BY version_number DESC 猜 latest。
--
-- 冪等:UNIQUE(intention_version_id, payload_checksum)。payload_checksum 是對
-- **一個固定的 input tuple** 做 canonical JSON 之後的 SHA-256,唯一的實作與
-- 唯一的定義在 src/services/ecsNeoContractAcceptanceServiceAsync.js 的
-- preparedDraftChecksum()。tuple 成員固定為這十個,鍵先排序再序列化:
--
--   intentionVersionPublicId   綁 exact intention version(用 public_id,跨環境穩定)
--   templateManifestChecksum   contract_template_versions.manifest_checksum
--   rulePackChecksum           legal_rule_pack_versions.rules_checksum
--   modelId / modelVersion / promptVersion
--   clauseSnapshot / responsibilityMatrix / issues / sourceMap  (已 parse 的值)
--
-- 用已 parse 的值而不是原始字串,所以兩個資料庫存回來的空白與鍵順序差異不影響
-- checksum;換掉任何一個範本、rule pack、model、prompt 或內容都會得到不同的值。
-- 接受時會重算並用 timingSafeEqual 比對,對不上就不准進交易。
--
-- 不可變性:內容欄位沒有 updated_at,也不該被 UPDATE。本號只讓改寫「可被偵測」
-- (checksum 與內容不符即為篡改),真正的 mutation-rejection guard 留給 016,
-- 因為 SQLite trigger 與 TiDB 的 integrityGuardsAsync 必須同批進。
-- 唯一允許在事後寫入一次的欄位是 materialized_contract_version_id,
-- 它在接受交易內設定,交易外看不到中間狀態。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS prepared_contract_drafts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  rental_intention_id BIGINT NOT NULL,
  intention_version_id BIGINT NOT NULL,
  contract_template_version_id BIGINT NOT NULL,
  legal_rule_pack_version_id BIGINT NOT NULL,
  agent_execution_id BIGINT DEFAULT NULL,
  model_id VARCHAR(128) DEFAULT NULL,
  model_version VARCHAR(128) DEFAULT NULL,
  prompt_version VARCHAR(64) DEFAULT NULL,
  clause_snapshot_json LONGTEXT NOT NULL,
  responsibility_matrix_json LONGTEXT NOT NULL,
  issues_json LONGTEXT NOT NULL,
  source_map_json LONGTEXT NOT NULL,
  payload_checksum VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft_review_required',
  blocking_issue_count BIGINT NOT NULL DEFAULT 0,
  validated_at DATETIME DEFAULT NULL,
  materialized_contract_version_id BIGINT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_prepared_contract_drafts_public_id (public_id),
  UNIQUE KEY uq_prepared_contract_drafts_payload (intention_version_id, payload_checksum),
  -- 一個 contract version 最多由一份 artifact 固化而來。NULL 不參與唯一性。
  UNIQUE KEY uq_prepared_contract_drafts_materialized (materialized_contract_version_id),
  KEY ix_prepared_contract_drafts_intention_status (rental_intention_id, status),
  KEY ix_prepared_contract_drafts_version_status (intention_version_id, status),
  KEY fk_prepared_contract_drafts_template_version_id (contract_template_version_id),
  KEY fk_prepared_contract_drafts_rule_pack_version_id (legal_rule_pack_version_id),
  KEY fk_prepared_contract_drafts_agent_execution_id (agent_execution_id),
  CONSTRAINT fk_prepared_contract_drafts_rental_intention_id
    FOREIGN KEY (rental_intention_id) REFERENCES rental_intentions (id),
  CONSTRAINT fk_prepared_contract_drafts_intention_version_id
    FOREIGN KEY (intention_version_id) REFERENCES intention_versions (id),
  CONSTRAINT fk_prepared_contract_drafts_template_version_id
    FOREIGN KEY (contract_template_version_id) REFERENCES contract_template_versions (id),
  CONSTRAINT fk_prepared_contract_drafts_rule_pack_version_id
    FOREIGN KEY (legal_rule_pack_version_id) REFERENCES legal_rule_pack_versions (id),
  CONSTRAINT fk_prepared_contract_drafts_agent_execution_id
    FOREIGN KEY (agent_execution_id) REFERENCES agent_executions (id),
  CONSTRAINT fk_prepared_contract_drafts_materialized_version_id
    FOREIGN KEY (materialized_contract_version_id) REFERENCES contract_versions (id),
  CONSTRAINT chk_prepared_contract_drafts_status
    CHECK (status IN ('draft_review_required', 'ready')),
  CONSTRAINT chk_prepared_contract_drafts_blocking_count CHECK (blocking_issue_count >= 0),
  -- 「ready 就一定零 blocking issue」寫成約束,不只寫在程式裡。這是 spec
  -- 「任何 blocking issue 都讓 artifact 成為 draft_review_required,不可進接受交易」
  -- 的 schema 形式,也是「不得只顯示警告後繼續」的最後一道防線。
  --
  -- 刻意寫成單向蘊含,不是 014 chk_showing_slots_held 那種等價式:
  -- 零 blocking issue **不代表**就該是 ready。缺漏欄位、未解的責任歸屬等
  -- 非 blocking 的 issue 也可以讓 artifact 留在 draft_review_required 等人看。
  -- 寫成等價式會讓那個合法狀態被資料庫拒絕。
  -- status 是 NOT NULL,兩側都沒有 NULL,兩個方言的求值完全一致。
  CONSTRAINT chk_prepared_contract_drafts_ready
    CHECK (status <> 'ready' OR blocking_issue_count = 0)
);

-- ---------------------------------------------------------------------------
-- 5. 成交鎖:一個 rental unit 只有一條 contracting 路徑(spec P0-B)
--
-- 為什麼要獨立一張表:P0-0 的唯讀查證顯示雲端 contracts 沒有 active-unit partial
-- unique,rental_intentions / inquiries / active_inquiry_contexts 也都缺 SQLite 那邊
-- 的 active-row partial unique。partial index 是 SQLite 專屬,TiDB 沒有,
-- 而 spec invariant 10 禁止用 SQLite-only 防線當唯一依據。
-- 所以改用一張新表 + rental_unit_id 的**全域** UNIQUE:兩個方言完全一樣的原語,
-- claim 以 INSERT 成敗判定,落敗者拿到唯一鍵衝突並回 409 unit_claim_conflict。
--
-- V1 不實作 release(沒有 released_at / status)。取消與重租另開 lifecycle spec,
-- 現在就放一個可為 NULL 的釋放欄位只會讓人以為釋放路徑已經想清楚了。
--
-- contract_id 可為 NULL:claim 必須在交易**最早**插入才能盡快擋掉競爭者,
-- 此時 contract 還沒建立;同一交易內回填。交易外永遠看得到已填的值。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rental_unit_contracting_claims (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id VARCHAR(255) NOT NULL,
  rental_unit_id BIGINT NOT NULL,
  rental_intention_id BIGINT NOT NULL,
  intention_version_id BIGINT NOT NULL,
  contract_id BIGINT DEFAULT NULL,
  claimed_by_user_id BIGINT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rental_unit_contracting_claims_public_id (public_id),
  -- **這一行就是 V1 的成交鎖。** 全域唯一,不是 partial、不看 status。
  UNIQUE KEY uq_rental_unit_contracting_claims_unit (rental_unit_id),
  -- 一筆 intention 只能 claim 一次。
  UNIQUE KEY uq_rental_unit_contracting_claims_intention (rental_intention_id),
  -- 一份合約只對應一個 claim。NULL 不參與唯一性。
  UNIQUE KEY uq_rental_unit_contracting_claims_contract (contract_id),
  -- 同一個 event 重送沿用同一個結果,不會產生第二份草稿。
  UNIQUE KEY uq_rental_unit_contracting_claims_idempotency_key (idempotency_key),
  KEY ix_rental_unit_contracting_claims_version (intention_version_id),
  KEY fk_rental_unit_contracting_claims_claimed_by_user_id (claimed_by_user_id),
  CONSTRAINT fk_rental_unit_contracting_claims_rental_unit_id
    FOREIGN KEY (rental_unit_id) REFERENCES rental_units (id),
  CONSTRAINT fk_rental_unit_contracting_claims_rental_intention_id
    FOREIGN KEY (rental_intention_id) REFERENCES rental_intentions (id),
  CONSTRAINT fk_rental_unit_contracting_claims_intention_version_id
    FOREIGN KEY (intention_version_id) REFERENCES intention_versions (id),
  CONSTRAINT fk_rental_unit_contracting_claims_contract_id
    FOREIGN KEY (contract_id) REFERENCES contracts (id),
  CONSTRAINT fk_rental_unit_contracting_claims_claimed_by_user_id
    FOREIGN KEY (claimed_by_user_id) REFERENCES users (id)
);

-- ---------------------------------------------------------------------------
-- 6. 既有表的 additive 冪等欄位(spec P0-D)
--
-- 全部 nullable。既有列維持 NULL,舊程式不受影響。NOT NULL 要等 016 backfill。
-- 唯一索引現在就加:NULL 在兩個方言都不參與唯一性,所以「舊列全是 NULL」與
-- 「新列必須唯一」可以並存 —— 這正是先加唯一索引、後收 NOT NULL 的原因。
-- ---------------------------------------------------------------------------

ALTER TABLE landlord_questions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_landlord_questions_idempotency_key
  ON landlord_questions (idempotency_key);

-- intention_decisions 建表時沒有 public_id(它原本只是內部關聯列)。
-- 房東決策現在要能被 LINE payload 與 API 精確指名,所以補上。
ALTER TABLE intention_decisions ADD COLUMN IF NOT EXISTS public_id VARCHAR(255) DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_intention_decisions_public_id
  ON intention_decisions (public_id);

ALTER TABLE intention_decisions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_intention_decisions_idempotency_key
  ON intention_decisions (idempotency_key);

-- 房客確認的**精確**版本。接受只能對這個指標指到的版本進行,不能拿同一筆意向的
-- 任何一版來接受,也不能用 ORDER BY version_number DESC 猜。
--
-- 這一號只加欄位與單欄索引,**不加外鍵**。ALTER TABLE ... ADD CONSTRAINT 沒有
-- IF NOT EXISTS,加了就讓整個檔案不再可重跑(014 就是為此在檔頭寫了 DROP FOREIGN KEY
-- 的復原步驟)。指向 intention_versions(id) 的外鍵留到 016 一併明確處理;
-- 在那之前由 service 在交易內比對指標與請求的版本。
ALTER TABLE rental_intentions
  ADD COLUMN IF NOT EXISTS confirmed_intention_version_id BIGINT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS ix_rental_intentions_confirmed_version
  ON rental_intentions (confirmed_intention_version_id);

-- 房東對這一版**條件**的確認。屋況附件的確認在 pre_inspection_sessions,那是
-- 另一件事;這兩道關卡都過了,房客才送得出簽署。
--
-- 綁在 contract_versions 而不是 contracts:房東確認的是他當下看到的那一版,
-- 之後只要產生新版本(房東要求修改 → 房客重新協調 → 重新固化),新版本的欄位
-- 天生是 NULL,必須重新確認。掛在 contracts 上就會變成「確認過一次就永遠算數」。
--
-- 沒有唯一索引:一個版本只有一列,唯一性由 contract_versions 的主鍵本身保證。
ALTER TABLE contract_versions
  ADD COLUMN IF NOT EXISTS landlord_terms_confirmed_at DATETIME DEFAULT NULL;

ALTER TABLE contract_versions
  ADD COLUMN IF NOT EXISTS landlord_terms_confirmed_by_user_id BIGINT DEFAULT NULL;

-- 這裡原本有一個 (intention_version_id, decision) 的複合索引。已移除。
--
-- 唯讀查證雲端後發現 intention_decisions.decision 的實際型別是 **LONGTEXT**
-- (1~12 版是轉換工具產生的,型別跟 database/migrations/ 裡寫的不一樣)。
-- MySQL/TiDB 對 BLOB/TEXT 欄位建索引必須指定前綴長度,否則直接
--   ER1170: BLOB/TEXT column 'decision' used in key specification without a key length
-- 本機 SQLite 對此毫無意見,所以這個錯誤只會在雲端套用時炸開。
--
-- 這個索引不是任何不變量的一部分(exact-version 的排他性由
-- rental_unit_contracting_claims 與 idempotency_key 保證),所以直接拿掉,
-- 不用前綴長度硬湊。若 016 之後真的需要,安全做法是只索引 intention_version_id
-- 這個 BIGINT 欄位,或先把 decision 改成 VARCHAR 再談複合索引。

-- ---------------------------------------------------------------------------
-- 7. Agent 主線用得到的既有表索引
--
-- 三個查詢在 Agent 接上主線之後會變成熱路徑,而且都跑在既有的大表上:
--
--   a. outbox dispatcher 每次掃 (channel='line', status IN ('pending','failed'))。
--      沒有索引就是每一輪推播都全表掃 notification_deliveries。
--   b. gateway 每一則訊息都用 (provider, provider_event_id) 去重 —— 這個唯一鍵
--      001 已經有了 —— 但收尾時還要用 (provider, processing_status) 找未處理事件。
--   c. Agent 的對話視窗查 messages(inquiry_id, sent_at, id)。
--
-- 全部是 additive、可重跑、不改任何既有欄位或約束。
-- ---------------------------------------------------------------------------

-- notification_deliveries.channel 在雲端是 longtext(1-12 版由 SQLite 轉換而來,
-- SQLite 的 TEXT 一律變成 longtext)。MySQL/TiDB 不接受沒有長度的 BLOB/TEXT 進索引:
--   BLOB/TEXT column 'channel' used in key specification without a key length
--
-- 不用 channel(16) 這種前綴索引硬湊 —— 這個檔案下面那段(intention_decisions 的
-- 複合索引)已經寫明本專案的做法是先把欄位改成 VARCHAR 再談索引。
-- channel 存的是 'line' 這種通道代號,VARCHAR(32) 綽綽有餘;雲端實測 5 列、
-- 最長 4 個字元、只有 'line' 一種值,轉型不會截斷任何資料。
--
-- MODIFY 重跑是 no-op,所以整份 migration 仍然可以重跑。
ALTER TABLE notification_deliveries
  MODIFY COLUMN channel VARCHAR(32) NOT NULL;

CREATE INDEX IF NOT EXISTS ix_notification_deliveries_dispatch
  ON notification_deliveries (channel, status, id);

CREATE INDEX IF NOT EXISTS ix_channel_events_provider_status
  ON channel_events (provider, processing_status, id);

CREATE INDEX IF NOT EXISTS ix_messages_inquiry_sent
  ON messages (inquiry_id, sent_at, id);
