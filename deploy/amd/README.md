# AMD Lab 推論準備

狀態：尚未核配、部署或 GPU 實測。以下範本僅適用於允許自架模型的 AMD ROCm Linux GPU 主機；若 Lab 提供代管 API，請依其通知設定端點，不必執行容器。

## llama.cpp 路線

1. 取得 GPU 型號／顯存、驅動／ROCm、登入方式與網路限制，確認 Lab 允許 Docker 與 GPU 裝置存取。
2. 選擇有授權、與硬體相容的 GGUF 模型，放在 GPU 主機的 MODEL_DIR。AI_MODEL 是 API 別名，並非權重下載位置。
3. 複製本目錄 `.env.example` 為 `.env`，填入獨立 INFERENCE_API_KEY、LLAMACPP_IMAGE 的固定版本、MODEL_DIR、GGUF_FILE。
4. 在 GPU 主機驗證與啟動：

```bash
docker compose --env-file .env -f llamacpp.compose.yaml config --quiet
docker compose --env-file .env -f llamacpp.compose.yaml up -d
```

容器只綁 GPU 主機的 `127.0.0.1:8001`，不直接公開推論介面。主機須有可用 ROCm、`/dev/kfd`、`/dev/dri` 與裝置權限。範本沒有保證適用所有 GPU，模型大小、量化、context 及 GPU offload 必須實測。

如果 Lab 允許 SSH，從 GCP 應用 VM 建立轉送：

```bash
ssh -N -L 127.0.0.1:8001:127.0.0.1:8001 <user>@<gpu-host>
```

GCP 上根目錄 `.env` 使用：

```dotenv
AI_PROVIDER=llamacpp
AI_MODEL=ecsneo-model
AI_BASE_URL=http://127.0.0.1:8001/v1
AI_API_KEY=<same-as-INFERENCE_API_KEY>
AI_ENABLE_JSON_SCHEMA=false
```

Node 與 Python ADK 共用這些設定；修改後兩者都要重啟。缺欄位會停止，不借用其他服務的金鑰。實際連線須符合 Lab 的白名單與帳號規定。

## 其他後端與驗收

vLLM 是另一種執行模型的工具；需要時明確改選 `AI_PROVIDER=vllm` 與 `vllm.compose.yaml`。兩份範本共用 8001，一次只啟動一份。映像版本須配合核配環境固定，不使用未驗證的版本冒充實測。

先用合成資料確認 `/v1/models`、金鑰驗證、繁體中文、JSON 輸出、來源引用與權限拒絕，再測完整對話至草稿流程。記錄 GPU、映像版本、模型／量化、context、延遲與測試結果；目前均尚待驗收。

官方工具文件：[llama.cpp Docker](https://github.com/ggml-org/llama.cpp/blob/master/docs/docker.md)、[llama-server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[vLLM](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)。
