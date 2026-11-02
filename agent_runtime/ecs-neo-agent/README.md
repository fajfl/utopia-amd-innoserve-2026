# ECS Neo Negotiation Coordinator

更新：2026-10-29

這是 ECS Neo 的本機 Google ADK Python sidecar。它接收 Node 已授權、去識別化的協商脈絡，輸出 typed proposed action；它不直接連資料庫、不發 LINE、不接受條件、不發行合約，也不簽署。

## 目前狀態

- 預設模型：DeepSeek `deepseek-flash`，明確關閉 thinking；ADK LiteLlm 使用 OpenAI 相容端點。
- 自架：明確選 `AI_PROVIDER=vllm` 或 `llamacpp`，並填 `AI_MODEL`、`AI_BASE_URL`、`AI_API_KEY`。缺值會報錯，不借用雲端金鑰；不送 DeepSeek thinking 參數。模型名稱與 Node trace 共用 `AI_MODEL`。見 [AMD 準備說明](../../deploy/amd/README.md)，尚未做 GPU 實測。
- 執行方式：本機 sidecar，預設 `127.0.0.1:8000`。
- 部署目標：`none`（見 `agents-cli-manifest.yaml`）。
- 雲端部署：尚未執行，也未獲授權。
- Node.js 仍是 system of record、授權與副作用邊界。
- Node／sidecar prompt 同步為 v4；新增選填 `pending_items` 提案，Node 驗證原話片段、欄位及詢問範圍。待辦每輪保留，房客確認相關版本或明確放棄後才結案。
- 其他約定沿用 `special_request_text`，每行一條、最多 10 條、每條 200 字。主庫與開發分支已套用 migration 036；此 PR 尚未合併，真人 LINE／真模型驗收依使用者指示暫不執行。詳見 [收尾紀錄](../../docs/testing/2026-10-29-session-completion.md)。

## 目錄

```text
app/agent.py              ADK Agent 與模型設定
app/fast_api_app.py       Node 呼叫的本機 HTTP adapter
app/proposed_action.py    輸出 schema 與 shared-secret 驗證
app/runtime_config.py     本機 runtime 設定
tests/                    unit、integration 與 eval fixtures
```

## 本機啟動

日常請在專案根目錄執行 `npm start`，即可一起管理 Node 與本機 AI，詳見 [根目錄教學](../../README.md#每天只用一個指令)。以下是首次安裝與獨立開發 AI 的進階方式；不要與已啟動的 `npm start` 重複執行。

先確認專案根目錄的 `.env` 已有 `DEEPSEEK_API_KEY`（或自架三個必填欄位）／sidecar 所需設定，且不要輸出 token。於本目錄執行：

```powershell
uv sync --locked
$env:LITELLM_LOCAL_MODEL_COST_MAP = "true"
.\.venv\Scripts\python.exe -X utf8 -m uvicorn app.fast_api_app:app --host 127.0.0.1 --port 8000
```

Node 端必須使用相同的 `AGENT_RUNTIME_SHARED_SECRET`，並將 `AGENT_RUNTIME_URL` 指向本機 sidecar。

## 測試注意

- 先跑 deterministic fake runtime 與 Node 測試，再決定是否跑真 DeepSeek。
- 不要把整份根目錄 `.env` 匯入 live flow；R2 設定會讓本機合約證據測試改走雲端物件儲存。
- 2026-09-17 在 Windows 重跑完整 sidecar pytest 時曾出現反覆 elevation 視窗，測試已中止。未查明來源前不要重複執行同一完整指令；可先針對純單元測試逐支執行並觀察。

## 部署邊界

不要執行 `agents-cli deploy`、`agents-cli infra cicd`、Terraform、Cloud Run、Agent Engine 或其他遠端建立／修改命令。任何部署、遠端資源或 credential 變更都需要使用者另行明確授權。
