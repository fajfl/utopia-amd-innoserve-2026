# 屋托邦｜AMD AI 代理人比賽版

2026 大專校院資訊應用服務創新競賽「AMD AI 代理人創新應用組」的開發版本。
透過 LINE 協助房客與房東確認租屋條件、追蹤待確認事項、產生租約草稿及完成簽署流程。

版本分工：本倉庫只維護 AMD 比賽版，主要準備 llama.cpp 推論；自有正式產品另行維護並使用 DeepSeek。兩版不共用私密設定或真實資料，共通修正經檢查後再個別移植。

**狀態：程式已支援 llama.cpp／vLLM 相容端點；AMD-ITRI Lab 算力待申請與核配，尚未部署或做 GPU 實測。** 本倉庫不宣稱已在 AI PC、NPU 或 Lab GPU 上執行。

## 規劃架構

LINE → GCP Debian VM（Node.js 服務＋Python ADK 協調器）→ AMD-ITRI Lab（llama.cpp 模型推論）。

GCP VM 處理應用與資料存取；Lab 處理模型推論。llama.cpp 是執行工具，GGUF 是模型檔格式，模型與量化版本須待硬體、授權及實測結果確認。Lab 是否允許自架容器、SSH 或既有 API，仍以核配通知為準。

Node 驗證身分、來源、條件與動作；模型只提出建議，不直接寫資料庫或簽署。模型輸入包含經授權的必要對話片段；採遠端推論時，這些內容會送往推論端點，示範階段請只使用合成資料。

## 本機準備

需要 Node.js 25 以上、Python 3.11–3.13，以及 uv。先安裝依賴並建立自己的設定：

```bash
npm ci
cp .env.example .env
npm run db:v2:migrate
npm run db:v2:seed
```

範例使用本機 SQLite 與合成資料，不需連接原團隊資料庫。`npm start` 啟動 Node；完整 LINE 流程需要另行申請自己的 LINE channel／Mini App、設定網址與金鑰。不要把範例值當成可用憑證。

取得模型服務後，在根目錄 `.env` 設定 `AI_PROVIDER=llamacpp`、`AI_MODEL`、`AI_BASE_URL`、`AI_API_KEY`。啟動協調器：

```bash
cd agent_runtime/ecs-neo-agent
uv sync --locked
LITELLM_LOCAL_MODEL_COST_MAP=true uv run uvicorn app.fast_api_app:app --host 127.0.0.1 --port 8000
```

Node 與協調器讀取同一份根目錄 `.env`。完成 shared secret 設定後，才開啟 `ECS_NEO_AGENT_ENABLED=true`，並重新啟動兩個程序。缺少自架模型設定會報錯，不自動改用其他雲端模型。

詳見 [AMD 部署準備](deploy/amd/README.md)、[公開內容與測試狀態](docs/PUBLIC_RELEASE.md)。

## 測試

```bash
npm test
npm run check:public
```

Python 純單元測試：在 `agent_runtime/ecs-neo-agent` 執行 `uv run python -m unittest discover -s tests`。真實 LINE、遠端資料庫與模型測試需要獨立設定與授權；目前不列為已驗收功能。

## 公開資料範圍

本倉庫從整理後的程式快照開始，不包含原倉庫提交歷史。示範房源、身分及對話均為合成測試資料；`example.test` 網址不提供真實服務。沒有附上金鑰、資料庫、真人合約、上傳檔案、內部工作紀錄或參賽計畫書。

`docs/reference/residential-lease-sources/` 僅保留程式驗證所需的政府公開租約資料，來源網址與校驗值記錄於 `database/seeds/fixtures/ecs-neo-reviewed-residential-bindings-2026-10-27.json`。本專案不隸屬 LINE、591、AMD 或 ITRI。
