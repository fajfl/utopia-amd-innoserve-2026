# 屋托邦協調器

本機 Python ADK sidecar 接收 Node 授權的必要脈絡，輸出結構化動作提案；資料庫、LINE 發訊與簽署仍由 Node 驗證及執行。

比賽版使用根目錄 `.env` 的 `AI_PROVIDER=llamacpp`、`AI_MODEL`、`AI_BASE_URL`、`AI_API_KEY`，與 Node 共用模型設定。也可明確改選 `vllm`。不需另外複製 Google 或 DeepSeek 憑證。

```bash
uv sync --locked
LITELLM_LOCAL_MODEL_COST_MAP=true uv run uvicorn app.fast_api_app:app --host 127.0.0.1 --port 8000
```

請先設定 `AGENT_RUNTIME_SHARED_SECRET`；Node 與 sidecar 必須一致。服務只綁本機，模型服務的連線方式見 [AMD 部署準備](../../deploy/amd/README.md)。

```bash
uv run python -m unittest discover -s tests
```

尚未在 AMD Lab GPU 上驗收。
